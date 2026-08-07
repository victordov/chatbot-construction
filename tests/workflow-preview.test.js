/**
 * Trying a workflow before publishing it.
 *
 * The tests that matter are the ones about restraint: a preview that raises
 * real tasks, tags real conversations, emails a real team or POSTs to a live
 * API is worse than no preview, because an author testing a branch six times
 * leaves six of everything behind and stops testing.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const dns = require('dns');

const User = require('../models/user');
const Company = require('../models/company');
const Task = require('../models/task');
const Conversation = require('../models/conversation');
const safeHttp = require('../services/safe-http');
const emailChannel = require('../services/email-channel');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/workflows', require('../routes/workflow'));
  return app;
};

describe('Workflow preview', () => {
  let app;
  let acme;
  let dana;
  let danaToken;
  let server;
  let base;
  let hits;

  const persona = {
    id: 'p1', type: 'persona', position: { x: 0, y: 0 },
    data: { prompt: 'Be helpful' }
  };

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'Preview Acme' });
    dana = await User.create({
      username: 'preview-dana', email: 'dana@preview.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Dana Diaz', company: acme._id
    });
    danaToken = await login('preview-dana');

    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        hits.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'shipped' }));
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

    await Task.deleteMany({ company: acme._id });
    await Conversation.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@preview\.example$/ });
    await Company.deleteMany({ name: /^Preview / });
  });

  beforeEach(async () => {
    hits = [];
    await Task.deleteMany({ company: acme._id });
    jest.restoreAllMocks();
  });

  const preview = (body, token = danaToken) => request(app)
    .post('/api/workflows/preview')
    .set('x-auth-token', token)
    .send(body);

  describe('running the draft', () => {
    test('a graph that was never saved still runs', async () => {
      // The whole point: try what is on the canvas, including unsaved edits.
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Hello there.' } }],
        edges: [{ id: 'e1', source: 's1', target: 'r1' }],
        message: 'hi'
      });

      expect(response.status).toBe(200);
      expect(response.body.response).toBe('Hello there.');
    });

    test('the path taken comes back, so the canvas can light it up', async () => {
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Hi' } }],
        edges: [{ id: 'e1', source: 's1', target: 'r1' }],
        message: 'hi'
      });

      expect(response.body.path).toEqual(['s1', 'r1']);
    });

    test('a multi-turn flow carries state between turns', async () => {
      const graph = {
        nodes: [persona,
          { id: 'a1', type: 'ask', position: { x: 0, y: 0 },
            data: { question: 'Order number?', variable: 'order_id', validate: 'reference' } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 },
            data: { template: 'Checking {{order_id}}.' } }],
        edges: [{ id: 'e1', source: 'a1', target: 'r1', sourceHandle: 'next' }]
      };

      const first = await preview({ ...graph, message: 'where is my order' });
      expect(first.body.response).toBe('Order number?');

      const second = await preview({ ...graph, message: 'HC-1', state: first.body.state });
      expect(second.body.response).toBe('Checking HC-1.');
    });

    test('an invalid draft reports the problems rather than failing the request', async () => {
      // Being half-built is the normal state while building.
      const response = await preview({
        nodes: [{ id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
        message: 'hi'
      });

      expect(response.status).toBe(200);
      expect(response.body.invalid).toBe(true);
      expect(response.body.errors.join(' ')).toMatch(/Persona/);
    });

    test('an empty canvas says so', async () => {
      const response = await preview({ nodes: [], edges: [], message: 'hi' });
      expect(response.status).toBe(400);
    });

    test('an operator cannot run a preview', async () => {
      const alice = await User.create({
        username: 'preview-alice', email: 'alice@preview.example',
        password: 'TestPassword123!', role: 'operator', company: acme._id
      });
      const token = await login('preview-alice');

      const response = await preview({ nodes: [persona], edges: [], message: 'hi' }, token);

      expect(response.status).toBe(403);
      expect(alice.role).toBe('operator');
    });
  });

  describe('refusing to change anything', () => {
    test('a task node raises nothing', async () => {
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 't1', type: 'task', position: { x: 0, y: 0 },
            data: { title: 'Refund for {{order_id}}', priority: 'high' } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Done.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 't1' },
          { id: 'e2', source: 't1', target: 'r1' }
        ],
        message: 'hi',
        variables: { order_id: 'HC-9' }
      });

      expect(await Task.countDocuments({ company: acme._id })).toBe(0);
      expect(response.body.simulated[0].description).toMatch(/Raise a high task.*HC-9/);
      // The flow still carries on, so the branch after it can be tested.
      expect(response.body.response).toBe('Done.');
    });

    test('a task node still fills {{task_id}} so later steps render', async () => {
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 't1', type: 'task', position: { x: 0, y: 0 }, data: { title: 'Something' } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 },
            data: { template: 'Reference {{task_id}}.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 't1' },
          { id: 'e2', source: 't1', target: 'r1' }
        ],
        message: 'hi'
      });

      expect(response.body.response).toBe('Reference preview-task.');
    });

    test('a tag node tags nothing', async () => {
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'g1', type: 'tag', position: { x: 0, y: 0 }, data: { tags: ['refund'] } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Done.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 'g1' },
          { id: 'e2', source: 'g1', target: 'r1' }
        ],
        message: 'hi'
      });

      expect(response.body.simulated[0].description).toMatch(/Tag the conversation: refund/);
      expect(await Conversation.countDocuments({ company: acme._id })).toBe(0);
    });

    test('a notify node sends nothing', async () => {
      const sendMail = jest.fn();
      jest.spyOn(emailChannel, 'buildTransport').mockReturnValue({ sendMail });

      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'n1', type: 'notify', position: { x: 0, y: 0 },
            data: { to: 'team@example.com', subject: 'Complaint', body: 'x' } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Done.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 'n1' },
          { id: 'e2', source: 'n1', target: 'r1' }
        ],
        message: 'hi'
      });

      expect(sendMail).not.toHaveBeenCalled();
      expect(response.body.simulated[0].description).toMatch(/Email team@example.com/);
    });

    test('a GET is really performed, so the branches are tested with real data', async () => {
      // The reads are what make a preview worth having: the condition after
      // this is being tested against what the API actually returns.
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'a1', type: 'action', position: { x: 0, y: 0 },
            data: { url: `${base}/orders/1`, method: 'GET',
              outputs: [{ variable: 'order_status', path: 'status' }] } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 },
            data: { template: 'It is {{order_status}}.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 'a1' },
          { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' }
        ],
        message: 'hi'
      });

      expect(hits).toHaveLength(1);
      expect(response.body.response).toBe('It is shipped.');
    });

    test.each(['POST', 'PUT', 'PATCH', 'DELETE'])('a %s is refused', async method => {
      // Testing a branch six times must not issue six refunds.
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'a1', type: 'action', position: { x: 0, y: 0 },
            data: { url: `${base}/refund`, method, body: '{"amount": 100}' } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Done.' } }],
        edges: [
          { id: 'e1', source: 's1', target: 'a1' },
          { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' }
        ],
        message: 'hi'
      });

      expect(hits).toHaveLength(0);
      expect(response.body.simulated[0].description).toMatch(new RegExp(`Send ${method}`));
      // Reported as success so the author is testing the branch they meant to.
      expect(response.body.response).toBe('Done.');
    });

    test('reaching a handover is reported rather than looking like silence', async () => {
      const response = await preview({
        nodes: [persona,
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          { id: 'h1', type: 'operator-handoff', position: { x: 0, y: 0 },
            data: { message: 'Getting a colleague.' } }],
        edges: [{ id: 'e1', source: 's1', target: 'h1' }],
        message: 'hi'
      });

      expect(response.body.simulated[0].description).toMatch(/Hand the conversation/);
      expect(response.body.escalation).toBeTruthy();
    });

    test('a live run is untouched by any of this', async () => {
      // The safety only applies to previews; the same graph run for real must
      // still do its job.
      const WorkflowCompilerService = require('../services/workflow-compiler');
      const compiler = new WorkflowCompilerService();

      const compiled = await compiler.compileWorkflow([persona,
        { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: {} },
        { id: 'a1', type: 'action', position: { x: 0, y: 0 },
          data: { url: `${base}/orders/1`, method: 'POST', body: '{}' } },
        { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { template: 'Done.' } }],
      [{ id: 'e1', source: 's1', target: 'a1' },
        { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' }],
      String(acme._id));

      await compiler.executeWorkflow(compiled.compiledChain, 'hi');

      expect(hits).toHaveLength(1);
      expect(hits[0].method).toBe('POST');
    });
  });
});
