/**
 * Saved Actions: the routes, the credential, and workflows using them.
 *
 * The things that would be a real problem if they regressed: a credential
 * coming back out of the API, one tenant reading or running another's action,
 * and "unchanged" on an update quietly wiping the key.
 */

const http = require('http');
const dns = require('dns');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Action = require('../models/action');
const AuditLog = require('../models/audit-log');
const Subscription = require('../models/subscription');
const actions = require('../services/actions');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const usageService = require('../services/usage');
const WorkflowCompilerService = require('../services/workflow-compiler');
const eventually = require('./eventually');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/actions', require('../routes/actions'));
  return app;
};

describe('Actions', () => {
  let app;
  let acme;
  let rival;
  let basicCo;
  let danaToken;
  let rexToken;
  let aliceToken;
  let bobToken;
  let rootToken;

  let server;
  let base;
  let received;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const orderAction = (overrides = {}) => ({
    name: 'order_status',
    title: 'Order status',
    description: 'Look up an order by its number when the visitor asks where it is.',
    inputs: [
      { name: 'order_id', type: 'string', required: true, source: 'visitor', description: 'The order number' },
      { name: 'region', source: 'constant', value: 'eu' }
    ],
    request: {
      method: 'GET',
      url: `${base}/orders/{{order_id}}?region={{region}}`,
      auth: { type: 'bearer', value: 'sk_live_super_secret' }
    },
    response: { mode: 'paths', outputs: [{ name: 'status', path: 'order.status' }] },
    ...overrides
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    process.env.SECRETS_KEY = 'test-secrets-key-for-the-actions-suite';
    secrets.resetForTests();

    acme = await Company.create({ name: 'Action Acme' });
    rival = await Company.create({ name: 'Action Rival' });
    basicCo = await Company.create({ name: 'Action Basic' });
    await Subscription.create({ company: basicCo._id, planId: 'basic', status: 'active' });
    usageService.invalidateSubscription(basicCo._id);

    const make = (username, role, company) => User.create({
      username, email: `${username}@actions.example`, password: 'TestPassword123!',
      role, displayName: username, company: company ? company._id : undefined
    });

    await make('act-dana', 'company_admin', acme);
    await make('act-rex', 'company_admin', rival);
    await make('act-alice', 'operator', acme);
    await make('act-bob', 'company_admin', basicCo);
    await make('act-root', 'superadmin', null);

    danaToken = await login('act-dana');
    rexToken = await login('act-rex');
    aliceToken = await login('act-alice');
    bobToken = await login('act-bob');
    rootToken = await login('act-root');

    // A stub API on loopback, which the address guard exists to block — so
    // the guard is replaced here rather than weakened, as the workflow action
    // and webhook suites do.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
          if (req.url.startsWith('/orders/missing')) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end('{"error":"not found"}');
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ order: { status: 'shipped', email: 'someone@example.com' }, padding: 'x'.repeat(6000) }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        base = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    await new Promise(resolve => server.close(resolve));
    await Promise.all([
      User.deleteMany({ username: /^act-/ }),
      Company.deleteMany({ _id: { $in: [acme._id, rival._id, basicCo._id] } }),
      Action.deleteMany({}),
      Subscription.deleteMany({ company: { $in: [acme._id, rival._id, basicCo._id] } })
    ]);
  });

  beforeEach(async () => {
    await Action.deleteMany({});
    received = null;
  });

  const create = (token, body) => request(app)
    .post('/api/actions')
    .set('x-auth-token', token)
    .send(body);

  describe('CRUD and the credential', () => {
    test('creating returns the action without its credential', async () => {
      const response = await create(danaToken, orderAction());

      expect(response.status).toBe(201);
      const { action } = response.body;
      expect(action).toMatchObject({
        name: 'order_status',
        title: 'Order status',
        mode: 'auto',
        requiresVerified: false,
        enabled: true,
        isWrite: false,
        request: { method: 'GET', auth: { type: 'bearer', hasCredential: true } },
        response: { mode: 'paths', maxBytes: 4000, outputs: [{ name: 'status', path: 'order.status' }] }
      });
      expect(JSON.stringify(response.body)).not.toContain('sk_live_super_secret');
      expect(action.request.auth.value).toBeUndefined();

      // Encrypted at rest.
      const stored = await Action.findById(action._id).select('+request.auth.value').lean();
      expect(stored.request.auth.value).toMatch(/^enc:v1:/);
      expect(secrets.decrypt(stored.request.auth.value)).toBe('sk_live_super_secret');
    });

    test('listing never carries the credential', async () => {
      await create(danaToken, orderAction());
      const response = await request(app).get('/api/actions').set('x-auth-token', danaToken);

      expect(response.status).toBe(200);
      expect(response.body.actions).toHaveLength(1);
      expect(response.body.actions[0].request.auth.hasCredential).toBe(true);
      expect(JSON.stringify(response.body)).not.toMatch(/sk_live|enc:v1/);
    });

    test('an update without a credential keeps the stored one; a new one replaces it', async () => {
      const { body } = await create(danaToken, orderAction());
      const id = body.action._id;

      const kept = await request(app).put(`/api/actions/${id}`)
        .set('x-auth-token', danaToken)
        .send({ title: 'Where is my order', request: { auth: { type: 'bearer', value: '' } } });
      expect(kept.status).toBe(200);
      expect(kept.body.action.title).toBe('Where is my order');
      expect(kept.body.action.request.auth.hasCredential).toBe(true);
      // Fields not sent are untouched.
      expect(kept.body.action.request.url).toContain('/orders/{{order_id}}');

      let stored = await Action.findById(id).select('+request.auth.value').lean();
      expect(secrets.decrypt(stored.request.auth.value)).toBe('sk_live_super_secret');

      await request(app).put(`/api/actions/${id}`)
        .set('x-auth-token', danaToken)
        .send({ request: { auth: { type: 'bearer', value: 'sk_rotated' } } });
      stored = await Action.findById(id).select('+request.auth.value').lean();
      expect(secrets.decrypt(stored.request.auth.value)).toBe('sk_rotated');

      // Switching auth off removes it.
      const off = await request(app).put(`/api/actions/${id}`)
        .set('x-auth-token', danaToken)
        .send({ request: { auth: { type: 'none' } } });
      expect(off.body.action.request.auth.hasCredential).toBe(false);
    });

    test('bad definitions are refused with a reason', async () => {
      const cases = [
        orderAction({ name: 'Bad Name!' }),
        orderAction({ name: 'connector_catalog' }),
        orderAction({ request: { method: 'GET', url: 'https://169.254.169.254/latest' } }),
        orderAction({ request: { method: 'GET', url: 'https://api.example.com', headers: { Authorization: 'Bearer x' } } }),
        orderAction({ inputs: [{ name: 'who', source: 'verified', attribute: 'password' }] })
      ];

      for (const body of cases) {
        const response = await create(danaToken, body);
        expect(response.status).toBe(400);
        expect(response.body.error).toBeTruthy();
      }
    });

    test('names are unique per company, not across companies', async () => {
      expect((await create(danaToken, orderAction())).status).toBe(201);
      expect((await create(danaToken, orderAction())).status).toBe(409);
      expect((await create(rexToken, orderAction())).status).toBe(201);
    });

    test('create, update and delete are audited without the credential', async () => {
      const { body } = await create(danaToken, orderAction());
      await request(app).put(`/api/actions/${body.action._id}`)
        .set('x-auth-token', danaToken).send({ enabled: false });
      await request(app).delete(`/api/actions/${body.action._id}`)
        .set('x-auth-token', danaToken);

      // Audit writes are fire-and-forget.
      const entries = await eventually(async () => {
        const found = await AuditLog.find({ 'target.id': String(body.action._id) }).lean();
        return found.length >= 3 && found;
      });
      expect(entries.map(entry => entry.action).sort())
        .toEqual(['action.created', 'action.deleted', 'action.updated']);
      expect(JSON.stringify(entries)).not.toContain('sk_live_super_secret');
      expect(await Action.countDocuments({ _id: body.action._id })).toBe(0);
    });
  });

  describe('who may', () => {
    test('operators cannot manage actions', async () => {
      const response = await create(aliceToken, orderAction());
      expect(response.status).toBe(403);
    });

    test('a plan with no actions left is refused', async () => {
      // Basic includes a few actions now (the trial teaches people to rely on
      // them), so the refusal is the allowance running out rather than the
      // feature being absent.
      await Subscription.updateOne({ company: basicCo._id }, { $set: { limitOverrides: { actions: 0 } } });
      usageService.invalidateSubscription(basicCo._id);

      try {
        const response = await create(bobToken, orderAction());
        expect(response.status).toBe(402);
        expect(response.body.code).toBe('PLAN_LIMIT_REACHED');
      } finally {
        await Subscription.updateOne({ company: basicCo._id }, { $unset: { limitOverrides: 1 } });
        usageService.invalidateSubscription(basicCo._id);
      }
    });

    test('one tenant cannot see, change, run or delete another\'s action', async () => {
      const { body } = await create(danaToken, orderAction());
      const id = body.action._id;
      const as = token => ({ 'x-auth-token': token });

      expect((await request(app).get('/api/actions').set(as(rexToken))).body.actions).toHaveLength(0);
      expect((await request(app).get(`/api/actions/${id}`).set(as(rexToken))).status).toBe(404);
      expect((await request(app).put(`/api/actions/${id}`).set(as(rexToken)).send({ title: 'x' })).status).toBe(404);
      expect((await request(app).post(`/api/actions/${id}/test`).set(as(rexToken)).send({ inputs: { order_id: '1' } })).status).toBe(404);
      expect((await request(app).delete(`/api/actions/${id}`).set(as(rexToken))).status).toBe(404);
      expect(received).toBeNull();
      expect(await Action.countDocuments({ _id: id })).toBe(1);
    });

    test('a superadmin names the company', async () => {
      const without = await create(rootToken, orderAction());
      expect(without.status).toBe(400);

      const withCompany = await create(rootToken, { ...orderAction(), companyId: String(acme._id) });
      expect(withCompany.status).toBe(201);

      const listed = await request(app).get(`/api/actions?companyId=${acme._id}`)
        .set('x-auth-token', rootToken);
      expect(listed.body.actions).toHaveLength(1);
    });
  });

  describe('the test panel', () => {
    test('runs the action once and returns status, a truncated body and the extracted values', async () => {
      const { body } = await create(danaToken, orderAction());

      const response = await request(app).post(`/api/actions/${body.action._id}/test`)
        .set('x-auth-token', danaToken)
        .send({ inputs: { order_id: 'A 1/2' } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 200, ok: true, extracted: { status: 'shipped' }, truncated: true });
      expect(response.body.body.length).toBeLessThanOrEqual(4000);

      // Templated, encoded, authenticated.
      expect(received.url).toBe('/orders/A%201%2F2?region=eu');
      expect(received.headers.authorization).toBe('Bearer sk_live_super_secret');
      expect(JSON.stringify(response.body)).not.toContain('sk_live_super_secret');
    });

    test('a failing API is reported, not thrown', async () => {
      const { body } = await create(danaToken, orderAction());
      const response = await request(app).post(`/api/actions/${body.action._id}/test`)
        .set('x-auth-token', danaToken)
        .send({ inputs: { order_id: 'missing' } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 404, ok: false });
      expect(response.body.error).toMatch(/404/);
    });

    test('a missing required input is a 400', async () => {
      const { body } = await create(danaToken, orderAction());
      const response = await request(app).post(`/api/actions/${body.action._id}/test`)
        .set('x-auth-token', danaToken)
        .send({ inputs: {} });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/order_id/);
    });
  });

  describe('presets', () => {
    test('the five editor presets come back as valid action templates', async () => {
      const response = await request(app).get('/api/actions/presets').set('x-auth-token', danaToken);

      expect(response.status).toBe(200);
      const ids = response.body.presets.map(preset => preset.id);
      expect(ids).toEqual(['shopify-order', 'stripe-subscription', 'zendesk-ticket', 'slack-notify', 'hubspot-contact']);

      response.body.presets.forEach(preset => {
        expect(preset.note).toBeTruthy();
        const normalised = actions.normalise(preset.action);
        expect(normalised.errors).toEqual([]);
        expect(normalised.value.inputs.length).toBeGreaterThan(0);
      });

      // Account lookups read the identifier from the verified contact.
      const stripe = response.body.presets.find(preset => preset.id === 'stripe-subscription').action;
      expect(stripe.requiresVerified).toBe(true);
      expect(stripe.inputs[0]).toMatchObject({ source: 'verified', attribute: 'externalId' });
    });

    test('a preset can be saved as it is', async () => {
      const preset = actions.PRESETS.find(entry => entry.id === 'zendesk-ticket');
      const response = await create(danaToken, preset.action);
      expect(response.status).toBe(201);
      expect(response.body.action.isWrite).toBe(true);
    });
  });

  describe('workflows can use a saved action', () => {
    test('an action node with actionId runs the saved request', async () => {
      const { body } = await create(danaToken, orderAction());

      const compiler = new WorkflowCompilerService();
      // The editor's check only needs the reference; the URL lives on the action.
      expect(compiler.validateActionNode({ id: 'lookup', data: { actionId: body.action._id } })).toEqual([]);
      expect(compiler.validateActionNode({ id: 'lookup', data: { actionId: 'nope' } })).toHaveLength(1);

      // The compiled shape the executor consumes, built by hand as the
      // workflow action suite does.
      const chain = tenantId => ({
        tenantId,
        entryPoint: 'lookup',
        prompts: { moderation: { enabled: false } },
        knowledge: { sources: [] },
        routing: { conditions: [], fallback: null },
        steps: {
          lookup: {
            type: 'action',
            data: { label: 'Lookup', actionId: body.action._id },
            next: [{ target: 'ok', handle: 'success' }, { target: 'bad', handle: 'error' }]
          },
          ok: { type: 'response', data: { template: 'Your order is {{status}}.' }, next: [] },
          bad: { type: 'response', data: { template: 'Could not check.' }, next: [] }
        }
      });

      const result = await compiler.executeWorkflow(chain(String(acme._id)), 'where is order 42?', [], {
        variables: { order_id: '42' }
      });

      expect(result.response).toBe('Your order is shipped.');
      expect(received.url).toBe('/orders/42?region=eu');

      // Another tenant's flow cannot reach it by id.
      const refused = await compiler.executeWorkflow(chain(String(rival._id)), 'hi', [], { variables: { order_id: '42' } });
      expect(refused.response).toBe('Could not check.');
    });

    test('a saved action that needs a verified customer fails down the error branch for an unverified one', async () => {
      const result = await actions.runForWorkflow(String(acme._id), (await Action.create({
        company: acme._id, name: 'acct', title: 'Account', requiresVerified: true,
        request: { method: 'GET', url: `${base}/orders/1` }
      }))._id, { contact_verified: 'false' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/verified/);
      expect(received).toBeNull();
    });
  });
});
