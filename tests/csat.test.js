/**
 * Customer satisfaction ratings.
 *
 * The rating comes from a visitor, so the tests that matter are about what the
 * visitor cannot do: rate somebody else's conversation, rate twice, or move a
 * score after the fact.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const csat = require('../services/csat');
const analytics = require('../services/analytics');

const daysAgo = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe('CSAT', () => {
  let acme;
  let rival;
  let alice;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({ name: 'Csat Acme' });
    rival = await Company.create({ name: 'Csat Rival' });
    alice = await User.create({
      username: 'csat-alice', email: 'alice@csat.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Alice Anderson', company: acme._id
    });
  });

  afterAll(async () => {
    // Scoped to this suite's own companies: a bare deleteMany would take out
    // the fixtures of every suite running in parallel.
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@csat\.example$/ });
    await Company.deleteMany({ name: /^Csat / });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
  });

  const conversation = async (overrides = {}) => Conversation.create({
    sessionId: overrides.sessionId || `csat-${Math.random().toString(36).slice(2)}`,
    company: acme._id,
    messages: [
      { content: 'hello', sender: 'user' },
      { content: 'hi there', sender: 'bot' },
      { content: 'where is my order', sender: 'user' }
    ],
    ...overrides
  });

  describe('when to ask', () => {
    test('a real conversation is worth asking about', async () => {
      expect(csat.shouldRequestRating(await conversation())).toBe(true);
    });

    test('a single message is not', async () => {
      // Asking after one "hi" annoys people and produces noise.
      const short = await conversation({ messages: [{ content: 'hi', sender: 'user' }] });
      expect(csat.shouldRequestRating(short)).toBe(false);
    });

    test('somebody already asked is not asked again', async () => {
      const asked = await conversation({ ratingRequestedAt: new Date() });
      expect(csat.shouldRequestRating(asked)).toBe(false);
    });

    test('somebody who already rated is not asked again', async () => {
      const rated = await conversation({ rating: { score: 5, ratedAt: new Date() } });
      expect(csat.shouldRequestRating(rated)).toBe(false);
    });

    test('declining is remembered, so a reconnect does not ask again', async () => {
      const chat = await conversation({ sessionId: 'csat-declined' });
      await csat.markRequested('csat-declined');

      const reloaded = await Conversation.findById(chat._id);
      expect(csat.shouldRequestRating(reloaded)).toBe(false);
    });
  });

  describe('recording a score', () => {
    test('a valid score is stored', async () => {
      await conversation({ sessionId: 'csat-happy' });
      const result = await csat.record('csat-happy', 5);

      expect(result.ok).toBe(true);
      expect(result.rating.score).toBe(5);
      expect(result.rating.ratedAt).toBeInstanceOf(Date);
    });

    test.each([0, 6, -1, 2.5, 'five', null, undefined, NaN])(
      '%p is refused',
      async score => {
        await conversation({ sessionId: `csat-bad-${String(score)}` });
        const result = await csat.record(`csat-bad-${String(score)}`, score);

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/1 to 5/);
      }
    );

    test('an unknown session cannot be rated', async () => {
      const result = await csat.record('csat-does-not-exist', 5);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    test('a score cannot be revised once given', async () => {
      // Otherwise anyone still holding the session could overwrite a rating at
      // will — a 1 turned into a 5, or the reverse.
      await conversation({ sessionId: 'csat-once' });
      await csat.record('csat-once', 2);
      const second = await csat.record('csat-once', 5);

      expect(second.duplicate).toBe(true);
      expect((await Conversation.findOne({ sessionId: 'csat-once' })).rating.score).toBe(2);
    });

    test('a comment sent after the score is kept', async () => {
      // The widget records the score the moment it is tapped and only then
      // offers a comment box, so this second call is how every comment
      // arrives. Treating it purely as a duplicate threw them all away.
      await conversation({ sessionId: 'csat-comment' });
      await csat.record('csat-comment', 4);
      const followUp = await csat.record('csat-comment', 4, '  Sorted it quickly.  ');

      expect(followUp.commentAdded).toBe(true);
      expect((await Conversation.findOne({ sessionId: 'csat-comment' })).rating.comment)
        .toBe('Sorted it quickly.');
    });

    test('a comment cannot be replaced either', async () => {
      await conversation({ sessionId: 'csat-comment-once' });
      await csat.record('csat-comment-once', 4, 'First thought.');
      await csat.record('csat-comment-once', 4, 'Second thought.');

      expect((await Conversation.findOne({ sessionId: 'csat-comment-once' })).rating.comment)
        .toBe('First thought.');
    });

    test('an overlong comment is truncated rather than rejected', async () => {
      await conversation({ sessionId: 'csat-long' });
      await csat.record('csat-long', 3, 'x'.repeat(5000));

      expect((await Conversation.findOne({ sessionId: 'csat-long' })).rating.comment)
        .toHaveLength(1000);
    });
  });

  describe('who gets the credit', () => {
    test('a conversation with no operator is the bot\'s', async () => {
      await conversation({ sessionId: 'csat-bot' });
      const result = await csat.record('csat-bot', 5);

      expect(result.rating.handledBy).toBe('bot');
    });

    test('the last operator to speak is credited', async () => {
      // Ending a chat clears the conversation's operator fields, so reading
      // them at rating time would attribute every score to nobody.
      await conversation({
        sessionId: 'csat-operator',
        operatorId: null,
        operatorName: null,
        messages: [
          { content: 'hello', sender: 'user' },
          { content: 'one moment', sender: 'operator', operatorId: alice._id, operatorName: 'Alice Anderson' },
          { content: 'thanks', sender: 'user' }
        ]
      });

      const result = await csat.record('csat-operator', 5);

      expect(result.rating.handledBy).toBe('operator');
      expect(result.rating.operatorName).toBe('Alice Anderson');
      expect(String(result.rating.operatorId)).toBe(String(alice._id));
    });

    test('after a transfer the operator who finished it is credited', async () => {
      await conversation({
        sessionId: 'csat-transfer',
        messages: [
          { content: 'hello', sender: 'user' },
          { content: 'let me pass you on', sender: 'operator', operatorName: 'Bob Brown' },
          { content: 'I can help', sender: 'operator', operatorName: 'Alice Anderson' },
          { content: 'thanks', sender: 'user' }
        ]
      });

      const result = await csat.record('csat-transfer', 4);
      expect(result.rating.operatorName).toBe('Alice Anderson');
    });
  });

  describe('reporting', () => {
    const match = () => ({ company: acme._id });

    const rated = async (score, extra = {}) => {
      const chat = await conversation({ ...extra });
      chat.rating = { score, ratedAt: new Date(), handledBy: 'bot', ...(extra.rating || {}) };
      chat.ratingRequestedAt = new Date();
      await chat.save();
      return chat;
    };

    test('nothing rated reports nulls rather than zero', async () => {
      // A CSAT of 0% and "no ratings yet" mean very different things, and a
      // dashboard that shows the first when it means the second is a lie.
      const summary = await csat.summary(match(), daysAgo(30));

      expect(summary.rated).toBe(0);
      expect(summary.average).toBeNull();
      expect(summary.csat).toBeNull();
    });

    test('CSAT is the share satisfied, not the mean', async () => {
      // 5, 5, 4, 2, 1 — mean 3.4, but three of five were satisfied.
      for (const score of [5, 5, 4, 2, 1]) {
        await rated(score);
      }

      const summary = await csat.summary(match(), daysAgo(30));

      expect(summary.rated).toBe(5);
      expect(summary.average).toBe(3.4);
      expect(summary.csat).toBe(60);
      expect(summary.distribution).toEqual([1, 1, 0, 1, 2]);
    });

    test('the response rate is reported beside the score', async () => {
      // Without it a tenant cannot tell 5.0 from four people apart from 5.0
      // from four hundred.
      await rated(5);
      await rated(5);
      const unanswered = await conversation();
      unanswered.ratingRequestedAt = new Date();
      await unanswered.save();

      const summary = await csat.summary(match(), daysAgo(30));

      expect(summary.asked).toBe(3);
      expect(summary.rated).toBe(2);
      expect(summary.responseRate).toBe(67);
    });

    test('another company\'s ratings are not counted', async () => {
      await rated(5);
      const theirs = await Conversation.create({
        sessionId: 'csat-rival', company: rival._id,
        messages: [{ content: 'hi', sender: 'user' }],
        rating: { score: 1, ratedAt: new Date(), handledBy: 'bot' },
        ratingRequestedAt: new Date()
      });

      const summary = await csat.summary(match(), daysAgo(30));

      expect(summary.rated).toBe(1);
      expect(summary.average).toBe(5);
      expect(theirs.company).not.toEqual(acme._id);
    });

    test('ratings outside the window are excluded', async () => {
      const old = await rated(1);
      old.startedAt = daysAgo(90);
      await old.save();
      await rated(5);

      const summary = await csat.summary(match(), daysAgo(30));
      expect(summary.rated).toBe(1);
      expect(summary.average).toBe(5);
    });

    test('bot and operator satisfaction are reported apart', async () => {
      // The comparison a deflection rate is meaningless without.
      await rated(2, { rating: { handledBy: 'bot' } });
      await rated(2, { rating: { handledBy: 'bot' } });
      await rated(5, { rating: { handledBy: 'operator', operatorName: 'Alice Anderson' } });

      const split = await csat.byHandler(match(), daysAgo(30));

      expect(split.bot).toMatchObject({ rated: 2, average: 2, csat: 0 });
      expect(split.operator).toMatchObject({ rated: 1, average: 5, csat: 100 });
    });

    test('per-operator figures carry their sample size', async () => {
      await rated(5, { rating: { handledBy: 'operator', operatorName: 'Alice Anderson' } });
      await rated(3, { rating: { handledBy: 'operator', operatorName: 'Alice Anderson' } });

      const [row] = await csat.byOperator(match(), daysAgo(30));

      expect(row).toMatchObject({ operator: 'Alice Anderson', rated: 2, average: 4, csat: 50 });
    });

    test('comments come back newest first', async () => {
      await rated(1, { rating: { comment: 'Older', ratedAt: daysAgo(2), handledBy: 'bot' } });
      await rated(2, { rating: { comment: 'Newer', ratedAt: new Date(), handledBy: 'bot' } });

      const rows = await csat.comments(match(), daysAgo(30));

      expect(rows.map(row => row.rating.comment)).toEqual(['Newer', 'Older']);
    });

    test('conversations with no comment are left out of the comment list', async () => {
      await rated(5);
      expect(await csat.comments(match(), daysAgo(30))).toHaveLength(0);
    });

    test('satisfaction is reported alongside deflection', async () => {
      // Returned together on purpose: deflection without satisfaction rewards a
      // bot that is merely hard to escape.
      await rated(5, { rating: { handledBy: 'bot' } });

      const report = await analytics.advanced(
        { role: 'company_admin', company: { id: acme._id.toString() } },
        30
      );

      expect(report.deflection).toBeDefined();
      expect(report.satisfaction.rated).toBe(1);
      expect(report.satisfaction.byHandler.bot.rated).toBe(1);
    });
  });
});
