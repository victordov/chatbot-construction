/**
 * Managing MCP servers: the routes behind "Connected tools (MCP)".
 *
 * What would be a real problem if it regressed: a token coming back out of
 * the API or sitting in the database in clear, one tenant reaching another's
 * server, a saved token being sent to a new address nobody re-entered it for,
 * and tools getting past the plan's actions limit.
 */

const dns = require('dns');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Action = require('../models/action');
const McpServer = require('../models/mcp-server');
const AuditLog = require('../models/audit-log');
const Subscription = require('../models/subscription');
const mcpClient = require('../services/mcp-client');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const usageService = require('../services/usage');
const { mergeTools } = require('../routes/mcp');
const eventually = require('./eventually');
const { createStub } = require('./p2e-mcp-stub');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/mcp', require('../routes/mcp'));
  return app;
};

describe('MCP server routes', () => {
  const stub = createStub();
  let app;
  let base;
  let acme;
  let rival;
  let limited;
  let dana;
  let rex;
  let alice;
  let bob;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const as = token => ({ 'x-auth-token': token });

  const create = (token, overrides = {}) => request(app).post('/api/mcp').set(as(token)).send({
    name: 'Shop',
    url: `${base}/modern/mcp`,
    auth: { type: 'bearer', secret: 'mcp_live_secret' },
    ...overrides
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-mcp-routes';
    secrets.resetForTests();
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));
    base = await stub.listen();

    acme = await Company.create({ name: 'MCP Routes Acme' });
    rival = await Company.create({ name: 'MCP Routes Rival' });
    limited = await Company.create({ name: 'MCP Routes Limited' });
    await Subscription.create({ company: limited._id, planId: 'basic', status: 'active', limitOverrides: { actions: 2 } });
    usageService.invalidateSubscription(limited._id);

    const make = (username, role, company) => User.create({
      username, email: `${username}@mcp.example`, password: 'TestPassword123!',
      role, displayName: username, company: company._id
    });
    await make('mcp-dana', 'company_admin', acme);
    await make('mcp-rex', 'company_admin', rival);
    await make('mcp-alice', 'operator', acme);
    await make('mcp-bob', 'company_admin', limited);

    dana = await login('mcp-dana');
    rex = await login('mcp-rex');
    alice = await login('mcp-alice');
    bob = await login('mcp-bob');
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    mcpClient.resetForTests();
    await stub.close();
    const companies = [acme._id, rival._id, limited._id];
    await Promise.all([
      User.deleteMany({ username: /^mcp-/ }),
      Company.deleteMany({ _id: { $in: companies } }),
      McpServer.deleteMany({ company: { $in: companies } }),
      Action.deleteMany({ company: { $in: companies } }),
      Subscription.deleteMany({ company: { $in: companies } })
    ]);
  });

  beforeEach(async () => {
    mcpClient.resetForTests();
    await McpServer.deleteMany({ company: { $in: [acme._id, rival._id, limited._id] } });
    await Action.deleteMany({ company: { $in: [acme._id, rival._id, limited._id] } });
  });

  test('a server is stored with its token encrypted, and the token never comes back', async () => {
    const created = await create(dana);
    expect(created.status).toBe(201);
    expect(created.body.server).toMatchObject({
      name: 'Shop', slug: 'shop', status: 'new', auth: { type: 'bearer', hasSecret: true }, tools: []
    });
    expect(JSON.stringify(created.body)).not.toContain('mcp_live_secret');

    const raw = await mongoose.connection.collection('mcpservers').findOne({ _id: new mongoose.Types.ObjectId(created.body.server._id) });
    expect(raw.auth.secret.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('mcp_live_secret');
    expect(secrets.decrypt(raw.auth.secret)).toBe('mcp_live_secret');

    const list = await request(app).get('/api/mcp').set(as(dana));
    expect(list.status).toBe(200);
    expect(list.body.servers).toHaveLength(1);
    expect(list.body.servers[0].auth).toEqual({ type: 'bearer', hasSecret: true });
    expect(JSON.stringify(list.body)).not.toMatch(/mcp_live_secret|enc:v1/);

    const entry = await eventually(() => AuditLog.findOne({ action: 'mcp.server_created', 'target.id': created.body.server._id }).lean());
    expect(JSON.stringify(entry)).not.toMatch(/mcp_live_secret|enc:v1/);
  });

  test('the form is checked: address, header name, a token when one is needed, and slugs stay unique', async () => {
    expect((await create(dana, { url: 'http://mcp.example.com/mcp' })).body.error).toMatch(/https/);
    expect((await create(dana, { url: 'https://10.1.2.3/mcp' })).body.error).toMatch(/private or reserved/);
    expect((await create(dana, { auth: { type: 'header', headerName: 'Content-Type', secret: 'x' } })).body.error).toMatch(/header/);
    expect((await create(dana, { auth: { type: 'bearer' } })).body.error).toMatch(/token or key/);
    expect((await create(dana, { auth: { type: 'bearer', secret: 'line\nbreak' } })).body.error).toMatch(/cannot be sent/);

    const first = await create(dana, { name: 'My Shop!' });
    const second = await create(dana, { name: 'my shop' });
    expect(first.body.server.slug).toBe('my_shop');
    expect(second.body.server.slug).toBe('my_shop2');
  });

  test('Connect & list tools stores the tools switched off, the era, and sensible confirmation defaults', async () => {
    const { body } = await create(dana);
    const connected = await request(app).post(`/api/mcp/${body.server._id}/connect`).set(as(dana));

    expect(connected.status).toBe(200);
    expect(connected.body.ok).toBe(true);
    expect(connected.body.summary).toEqual({ listed: 4, added: 4, changed: 0, missing: 0 });

    const server = connected.body.server;
    expect(server).toMatchObject({ status: 'connected', lastError: '', protocol: { era: 'modern', version: '2026-07-28' } });
    expect(server.warnings.join(' ')).toMatch(/bad_header/);
    expect(server.tools.every(tool => tool.enabled === false)).toBe(true);

    const lookup = server.tools.find(tool => tool.name === 'lookup_order');
    expect(lookup).toMatchObject({
      toolName: 'mcp_shop_lookup_order', readOnly: true, needsConfirmation: false, mode: 'automatic', problem: null,
      inputs: [{ name: 'order_id', type: 'string', description: 'The order number', required: true }]
    });
    expect(server.tools.find(tool => tool.name === 'refund.order')).toMatchObject({ readOnly: false, needsConfirmation: true });

    // The bearer token reached the server.
    expect(stub.requests[stub.requests.length - 1].headers.authorization).toBe('Bearer mcp_live_secret');
  });

  test('a failed connection is recorded plainly', async () => {
    const { body } = await create(dana, { url: `${base}/oauth/mcp` });
    const connected = await request(app).post(`/api/mcp/${body.server._id}/connect`).set(as(dana));
    expect(connected.body.ok).toBe(false);
    expect(connected.body.server.status).toBe('error');
    expect(connected.body.server.lastError).toMatch(/OAuth sign-in/);
  });

  test('tool switches are saved and checked', async () => {
    const { body } = await create(dana);
    const id = body.server._id;
    await request(app).post(`/api/mcp/${id}/connect`).set(as(dana));

    const on = await request(app).put(`/api/mcp/${id}/tools/refund.order`).set(as(dana))
      .send({ enabled: true, mode: 'workflow_only', verifiedOnly: true, needsConfirmation: false });
    expect(on.status).toBe(200);
    expect(on.body.tool).toMatchObject({ enabled: true, mode: 'workflow_only', verifiedOnly: true, needsConfirmation: false });

    expect((await request(app).put(`/api/mcp/${id}/tools/refund.order`).set(as(dana)).send({ mode: 'sometimes' })).status).toBe(400);
    expect((await request(app).put(`/api/mcp/${id}/tools/refund.order`).set(as(dana)).send({ enabled: 'yes' })).status).toBe(400);
    expect((await request(app).put(`/api/mcp/${id}/tools/nope`).set(as(dana)).send({ enabled: true })).status).toBe(404);

    const entry = await eventually(() => AuditLog.findOne({ action: 'mcp.tool_updated', 'target.id': id }).lean());
    expect(entry.details).toMatchObject({ tool: 'refund.order', enabled: true });
  });

  test('switched-on tools count against the actions limit together with saved actions', async () => {
    await Action.create({
      company: limited._id, name: 'order_status', title: 'Order status', description: 'Look up',
      request: { method: 'GET', url: 'https://api.example.com/orders' }
    });
    const { body } = await create(bob);
    const id = body.server._id;
    await request(app).post(`/api/mcp/${id}/connect`).set(as(bob));

    // One action + one tool = 2, the limit.
    const first = await request(app).put(`/api/mcp/${id}/tools/lookup_order`).set(as(bob)).send({ enabled: true });
    expect(first.status).toBe(200);

    const second = await request(app).put(`/api/mcp/${id}/tools/search`).set(as(bob)).send({ enabled: true });
    expect(second.status).toBe(402);
    expect(second.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', meter: 'actions', limit: 2, used: 2 });
    expect(second.body.error).toMatch(/actions and connected tools together/);

    // Switching one off frees the place; other settings never need it.
    expect((await request(app).put(`/api/mcp/${id}/tools/lookup_order`).set(as(bob)).send({ enabled: false })).status).toBe(200);
    expect((await request(app).put(`/api/mcp/${id}/tools/search`).set(as(bob)).send({ enabled: true })).status).toBe(200);
    expect((await request(app).put(`/api/mcp/${id}/tools/lookup_order`).set(as(bob)).send({ verifiedOnly: true })).status).toBe(200);
  });

  test('a plan that does not include actions does not include MCP either', async () => {
    await Subscription.updateOne({ company: limited._id }, { $set: { status: 'suspended' } });
    usageService.invalidateSubscription(limited._id);
    try {
      const response = await request(app).get('/api/mcp').set(as(bob));
      expect(response.status).toBe(402);
      expect(response.body.code).toBe('FEATURE_NOT_IN_PLAN');
    } finally {
      await Subscription.updateOne({ company: limited._id }, { $set: { status: 'active' } });
      usageService.invalidateSubscription(limited._id);
    }
  });

  test('a saved token goes only to the address it was saved for', async () => {
    const { body } = await create(dana);
    const id = body.server._id;
    await request(app).post(`/api/mcp/${id}/connect`).set(as(dana));

    const moved = await request(app).put(`/api/mcp/${id}`).set(as(dana)).send({ url: 'https://attacker.example/mcp' });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/Enter the credential again/);

    // A rename changes nothing that matters to the connection.
    const renamed = await request(app).put(`/api/mcp/${id}`).set(as(dana)).send({ name: 'Shop EU' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.reconnect).toBe(false);
    expect(renamed.body.server.slug).toBe('shop');

    // Another path on the same server keeps the token, but needs a reconnect.
    const samePlace = await request(app).put(`/api/mcp/${id}`).set(as(dana)).send({ url: `${base}/modern-sse/mcp` });
    expect(samePlace.status).toBe(200);
    expect(samePlace.body).toMatchObject({ reconnect: true, server: { auth: { hasSecret: true } } });

    const withToken = await request(app).put(`/api/mcp/${id}`).set(as(dana))
      .send({ url: 'https://mcp.example.com/mcp', auth: { type: 'bearer', secret: 'new_token' } });
    expect(withToken.status).toBe(200);
    expect(withToken.body).toMatchObject({ reconnect: true, server: { status: 'new', protocol: null } });
    // Tool settings survive a move; the next refresh decides what is still there.
    expect(withToken.body.server.tools).toHaveLength(4);
  });

  test('one tenant cannot see, change, connect or remove another\'s server', async () => {
    const { body } = await create(dana);
    const id = body.server._id;

    expect((await request(app).get('/api/mcp').set(as(rex))).body.servers).toEqual([]);
    expect((await request(app).put(`/api/mcp/${id}`).set(as(rex)).send({ name: 'Mine' })).status).toBe(404);
    expect((await request(app).post(`/api/mcp/${id}/connect`).set(as(rex))).status).toBe(404);
    expect((await request(app).put(`/api/mcp/${id}/tools/lookup_order`).set(as(rex)).send({ enabled: true })).status).toBe(404);
    expect((await request(app).delete(`/api/mcp/${id}`).set(as(rex))).status).toBe(404);
    expect(await McpServer.countDocuments({ _id: id })).toBe(1);
  });

  test('operators cannot manage servers', async () => {
    expect((await request(app).get('/api/mcp').set(as(alice))).status).toBe(403);
    expect((await create(alice)).status).toBe(403);
  });

  test('removing a server deletes it', async () => {
    const { body } = await create(dana);
    const removed = await request(app).delete(`/api/mcp/${body.server._id}`).set(as(dana));
    expect(removed.status).toBe(200);
    expect(await McpServer.countDocuments({ _id: body.server._id })).toBe(0);
  });

  describe('refresh', () => {
    const tool = (name, extra = {}) => ({
      name, title: '', description: `${name} does things`, inputSchema: '{"type":"object"}',
      readOnlyHint: false, destructiveHint: true, ...extra
    });

    test('keeps switches, adds new tools off, flags changes, and keeps missing tools as unavailable', () => {
      const now = new Date();
      const existing = [
        { ...tool('kept'), enabled: true, mode: 'automatic', verifiedOnly: true, needsConfirmation: true, available: true },
        { ...tool('reworded'), enabled: true, needsConfirmation: true, available: true },
        { ...tool('reader', { readOnlyHint: true }), enabled: true, needsConfirmation: false, available: true },
        { ...tool('gone'), enabled: true, needsConfirmation: true, available: true }
      ];
      const fresh = [
        tool('kept'),
        tool('reworded', { description: 'Now does something else' }),
        tool('reader', { readOnlyHint: false }),
        tool('brand_new', { readOnlyHint: true })
      ];

      const { tools, added, changed, missing } = mergeTools(existing, fresh, now);
      const byName = Object.fromEntries(tools.map(entry => [entry.name, entry]));

      expect({ added, changed, missing }).toEqual({ added: 1, changed: 1, missing: 1 });
      expect(byName.kept).toMatchObject({ enabled: true, verifiedOnly: true, available: true });
      expect(byName.kept.changedAt).toBeUndefined();
      expect(byName.reworded).toMatchObject({ enabled: true, description: 'Now does something else', changedAt: now });
      // It no longer says it only reads, so it asks again.
      expect(byName.reader).toMatchObject({ needsConfirmation: true, readOnlyHint: false, changedAt: now });
      expect(byName.brand_new).toMatchObject({ enabled: false, needsConfirmation: false });
      expect(byName.gone).toMatchObject({ enabled: true, available: false });
    });
  });
});
