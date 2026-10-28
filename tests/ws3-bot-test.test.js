/**
 * Test your bot, the parts that explain an answer: whether the knowledge base
 * was used and what it found (with scores), the actions the assistant called,
 * an "I don't know", what a visitor would see when the model fails (and why),
 * testing as a verified customer, and the Home checklist's "tried it" step.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const ResponseTemplate = require('../models/response-template');
const AIService = require('../services/ai');
const assistantTools = require('../services/assistant-tools');
const availability = require('../services/availability');
const runtimeRegistry = require('../services/runtime-registry');
const { getVectorStore } = require('../services/vector-store');
const eventually = require('./eventually');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/bot', require('../routes/bot'));
  return app;
};

/** An AI service that answers once, with the given flags. */
function assistantSays({ text = 'An answer.', path = 'assistant', sources = [], flags = {} } = {}) {
  return jest.spyOn(AIService, 'forCompany').mockImplementation(async () => ({
    openai: null,
    async generateResponse() {
      this.lastPath = path;
      this.lastSources = sources;
      Object.assign(this, flags);
      return text;
    }
  }));
}

describe('Test your bot: explaining the answer', () => {
  let app;
  let company;
  let adminToken;
  let superToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const ask = (body, token = adminToken) => request(app)
    .post('/api/bot/test')
    .set('x-auth-token', token)
    .send(body);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    company = await Company.create({ name: 'Explain Co' });

    await User.create([
      { username: 'explain-admin', email: 'admin@explain.test', password: 'TestPassword123!', role: 'company_admin', company: company._id, displayName: 'Admin' },
      { username: 'explain-root', email: 'root@explain.test', password: 'TestPassword123!', role: 'superadmin', displayName: 'Root' }
    ]);

    adminToken = await login('explain-admin');
    superToken = await login('explain-root');
  });

  beforeEach(async () => {
    await Promise.all([
      KnowledgeChunk.deleteMany({ company: company._id }),
      ResponseTemplate.deleteMany({ company: company._id }),
      Company.updateOne({ _id: company._id }, { $unset: { onboarding: 1 } })
    ]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ email: /@explain\.test$/ }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id }),
      ResponseTemplate.deleteMany({ company: company._id })
    ]);
  });

  test('an answer from knowledge says so, and shows the passages with their scores', async () => {
    await getVectorStore().store(
      [{ content: 'Kettles cost £25 and come in steel or white.', metadata: { title: 'Pricing', url: 'https://shop.test/pricing' } }],
      { companyId: company._id, sourceId: 'url:https://shop.test/pricing', sourceType: 'url' }
    );
    assistantSays({ text: 'Kettles are £25.', sources: [{ title: 'Pricing', url: 'https://shop.test/pricing' }] });

    const response = await ask({ message: 'How much do kettles cost?' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: 'assistant', knowledgeMatched: true, unanswered: false, failed: false });
    expect(response.body.passages[0]).toMatchObject({
      title: 'Pricing', url: 'https://shop.test/pricing', sourceId: 'url:https://shop.test/pricing'
    });
    expect(typeof response.body.passages[0].score).toBe('number');
    expect(response.body.passages[0].excerpt).toContain('Kettles cost £25');
  });

  test('says plainly when nothing in the knowledge matched', async () => {
    assistantSays({ text: 'We are open nine to five.' });

    const response = await ask({ message: 'When are you open?' });

    expect(response.body).toMatchObject({ path: 'assistant', knowledgeMatched: false, passages: [] });
  });

  test('a canned reply carries no passages: the knowledge was not consulted', async () => {
    assistantSays({ text: 'Refunds take five days.', path: 'canned' });

    const response = await ask({ message: 'refund' });

    expect(response.body.path).toBe('canned');
    expect(response.body.passages).toBeUndefined();
  });

  test('returns the actions the assistant called', async () => {
    assistantSays({ text: 'Your order shipped on Tuesday.' });
    jest.spyOn(assistantTools, 'prepare').mockResolvedValue({
      hasTools: () => true,
      outcome: () => ({ toolCalls: [{ name: 'order_lookup', status: 'ok' }] })
    });

    const response = await ask({ message: 'Where is order 42?' });

    expect(response.body.toolCalls).toEqual([{ name: 'order_lookup', status: 'ok' }]);
  });

  test('an "I don\'t know" is flagged', async () => {
    assistantSays({ text: 'I do not have that information.', flags: { lastUnanswered: true } });

    const response = await ask({ message: 'Do you deliver to Mars?' });

    expect(response.body).toMatchObject({ unanswered: true, failed: false, reply: 'I do not have that information.' });
  });

  describe('when the model fails', () => {
    test('with nobody available, the visitor is asked for an email address', async () => {
      assistantSays({ text: null, flags: { lastFailed: true } });
      jest.spyOn(availability, 'status').mockResolvedValue({ open: true, operatorsOnline: 0, canReachOperator: false });

      const response = await ask({ message: 'hours?' });

      expect(response.status).toBe(200);
      expect(response.body.failed).toBe(true);
      expect(response.body.visitorWouldSee.kind).toBe('leave_message');
      expect(response.body.visitorWouldSee.why).toMatch(/nobody from your team is available/i);
      expect(response.body.reply).toBe(response.body.visitorWouldSee.text);
      expect(response.body.reply).toMatch(/email/i);
    });

    test('with somebody available, the tenant\'s own hand-over line is used', async () => {
      assistantSays({ text: null, flags: { lastFailed: true } });
      jest.spyOn(availability, 'status').mockResolvedValue({ open: true, operatorsOnline: 2, canReachOperator: true });
      await ResponseTemplate.create({
        company: company._id, name: 'Handover', role: 'handoff', responses: ['One moment, a colleague will take over.']
      });

      const response = await ask({ message: 'hours?' });

      expect(response.body.visitorWouldSee).toMatchObject({ kind: 'handover', text: 'One moment, a colleague will take over.' });
      expect(response.body.reply).toBe('One moment, a colleague will take over.');
    });
  });

  describe('as a verified customer', () => {
    test('a workflow sees a verified contact with the id the admin typed', async () => {
      const runtime = {
        ensureWorkflowLoaded: jest.fn().mockResolvedValue({ id: 'wf-1', version: 1 }),
        executeWorkflow: jest.fn().mockResolvedValue({ response: 'Your order shipped.', state: {} })
      };
      jest.spyOn(runtimeRegistry, 'getRuntimeService').mockReturnValue(runtime);

      const response = await ask({ message: 'Where is my order?', asVerified: true, customer: { externalId: 'cus_42' } });

      expect(response.body.asVerified).toBe(true);
      expect(runtime.executeWorkflow.mock.calls[0][3].variables).toMatchObject({
        contact_verified: 'true', contact_external_id: 'cus_42', contact_email: 'test.customer@example.com'
      });
    });

    test('the assistant\'s tools are prepared for a verified contact, in simulate mode', async () => {
      assistantSays();
      const prepare = jest.spyOn(assistantTools, 'prepare').mockResolvedValue(null);

      await ask({ message: 'Where is my order?', asVerified: true, useWorkflow: false });

      const options = prepare.mock.calls[0][0];
      expect(options.simulate).toBe(true);
      expect(options.contact).toMatchObject({ identityLevel: 'verified', externalId: 'test-customer' });
    });
  });

  describe('the Home checklist', () => {
    test('trying the bot records it for the company', async () => {
      assistantSays();

      await ask({ message: 'hello' });

      const stored = await eventually(async () => {
        const found = await Company.findById(company._id).lean();
        return found.onboarding && found.onboarding.botTestedAt && found;
      });
      expect(stored.onboarding.botTestedAt).toBeInstanceOf(Date);
    });

    test('a superadmin trying a tenant\'s bot does not tick it for them', async () => {
      // A company of its own: the shared one's earlier tests record their own
      // tries without waiting, and one landing late would look like this one.
      const untouched = await Company.create({ name: 'Bot Test Untouched' });
      assistantSays();

      try {
        await ask({ message: 'hello', companyId: String(untouched._id) }, superToken);
        await new Promise(resolve => setTimeout(resolve, 50));

        const stored = await Company.findById(untouched._id).lean();
        expect(stored.onboarding && stored.onboarding.botTestedAt).toBeFalsy();
      } finally {
        await Company.deleteOne({ _id: untouched._id });
      }
    });
  });
});
