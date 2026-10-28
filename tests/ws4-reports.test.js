/**
 * Reports that tell the truth: what counts as the bot handling something,
 * what counts as a conversation at all, and what the bot is worth.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const Task = require('../models/task');
const usageService = require('../services/usage');
const analytics = require('../services/analytics');

const PASSWORD = 'TestPassword123!';
const DAY = 24 * 60 * 60 * 1000;

describe('Reports', () => {
  let app;
  let company;
  let match;
  let adminToken;
  let rootToken;
  const since = new Date(Date.now() - 30 * DAY);

  const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000);
  const user = (content, minutesAgo = 60) => ({ content, sender: 'user', timestamp: at(minutesAgo) });
  const bot = (content, minutesAgo = 59, extra = {}) => ({ content, sender: 'bot', timestamp: at(minutesAgo), ...extra });
  const op = (content, minutesAgo = 58, extra = {}) => ({ content, sender: 'operator', timestamp: at(minutesAgo), ...extra });

  const conversation = (overrides = {}) => Conversation.create({
    sessionId: `rep-${Math.random().toString(36).slice(2, 10)}`,
    company: company._id,
    startedAt: at(90),
    lastActivity: at(30),
    ...overrides
  });

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: PASSWORD })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/admin', require('../routes/admin'));

    company = await Company.create({ name: 'Reports Co', businessHours: { timezone: 'Asia/Tokyo' } });
    match = { company: company._id };
    await User.create({
      username: 'reports-admin', email: 'admin@reports.example', password: PASSWORD,
      role: 'company_admin', company: company._id
    });
    await User.create({
      username: 'reports-root', email: 'root@reports.example', password: PASSWORD, role: 'superadmin'
    });
    adminToken = await login('reports-admin');
    rootToken = await login('reports-root');
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: company._id });
    await Subscription.deleteMany({ company: company._id });
    usageService.invalidateSubscription(company._id);
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: company._id });
    await Subscription.deleteMany({ company: company._id });
    await User.deleteMany({ email: /@reports\.example$/ });
    await Company.deleteMany({ name: 'Reports Co' });
  });

  describe('who handled it', () => {
    test('a finished chat a person took part in is not a bot win, though hasOperator was cleared', async () => {
      await conversation({
        status: 'ended', hasOperator: false, operatorEverJoined: true,
        messages: [user('my order', 60), bot('let me check', 59), user('a person please', 58), op('hello', 50)]
      });

      const result = await analytics.deflection(match, since);
      expect(result.eligible).toBe(1);
      expect(result.deflected).toBe(0);
      expect(result.escalated).toBe(1);
    });

    test('an older row with an operator message counts as a person joining', async () => {
      await conversation({
        status: 'ended', hasOperator: false,
        messages: [user('one', 60), bot('two', 59), user('three', 58), op('four', 57)]
      });
      expect((await analytics.deflection(match, since)).escalated).toBe(1);
    });

    test('asking for a person and getting nobody is not a deflection either', async () => {
      await conversation({
        handoff: { requestedAt: at(55), reason: 'visitor_request' },
        messages: [user('one', 60), bot('two', 59), user('a person', 56)]
      });

      const result = await analytics.deflection(match, since);
      expect(result.deflected).toBe(0);
      expect(result.unmetHandoffs).toBe(1);
    });

    test('operator performance includes ended chats, credited to whoever replied', async () => {
      await conversation({
        status: 'ended', hasOperator: false, operatorEverJoined: true, operatorName: null,
        messages: [user('hello', 60), op('hi there', 50, { operatorName: 'Dana' })]
      });

      const [dana] = await analytics.operatorPerformance(match, since);
      expect(dana.operator).toBe('Dana');
      expect(dana.conversations).toBe(1);
      expect(dana.avgResponseSeconds).toBe(600);
    });
  });

  describe('empty conversations', () => {
    beforeEach(async () => {
      // Opened and closed the widget: no message, no details.
      await conversation({ messages: [] });
      await conversation({ messages: [], status: 'active' });
    });

    test('count for nothing anywhere', async () => {
      expect((await analytics.abandonment(match, since)).total).toBe(0);
      expect(await analytics.peakHours(match, since)).toEqual([]);

      const overview = await analytics.overview(match, 7);
      expect(overview.activeChats).toBe(0);
      expect(overview.conversationMetrics.current.total).toBe(0);
      expect(overview.chatVolumePerDay.every(day => day.count === 0)).toBe(true);
    });

    test('but leaving contact details is not empty', async () => {
      await conversation({ messages: [], metadata: { email: 'someone@example.com' } });
      const overview = await analytics.overview(match, 7);
      expect(overview.conversationMetrics.current.total).toBe(1);
    });
  });

  describe('what people ask about', () => {
    test('keeps words in any alphabet', async () => {
      await conversation({ messages: [user('Unde este livrarea comenzii mele?')] });
      await conversation({ messages: [user('Где моя доставка? livrarea')] });

      const terms = (await analytics.topics(match, since)).map(topic => topic.term);
      expect(terms).toContain('livrarea');
      expect(terms).toContain('доставка');
      const livrarea = (await analytics.topics(match, since)).find(topic => topic.term === 'livrarea');
      expect(livrarea.conversations).toBe(2);
    });
  });

  describe('when conversations start', () => {
    test('is in the company\'s timezone', async () => {
      // Monday 23:30 in London (UTC in winter) is Tuesday 08:30 in Tokyo.
      const startedAt = new Date('2026-01-05T23:30:00Z');
      await conversation({ startedAt, messages: [user('hello', 0)] });

      const longAgo = new Date('2026-01-01T00:00:00Z');
      const [cell] = await analytics.peakHours(match, longAgo, 'Asia/Tokyo');
      expect(cell).toEqual({ day: 2, hour: 8, count: 1 });

      const [utc] = await analytics.peakHours(match, longAgo);
      expect(utc).toEqual({ day: 1, hour: 23, count: 1 });
    });
  });

  describe('the overview', () => {
    test('waiting means a person was asked for and nobody has picked up', async () => {
      await conversation({ status: 'active', messages: [user('the bot is handling me')] });
      await conversation({
        status: 'active', handoff: { requestedAt: at(5), reason: 'visitor_request' },
        messages: [user('a person please')]
      });
      await conversation({
        status: 'active', hasOperator: true, handoff: { requestedAt: at(5), reason: 'visitor_request' },
        messages: [user('a person please')]
      });

      const overview = await analytics.overview(match, 7);
      expect(overview.activeChats).toBe(3);
      expect(overview.waitingForPerson).toBe(1);
    });

    test('first response is a person\'s, from when they were asked for', async () => {
      await conversation({
        startedAt: at(60), handoff: { requestedAt: at(40), reason: 'visitor_request' },
        firstOperatorReplyAt: at(38), operatorEverJoined: true,
        messages: [user('hi', 60), bot('hello', 60), user('a person', 40), op('here', 38)]
      });
      // A bot-only conversation has no first response from a person.
      await conversation({ messages: [user('hi', 60), bot('hello', 60)] });

      const overview = await analytics.overview(match, 7);
      expect(overview.avgFirstResponseSeconds).toBe(120);
      expect(overview.firstResponseCount).toBe(1);
      expect(overview.chatVolumePerDay).toHaveLength(7);
      const today = overview.chatVolumePerDay[overview.chatVolumePerDay.length - 1];
      expect(today.count).toBe(2);
      expect(today.reachedPerson).toBe(1);
    });

    test('the window follows ?days= and says which it is', async () => {
      await conversation({ startedAt: at(20 * 24 * 60), messages: [user('three weeks ago', 20 * 24 * 60)] });

      const week = await request(app).get('/api/admin/analytics?days=7').set('x-auth-token', adminToken);
      const month = await request(app).get('/api/admin/analytics?days=30').set('x-auth-token', adminToken);

      expect(week.body.range.days).toBe(7);
      expect(week.body.conversationMetrics.current.total).toBe(0);
      expect(month.body.range.days).toBe(30);
      expect(month.body.conversationMetrics.current.total).toBe(1);
      expect(month.body.chatVolumePerDay.length).toBeGreaterThanOrEqual(30);
    });

    test('a superadmin reads one tenant at a time', async () => {
      await conversation({ messages: [user('hello')] });
      const one = await request(app).get(`/api/admin/analytics?companyId=${company._id}`).set('x-auth-token', rootToken);
      expect(one.status).toBe(200);
      expect(one.body.company.name).toBe('Reports Co');
      expect(one.body.conversationMetrics.current.total).toBe(1);

      expect((await request(app).get('/api/admin/analytics?companyId=nope').set('x-auth-token', rootToken)).status).toBe(400);
    });
  });

  describe('the value report', () => {
    beforeEach(async () => {
      // Resolved: wrote, answered, nobody needed.
      await conversation({ messages: [user('opening hours?'), bot('9 to 5', 59, { path: 'assistant' })] });
      await conversation({ messages: [user('parking?'), bot('round the back', 59, { path: 'canned' })], rating: { score: 5, handledBy: 'bot' } });
      // Not resolved: the bot did not know.
      await conversation({ messages: [user('do you do implants?'), bot('I am not sure', 59, { path: 'assistant', unanswered: true })] });
      // Not resolved: rated badly.
      await conversation({ messages: [user('price?'), bot('£50', 59, { path: 'assistant' })], rating: { score: 1, handledBy: 'bot' } });
      // Not resolved: a person took over.
      await conversation({
        operatorEverJoined: true,
        messages: [user('complaint'), bot('sorry', 59, { path: 'assistant' }), op('I can help', 50)],
        rating: { score: 4, handledBy: 'operator' }
      });
      // Not resolved: asked for a person.
      await conversation({
        handoff: { requestedAt: at(55), reason: 'visitor_request' },
        messages: [user('person please'), bot('one moment', 59, { path: 'handoff' })]
      });
      // Not a conversation at all.
      await conversation({ messages: [] });
    });

    test('counts only what the bot really resolved', async () => {
      const report = await analytics.value(match, 30, { monthlyPrice: 99 });

      expect(report.conversations).toBe(6);
      expect(report.botResolved).toBe(2);
      expect(report.handedOver).toBe(2);
      expect(report.resolutionRate).toBe(33);
      expect(report.minutesPerConversation).toBe(6);
      expect(report.hoursSaved).toBe(0.2);
      // Canned and handoff replies are not the model's.
      expect(report.aiReplies).toBe(4);
      expect(report.costPerResolution).toBe(49.5);
      expect(report.csatBot.rated).toBe(2);
      expect(report.csatHuman.rated).toBe(1);
      expect(report.definition.botResolved).toMatch(/no person joined/);
    });

    test('a week is charged a week\'s share of the price, and nothing resolved costs nothing per resolution', async () => {
      expect((await analytics.value(match, 7, { monthlyPrice: 30 })).costPerResolution).toBe(3.5);
      expect((await analytics.value({ company: new mongoose.Types.ObjectId() }, 30, { monthlyPrice: 30 })).costPerResolution).toBeNull();
    });

    test('is on every plan, uses the company\'s own minutes, and exports as CSV', async () => {
      await Subscription.create({ company: company._id, planId: 'basic', status: 'active' });

      const saved = await request(app).put('/api/admin/analytics/settings').set('x-auth-token', adminToken)
        .send({ minutesPerConversation: 15 });
      expect(saved.status).toBe(200);
      expect((await request(app).put('/api/admin/analytics/settings').set('x-auth-token', adminToken)
        .send({ minutesPerConversation: 0 })).status).toBe(400);

      const report = await request(app).get('/api/admin/analytics/value?days=30').set('x-auth-token', adminToken);
      expect(report.status).toBe(200);
      expect(report.body.minutesPerConversation).toBe(15);
      expect(report.body.hoursSaved).toBe(0.5);
      expect(report.body.costPerResolution).toBe(14.5);

      const csv = await request(app).get('/api/admin/analytics/value/export?days=30').set('x-auth-token', adminToken);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toMatch(/"Resolved by the bot","2"/);
    });
  });

  describe('a metric that fails', () => {
    test('comes back as unavailable rather than as zero', async () => {
      jest.spyOn(Task, 'aggregate').mockRejectedValueOnce(new Error('database blip'));

      const result = await analytics.advanced({ role: 'company_admin', company: { id: company._id } }, 30);
      expect(result.tasks).toBeNull();
      expect(result.unavailable).toEqual(['tasks']);
      expect(result.deflection).not.toBeNull();

      jest.restoreAllMocks();
    });
  });
});
