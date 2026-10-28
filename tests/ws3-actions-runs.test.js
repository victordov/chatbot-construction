/**
 * Actions: "Run once" tries the form as it stands rather than the saved copy,
 * the saved secret only ever goes to the saved address, and each action has a
 * log of its last calls - from the assistant, a workflow or the test panel.
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
const actions = require('../services/actions');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/actions', require('../routes/actions'));
  return app;
};

describe('running actions', () => {
  let app;
  let acme;
  let rival;
  let danaToken;
  let rexToken;
  let server;
  let base;
  let received;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;
  const as = token => ({ 'x-auth-token': token });

  const definition = (overrides = {}) => ({
    name: 'order_lookup',
    title: 'Order lookup',
    description: 'Look up an order when the visitor asks where it is.',
    inputs: [{ name: 'order_id', source: 'visitor', required: true }],
    request: {
      method: 'GET',
      url: `${base}/orders/{{order_id}}`,
      auth: { type: 'bearer', value: 'sk_saved_secret' }
    },
    response: { mode: 'paths', outputs: [{ name: 'status', path: 'order.status' }] },
    ...overrides
  });

  /** The form as the dashboard sends it: no secret unless one was typed. */
  const form = (overrides = {}) => {
    const body = definition(overrides);
    return { ...body, request: { ...body.request, auth: { type: body.request.auth.type, ...(overrides.secret ? { value: overrides.secret } : {}) } } };
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    process.env.SECRETS_KEY = 'test-secrets-key-for-the-ws3-actions-suite';
    secrets.resetForTests();

    acme = await Company.create({ name: 'WS3 Actions Acme' });
    rival = await Company.create({ name: 'WS3 Actions Rival' });
    await User.create({
      username: 'ws3a-dana', email: 'dana@ws3a.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Dana', company: acme._id
    });
    await User.create({
      username: 'ws3a-rex', email: 'rex@ws3a.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Rex', company: rival._id
    });
    danaToken = await login('ws3a-dana');
    rexToken = await login('ws3a-rex');

    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ order: { status: 'shipped' } }));
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
      User.deleteMany({ email: /@ws3a\.example$/ }),
      Company.deleteMany({ _id: { $in: [acme._id, rival._id] } }),
      Action.deleteMany({ company: { $in: [acme._id, rival._id] } }),
      AuditLog.deleteMany({ company: { $in: [acme._id, rival._id] } })
    ]);
  });

  beforeEach(async () => {
    await Action.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await AuditLog.deleteMany({ company: { $in: [acme._id, rival._id] } });
    received = null;
  });

  const save = async (overrides = {}) => {
    const response = await request(app).post('/api/actions').set(as(danaToken)).send(definition(overrides));
    expect(response.status).toBe(201);
    return response.body.action;
  };

  const runOnce = (id, body, token = danaToken) => request(app)
    .post(id ? `/api/actions/${id}/test` : '/api/actions/test')
    .set(as(token))
    .send(body);

  describe('Run once', () => {
    test('calls what the form says now, not what was saved', async () => {
      const action = await save();

      const response = await runOnce(action._id, {
        inputs: { order_id: '7' },
        config: form({ request: { method: 'GET', url: `${base}/v2/orders/{{order_id}}`, auth: { type: 'none' } } })
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.method).toBe('GET');
      expect(received.url).toBe('/v2/orders/7');
      expect(received.headers.authorization).toBeUndefined();
      expect(response.body.extracted).toEqual({ status: 'shipped' });

      // Nothing was saved by trying it.
      const stored = await Action.findById(action._id).lean();
      expect(stored.request.url).toBe(`${base}/orders/{{order_id}}`);
    });

    test('sends the method in the form', async () => {
      const action = await save();

      const response = await runOnce(action._id, {
        inputs: { order_id: '8' },
        config: form({ request: { method: 'POST', url: `${base}/orders/{{order_id}}`, body: '{"id": "{{order_id}}"}', auth: { type: 'bearer' } } })
      });

      expect(response.status).toBe(200);
      expect(response.body.method).toBe('POST');
      expect(received.method).toBe('POST');
      expect(JSON.parse(received.body)).toEqual({ id: '8' });
    });

    test('uses the saved secret only with the saved address', async () => {
      const action = await save();

      const same = await runOnce(action._id, { inputs: { order_id: '1' }, config: form() });
      expect(same.body.error).toBeUndefined();
      expect(same.status).toBe(200);
      expect(received.headers.authorization).toBe('Bearer sk_saved_secret');

      received = null;
      const moved = await runOnce(action._id, {
        inputs: { order_id: '1' },
        config: form({ request: { method: 'GET', url: `${base}/elsewhere/{{order_id}}`, auth: { type: 'bearer' } } })
      });
      expect(moved.status).toBe(400);
      expect(moved.body.error).toMatch(/address has changed/);
      expect(received).toBeNull();

      const retyped = await runOnce(action._id, {
        inputs: { order_id: '1' },
        config: form({ secret: 'sk_typed_now', request: { method: 'GET', url: `${base}/elsewhere/{{order_id}}`, auth: { type: 'bearer' } } })
      });
      expect(retyped.status).toBe(200);
      expect(received.headers.authorization).toBe('Bearer sk_typed_now');
      expect(JSON.stringify(retyped.body)).not.toContain('sk_');
    });

    test('an action never saved can be tried, and is not logged against anything', async () => {
      const response = await runOnce(null, {
        inputs: { order_id: '3' },
        config: form({ name: '', title: '', request: { method: 'GET', url: `${base}/orders/{{order_id}}`, auth: { type: 'none' } } })
      });

      expect(response.status).toBe(200);
      expect(received.url).toBe('/orders/3');
      expect(await AuditLog.countDocuments({ company: acme._id, action: 'action.tested' })).toBe(0);
    });

    test('a form that would not save does not run', async () => {
      const response = await runOnce(null, {
        inputs: {},
        config: form({ request: { method: 'GET', url: 'ftp://example.com/x', auth: { type: 'none' } } })
      });
      expect(response.status).toBe(400);
      expect(received).toBeNull();
    });

    test('another company\'s action cannot be run', async () => {
      const action = await save();
      const response = await runOnce(action._id, { inputs: { order_id: '1' }, config: form() }, rexToken);
      expect(response.status).toBe(404);
      expect(received).toBeNull();
    });
  });

  describe('the run log', () => {
    const entry = (fields, minutesAgo) => ({
      company: acme._id,
      at: new Date(Date.now() - minutesAgo * 60 * 1000),
      ...fields
    });

    test('lists the last calls from every caller, newest first, with the last error', async () => {
      const action = await save();

      await AuditLog.create([
        entry({ action: 'assistant.tool_called', target: { type: 'conversation', label: 'order_lookup' },
          details: { tool: 'order_lookup', status: 'ok', httpStatus: 200, durationMs: 120 }, outcome: 'success' }, 5),
        entry({ action: 'action.run', target: { type: 'action', id: String(action._id) },
          details: { ok: false, httpStatus: 502, durationMs: 30, error: 'The API answered 502' }, outcome: 'failure' }, 4),
        entry({ action: 'action.tested', target: { type: 'action', id: String(action._id) },
          details: { ok: true, httpStatus: 200, durationMs: 80 } }, 3),
        // Someone else's tool, and another company's call to a tool of the same name.
        entry({ action: 'assistant.tool_called', details: { tool: 'something_else', status: 'error' } }, 2),
        { company: rival._id, action: 'assistant.tool_called', details: { tool: 'order_lookup', status: 'error' }, at: new Date() }
      ]);

      const response = await request(app).get(`/api/actions/${action._id}/runs`).set(as(danaToken));
      expect(response.status).toBe(200);

      const { runs, lastError } = response.body;
      expect(runs.map(run => run.by)).toEqual(['test', 'workflow', 'assistant']);
      expect(runs[0]).toMatchObject({ ok: true, httpStatus: 200, durationMs: 80 });
      expect(runs[1]).toMatchObject({ ok: false, httpStatus: 502, error: 'The API answered 502' });
      expect(runs[2]).toMatchObject({ ok: true, status: 'ok', httpStatus: 200, durationMs: 120 });
      expect(lastError).toMatchObject({ by: 'workflow', error: 'The API answered 502' });
    });

    test('shows twenty at most, and only to the action\'s own company', async () => {
      const action = await save();
      await AuditLog.create(Array.from({ length: 25 }, (_, index) => entry({
        action: 'assistant.tool_called', details: { tool: 'order_lookup', status: 'ok', durationMs: index }
      }, index)));

      const response = await request(app).get(`/api/actions/${action._id}/runs`).set(as(danaToken));
      expect(response.body.runs).toHaveLength(20);
      expect(response.body.lastError).toBeNull();

      expect((await request(app).get(`/api/actions/${action._id}/runs`).set(as(rexToken))).status).toBe(404);
    });

    test('Run once and a workflow run both write to it; a preview run does not', async () => {
      const action = await save();
      await runOnce(action._id, { inputs: { order_id: '1' }, config: form() });

      await actions.runForWorkflow(acme._id, action._id, { order_id: '2' });
      await actions.runForWorkflow(acme._id, action._id, { order_id: '3' }, { simulate: true });

      let runs = [];
      for (let attempt = 0; attempt < 50 && runs.length < 2; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        runs = (await request(app).get(`/api/actions/${action._id}/runs`).set(as(danaToken))).body.runs;
      }
      // Give a stray simulated entry the same chance to land.
      await new Promise(resolve => setTimeout(resolve, 50));
      runs = (await request(app).get(`/api/actions/${action._id}/runs`).set(as(danaToken))).body.runs;

      expect(runs.map(run => run.by).sort()).toEqual(['test', 'workflow']);
      expect(runs.every(run => run.ok)).toBe(true);
    });
  });
});
