/**
 * Teach the bot: POST /api/bot/teach.
 *
 * Saving an answer as knowledge (a note titled from the question, chunked and
 * embedded like Paste) or as a canned reply (whose example question is the
 * visitor's), marking the corrected message, clearing the question from the
 * unanswered list, re-running the saved tests, the audit entry - and that none
 * of it can reach into another tenant's conversations.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const KnowledgeChunk = require('../models/knowledge-chunk');
const ResponseTemplate = require('../models/response-template');
const TestCase = require('../models/test-case');
const GapDismissal = require('../models/gap-dismissal');
const AuditLog = require('../models/audit-log');
const AIService = require('../services/ai');
const usageService = require('../services/usage');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/bot', require('../routes/bot'));
  return app;
};

describe('POST /api/bot/teach', () => {
  let app;
  let company;
  let other;
  let adminToken;
  let operatorToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const teach = (body, token = adminToken) => request(app)
    .post('/api/bot/teach')
    .set('x-auth-token', token)
    .send(body);

  /** A conversation where the bot did not know, as the reply path stores it. */
  const missed = (companyId, sessionId, question = 'Do you deliver to Ireland?') => Conversation.create({
    company: companyId,
    sessionId,
    lastActivity: new Date(),
    messages: [
      { sender: 'user', content: question, timestamp: new Date(Date.now() - 2000) },
      {
        sender: 'bot', content: 'I do not have that information.', messageId: `client-${sessionId}`,
        path: 'assistant', unanswered: true, timestamp: new Date(Date.now() - 1000)
      }
    ]
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    company = await Company.create({ name: 'Teach Co' });
    other = await Company.create({ name: 'Teach Other' });

    await User.create([
      { username: 'teach-admin', email: 'admin@teach.test', password: 'TestPassword123!', role: 'company_admin', company: company._id, displayName: 'Admin' },
      { username: 'teach-op', email: 'op@teach.test', password: 'TestPassword123!', role: 'operator', company: company._id, displayName: 'Op' }
    ]);

    adminToken = await login('teach-admin');
    operatorToken = await login('teach-op');
  });

  const ids = () => [company._id, other._id];

  beforeEach(async () => {
    await Promise.all([
      Conversation.deleteMany({ company: { $in: ids() } }),
      KnowledgeChunk.deleteMany({ company: { $in: ids() } }),
      ResponseTemplate.deleteMany({ company: { $in: ids() } }),
      TestCase.deleteMany({ company: { $in: ids() } }),
      GapDismissal.deleteMany({ company: { $in: ids() } })
    ]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ email: /@teach\.test$/ }),
      Company.deleteMany({ _id: { $in: ids() } }),
      Conversation.deleteMany({ company: { $in: ids() } }),
      KnowledgeChunk.deleteMany({ company: { $in: ids() } }),
      ResponseTemplate.deleteMany({ company: { $in: ids() } }),
      TestCase.deleteMany({ company: { $in: ids() } }),
      GapDismissal.deleteMany({ company: { $in: ids() } })
    ]);
  });

  test('as knowledge: a note titled from the question, and the message marked corrected', async () => {
    const conversation = await missed(company._id, 'teach-k');
    const botMessage = conversation.messages[1];

    const response = await teach({
      question: 'Do you deliver to Ireland?',
      answer: 'Yes: 3 to 5 working days, €6.95.',
      kind: 'knowledge',
      sessionId: 'teach-k',
      messageId: String(botMessage._id)
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, kind: 'knowledge', corrected: true, title: 'Do you deliver to Ireland?' });
    expect(response.body.refId).toMatch(/^text:/);
    expect(response.body.tests).toBeUndefined();

    const chunks = await KnowledgeChunk.find({ company: company._id, sourceId: response.body.refId }).lean();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Do you deliver to Ireland?');
    expect(chunks[0].content).toContain('€6.95');
    expect(chunks[0].metadata.title).toBe('Do you deliver to Ireland?');
    expect(chunks[0].sourceType).toBe('manual');

    const stored = await Conversation.findById(conversation._id).lean();
    expect(stored.messages[1].correction).toMatchObject({ kind: 'knowledge', refId: response.body.refId });

    const entry = await AuditLog.findOne({ action: 'bot.taught', 'target.id': response.body.refId }).lean();
    expect(entry).not.toBeNull();
    expect(entry.details).toMatchObject({ kind: 'knowledge', corrected: true });
  });

  test('saved from an operator\'s reply, it also fixes the bot\'s failed attempt at the same question', async () => {
    const conversation = await missed(company._id, 'teach-op-reply', 'Is there parking?');
    conversation.messages.push(
      { sender: 'system', content: 'Ada joined', timestamp: new Date() },
      { sender: 'operator', content: 'Yes, behind the clinic.', operatorName: 'Ada', timestamp: new Date() }
    );
    await conversation.save();
    const reply = conversation.messages[3];

    const response = await teach({
      question: 'Is there parking?',
      answer: 'Yes, behind the clinic.',
      kind: 'knowledge',
      sessionId: 'teach-op-reply',
      messageId: String(reply._id)
    });

    expect(response.status).toBe(201);
    const stored = await Conversation.findById(conversation._id).lean();
    expect(stored.messages[3].correction).toMatchObject({ kind: 'knowledge' });
    // The bot's "I do not have that information" leaves the unanswered list.
    expect(stored.messages[1].correction).toMatchObject({ kind: 'knowledge', refId: response.body.refId });
    // The visitor's question itself is not a reply and is left alone.
    expect(stored.messages[0].correction).toBeUndefined();
  });

  test('as a canned reply: the visitor\'s question is its example, the answer sent word for word', async () => {
    await missed(company._id, 'teach-c');

    const response = await teach({
      question: 'Can I pay by invoice?',
      answer: 'Yes, for orders over £500.',
      kind: 'canned',
      title: 'Paying by invoice',
      sessionId: 'teach-c',
      // The client-side id works as well as the database one.
      messageId: 'client-teach-c'
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ kind: 'canned', corrected: true, title: 'Paying by invoice' });

    const template = await ResponseTemplate.findById(response.body.refId).lean();
    expect(template).toMatchObject({
      name: 'Paying by invoice', triggers: ['Can I pay by invoice?'], responses: ['Yes, for orders over £500.'], enabled: true
    });
  });

  test('without a conversation it still saves, and marks nothing', async () => {
    const response = await teach({ question: 'Opening hours?', answer: '9 to 5, Monday to Friday.', kind: 'knowledge' });
    expect(response.status).toBe(201);
    expect(response.body.corrected).toBe(false);
  });

  test('cannot mark a message in another tenant\'s conversation', async () => {
    const theirs = await missed(other._id, 'teach-other');

    const response = await teach({
      question: 'Do you deliver to Ireland?',
      answer: 'Yes.',
      kind: 'knowledge',
      sessionId: 'teach-other',
      messageId: String(theirs.messages[1]._id)
    });

    expect(response.status).toBe(201);
    expect(response.body.corrected).toBe(false);
    expect((await Conversation.findById(theirs._id).lean()).messages[1].correction).toBeUndefined();
    // And the note went into the teacher's own knowledge base.
    expect(await KnowledgeChunk.countDocuments({ company: other._id })).toBe(0);
  });

  test('answering a group from the list clears the whole group, not just one example', async () => {
    await missed(company._id, 'gap-a', 'Do you sell gift cards?');
    await missed(company._id, 'gap-b', 'gift cards available?');

    const list = await request(app).get('/api/bot/gaps').set('x-auth-token', adminToken);
    expect(list.body.groups).toHaveLength(1);
    const group = list.body.groups[0];
    expect(group.count).toBe(2);

    const response = await teach({
      question: group.question,
      answer: 'Yes, from £10.',
      kind: 'knowledge',
      sessionId: group.examples[0].sessionId,
      messageId: group.examples[0].messageId,
      gapKey: group.key
    });
    expect(response.status).toBe(201);

    const after = await request(app).get('/api/bot/gaps').set('x-auth-token', adminToken);
    expect(after.body.groups).toEqual([]);
    expect(await GapDismissal.countDocuments({ company: company._id, reason: 'taught' })).toBe(1);
  });

  test('re-runs the saved tests and says how they did', async () => {
    jest.spyOn(AIService, 'forCompany').mockImplementation(async () => ({
      openai: null,
      async generateResponse(message) {
        this.lastPath = 'assistant';
        this.lastSources = [];
        return message === 'How much is a kettle?' ? 'Kettles are £25.' : 'We do exchanges only.';
      }
    }));

    await TestCase.create([
      { company: company._id, question: 'How much is a kettle?', expect: { type: 'contains', value: '£25' } },
      { company: company._id, question: 'Do you refund?', expect: { type: 'contains', value: 'refund' } }
    ]);

    const response = await teach({ question: 'Do you refund?', answer: 'Refunds within 30 days.', kind: 'canned' });

    expect(response.status).toBe(201);
    expect(response.body.tests).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(response.body.tests.failures).toEqual([
      expect.objectContaining({ question: 'Do you refund?', reason: 'Does not mention "refund"' })
    ]);
  });

  test('says what is missing', async () => {
    expect((await teach({ question: 'Hi?', answer: '', kind: 'knowledge' })).body.error).toMatch(/answer/);
    expect((await teach({ question: '', answer: 'x', kind: 'knowledge' })).body.error).toMatch(/visitor asked/);
    expect((await teach({ question: 'Hi?', answer: 'x', kind: 'poem' })).status).toBe(400);
  });

  test('a knowledge note over the plan\'s allowance is refused with the plan\'s reason', async () => {
    jest.spyOn(usageService, 'check').mockResolvedValue({
      allowed: false, reason: 'Knowledge limit reached.', limit: 10, used: 10, planId: 'trial'
    });

    const response = await teach({ question: 'Opening hours?', answer: '9 to 5.', kind: 'knowledge' });

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', meter: 'knowledgeChunks' });
    expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(0);
  });

  test('is for admins', async () => {
    expect((await teach({ question: 'Hi?', answer: 'Hello.', kind: 'canned' }, operatorToken)).status).toBe(403);
  });
});
