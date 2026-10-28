/**
 * The MCP client: both protocol eras, both response forms, and the limits.
 *
 * Against a local stub (tests/p2e-mcp-stub.js) that behaves like the servers
 * a tenant will actually paste in. Loopback is what safe-http exists to
 * refuse, so its lookup is swapped for the duration, as the action and
 * connector suites do — and one test puts the real guard back to prove it
 * still refuses.
 */

const dns = require('dns');

const mcpClient = require('../services/mcp-client');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const { createStub } = require('./p2e-mcp-stub');

const stub = createStub();
let base;
let counter = 0;

/** A server record as routes/mcp.js would store it. */
function serverAt(path, extra = {}) {
  counter += 1;
  return { _id: `srv${counter}`, url: `${base}${path}`, auth: { type: 'none' }, ...extra };
}

function storedTool(name) {
  const raw = stub.TOOLS.find(tool => tool.name === name);
  return mcpClient.checkTool(raw).tool;
}

beforeAll(async () => {
  process.env.SECRETS_KEY = 'test-secrets-key-for-the-mcp-suite';
  secrets.resetForTests();
  process.env.ACTIONS_ALLOW_HTTP = 'true';
  safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));
  base = await stub.listen();
});

afterAll(async () => {
  safeHttp.__setLookupForTests(null);
  delete process.env.ACTIONS_ALLOW_HTTP;
  mcpClient.resetForTests();
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
});

describe('legacy era (initialize and sessions)', () => {
  test('a modern probe is refused, so it initializes, keeps the session id and pages through tools/list', async () => {
    const result = await mcpClient.discover(serverAt('/legacy/mcp'));

    expect(result.ok).toBe(true);
    expect(result.protocol).toEqual({ era: 'legacy', version: '2025-11-25' });
    expect(result.serverInfo).toEqual({ name: 'stub/legacy/mcp', version: '1.2.3' });

    const methods = stub.requests.map(entry => entry.message && entry.message.method);
    expect(methods).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/list']);

    const [probe, init, initialized, firstPage, secondPage] = stub.requests;
    expect(probe.headers.accept).toBe('application/json, text/event-stream');
    expect(probe.headers['mcp-protocol-version']).toBe('2026-07-28');
    // No version header and no session on the handshake itself.
    expect(init.headers['mcp-protocol-version']).toBeUndefined();
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(init.message.params).toMatchObject({ protocolVersion: '2025-11-25', capabilities: {} });
    expect(initialized.headers['mcp-session-id']).toBe(firstPage.headers['mcp-session-id']);
    expect(firstPage.headers['mcp-protocol-version']).toBe('2025-11-25');
    expect(secondPage.message.params).toEqual({ cursor: '2' });

    // Every tool but the one whose x-mcp-header breaks the rules.
    expect(result.tools.map(tool => tool.name)).toEqual(['lookup_order', 'refund.order', 'search', 'regional']);
    expect(result.warnings.join(' ')).toMatch(/bad_header.*x-mcp-header/);
    expect(result.tools[0]).toMatchObject({ readOnlyHint: true, title: 'Look up an order' });
    expect(result.tools[1]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  test('a tool call reuses the session, and an expired session is started again', async () => {
    const server = serverAt('/legacy/mcp', { protocol: { era: 'legacy', version: '2025-11-25' } });

    const first = await mcpClient.callTool(server, storedTool('lookup_order'), { order_id: '7' });
    expect(first).toMatchObject({ ok: true, isError: false });
    expect(first.text).toContain('Order 7 has shipped.');
    expect(first.text).toContain('[image omitted]');

    await mcpClient.callTool(server, storedTool('lookup_order'), { order_id: '8' });
    expect(stub.requests.filter(entry => entry.message && entry.message.method === 'initialize')).toHaveLength(1);

    stub.expireSessions();
    const third = await mcpClient.callTool(server, storedTool('refund.order'), { order_id: '9' });
    expect(third).toMatchObject({ ok: true, text: 'Refunded 9.' });
    expect(stub.requests.filter(entry => entry.message && entry.message.method === 'initialize')).toHaveLength(2);
  });

  test('forgetting a server ends its session with DELETE', async () => {
    const server = serverAt('/legacy/mcp', { protocol: { era: 'legacy', version: '2025-11-25' } });
    await mcpClient.callTool(server, storedTool('lookup_order'), { order_id: '1' });
    const sessionId = stub.requests.find(entry => entry.message && entry.message.method === 'tools/call').headers['mcp-session-id'];

    await mcpClient.forget(server._id);
    const deleted = stub.requests.find(entry => entry.method === 'DELETE');
    expect(deleted.headers['mcp-session-id']).toBe(sessionId);
  });

  test('an event-stream answer is read as it arrives: priming event, ping answered, split CRLF response, stream left open', async () => {
    const server = serverAt('/legacy-sse/mcp');
    const listed = await mcpClient.discover(server);
    expect(listed.ok).toBe(true);
    expect(listed.tools).toHaveLength(4);

    const started = Date.now();
    const result = await mcpClient.callTool({ ...server, protocol: listed.protocol }, storedTool('lookup_order'), { order_id: '5' });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Order 5 has shipped.');
    // The stream is never closed by the server: finishing well inside the
    // 15 second deadline means the client stopped reading by itself.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stub.pending.lastPong).toEqual({ jsonrpc: '2.0', id: 'srv-ping', result: {} });
  });

  test('a stream dropped after an event id is resumed with Last-Event-ID', async () => {
    const server = serverAt('/legacy-resume/mcp', { protocol: { era: 'legacy', version: '2025-11-25' } });
    const result = await mcpClient.callTool(server, storedTool('refund.order'), { order_id: '3' });

    expect(result).toMatchObject({ ok: true, text: 'Refunded 3.' });
    const resumed = stub.requests.find(entry => entry.method === 'GET');
    expect(resumed.headers['last-event-id']).toBe('ev-1');
    expect(resumed.headers['mcp-session-id']).toBeTruthy();
  });
});

describe('modern era (stateless, per-request metadata)', () => {
  test('server/discover settles it: no handshake, _meta and mirrored headers on every request', async () => {
    const result = await mcpClient.discover(serverAt('/modern/mcp'));

    expect(result.ok).toBe(true);
    expect(result.protocol).toEqual({ era: 'modern', version: '2026-07-28' });
    expect(result.serverInfo).toEqual({ name: 'modern-stub', version: '9.0' });
    expect(stub.requests.map(entry => entry.message.method)).toEqual(['server/discover', 'tools/list', 'tools/list', 'tools/list']);

    stub.requests.forEach(entry => {
      expect(entry.headers['mcp-session-id']).toBeUndefined();
      expect(entry.headers['mcp-method']).toBe(entry.message.method);
      expect(entry.message.params._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'chatbot-platform' }
      });
    });
  });

  test('tools/call carries Mcp-Name, base64-encoded when the name needs it, and Mcp-Param-* headers', async () => {
    const server = serverAt('/modern/mcp', { protocol: { era: 'modern', version: '2026-07-28' } });

    const refund = await mcpClient.callTool(server, storedTool('refund.order'), { order_id: '1' });
    expect(refund).toMatchObject({ ok: true, text: 'Refunded 1.' });
    expect(stub.requests[0].headers['mcp-name']).toBe('refund.order');

    const regional = await mcpClient.callTool(server, storedTool('regional'), { region: 'Zürich', q: 'x' });
    expect(regional).toMatchObject({ ok: true, text: 'Ran in Zürich' });
    expect(stub.requests[1].headers['mcp-param-region']).toBe(`=?base64?${Buffer.from('Zürich').toString('base64')}?=`);

    const structured = await mcpClient.callTool(server, storedTool('search'), { query: 'bike' });
    expect(structured.text).toBe('{"results":["bike rack"]}');
  });

  test('event-stream answers work in the modern era too', async () => {
    const result = await mcpClient.discover(serverAt('/modern-sse/mcp'));
    expect(result).toMatchObject({ ok: true, protocol: { era: 'modern' } });
    expect(result.tools).toHaveLength(4);
  });

  test('a stored era that turns out wrong is probed again once, and the call still succeeds', async () => {
    // Told it is legacy; it is modern, and refuses initialize.
    const server = serverAt('/modern/mcp', { protocol: { era: 'legacy', version: '2025-11-25' } });
    const result = await mcpClient.callTool(server, storedTool('refund.order'), { order_id: '4' });

    expect(result).toMatchObject({ ok: true, protocol: { era: 'modern' } });
  });

  test('a tool error is a result the model can read, not a failure', async () => {
    const server = serverAt('/modern/mcp', { protocol: { era: 'modern', version: '2026-07-28' } });
    const result = await mcpClient.callTool(server, storedTool('lookup_order'), { order_id: 'bad' });
    expect(result).toMatchObject({ ok: true, isError: true, text: 'Unknown order number: bad' });

    const unknown = await mcpClient.callTool(server, { name: 'nope', inputSchema: '{}' }, {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown tool/);
  });
});

describe('limits and refusals', () => {
  test('a server that never answers is cut off at the deadline', async () => {
    const result = await mcpClient.discover(serverAt('/hang/mcp'), { timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not answer/);
  });

  test('keep-alives do not hold a call open past the deadline', async () => {
    const started = Date.now();
    const result = await mcpClient.callTool(
      serverAt('/trickle/mcp', { protocol: { era: 'modern', version: '2026-07-28' } }),
      storedTool('refund.order'), { order_id: '1' }, { timeoutMs: 500 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not answer/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('a response over the size cap is refused', async () => {
    const result = await mcpClient.discover(serverAt('/huge/mcp'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/more data than we will read/);
  });

  test('an OAuth-protected server is explained, not just refused', async () => {
    const result = await mcpClient.discover(serverAt('/oauth/mcp'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OAuth sign-in/);
    // A 401 is about the credential; the handshake is not tried as well.
    expect(stub.requests).toHaveLength(1);
  });

  test('a web page is not mistaken for a server', async () => {
    const result = await mcpClient.discover(serverAt('/html/mcp'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not MCP/);
  });

  test('the bearer token is sent, and a credential that cannot be decrypted stops the call', async () => {
    const server = serverAt('/modern/mcp', {
      protocol: { era: 'modern', version: '2026-07-28' },
      auth: { type: 'bearer', secret: secrets.encrypt('mcp_tok_123') }
    });
    await mcpClient.callTool(server, storedTool('refund.order'), { order_id: '1' });
    expect(stub.requests[0].headers.authorization).toBe('Bearer mcp_tok_123');

    const broken = await mcpClient.callTool(
      serverAt('/modern/mcp', { auth: { type: 'header', headerName: 'X-Api-Key', secret: 'enc:v1:garbage:x:y' } }),
      storedTool('refund.order'), { order_id: '1' }
    );
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/credential could not be read/);
  });

  test('with the real address guard, a server on a private address is refused', async () => {
    // A second server, so no pooled keep-alive socket from the tests above
    // (opened under the test lookup) can stand in for a fresh connection.
    const other = createStub();
    const otherBase = await other.listen();
    safeHttp.__setLookupForTests(null);
    try {
      const result = await mcpClient.discover({ _id: 'private', url: `${otherBase}/modern/mcp`, auth: { type: 'none' } });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/private or reserved/);
      expect(result.error).toMatch(/tunnel/);
      expect(other.requests).toHaveLength(0);

      // A literal private address never gets as far as a connection.
      const literal = await mcpClient.discover({ _id: 'literal', url: 'https://169.254.169.254/mcp', auth: { type: 'none' } });
      expect(literal.error).toMatch(/private or reserved/);
    } finally {
      safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));
      await other.close();
    }
  });

  test('URLs: https only, http only for a local server outside production, no private literals, no credentials', () => {
    expect(mcpClient.validateServerUrl('https://mcp.stripe.com').valid).toBe(true);
    expect(mcpClient.validateServerUrl('http://mcp.example.com/mcp').valid).toBe(false);
    expect(mcpClient.validateServerUrl('https://169.254.169.254/latest').valid).toBe(false);
    expect(mcpClient.validateServerUrl('https://10.0.0.5/mcp').valid).toBe(false);
    expect(mcpClient.validateServerUrl('https://user:pass@mcp.example.com/mcp').valid).toBe(false);
    expect(mcpClient.validateServerUrl('ftp://mcp.example.com').valid).toBe(false);
    expect(mcpClient.validateServerUrl('http://localhost:3000/mcp').valid).toBe(true);

    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(mcpClient.validateServerUrl('http://localhost:3000/mcp').valid).toBe(false);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe('the pieces', () => {
  test('header values are encoded the way the specification shows', () => {
    expect(mcpClient.encodeHeaderValue('us-west1')).toBe('us-west1');
    expect(mcpClient.encodeHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(mcpClient.encodeHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(mcpClient.encodeHeaderValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=');
    expect(mcpClient.encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  });

  test('x-mcp-header annotations are found, and broken ones refuse the tool', () => {
    const ok = mcpClient.headerParams({
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        nested: { type: 'object', properties: { tenant: { type: 'integer', 'x-mcp-header': 'Tenant' } } }
      }
    });
    expect(ok.params).toEqual([{ path: ['region'], header: 'Region' }, { path: ['nested', 'tenant'], header: 'Tenant' }]);
    expect(mcpClient.paramHeaders(ok.params, { region: 'eu', nested: { tenant: 42 } }))
      .toEqual({ 'Mcp-Param-Region': 'eu', 'Mcp-Param-Tenant': '42' });

    expect(mcpClient.headerParams({ properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } }).error).toMatch(/twice/);
    expect(mcpClient.headerParams({ properties: { a: { type: 'string', 'x-mcp-header': 'Bad Name' } } }).error).toMatch(/not a valid header/);
    expect(mcpClient.headerParams({ properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } }).error).toMatch(/not reachable/);
    // A literal default that happens to look like an annotation is data.
    expect(mcpClient.headerParams({ properties: { a: { type: 'object', default: { 'x-mcp-header': 'X' } } } }).params).toEqual([]);
  });

  test('the SSE reader handles CRLF split across chunks, multi-line data, comments and priming events', () => {
    const reader = new mcpClient.SseReader(7);
    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(reader.push(Buffer.from(': hello\r\nid: 1\r\ndata:\r\n\r\ndata: {"jsonrpc":"2.0",\r'))).toBe(false);
    expect(reader.push(Buffer.from('\ndata: "method":"notifications/progress"}\r\n\r\n'))).toBe(false);
    expect(reader.push(Buffer.from(`retry: 250\ndata: ${message.slice(0, 10)}`))).toBe(false);
    expect(reader.push(Buffer.from(`${message.slice(10)}\n\n`))).toBe(true);
    expect(reader.response).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(reader.lastEventId).toBe('1');
    expect(reader.retryMs).toBe(250);
  });

  test('a result is read as text, with structured content when there is no text', () => {
    expect(mcpClient.readResult({ content: [{ type: 'text', text: 'a' }, { type: 'resource_link', uri: 'https://x/y', name: 'Y' }] }).text)
      .toBe('a\n\n[link: Y https://x/y]');
    expect(mcpClient.readResult({ content: [], structuredContent: { n: 1 } }).text).toBe('{"n":1}');
    expect(mcpClient.readResult({ content: [{ type: 'text', text: 'no' }], isError: true }).isError).toBe(true);
  });
});

describe('schema sanitising', () => {
  test('local refs are inlined, oneOf becomes anyOf, allOf is merged, unsupported keywords go', () => {
    const { ok, schema } = mcpClient.modelSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { Address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
      properties: {
        address: { $ref: '#/$defs/Address' },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Optional' },
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        both: { allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } }, required: ['b'] }] },
        kind: { const: 'fixed' },
        list: { type: 'array' },
        nullable: { type: ['integer', 'null'], minimum: 1 },
        remote: { $ref: 'https://evil.example/schema.json' },
        weird: { type: 'string', not: { const: 'x' }, if: {}, then: {}, 'x-vendor': true, patternProperties: {} }
      },
      required: ['address', 'missing_property'],
      additionalProperties: false
    });

    expect(ok).toBe(true);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        maybe: { type: 'string', description: 'Optional' },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        both: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['b'] },
        kind: { enum: ['fixed'] },
        list: { type: 'array', items: {} },
        nullable: { type: 'integer', minimum: 1 },
        remote: {},
        weird: { type: 'string' }
      },
      required: ['address'],
      additionalProperties: false
    });
  });

  test('a recursive schema stops at the cycle, and a top-level union offers every field', () => {
    const recursive = mcpClient.modelSchema({
      type: 'object',
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' }, name: { type: 'string' } } } },
      properties: { root: { $ref: '#/$defs/Node' } }
    });
    expect(recursive.ok).toBe(true);
    expect(recursive.schema.properties.root.properties.child).toEqual({});

    const union = mcpClient.modelSchema({ anyOf: [{ properties: { id: { type: 'string' } } }, { properties: { email: { type: 'string' } } }] });
    expect(union.schema).toEqual({ type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } });
  });

  test('a schema too large even without nested descriptions is refused rather than sent', () => {
    const properties = {};
    for (let i = 0; i < 60; i += 1) {
      properties[`field_${i}`] = { type: 'string', description: 'd'.repeat(300), enum: Array.from({ length: 30 }, (_, n) => `value_${n}`) };
    }
    const result = mcpClient.modelSchema({ type: 'object', properties });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/);
  });

  test('tool names are namespaced and kept to the model\'s rules', () => {
    expect(mcpClient.assistantToolName('shop', 'refund.order')).toBe('mcp_shop_refund_order');
    const long = mcpClient.assistantToolName('shop', 'x'.repeat(100));
    expect(long).toMatch(/^mcp_shop_x+_[0-9a-f]{8}$/);
    expect(long.length).toBe(64);
    expect(long).not.toBe(mcpClient.assistantToolName('shop', `${'x'.repeat(99)}y`));
  });
});
