/**
 * The scheduler's two sweeps over open conversations: alerting the team
 * about a visitor who has waited too long, and ending chats left idle.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Notification = require('../models/notification');
const User = require('../models/user');
const webhookService = require('../services/webhooks');
const sweeps = require('../services/conversation-sweeps');

const MINUTE = 60 * 1000;

describe('conversation sweeps', () => {
  let company;
  let quiet;
  let admin;
  let operator;
  let away;

  const visitorMessage = { sender: 'user', content: 'Hello?', timestamp: new Date() };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'Sweeps Clinic', routing: { escalateAfterMinutes: 5 } });
    quiet = await Company.create({ name: 'Sweeps Quiet', routing: { escalateAfterMinutes: 0 } });

    const make = (username, role, extra = {}) => User.create({
      username, email: `${username}@sweeps.test`, password: 'TestPassword123!', role, company: company._id, ...extra
    });
    admin = await make('sweeps-admin', 'company_admin');
    operator = await make('sweeps-op', 'operator');
    away = await make('sweeps-away', 'operator', { acceptingChats: false });
  });

  beforeEach(async () => {
    await Promise.all([
      Conversation.deleteMany({ sessionId: /^sweeps-/ }),
      Notification.deleteMany({ userId: { $in: [admin._id, operator._id, away._id] } })
    ]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Promise.all([
      Conversation.deleteMany({ sessionId: /^sweeps-/ }),
      Notification.deleteMany({ userId: { $in: [admin._id, operator._id, away._id] } }),
      User.deleteMany({ email: /@sweeps\.test$/ }),
      Company.deleteMany({ _id: { $in: [company._id, quiet._id] } })
    ]);
  });

  describe('a long wait', () => {
    test('alerts every admin and everyone taking chats, once', async () => {
      const now = new Date();
      await Conversation.create({
        sessionId: 'sweeps-waiting', company: company._id, status: 'active',
        messages: [visitorMessage],
        metadata: { name: 'Jamie' },
        handoff: { requestedAt: new Date(now - 7 * MINUTE), reason: 'visitor_request' }
      });

      expect(await sweeps.escalateLongWaits(now)).toBe(1);

      const sent = await Notification.find({ sessionId: 'sweeps-waiting' }).lean();
      expect(sent.map(n => String(n.userId)).sort()).toEqual([String(admin._id), String(operator._id)].sort());
      expect(sent[0]).toMatchObject({ type: 'visitor_waiting' });
      expect(sent[0].message).toMatch(/Jamie has waited 7 minutes/);

      // The next minute's run says nothing more about the same wait.
      expect(await sweeps.escalateLongWaits(new Date(now.getTime() + MINUTE))).toBe(0);
      expect(await Notification.countDocuments({ sessionId: 'sweeps-waiting' })).toBe(2);
    });

    test('a short wait, a held chat or one a person already answered is left alone', async () => {
      const now = new Date();
      await Conversation.create([
        { sessionId: 'sweeps-short', company: company._id, status: 'active', messages: [visitorMessage],
          handoff: { requestedAt: new Date(now - 2 * MINUTE), reason: 'visitor_request' } },
        { sessionId: 'sweeps-held', company: company._id, status: 'active', messages: [visitorMessage],
          hasOperator: true, handoff: { requestedAt: new Date(now - 20 * MINUTE), reason: 'visitor_request' } },
        { sessionId: 'sweeps-answered', company: company._id, status: 'active', messages: [visitorMessage],
          operatorEverJoined: true, handoff: { requestedAt: new Date(now - 20 * MINUTE), reason: 'visitor_request' } }
      ]);

      expect(await sweeps.escalateLongWaits(now)).toBe(0);
    });

    test('a company that turned it off is never alerted', async () => {
      const now = new Date();
      await Conversation.create({
        sessionId: 'sweeps-quiet', company: quiet._id, status: 'active', messages: [visitorMessage],
        awaitingOperatorSince: new Date(now - 60 * MINUTE)
      });

      expect(await sweeps.escalateLongWaits(now)).toBe(0);
    });
  });

  describe('an idle chat', () => {
    test('is ended after a day of silence, and the tenant\'s systems are told', async () => {
      const dispatch = jest.spyOn(webhookService, 'dispatch').mockResolvedValue();
      const now = new Date();
      await Conversation.create({
        sessionId: 'sweeps-idle', company: company._id, status: 'active', channel: 'chat',
        messages: [visitorMessage, { sender: 'bot', content: 'We open at nine.' }],
        lastActivity: new Date(now - 25 * 60 * MINUTE)
      });

      expect(await sweeps.closeIdleConversations(now)).toBe(1);

      const stored = await Conversation.findOne({ sessionId: 'sweeps-idle' }).lean();
      expect(stored).toMatchObject({ status: 'ended' });
      expect(stored.endedAt).toBeInstanceOf(Date);
      expect(dispatch).toHaveBeenCalledWith(company._id, 'conversation.ended',
        expect.objectContaining({ sessionId: 'sweeps-idle', endedBy: 'idle', messages: 2 }));
    });

    test('a recent chat, one an operator holds, or an email thread stays open', async () => {
      jest.spyOn(webhookService, 'dispatch').mockResolvedValue();
      const now = new Date();
      const old = new Date(now - 30 * 60 * MINUTE);
      await Conversation.create([
        { sessionId: 'sweeps-recent', company: company._id, status: 'active', messages: [visitorMessage],
          lastActivity: new Date(now - 60 * MINUTE) },
        { sessionId: 'sweeps-holding', company: company._id, status: 'active', messages: [visitorMessage],
          hasOperator: true, lastActivity: old },
        { sessionId: 'sweeps-email', company: company._id, status: 'active', channel: 'email',
          messages: [visitorMessage], lastActivity: old }
      ]);

      expect(await sweeps.closeIdleConversations(now)).toBe(0);
      const statuses = await Conversation.find({ sessionId: /^sweeps-/ }).distinct('status');
      expect(statuses).toEqual(['active']);
    });
  });
});
