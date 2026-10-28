/**
 * Unanswered questions: GET /api/bot/gaps and POST /api/bot/gaps/:key/dismiss.
 *
 * What counts as the bot not answering (an "I don't know", a thumbs down, a
 * visitor asking for a person straight after an answer, the model failing),
 * what does not (a corrected answer, a request for a person that was the
 * question itself, an answer long before the handover), how the same question
 * asked different ways becomes one row, and that dismissing a row hides it
 * only until the question is asked again.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const GapDismissal = require('../models/gap-dismissal');
const AuditLog = require('../models/audit-log');
const gaps = require('../services/gaps');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/bot', require('../routes/bot'));
  return app;
};

const minutesAgo = minutes => new Date(Date.now() - minutes * 60 * 1000);
const since = () => minutesAgo(60 * 24 * 30);

describe('unanswered questions', () => {
  describe('what counts', () => {
    const conversation = (messages, extra = {}) => ({
      sessionId: 'gap-unit',
      lastActivity: new Date(),
      messages: messages.map((message, index) => ({
        _id: new mongoose.Types.ObjectId(),
        timestamp: minutesAgo(60 - index),
        ...message
      })),
      ...extra
    });

    test('an "I don\'t know" and a fallback line are unanswered', () => {
      const found = gaps.occurrencesIn(conversation([
        { sender: 'user', content: 'Do you deliver to Ireland?' },
        { sender: 'bot', content: 'I do not have that information.', path: 'assistant', unanswered: true },
        { sender: 'user', content: 'What about Spain?' },
        { sender: 'bot', content: 'Sorry, I did not catch that.', path: 'fallback' }
      ]), since());

      expect(found.map(entry => entry.question)).toEqual(['Do you deliver to Ireland?', 'What about Spain?']);
      expect(found.every(entry => entry.reasons.has('unanswered'))).toBe(true);
      expect(found[0].answer).toBe('I do not have that information.');
    });

    test('a thumbs down counts, and a thumbs up does not', () => {
      const found = gaps.occurrencesIn(conversation([
        { sender: 'user', content: 'How much is the deluxe kettle?' },
        { sender: 'bot', content: 'It is £25.', path: 'assistant', feedback: { rating: 'down' } },
        { sender: 'user', content: 'And the basic one?' },
        { sender: 'bot', content: 'It is £15.', path: 'assistant', feedback: { rating: 'up' } }
      ]), since());

      expect(found).toHaveLength(1);
      expect(found[0].reasons.has('thumbs_down')).toBe(true);
    });

    test('an answer somebody already corrected is skipped', () => {
      const found = gaps.occurrencesIn(conversation([
        { sender: 'user', content: 'Do you deliver to Ireland?' },
        {
          sender: 'bot', content: 'I do not know.', unanswered: true,
          correction: { kind: 'knowledge', refId: 'text:1', at: new Date() }
        }
      ]), since());

      expect(found).toEqual([]);
    });

    test('a visitor asking for a person soon after an answer counts against the answer', () => {
      const messages = [
        { sender: 'user', content: 'Can I return a used kettle?' },
        { sender: 'bot', content: 'Returns are accepted within 30 days.', path: 'assistant' }
      ];
      const convo = conversation(messages);
      convo.handoff = {
        reason: 'visitor_request',
        requestedAt: new Date(convo.messages[1].timestamp.getTime() + 60 * 1000)
      };

      const found = gaps.occurrencesIn(convo, since());
      expect(found).toHaveLength(1);
      expect(found[0].reasons.has('handoff')).toBe(true);
    });

    test('but not long after it, and not when asking for a person was the question', () => {
      const late = conversation([
        { sender: 'user', content: 'Can I return a used kettle?' },
        { sender: 'bot', content: 'Returns are accepted within 30 days.', path: 'assistant' }
      ]);
      late.handoff = {
        reason: 'visitor_request',
        requestedAt: new Date(late.messages[1].timestamp.getTime() + gaps.HANDOFF_WINDOW_MS + 60 * 1000)
      };
      expect(gaps.occurrencesIn(late, since())).toEqual([]);

      const asked = conversation([
        { sender: 'user', content: 'Can I talk to a person please' },
        { sender: 'bot', content: 'Of course, one moment.', path: 'assistant' }
      ]);
      asked.handoff = { reason: 'visitor_request', requestedAt: new Date() };
      expect(gaps.occurrencesIn(asked, since())).toEqual([]);
    });

    test('a model failure counts against the question, with no answer on record', () => {
      const convo = conversation([
        { sender: 'user', content: 'What are your opening hours?' }
      ]);
      convo.handoff = { reason: 'model_error', requestedAt: new Date() };

      const found = gaps.occurrencesIn(convo, since());
      expect(found).toHaveLength(1);
      expect(found[0].reasons.has('failed')).toBe(true);
      expect(found[0].answer).toBeNull();
      expect(found[0].messageId).toBe(String(convo.messages[0]._id));
    });

    test('system lines are not part of the conversation', () => {
      const found = gaps.occurrencesIn(conversation([
        { sender: 'user', content: 'Do you sell gift cards?' },
        { sender: 'system', content: 'Visitor asked for a person' },
        { sender: 'bot', content: 'I do not know.', unanswered: true }
      ]), since());

      expect(found[0].question).toBe('Do you sell gift cards?');
    });
  });

  describe('grouping', () => {
    const occurrence = (question, minutes = 1) => ({
      sessionId: 's', messageId: 'm', question, answer: null, at: minutesAgo(minutes), reasons: new Set(['unanswered'])
    });

    test('the same question asked different ways is one group, a different one is not', () => {
      const groups = gaps.group([
        occurrence('What are your opening hours?', 5),
        occurrence('opening hours??', 4),
        occurrence('When are you open', 3),
        occurrence('Do you deliver to France?', 2),
        occurrence('Do you deliver to Spain?', 1)
      ]);

      const sizes = groups.map(entry => entry.occurrences.length).sort();
      expect(sizes).toEqual([1, 1, 3]);
    });

    test('filler words and plurals do not matter; questions with nothing in them are dropped', () => {
      expect(gaps.tokens('What are your Opening HOURS?')).toEqual(gaps.tokens('opening hour'));
      expect(gaps.group([occurrence('hi?'), occurrence('ok thanks')])).toEqual([]);
    });
  });

  describe('the endpoints', () => {
    let app;
    let company;
    let other;
    let adminToken;
    let operatorToken;
    let otherToken;

    const login = async username => (await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' })).body.token;

    const unanswered = (companyId, sessionId, question, minutes = 10, extra = {}) => Conversation.create({
      company: companyId,
      sessionId,
      lastActivity: minutesAgo(minutes),
      messages: [
        { sender: 'user', content: question, timestamp: minutesAgo(minutes + 1) },
        { sender: 'bot', content: 'I do not have that information.', path: 'assistant', unanswered: true, timestamp: minutesAgo(minutes), ...extra }
      ]
    });

    beforeAll(async () => {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_TEST_URI);
      }
      app = buildApp();
      company = await Company.create({ name: 'Gaps Co' });
      other = await Company.create({ name: 'Gaps Other' });

      await User.create([
        { username: 'gaps-admin', email: 'admin@gaps.test', password: 'TestPassword123!', role: 'company_admin', company: company._id, displayName: 'Admin' },
        { username: 'gaps-op', email: 'op@gaps.test', password: 'TestPassword123!', role: 'operator', company: company._id, displayName: 'Op' },
        { username: 'gaps-other', email: 'other@gaps.test', password: 'TestPassword123!', role: 'company_admin', company: other._id, displayName: 'Other' }
      ]);

      adminToken = await login('gaps-admin');
      operatorToken = await login('gaps-op');
      otherToken = await login('gaps-other');
    });

    beforeEach(async () => {
      await Promise.all([
        Conversation.deleteMany({ company: { $in: [company._id, other._id] } }),
        GapDismissal.deleteMany({ company: { $in: [company._id, other._id] } })
      ]);
    });

    afterAll(async () => {
      await Promise.all([
        User.deleteMany({ email: /@gaps\.test$/ }),
        Company.deleteMany({ _id: { $in: [company._id, other._id] } }),
        Conversation.deleteMany({ company: { $in: [company._id, other._id] } }),
        GapDismissal.deleteMany({ company: { $in: [company._id, other._id] } })
      ]);
    });

    const list = (token = adminToken, query = '') => request(app)
      .get(`/api/bot/gaps${query}`)
      .set('x-auth-token', token);

    test('lists grouped questions, most asked first, in the contract shape', async () => {
      await unanswered(company._id, 'g1', 'What are your opening hours?', 30);
      await unanswered(company._id, 'g2', 'opening hours?', 20);
      await unanswered(company._id, 'g3', 'Do you sell gift cards?', 10, { feedback: { rating: 'down' } });

      const response = await list();

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      expect(response.body.occurrences).toBe(3);

      const [first, second] = response.body.groups;
      expect(first).toMatchObject({ count: 2, reasons: { unanswered: 2, thumbs_down: 0, handoff: 0, failed: 0 } });
      expect(first.key).toMatch(/^[a-f0-9]{16}$/);
      expect(first.question).toBe('opening hours?');
      expect(first.examples[0]).toMatchObject({ sessionId: 'g2', question: 'opening hours?', answer: 'I do not have that information.' });
      expect(first.examples[0].messageId).toMatch(/^[a-f0-9]{24}$/);
      expect(first.tokens).toBeUndefined();
      expect(second).toMatchObject({ count: 1, question: 'Do you sell gift cards?', reasons: { unanswered: 1, thumbs_down: 1 } });
    });

    test('respects the window and the limit', async () => {
      await unanswered(company._id, 'old', 'Do you sell gift cards?', 60 * 24 * 10);
      await unanswered(company._id, 'new', 'What are your opening hours?', 10);

      expect((await list(adminToken, '?days=7')).body.total).toBe(1);
      expect((await list(adminToken, '?days=30')).body.total).toBe(2);

      const limited = await list(adminToken, '?days=30&limit=1');
      expect(limited.body.groups).toHaveLength(1);
      expect(limited.body.total).toBe(2);
    });

    test('says plainly when there is nothing', async () => {
      const response = await list();
      expect(response.body).toMatchObject({ groups: [], total: 0, occurrences: 0, days: 30 });
    });

    test('only ever shows the company\'s own conversations', async () => {
      await unanswered(other._id, 'theirs', 'Secret question from another tenant', 10);

      expect((await list()).body.total).toBe(0);
      expect((await list(otherToken)).body.total).toBe(1);
    });

    test('is for admins', async () => {
      expect((await list(operatorToken)).status).toBe(403);
    });

    test('dismissing hides a group until the question is asked again', async () => {
      await unanswered(company._id, 'd1', 'Do you sell gift cards?', 30);
      await unanswered(company._id, 'd2', 'What are your opening hours?', 20);

      const { groups } = (await list()).body;
      const giftCards = groups.find(entry => /gift/.test(entry.question));

      const dismissed = await request(app)
        .post(`/api/bot/gaps/${giftCards.key}/dismiss`)
        .set('x-auth-token', adminToken);
      expect(dismissed.status).toBe(200);

      const after = (await list()).body;
      expect(after.groups.map(entry => entry.question)).toEqual(['What are your opening hours?']);

      const entry = await AuditLog.findOne({ action: 'bot.gap_dismissed', 'target.id': giftCards.key }).lean();
      expect(entry).not.toBeNull();

      // Asked again, after the dismissal: it is news, and comes back.
      await Conversation.create({
        company: company._id,
        sessionId: 'd3',
        lastActivity: new Date(Date.now() + 1000),
        messages: [
          { sender: 'user', content: 'gift cards - do you sell them?', timestamp: new Date(Date.now() + 500) },
          { sender: 'bot', content: 'Not sure.', unanswered: true, timestamp: new Date(Date.now() + 1000) }
        ]
      });
      const back = (await list()).body.groups.find(group => /gift/.test(group.question));
      expect(back).toMatchObject({ count: 1 });
    });

    test('dismissing an unknown group is a 404, and a malformed key a 400', async () => {
      const missing = await request(app).post('/api/bot/gaps/0123456789abcdef/dismiss').set('x-auth-token', adminToken);
      expect(missing.status).toBe(404);

      const malformed = await request(app).post('/api/bot/gaps/not-a-key!/dismiss').set('x-auth-token', adminToken);
      expect(malformed.status).toBe(400);
    });

    test('another tenant cannot dismiss a group by its key', async () => {
      await unanswered(company._id, 'x1', 'Do you sell gift cards?', 10);
      const { groups } = (await list()).body;

      const response = await request(app)
        .post(`/api/bot/gaps/${groups[0].key}/dismiss`)
        .set('x-auth-token', otherToken);

      expect(response.status).toBe(404);
      expect((await list()).body.total).toBe(1);
    });
  });
});
