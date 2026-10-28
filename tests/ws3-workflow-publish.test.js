/**
 * Publishing workflows that do not hijack the bot: several live at once,
 * each with a trigger; one "always" at most; drafts that do not go live on
 * Save; unpublish; the live-workflow plan limit; and the ids that reach the
 * editor's HTML.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const Workflow = require('../models/workflow');
const WorkflowVersion = require('../models/workflow-version');
const runtimeRegistry = require('../services/runtime-registry');
const assistantConfig = require('../services/assistant-config');
const usageService = require('../services/usage');
const reply = require('../services/reply');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/workflows', require('../routes/workflow'));
  app.use('/api/workflow-execution', require('../routes/workflow-execution'));
  return app;
};

const persona = (extra = {}) => ({
  id: 'p1', type: 'persona', position: { x: 0, y: 0 }, data: { type: 'persona', prompt: 'You are the Wsp bot.', ...extra }
});

/** Start → Fixed Reply saying `text`: the smallest complete workflow. */
const replyGraph = text => ({
  nodes: [
    persona(),
    { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start' } },
    { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { type: 'response', template: text } }
  ],
  edges: [{ id: 'e1', source: 's1', target: 'r1' }]
});

describe('publishing workflows (WS3)', () => {
  let app;
  let pro;
  let trial;
  let admin;
  let trialAdmin;
  let operator;
  let token;
  let trialToken;
  let operatorToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const api = (method, url, body, as = token) => request(app)[method](url).set('x-auth-token', as).send(body);

  const create = async (name, graph, trigger, as = token) => {
    const response = await api('post', '/api/workflows', { name, ...graph, trigger }, as);
    expect(response.status).toBe(201);
    return response.body.workflow;
  };

  const cleanUp = async () => {
    const companies = await Company.find({ name: /^Wsp / }).select('_id');
    const ids = companies.map(company => company._id);
    const workflows = await Workflow.find({ company: { $in: ids } }).select('_id');
    await WorkflowVersion.deleteMany({ workflowId: { $in: workflows.map(w => w._id) } });
    await Workflow.deleteMany({ company: { $in: ids } });
    await Subscription.deleteMany({ company: { $in: ids } });
    await User.deleteMany({ email: /@wsp\.example$/ });
    await Company.deleteMany({ _id: { $in: ids } });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    await cleanUp();

    pro = await Company.create({ name: 'Wsp Pro' });
    trial = await Company.create({ name: 'Wsp Trial' });
    await Subscription.create({ company: pro._id, planId: 'professional', status: 'active' });
    usageService.invalidateSubscription(pro._id);

    admin = await User.create({
      username: 'wsp-admin', email: 'admin@wsp.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Wsp Admin', company: pro._id
    });
    trialAdmin = await User.create({
      username: 'wsp-trial', email: 'trial@wsp.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Wsp Trial', company: trial._id
    });
    operator = await User.create({
      username: 'wsp-operator', email: 'operator@wsp.example', password: 'TestPassword123!',
      role: 'operator', displayName: 'Wsp Operator', company: pro._id
    });
    token = await login('wsp-admin');
    trialToken = await login('wsp-trial');
    operatorToken = await login('wsp-operator');
    void admin;
    void trialAdmin;
    void operator;
  });

  afterAll(async () => {
    runtimeRegistry.reset();
    await cleanUp();
  });

  beforeEach(async () => {
    runtimeRegistry.reset();
    assistantConfig.invalidate();
    await Workflow.deleteMany({ company: { $in: [pro._id, trial._id] } });
  });

  describe('several live at once', () => {
    test('publishing one no longer archives the others', async () => {
      const orders = await create('Wsp orders', replyGraph('Orders here'), { type: 'intent', description: 'where is my order' });
      const refunds = await create('Wsp refunds', replyGraph('Refunds here'), { type: 'keywords', keywords: ['refund'] });

      expect((await api('post', `/api/workflows/${orders._id}/publish`)).status).toBe(200);
      expect((await api('post', `/api/workflows/${refunds._id}/publish`)).status).toBe(200);

      const live = await Workflow.find({ company: pro._id, status: 'published' });
      expect(live.map(w => w.name).sort()).toEqual(['Wsp orders', 'Wsp refunds']);
      expect(live.every(w => w.liveVersion === w.version)).toBe(true);
      expect(String(live[0].publishedBy)).toBe(String(admin._id));

      const list = await api('get', '/api/workflows');
      expect(list.body.liveUsage).toEqual({ used: 2, limit: 10 });
      const row = list.body.workflows.find(w => w.name === 'Wsp refunds');
      expect(row.liveTrigger).toEqual({ type: 'keywords', description: '', keywords: ['refund'] });
      expect(row.publishedBy.displayName).toBe('Wsp Admin');
    });

    test('a second "always" workflow is refused with the first named, and replace swaps them', async () => {
      const first = await create('Wsp front desk', replyGraph('Desk'), { type: 'always' });
      const second = await create('Wsp new desk', replyGraph('New desk'));

      expect((await api('post', `/api/workflows/${first._id}/publish`)).status).toBe(200);

      const refused = await api('post', `/api/workflows/${second._id}/publish`);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'ALWAYS_CONFLICT',
        conflict: { id: String(first._id), name: 'Wsp front desk' }
      });
      expect((await Workflow.findById(second._id)).status).toBe('draft');

      const replaced = await api('post', `/api/workflows/${second._id}/publish`, { replace: true });
      expect(replaced.status).toBe(200);
      expect(replaced.body.replaced).toEqual({ id: String(first._id), name: 'Wsp front desk' });

      const old = await Workflow.findById(first._id);
      expect(old.status).toBe('draft');
      expect(old.liveVersion).toBeUndefined();

      // The runtime serves only the new one.
      const served = await runtimeRegistry.getRuntimeService().ensureWorkflowsLoaded(String(pro._id));
      expect(served.map(entry => String(entry.id))).toEqual([String(second._id)]);
    });

    test('a published workflow from before triggers counts as answering everything', async () => {
      const legacy = await create('Wsp legacy', replyGraph('Legacy'));
      // As stored before this change: no trigger, no live version.
      await Workflow.updateOne({ _id: legacy._id }, {
        $set: { status: 'published', publishedAt: new Date() }, $unset: { trigger: 1, liveVersion: 1 }
      });

      const newer = await create('Wsp newer', replyGraph('Newer'), { type: 'always' });
      expect((await api('post', `/api/workflows/${newer._id}/publish`)).status).toBe(409);
    });
  });

  describe('drafts', () => {
    test('saving a live workflow makes a draft; visitors keep the live version until publish', async () => {
      const wf = await create('Wsp draft', replyGraph('Version one'));
      await api('post', `/api/workflows/${wf._id}/publish`);

      const conversation = { _id: new mongoose.Types.ObjectId(), company: pro._id, sessionId: 'wsp-1', workflowState: {} };
      expect((await reply.generate({ conversation, message: 'hi' })).text).toBe('Version one');

      const saved = await api('put', `/api/workflows/${wf._id}`, replyGraph('Version two'));
      expect(saved.status).toBe(200);
      expect(saved.body.workflow).toMatchObject({
        status: 'published', version: 2, liveVersion: 1, hasUnpublishedChanges: true
      });

      // Even with the runtime's cache gone, the live snapshot is what loads.
      runtimeRegistry.reset();
      expect((await reply.generate({ conversation: { ...conversation, workflowState: {} }, message: 'hi' })).text)
        .toBe('Version one');

      await api('post', `/api/workflows/${wf._id}/publish`);
      runtimeRegistry.reset();
      expect((await reply.generate({ conversation: { ...conversation, workflowState: {} }, message: 'hi' })).text)
        .toBe('Version two');
    });

    test('a half-built draft saves, with what it still needs as warnings; publishing refuses it', async () => {
      const response = await api('post', '/api/workflows', {
        name: 'Wsp half built',
        nodes: [persona(),
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start' } },
          { id: 'ask1', type: 'ask', position: { x: 0, y: 0 }, data: { type: 'ask', label: 'Ask for the order', question: '', variable: 'order' } }],
        edges: [{ id: 'e1', source: 's1', target: 'ask1' }]
      });

      expect(response.status).toBe(201);
      expect(response.body.ready).toBe(false);
      const problem = response.body.problems.find(p => /must have a question/.test(p.message));
      // Named the way the editor shows it, and pinned to the node by id.
      expect(problem).toMatchObject({ nodeId: 'ask1', level: 'error' });
      expect(problem.message).toContain('"Ask for the order"');
      expect(problem.message).not.toContain('ask1');

      const publish = await api('post', `/api/workflows/${response.body.workflow._id}/publish`);
      expect(publish.status).toBe(400);
      expect(publish.body.problems.some(p => p.nodeId === 'ask1')).toBe(true);
    });

    test('ids that could carry markup are refused on save', async () => {
      const graph = replyGraph('Hi');
      graph.nodes[1].id = '"><img src=x onerror=alert(1)>';
      graph.edges[0].source = graph.nodes[1].id;

      const response = await api('post', '/api/workflows', { name: 'Wsp xss', ...graph });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/id that is not allowed/);

      const edgeGraph = replyGraph('Hi');
      edgeGraph.edges[0].id = 'e1<script>';
      expect((await api('post', '/api/workflows', { name: 'Wsp xss 2', ...edgeGraph })).status).toBe(400);
    });

    test('a step using a saved action saves and validates without a URL of its own', async () => {
      const response = await api('post', '/api/workflows/validate', {
        nodes: [persona(),
          { id: 's1', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start' } },
          { id: 'a1', type: 'action', position: { x: 0, y: 0 },
            data: { type: 'action', label: 'Look it up', actionId: new mongoose.Types.ObjectId().toString() } },
          { id: 'r1', type: 'response', position: { x: 0, y: 0 }, data: { type: 'response', template: 'Done' } }],
        edges: [{ id: 'e1', source: 's1', target: 'a1' }, { id: 'e2', source: 'a1', target: 'r1', sourceHandle: 'success' }]
      });

      expect(response.body.errors).toEqual([]);
      expect(response.body.valid).toBe(true);
    });

    test('a rename is not a new version, so a live workflow gains no unpublished changes', async () => {
      const wf = await create('Wsp rename', replyGraph('Hi'));
      await api('post', `/api/workflows/${wf._id}/publish`);

      const renamed = await api('put', `/api/workflows/${wf._id}`, { name: 'Wsp renamed' });
      expect(renamed.body.workflow).toMatchObject({ name: 'Wsp renamed', version: 1, hasUnpublishedChanges: false });
    });
  });

  describe('unpublish and delete', () => {
    test('unpublish takes it off live and out of the runtime; delete refuses a live one', async () => {
      const wf = await create('Wsp off', replyGraph('Hi'));
      await api('post', `/api/workflows/${wf._id}/publish`);

      const refused = await api('delete', `/api/workflows/${wf._id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/Unpublish it first/);

      const runtime = runtimeRegistry.getRuntimeService();
      expect((await runtime.ensureWorkflowsLoaded(String(pro._id))).length).toBe(1);

      const off = await api('post', `/api/workflows/${wf._id}/unpublish`);
      expect(off.status).toBe(200);
      expect(off.body.workflow.status).toBe('draft');
      expect(runtime.activeWorkflows.has(String(pro._id))).toBe(false);
      expect(await runtime.ensureWorkflowsLoaded(String(pro._id))).toEqual([]);

      expect((await api('post', `/api/workflows/${wf._id}/unpublish`)).status).toBe(400);
      expect((await api('delete', `/api/workflows/${wf._id}`)).status).toBe(200);
    });

    test('duplicate makes a draft copy with the same trigger', async () => {
      const wf = await create('Wsp original', replyGraph('Hi'), { type: 'intent', description: 'return or refund' });
      const copy = await api('post', `/api/workflows/${wf._id}/duplicate`);

      expect(copy.status).toBe(201);
      expect(copy.body.workflow).toMatchObject({
        name: 'Wsp original (copy)', status: 'draft', trigger: { type: 'intent', description: 'return or refund' }
      });
    });
  });

  describe('the plan limit counts live workflows only', () => {
    test('drafts are unlimited; the second live one on a one-workflow plan is a 402', async () => {
      const one = await create('Wsp trial one', replyGraph('One'), { type: 'keywords', keywords: ['one'] }, trialToken);
      const two = await create('Wsp trial two', replyGraph('Two'), { type: 'keywords', keywords: ['two'] }, trialToken);
      await create('Wsp trial three', replyGraph('Three'), undefined, trialToken);

      expect((await api('post', `/api/workflows/${one._id}/publish`, {}, trialToken)).status).toBe(200);

      const refused = await api('post', `/api/workflows/${two._id}/publish`, {}, trialToken);
      expect(refused.status).toBe(402);
      expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', meter: 'workflows', limit: 1, used: 1 });

      // Republishing the live one does not need another slot.
      expect((await api('post', `/api/workflows/${one._id}/publish`, {}, trialToken)).status).toBe(200);

      const list = await api('get', '/api/workflows', undefined, trialToken);
      expect(list.body.liveUsage).toEqual({ used: 1, limit: 1 });
    });
  });

  describe('execution', () => {
    test('only an admin may drive the live workflow through the execute route', async () => {
      const wf = await create('Wsp exec', replyGraph('Executed'));
      await api('post', `/api/workflows/${wf._id}/publish`);

      const asOperator = await api('post', '/api/workflow-execution/execute', { message: 'hi' }, operatorToken);
      expect(asOperator.status).toBe(403);

      const asAdmin = await api('post', '/api/workflow-execution/execute', { message: 'hi' });
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.response).toBe('Executed');
    });

    test('runs with real visitors are counted on the workflow, previews are not', async () => {
      const wf = await create('Wsp stats', replyGraph('Counted'));
      await api('post', `/api/workflows/${wf._id}/publish`);

      const conversation = () => ({ _id: new mongoose.Types.ObjectId(), company: pro._id, sessionId: 'wsp-s', workflowState: {} });
      await reply.generate({ conversation: conversation(), message: 'hi' });
      await reply.generate({ conversation: conversation(), message: 'hello' });
      await reply.generate({ conversation: conversation(), message: 'test', simulate: true });

      const stats = await api('get', `/api/workflows/${wf._id}/stats`);
      expect(stats.body.stats).toMatchObject({ runs: 2, completions: 2, handoffs: 0, errors: 0 });
      expect(stats.body.stats.lastRunAt).toBeTruthy();

      const list = await api('get', '/api/workflows');
      expect(list.body.workflows.find(w => w.name === 'Wsp stats').executionStats.runs).toBe(2);
    });
  });

  describe('persona', () => {
    test('an untouched starter persona defers to the Persona screen; an edited one does not', async () => {
      await Company.updateOne({ _id: pro._id }, { $set: { 'assistant.persona': 'You are the Wsp Persona-screen bot.' } });

      const starter = replyGraph('Hi');
      starter.nodes[0] = persona({ prompt: 'You are a helpful assistant.', inheritPersona: true });
      const wf = await create('Wsp starter', starter);
      await api('post', `/api/workflows/${wf._id}/publish`);

      assistantConfig.invalidate();
      expect(await assistantConfig.resolve(pro._id)).toMatchObject({
        source: 'company', persona: 'You are the Wsp Persona-screen bot.'
      });

      const edited = replyGraph('Hi');
      edited.nodes[0] = persona({ prompt: 'You are the workflow persona.' });
      await api('put', `/api/workflows/${wf._id}`, edited);
      // Still a draft: the live version defers.
      assistantConfig.invalidate();
      expect((await assistantConfig.resolve(pro._id)).source).toBe('company');

      await api('post', `/api/workflows/${wf._id}/publish`);
      assistantConfig.invalidate();
      expect(await assistantConfig.resolve(pro._id)).toMatchObject({
        source: 'workflow', persona: 'You are the workflow persona.'
      });

      await Company.updateOne({ _id: pro._id }, { $unset: { 'assistant.persona': 1 } });
    });
  });
});
