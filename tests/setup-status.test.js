/**
 * GET /api/companies/me/setup: how far a tenant has got with setting up.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const KnowledgeChunk = require('../models/knowledge-chunk');
const Workflow = require('../models/workflow');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/companies', require('../routes/company'));
  return app;
};

const chunk = (company, sourceId, content) => ({
  company, sourceId, sourceType: 'manual', content, embedding: [1, 0], embeddingSignature: 'test'
});

describe('setup status', () => {
  let app;
  let fresh;
  let busy;
  let freshAdmin;
  let busyAdmin;
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

    fresh = await Company.create({ name: 'Setup Fresh Co' });
    busy = await Company.create({
      name: 'Setup Busy Co',
      allowedDomains: ['https://busy.test'],
      assistant: { persona: 'You are the Busy Co assistant.' },
      businessHours: { enabled: true, timezone: 'Europe/London', days: [] },
      emailChannel: { enabled: true, inboundAddress: 'help@busy.test' }
    });

    const user = (username, role, company) => ({
      username, email: `${username}@setup.test`, password: 'TestPassword123!',
      role, company: company && company._id, displayName: username
    });
    await User.create([
      user('setup-fresh-admin', 'company_admin', fresh),
      user('setup-busy-admin', 'company_admin', busy),
      user('setup-busy-op', 'operator', busy),
      { ...user('setup-busy-gone', 'operator', busy), isActive: false },
      user('setup-root', 'superadmin', null)
    ]);

    await KnowledgeChunk.insertMany([
      chunk(busy._id, 'url:https://busy.test/', 'Home'),
      chunk(busy._id, 'url:https://busy.test/', 'More home'),
      chunk(busy._id, 'file:prices.csv', 'Kettle: £25')
    ]);
    // One real conversation, and one empty one - the widget opened and closed
    // again - which counts for nothing.
    await Conversation.create({
      sessionId: `setup-${Date.now()}`, company: busy._id,
      messages: [{ content: 'Do you open on Saturdays?', sender: 'user' }]
    });
    await Conversation.create({ sessionId: `setup-empty-${Date.now()}`, company: busy._id, messages: [] });
    const busyAdminUser = await User.findOne({ username: 'setup-busy-admin' });
    await Workflow.create({
      name: 'Live', company: busy._id, status: 'published', publishedAt: new Date(),
      nodes: [], edges: [], createdBy: busyAdminUser._id
    });

    freshAdmin = await login('setup-fresh-admin');
    busyAdmin = await login('setup-busy-admin');
    operatorToken = await login('setup-busy-op');
    superToken = await login('setup-root');
  });

  afterAll(async () => {
    const companies = [fresh._id, busy._id];
    await Promise.all([
      User.deleteMany({ email: /@setup\.test$/ }),
      Company.deleteMany({ _id: { $in: companies } }),
      KnowledgeChunk.deleteMany({ company: { $in: companies } }),
      Conversation.deleteMany({ company: { $in: companies } }),
      Workflow.deleteMany({ company: { $in: companies } })
    ]);
  });

  const setup = (token, query = '') => request(app)
    .get(`/api/companies/me/setup${query}`)
    .set('x-auth-token', token);

  test('a new company has done nothing yet', async () => {
    const response = await setup(freshAdmin);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      knowledgeSources: 0,
      knowledgeChunks: 0,
      persona: false,
      allowedDomains: [],
      conversations: 0,
      widgetSeen: false,
      widgetSeenAt: null,
      widgetOrigin: null,
      botTested: false,
      botTestedAt: null,
      operators: 1,
      workflowPublished: false,
      emailChannel: false,
      businessHours: false
    });
  });

  test('a set-up company shows its progress', async () => {
    const response = await setup(busyAdmin);

    expect(response.body).toEqual({
      knowledgeSources: 2,
      knowledgeChunks: 3,
      persona: true,
      allowedDomains: ['https://busy.test'],
      conversations: 1,
      // No record of the widget loading, so a conversation is the evidence.
      widgetSeen: true,
      widgetSeenAt: null,
      widgetOrigin: null,
      botTested: false,
      botTestedAt: null,
      // The admin and the active operator; the deactivated one does not count.
      operators: 2,
      workflowPublished: true,
      emailChannel: true,
      businessHours: true
    });
  });

  test('installed and tried come from what the widget and Test your bot recorded', async () => {
    const seenAt = new Date(Date.now() - 4 * 60 * 1000);
    const testedAt = new Date(Date.now() - 60 * 60 * 1000);
    await Company.updateOne({ _id: fresh._id }, {
      $set: {
        widgetSeen: { at: seenAt, origin: 'https://fresh.test', origins: ['https://fresh.test'] },
        onboarding: { botTestedAt: testedAt }
      }
    });

    try {
      const response = await setup(freshAdmin);
      expect(response.body.conversations).toBe(0);
      expect(response.body.widgetSeen).toBe(true);
      expect(new Date(response.body.widgetSeenAt).getTime()).toBe(seenAt.getTime());
      expect(response.body.widgetOrigin).toBe('https://fresh.test');
      expect(response.body.botTested).toBe(true);
      expect(new Date(response.body.botTestedAt).getTime()).toBe(testedAt.getTime());
    } finally {
      await Company.updateOne({ _id: fresh._id }, { $unset: { widgetSeen: 1, onboarding: 1 } });
    }
  });

  test('an operator may not read it', async () => {
    expect((await setup(operatorToken)).status).toBe(403);
  });

  test('a superadmin names the company', async () => {
    expect((await setup(superToken)).status).toBe(400);

    const response = await setup(superToken, `?companyId=${busy._id}`);
    expect(response.status).toBe(200);
    expect(response.body.knowledgeChunks).toBe(3);
  });
});
