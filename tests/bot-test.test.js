/**
 * "Test your bot": POST /api/bot/test.
 *
 * The point of the endpoint is that it is the real reply path with none of
 * the consequences, so these tests check both halves: the answer comes from
 * where a visitor's would (workflow, canned reply, assistant, fallback), and
 * nothing is created, counted or written.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Usage = require('../models/usage');
const KnowledgeChunk = require('../models/knowledge-chunk');
const ResponseTemplate = require('../models/response-template');
const AIService = require('../services/ai');
const runtimeRegistry = require('../services/runtime-registry');
const { getVectorStore } = require('../services/vector-store');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/bot', require('../routes/bot'));
  return app;
};

/** A model that answers, so the assistant path can be exercised without a key. */
function fakeModel(content = 'Kettles are £25.') {
  return {
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } }
  };
}

describe('POST /api/bot/test', () => {
  let app;
  let company;
  let adminToken;
  let operatorToken;
  let superToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    company = await Company.create({ name: 'Bot Test Co' });

    await User.create([
      {
        username: 'bottest-admin', email: 'admin@bottest.test', password: 'TestPassword123!',
        role: 'company_admin', company: company._id, displayName: 'Admin'
      },
      {
        username: 'bottest-op', email: 'op@bottest.test', password: 'TestPassword123!',
        role: 'operator', company: company._id, displayName: 'Op'
      },
      {
        username: 'bottest-root', email: 'root@bottest.test', password: 'TestPassword123!',
        role: 'superadmin', displayName: 'Root'
      }
    ]);

    adminToken = await login('bottest-admin');
    operatorToken = await login('bottest-op');
    superToken = await login('bottest-root');
  });

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ email: /@bottest\.test$/ }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id }),
      ResponseTemplate.deleteMany({ company: company._id }),
      Usage.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      KnowledgeChunk.deleteMany({ company: company._id }),
      ResponseTemplate.deleteMany({ company: company._id })
    ]);
  });

  afterEach(() => jest.restoreAllMocks());

  const ask = (body, token = adminToken) => request(app)
    .post('/api/bot/test')
    .set('x-auth-token', token)
    .send(body);

  /** Nothing a real conversation leaves behind. */
  const expectNoTrace = async () => {
    expect(await Conversation.countDocuments({ company: company._id })).toBe(0);
    expect(await Usage.countDocuments({ company: company._id })).toBe(0);
  };

  test('without a key, answers what a visitor would get, and says why', async () => {
    const response = await ask({ message: 'Do you sell kettles?' });

    expect(response.status).toBe(200);
    expect(response.body.path).toBe('fallback');
    // The assistant no longer writes an apology of its own (contract §3); what
    // the visitor would see instead is the caller's to say.
    expect(response.body.reply || '').not.toMatch(/encountered an error/i);
    expect(response.body.sources).toEqual([]);
    expect(response.body.warning).toBe('OPENAI_API_KEY is not set');
    await expectNoTrace();
  });

  test('the assistant answers from the knowledge base and cites it', async () => {
    await getVectorStore().store(
      [{ content: 'Kettles cost £25 and come in steel or white.', metadata: { title: 'Pricing', url: 'https://shop.test/pricing' } }],
      { companyId: company._id, sourceId: 'url:https://shop.test/pricing', sourceType: 'url' }
    );

    const model = fakeModel();
    const forCompany = AIService.forCompany;
    jest.spyOn(AIService, 'forCompany').mockImplementation(async (...args) => {
      const service = await forCompany(...args);
      service.openai = model;
      return service;
    });

    const response = await ask({
      message: 'How much do kettles cost?',
      history: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'system', content: 'ignored: not a visitor turn' }
      ]
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reply: 'Kettles are £25.',
      path: 'assistant',
      sources: [{ title: 'Pricing', url: 'https://shop.test/pricing' }]
    });

    const sent = model.chat.completions.create.mock.calls[0][0].messages;
    expect(sent.some(message => message.content === 'Hello!')).toBe(true);
    expect(sent.some(message => /ignored/.test(message.content))).toBe(false);
    await expectNoTrace();
  });

  test('a canned reply is reported as one, and its use is not counted', async () => {
    const template = await ResponseTemplate.create({
      company: company._id,
      name: 'Refunds',
      triggers: ['refund'],
      responses: ['Refunds take five days.']
    });

    const response = await ask({ message: 'refund' });

    expect(response.body).toMatchObject({ reply: 'Refunds take five days.', path: 'canned', sources: [] });
    // Give a fire-and-forget write the chance to land if it were made.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await ResponseTemplate.findById(template._id)).useCount || 0).toBe(0);
  });

  describe('with a published workflow', () => {
    const fakeRuntime = result => {
      const runtime = {
        ensureWorkflowLoaded: jest.fn().mockResolvedValue({ id: 'wf-1', version: 3 }),
        executeWorkflow: jest.fn().mockResolvedValue(result)
      };
      jest.spyOn(runtimeRegistry, 'getRuntimeService').mockReturnValue(runtime);
      return runtime;
    };

    test('the workflow answers, in the preview\'s simulate mode, with no session', async () => {
      const runtime = fakeRuntime({
        response: 'What is your order number?',
        choices: [{ label: 'I do not have one' }],
        escalation: null,
        state: { awaiting: 'ask-order', variables: { topic: 'orders' } }
      });

      const response = await ask({ message: 'where is my order?' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        reply: 'What is your order number?',
        path: 'workflow',
        sources: [],
        choices: [{ label: 'I do not have one' }],
        state: { workflowId: 'wf-1', version: 3, awaiting: 'ask-order', variables: { topic: 'orders' } }
      });

      const [companyId, message, , context] = runtime.executeWorkflow.mock.calls[0];
      expect(companyId).toBe(String(company._id));
      expect(message).toBe('where is my order?');
      expect(context).toMatchObject({ simulate: true, sessionId: null, conversationId: null });
      expect(context.variables).toEqual({ contact_verified: 'false' });
      await expectNoTrace();
    });

    test('the returned state carries the next turn, minus identity it may not assert', async () => {
      const runtime = fakeRuntime({ response: 'Thanks.', state: { awaiting: null, variables: {} } });

      await ask({
        message: '12345',
        state: { workflowId: 'wf-1', version: 3, awaiting: 'ask-order', variables: { topic: 'orders', contact_verified: 'true' } }
      });

      const context = runtime.executeWorkflow.mock.calls[0][3];
      expect(context.state).toMatchObject({ awaiting: 'ask-order', variables: { topic: 'orders' } });
      expect(context.state.variables.contact_verified).toBeUndefined();
    });

    test('useWorkflow: false asks the assistant instead', async () => {
      const runtime = fakeRuntime({ response: 'From the flow' });

      const response = await ask({ message: 'hello there', useWorkflow: false });

      expect(runtime.executeWorkflow).not.toHaveBeenCalled();
      expect(response.body.path).not.toBe('workflow');
    });

    test('a workflow asking for a person reports it, and nobody is assigned', async () => {
      fakeRuntime({ response: 'Connecting you.', escalation: { enabled: true, type: 'human' } });

      const response = await ask({ message: 'a person please' });

      expect(response.body.escalate).toEqual({ enabled: true, type: 'human' });
      await expectNoTrace();
    });
  });

  describe('who may ask', () => {
    test('an operator may not', async () => {
      expect((await ask({ message: 'hi' }, operatorToken)).status).toBe(403);
    });

    test('a superadmin has to name the company', async () => {
      expect((await ask({ message: 'hi' }, superToken)).status).toBe(400);
      expect((await ask({ message: 'hi', companyId: 'nonsense' }, superToken)).status).toBe(400);

      const response = await ask({ message: 'hi', companyId: String(company._id) }, superToken);
      expect(response.status).toBe(200);
    });

    test('an empty message is a 400', async () => {
      expect((await ask({ message: '   ' })).status).toBe(400);
      expect((await ask({})).status).toBe(400);
    });
  });
});
