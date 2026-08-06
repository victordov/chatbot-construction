/**
 * Advanced analytics.
 *
 * These assert on the definitions, because the numbers are only useful if the
 * definitions are defensible: "deflected" must not count an abandoned "hi",
 * and "unanswered" must mean nobody replied at all.
 */

const mongoose = require('mongoose');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const analytics = require('../services/analytics');

describe('Advanced analytics', () => {
  let company;
  let user;
  const since = new Date(Date.now() - 30 * 86400000);

  const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000);

  const conversation = (overrides = {}) => ({
    sessionId: `an-${Math.random().toString(36).slice(2, 10)}`,
    company: company._id,
    startedAt: at(60),
    lastActivity: at(30),
    ...overrides
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'Analytics Co' });
    user = { role: 'company_admin', company: { id: company._id } };
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: company._id });
    await Company.deleteMany({ name: 'Analytics Co' });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: company._id });
  });

  describe('deflection', () => {
    test('counts a bot-only conversation as deflected', async () => {
      await Conversation.create(conversation({
        hasOperator: false,
        messages: [
          { content: 'where is my order', sender: 'user', timestamp: at(60) },
          { content: 'let me check', sender: 'bot', timestamp: at(59) },
          { content: 'thanks', sender: 'user', timestamp: at(58) }
        ]
      }));

      const result = await analytics.deflection({ company: company._id }, since);
      expect(result.deflected).toBe(1);
      expect(result.rate).toBe(100);
    });

    test('does not count a conversation an operator joined', async () => {
      await Conversation.create(conversation({
        hasOperator: true,
        messages: [
          { content: 'where is my order', sender: 'user', timestamp: at(60) },
          { content: 'let me check', sender: 'bot', timestamp: at(59) },
          { content: 'still waiting', sender: 'user', timestamp: at(58) }
        ]
      }));

      const result = await analytics.deflection({ company: company._id }, since);
      expect(result.deflected).toBe(0);
      expect(result.escalated).toBe(1);
    });

    test('ignores a one-message conversation, so an abandoned "hi" is not a win', async () => {
      await Conversation.create(conversation({
        hasOperator: false,
        messages: [
          { content: 'hi', sender: 'user', timestamp: at(60) },
          { content: 'hello, how can I help?', sender: 'bot', timestamp: at(59) }
        ]
      }));

      const result = await analytics.deflection({ company: company._id }, since);
      expect(result.eligible).toBe(0);
      expect(result.deflected).toBe(0);
    });
  });

  describe('abandonment', () => {
    test('counts a conversation nobody replied to', async () => {
      await Conversation.create(conversation({
        messages: [{ content: 'anyone there?', sender: 'user', timestamp: at(60) }]
      }));

      const result = await analytics.abandonment({ company: company._id }, since);
      expect(result.unanswered).toBe(1);
      expect(result.rate).toBe(100);
    });

    test('does not count a conversation that got any reply', async () => {
      await Conversation.create(conversation({
        messages: [
          { content: 'anyone there?', sender: 'user', timestamp: at(60) },
          { content: 'yes, hello', sender: 'bot', timestamp: at(59) }
        ]
      }));

      const result = await analytics.abandonment({ company: company._id }, since);
      expect(result.unanswered).toBe(0);
    });
  });

  describe('operator performance', () => {
    test('measures time to first reply, not time since the last visitor message', async () => {
      // Three visitor messages in a row then one reply: the operator waited
      // 10 minutes from the first, not 2 from the last.
      await Conversation.create(conversation({
        hasOperator: true,
        operatorName: 'Dana',
        messages: [
          { content: 'hello', sender: 'user', timestamp: at(60) },
          { content: 'are you there', sender: 'user', timestamp: at(54) },
          { content: 'still waiting', sender: 'user', timestamp: at(52) },
          { content: 'sorry for the wait', sender: 'operator', timestamp: at(50) }
        ]
      }));

      const [dana] = await analytics.operatorPerformance({ company: company._id }, since);
      expect(dana.operator).toBe('Dana');
      expect(dana.replies).toBe(1);
      expect(dana.avgResponseSeconds).toBe(600);
    });

    test('reports a median as well as a mean', async () => {
      await Conversation.create(conversation({
        hasOperator: true,
        operatorName: 'Dana',
        messages: [
          { content: 'q1', sender: 'user', timestamp: at(60) },
          { content: 'a1', sender: 'operator', timestamp: at(59) },
          { content: 'q2', sender: 'user', timestamp: at(58) },
          { content: 'a2', sender: 'operator', timestamp: at(57) },
          { content: 'q3', sender: 'user', timestamp: at(56) },
          // One very slow reply, which should move the mean far more than the median.
          { content: 'a3', sender: 'operator', timestamp: at(6) }
        ]
      }));

      const [dana] = await analytics.operatorPerformance({ company: company._id }, since);
      expect(dana.medianResponseSeconds).toBeLessThan(dana.avgResponseSeconds);
    });
  });

  describe('topics', () => {
    test('counts a term once per conversation, not once per mention', async () => {
      await Conversation.create(conversation({
        messages: [
          { content: 'refund refund refund refund', sender: 'user', timestamp: at(60) }
        ]
      }));
      await Conversation.create(conversation({
        messages: [{ content: 'refund please', sender: 'user', timestamp: at(60) }]
      }));

      const result = await analytics.topics({ company: company._id }, since);
      const refund = result.find(t => t.term === 'refund');
      expect(refund.conversations).toBe(2);
    });

    test('excludes filler words', async () => {
      await Conversation.create(conversation({
        messages: [{ content: 'hello please can you help me with the thing', sender: 'user', timestamp: at(60) }]
      }));

      const result = await analytics.topics({ company: company._id }, since);
      const terms = result.map(t => t.term);
      expect(terms).not.toContain('please');
      expect(terms).not.toContain('hello');
      expect(terms).not.toContain('the');
    });

    test('ignores operator and bot messages', async () => {
      await Conversation.create(conversation({
        messages: [
          { content: 'sprocket', sender: 'user', timestamp: at(60) },
          { content: 'flange flange flange', sender: 'bot', timestamp: at(59) }
        ]
      }));

      const result = await analytics.topics({ company: company._id }, since);
      expect(result.map(t => t.term)).toContain('sprocket');
      expect(result.map(t => t.term)).not.toContain('flange');
    });
  });

  describe('tenant scoping', () => {
    test('another company\'s conversations are not counted', async () => {
      const other = await Company.create({ name: 'Analytics Other Co' });

      await Conversation.create({
        sessionId: 'other-tenant', company: other._id, startedAt: at(60),
        messages: [
          { content: 'their question', sender: 'user', timestamp: at(60) },
          { content: 'their answer', sender: 'bot', timestamp: at(59) },
          { content: 'thanks', sender: 'user', timestamp: at(58) }
        ]
      });

      const result = await analytics.advanced(user, 30);
      expect(result.deflection.eligible).toBe(0);

      await Conversation.deleteMany({ company: other._id });
      await Company.deleteOne({ _id: other._id });
    });
  });

  test('advanced() returns every metric even with no data', async () => {
    const result = await analytics.advanced(user, 30);

    expect(result).toHaveProperty('deflection.rate');
    expect(result).toHaveProperty('abandonment.rate');
    expect(Array.isArray(result.peakHours)).toBe(true);
    expect(Array.isArray(result.operators)).toBe(true);
    expect(Array.isArray(result.topics)).toBe(true);
    expect(result).toHaveProperty('tasks.completionRate');
  });
});
