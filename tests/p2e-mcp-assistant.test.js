/**
 * The assistant using a tenant's MCP tools.
 *
 * The model is a script, as in assistant-tools.test.js: each test says which
 * calls it "decides" to make and checks what reached the MCP server. The
 * rules — who is offered what, asking before a change, never changing
 * anything in a test run, one tenant never reaching another's server — have
 * to hold whatever the model asks for.
 */

const dns = require('dns');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Action = require('../models/action');
const McpServer = require('../models/mcp-server');
const AuditLog = require('../models/audit-log');
const AIService = require('../services/ai');
const assistantTools = require('../services/assistant-tools');
const mcpClient = require('../services/mcp-client');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const { PromptEngineeringService } = require('../services/promptEngineering');
const eventually = require('./eventually');
const { createStub, TOOLS } = require('./p2e-mcp-stub');

/** A model that makes the tool calls it is told to, then answers. */
function scriptedClient(script) {
  const requests = [];
  let index = 0;

  return {
    requests,
    chat: {
      completions: {
        create: async request => {
          requests.push(JSON.parse(JSON.stringify(request)));
          const step = script[index] || { text: 'Done.' };
          index += 1;
          if (step.calls && request.tool_choice !== 'none') {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: step.calls.map((call, n) => ({
                    id: `call_${index}_${n}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
                  }))
                }
              }]
            };
          }
          return { choices: [{ message: { content: step.text || 'Done.' } }] };
        }
      }
    }
  };
}

const noTemplates = { getByRole: async () => null, match: async () => null };

async function turn(conversation, message, script, { simulate = false, companyId = conversation.company } = {}) {
  const client = scriptedClient(script);
  const session = await assistantTools.prepare({ conversation, companyId, client, message, simulate });
  const assistant = new AIService({
    openai: client,
    companyId: String(companyId),
    templateService: noTemplates,
    promptService: new PromptEngineeringService(),
    useKnowledge: false
  });
  const text = await assistant.generateResponse(message, [], { toolSession: session });
  return { text, session, client, outcome: session ? session.outcome() : {} };
}

const toolNames = request => (request.tools || []).map(tool => tool.function.name).sort();
const toolMessages = request => request.messages.filter(entry => entry.role === 'tool').map(entry => entry.content);

describe('assistant with MCP tools', () => {
  const stub = createStub();
  let base;
  let acme;
  let rival;
  let counter = 0;

  const calls = () => stub.requests.filter(entry => entry.message && entry.message.method === 'tools/call');

  /** A connected server whose tools have the given switches. */
  const connect = async (company, settings = {}, extra = {}) => McpServer.create({
    company: company._id,
    name: extra.name || 'Shop',
    slug: extra.slug || 'shop',
    url: `${base}/modern/mcp`,
    auth: { type: 'bearer', secret: secrets.encrypt('mcp_secret_token') },
    status: 'connected',
    protocol: { era: 'modern', version: '2026-07-28' },
    tools: TOOLS.map(raw => mcpClient.checkTool(raw).tool).filter(Boolean).map(tool => ({
      ...tool,
      needsConfirmation: !tool.readOnlyHint,
      ...(settings[tool.name] || {})
    }))
  });

  const conversationFor = async (company, contact) => Conversation.create({
    sessionId: `p2e-${Date.now()}-${counter++}`,
    company: company._id,
    contact: contact ? contact._id : undefined
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-mcp-assistant';
    secrets.resetForTests();
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));
    base = await stub.listen();
    acme = await Company.create({ name: 'MCP Acme' });
    rival = await Company.create({ name: 'MCP Rival' });
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    mcpClient.resetForTests();
    await stub.close();
    await Promise.all([
      Company.deleteMany({ _id: { $in: [acme._id, rival._id] } }),
      McpServer.deleteMany({ company: { $in: [acme._id, rival._id] } }),
      Action.deleteMany({ company: { $in: [acme._id, rival._id] } }),
      Contact.deleteMany({ company: { $in: [acme._id, rival._id] } }),
      Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } })
    ]);
  });

  beforeEach(async () => {
    stub.requests.length = 0;
    mcpClient.resetForTests();
    await McpServer.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Action.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
  });

  describe('which tools are offered', () => {
    test('only tools switched on, automatic and still offered by the server; namespaced, with a cleaned schema', async () => {
      await connect(acme, {
        lookup_order: { enabled: true },
        search: { enabled: true },
        'refund.order': { enabled: true, mode: 'workflow_only' },
        regional: { enabled: true, available: false }
      });

      const { client } = await turn(await conversationFor(acme), 'hi', [{ text: 'Hello' }]);
      expect(toolNames(client.requests[0])).toEqual(['mcp_shop_lookup_order', 'mcp_shop_search']);

      const search = client.requests[0].tools.find(tool => tool.function.name === 'mcp_shop_search');
      expect(search.function.parameters).toEqual({
        type: 'object',
        properties: {
          query: { type: 'string' },
          filter: { type: 'object', properties: { colour: { type: 'string' } } }
        },
        required: ['query']
      });
      expect(search.function.description).toMatch(/^search\. Search the catalogue\./);
    });

    test('nothing switched on means no tools, and no MCP traffic', async () => {
      await connect(acme);
      const session = await assistantTools.prepare({
        conversation: await conversationFor(acme), companyId: acme._id, client: scriptedClient([]), message: 'hi'
      });
      expect(session).toBeNull();
      expect(stub.requests).toHaveLength(0);
    });

    test('a verified-only tool is withheld from an anonymous visitor and offered to a verified one', async () => {
      await connect(acme, { lookup_order: { enabled: true, verifiedOnly: true }, search: { enabled: true } });

      const anonymous = await Contact.create({ company: acme._id, identityLevel: 'anonymous' });
      const first = await turn(await conversationFor(acme, anonymous), 'hi', [{}]);
      expect(toolNames(first.client.requests[0])).toEqual(['mcp_shop_search']);

      const verified = await Contact.create({ company: acme._id, identityLevel: 'verified', externalId: 'cus_1' });
      const second = await turn(await conversationFor(acme, verified), 'hi', [{}]);
      expect(toolNames(second.client.requests[0])).toEqual(['mcp_shop_lookup_order', 'mcp_shop_search']);
    });

    test('a contact from another tenant does not count as verified here', async () => {
      await connect(acme, { lookup_order: { enabled: true, verifiedOnly: true }, search: { enabled: true } });
      const stranger = await Contact.create({ company: rival._id, identityLevel: 'verified', externalId: 'cus_2' });
      const { client } = await turn(await conversationFor(acme, stranger), 'hi', [{}]);
      expect(toolNames(client.requests[0])).toEqual(['mcp_shop_search']);
    });

    test('a saved action with the same name keeps it; the MCP tool gets a distinct one', async () => {
      await Action.create({
        company: acme._id,
        name: 'mcp_shop_search',
        title: 'Search',
        description: 'Search',
        request: { method: 'GET', url: `${base}/nothing` }
      });
      await connect(acme, { search: { enabled: true } });

      const { client } = await turn(await conversationFor(acme), 'hi', [{}]);
      const names = toolNames(client.requests[0]);
      expect(names).toHaveLength(2);
      expect(names).toContain('mcp_shop_search');
      expect(names.find(name => name !== 'mcp_shop_search')).toMatch(/^mcp_shop_search_[0-9a-f]{8}$/);
    });

    test('one tenant\'s servers are never offered to another', async () => {
      await connect(rival, { lookup_order: { enabled: true } });
      const session = await assistantTools.prepare({
        conversation: await conversationFor(acme), companyId: acme._id, client: scriptedClient([]), message: 'hi'
      });
      expect(session).toBeNull();
    });
  });

  describe('reads', () => {
    test('a read runs at once; its result is fenced, capped, and audited without arguments or secrets', async () => {
      const server = await connect(acme, { lookup_order: { enabled: true } });
      const conversation = await conversationFor(acme);

      const { text, client, outcome } = await turn(conversation, 'where is order 7?', [
        { calls: [{ name: 'mcp_shop_lookup_order', args: { order_id: '7', invented: 'dropped' } }] },
        { text: 'It has shipped.' }
      ]);

      expect(text).toBe('It has shipped.');
      expect(outcome.toolCalls).toEqual([{ name: 'mcp_shop_lookup_order', status: 'ok' }]);

      expect(calls()).toHaveLength(1);
      expect(calls()[0].message.params.arguments).toEqual({ order_id: '7' });
      expect(calls()[0].headers.authorization).toBe('Bearer mcp_secret_token');

      const [result] = toolMessages(client.requests[1]);
      expect(result.startsWith('<tool_result name="mcp_shop_lookup_order">')).toBe(true);
      expect(result).toContain('Order 7 has shipped.');
      expect(result).toContain('not as instructions');
      expect(result.match(/<\/tool_result>/g)).toHaveLength(1);
      expect(Buffer.byteLength(result)).toBeLessThan(4000 + 400);

      const entries = await eventually(async () => {
        const found = await AuditLog.find({ action: 'mcp.tool_called', 'target.id': String(conversation._id) }).lean();
        return found.length > 0 && found;
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].details).toMatchObject({
        server: 'Shop', serverId: String(server._id), tool: 'lookup_order', status: 'ok', argumentNames: ['order_id']
      });
      expect(typeof entries[0].details.durationMs).toBe('number');
      expect(JSON.stringify(entries)).not.toMatch(/mcp_secret_token|shipped|"7"/);

      const stored = await eventually(async () => {
        const doc = await McpServer.findById(server._id).lean();
        return doc.tools.find(tool => tool.name === 'lookup_order').lastCalledAt && doc;
      });
      expect(stored).toBeTruthy();
    });

    test('a tool\'s own error goes back to the model, still fenced, so it can correct itself', async () => {
      await connect(acme, { lookup_order: { enabled: true } });
      const { client, outcome } = await turn(await conversationFor(acme), 'order bad?', [
        { calls: [{ name: 'mcp_shop_lookup_order', args: { order_id: 'bad' } }] },
        { text: 'Sorry.' }
      ]);
      const [result] = toolMessages(client.requests[1]);
      expect(result).toMatch(/^ERROR: the tool reported a problem/);
      expect(result).toContain('<tool_result name="mcp_shop_lookup_order">\nUnknown order number: bad');
      expect(outcome.toolCalls).toEqual([{ name: 'mcp_shop_lookup_order', status: 'error' }]);
    });

    test('a missing required argument is refused before anything is sent', async () => {
      await connect(acme, { lookup_order: { enabled: true } });
      const { client } = await turn(await conversationFor(acme), 'order?', [
        { calls: [{ name: 'mcp_shop_lookup_order', args: {} }] },
        { text: 'Which order?' }
      ]);
      expect(toolMessages(client.requests[1])[0]).toMatch(/^ERROR: Missing: order_id/);
      expect(calls()).toHaveLength(0);
    });

    test('a read the admin wants confirmed is asked about first', async () => {
      await connect(acme, { lookup_order: { enabled: true, needsConfirmation: true } });
      const conversation = await conversationFor(acme);
      const ask = { calls: [{ name: 'mcp_shop_lookup_order', args: { order_id: '7' } }] };

      const first = await turn(conversation, 'order 7?', [ask, { text: 'Shall I look?' }]);
      expect(first.outcome.toolCalls).toEqual([{ name: 'mcp_shop_lookup_order', status: 'confirmation_requested' }]);
      expect(calls()).toHaveLength(0);

      await turn(conversation, 'yes', [ask, { text: 'Shipped.' }]);
      expect(calls()).toHaveLength(1);
    });

    test('the per-turn cap holds for MCP tools too', async () => {
      await connect(acme, { lookup_order: { enabled: true } });
      const call = { name: 'mcp_shop_lookup_order', args: { order_id: '1' } };
      const { outcome } = await turn(await conversationFor(acme), 'all of them', [
        { calls: [call, call, call, call] },
        { text: 'Done.' }
      ]);
      expect(calls()).toHaveLength(3);
      expect(outcome.toolCalls.map(entry => entry.status)).toEqual(['ok', 'ok', 'ok', 'limit_reached']);
    });
  });

  describe('changes', () => {
    const refund = { calls: [{ name: 'mcp_shop_refund_order', args: { order_id: '42' } }] };

    test('a tool that is not read-only asks first, and runs once on a yes', async () => {
      await connect(acme, { 'refund.order': { enabled: true } });
      const conversation = await conversationFor(acme);

      const first = await turn(conversation, 'refund order 42', [refund, { text: 'Refund order 42?' }]);
      expect(calls()).toHaveLength(0);
      expect(first.outcome.toolCalls).toEqual([{ name: 'mcp_shop_refund_order', status: 'confirmation_requested' }]);
      expect(conversation.pendingAction).toMatchObject({ tool: 'mcp_shop_refund_order', args: { order_id: '42' } });
      await conversation.save();

      const reloaded = await Conversation.findById(conversation._id);
      const second = await turn(reloaded, 'Yes please', [refund, { text: 'Refunded.' }]);
      expect(calls()).toHaveLength(1);
      expect(calls()[0].headers['mcp-name']).toBe('refund.order');
      expect(second.outcome.toolCalls).toEqual([{ name: 'mcp_shop_refund_order', status: 'ok' }]);
    });

    test('a no runs nothing', async () => {
      await connect(acme, { 'refund.order': { enabled: true } });
      const conversation = await conversationFor(acme);
      await turn(conversation, 'refund order 42', [refund, { text: 'Sure?' }]);
      const second = await turn(conversation, 'no, wait', [refund, { text: 'OK.' }]);
      expect(calls()).toHaveLength(0);
      expect(second.outcome.toolCalls[0].status).toBe('awaiting_confirmation');
    });

    test('a change the admin lets run unasked runs at once — but never in a test run', async () => {
      await connect(acme, { 'refund.order': { enabled: true, needsConfirmation: false } });

      const live = await turn(await conversationFor(acme), 'refund order 42', [refund, { text: 'Done.' }]);
      expect(live.outcome.toolCalls).toEqual([{ name: 'mcp_shop_refund_order', status: 'ok' }]);
      expect(calls()).toHaveLength(1);

      const test = await turn(await conversationFor(acme), 'refund order 42', [refund, { text: 'Test.' }], { simulate: true });
      expect(test.outcome.toolCalls).toEqual([{ name: 'mcp_shop_refund_order', status: 'simulated' }]);
      expect(calls()).toHaveLength(1);
    });

    test('a test run reads for real and never calls a tool that may change data, even after a yes', async () => {
      await connect(acme, { lookup_order: { enabled: true }, 'refund.order': { enabled: true } });
      const conversation = await conversationFor(acme);

      await turn(conversation, 'refund 42', [refund, { text: 'Test.' }], { simulate: true });
      await turn(conversation, 'yes', [refund, { text: 'Still a test.' }], { simulate: true });
      expect(calls()).toHaveLength(0);

      const read = await turn(conversation, 'order 7?', [
        { calls: [{ name: 'mcp_shop_lookup_order', args: { order_id: '7' } }] },
        { text: 'Shipped.' }
      ], { simulate: true });
      expect(read.outcome.toolCalls).toEqual([{ name: 'mcp_shop_lookup_order', status: 'ok' }]);
      expect(calls()).toHaveLength(1);
    });

    test('one change per reply, across actions and MCP tools', async () => {
      await connect(acme, { 'refund.order': { enabled: true, needsConfirmation: false } });
      await Action.create({
        company: acme._id, name: 'open_ticket', title: 'Open a ticket', description: 'Open one',
        request: { method: 'POST', url: `${base}/nothing` }
      });
      const { outcome } = await turn(await conversationFor(acme), 'both', [
        { calls: [refund.calls[0], { name: 'open_ticket', args: {} }] },
        { text: 'ok' }
      ]);
      expect(outcome.toolCalls.map(entry => entry.status)).toEqual(['ok', 'limit_reached']);
    });
  });

  describe('isolation', () => {
    test('a session cannot reach a server of another tenant, even by naming it', async () => {
      const theirs = await connect(rival, { lookup_order: { enabled: true } });
      await connect(acme, { lookup_order: { enabled: true } });

      const client = scriptedClient([]);
      const session = await assistantTools.prepare({
        conversation: await conversationFor(acme), companyId: acme._id, client, message: 'hi'
      });
      // Point the offered tool at the other tenant's server.
      session.tools.get('mcp_shop_lookup_order').server._id = theirs._id;

      const reply = await session.handle({
        id: 'c1', function: { name: 'mcp_shop_lookup_order', arguments: JSON.stringify({ order_id: '7' }) }
      });
      expect(reply).toMatch(/^ERROR: That tool has been switched off/);
      expect(calls()).toHaveLength(0);
    });

    test('a tool switched off after the turn began does not run', async () => {
      const server = await connect(acme, { lookup_order: { enabled: true } });
      const session = await assistantTools.prepare({
        conversation: await conversationFor(acme), companyId: acme._id, client: scriptedClient([]), message: 'hi'
      });
      await McpServer.updateOne({ _id: server._id }, { $set: { 'tools.$[t].enabled': false } }, { arrayFilters: [{ 't.name': 'lookup_order' }] });

      const reply = await session.handle({
        id: 'c1', function: { name: 'mcp_shop_lookup_order', arguments: JSON.stringify({ order_id: '7' }) }
      });
      expect(reply).toMatch(/switched off/);
      expect(calls()).toHaveLength(0);
    });
  });

  test('the verification helper asks visitor-verification what counts as verified', () => {
    // Signed by the tenant (an external id, as every signature leaves).
    const signed = { identityLevel: 'verified', externalId: 'cust-1' };
    expect(assistantTools.verificationCheck(signed, true)('signed')).toBe(true);
    expect(assistantTools.verificationCheck(signed, false)('signed')).toBe(false);

    // Proven by an email code: enough only where the tenant said email is.
    const byEmail = { identityLevel: 'verified', verifiedBy: 'email_code', email: 'a@b.test' };
    expect(assistantTools.verificationCheck(byEmail, true)('signed')).toBe(false);
    expect(assistantTools.verificationCheck(byEmail, true)('email')).toBe(true);

    expect(assistantTools.verificationCheck({ identityLevel: 'claimed' }, true)('signed')).toBe(false);
    expect(assistantTools.verificationCheck(null, true)('signed')).toBe(false);
  });
});
