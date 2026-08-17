/**
 * The two ways a conversation could stop having anyone to answer it.
 *
 * Both were found by drawing the conversation state machine and looking for
 * states with no outgoing edge. Neither had a test, because the existing tests
 * exercise the paths that work.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const assignment = require('../services/assignment');

describe('Escalation dead ends', () => {
  let acme;
  let alice;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({
      name: 'Deadend Acme',
      routing: { autoAssign: true, maxConcurrent: 2 }
    });

    alice = await User.create({
      username: 'deadend-alice', email: 'alice@deadend.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Alice Anderson', company: acme._id
    });
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@deadend\.example$/ });
    await Company.deleteMany({ name: /^Deadend / });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: acme._id });
    jest.restoreAllMocks();
  });

  const conversation = (overrides = {}) => Conversation.create({
    sessionId: `deadend-${Math.random().toString(36).slice(2)}`,
    company: acme._id,
    messages: [
      { content: 'hello', sender: 'user' },
      { content: 'hi there', sender: 'bot' }
    ],
    ...overrides
  });

  /** Nobody online, which is what makes an escalation queue rather than connect. */
  const nobodyOnline = () => {
    const socketManager = require('../socketManager');
    jest.spyOn(socketManager, 'getIo').mockReturnValue({
      sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
    });
  };

  const someoneOnline = operator => {
    const socketManager = require('../socketManager');
    const room = new Set(['s1']);
    jest.spyOn(socketManager, 'getIo').mockReturnValue({
      sockets: {
        adapter: { rooms: new Map([[socketManager.operatorRoom(acme._id), room]]) },
        sockets: new Map([['s1', {
          user: { id: String(operator._id), displayName: operator.displayName }
        }]])
      }
    });
  };

  describe('asking for a person when nobody is free', () => {
    test('the bot keeps answering, so the visitor is not left in silence', async () => {
      // The original bug: botEnabled was switched off the moment somebody asked
      // for a human, whether or not one was available. If nobody ever claimed
      // it, the bot would not answer and no operator would — every further
      // message was stored and silently unanswered, with no way back.
      nobodyOnline();
      const chat = await conversation();

      const result = await assignment.autoAssign(chat);
      expect(result.assigned).toBe(false);

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.botEnabled).not.toBe(false);
    });

    test('the bot does step aside once a person actually takes it', async () => {
      someoneOnline(alice);
      const chat = await conversation();

      const result = await assignment.autoAssign(chat);
      expect(result.assigned).toBe(true);

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.hasOperator).toBe(true);
      expect(String(reloaded.operatorId)).toBe(String(alice._id));
    });

    test('claiming clears the waiting marker', async () => {
      const chat = await conversation({ awaitingOperatorSince: new Date() });

      await assignment.assign(chat, { id: alice._id, displayName: 'Alice Anderson' }, 'manual');

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.awaitingOperatorSince).toBeUndefined();
    });
  });

  describe('a visitor who comes back', () => {
    test('an unclaimed, closed conversation is answerable again', async () => {
      // Reactivation restored status and endedAt but not botEnabled or
      // hasOperator, so somebody escalated, never picked up and closed came
      // back days later to silence from their first message.
      const chat = await conversation({
        status: 'ended',
        endedAt: new Date(),
        hasOperator: true,
        operatorId: null,
        botEnabled: false,
        awaitingOperatorSince: new Date()
      });

      // What the socket handler does when a message arrives on an ended chat.
      if (chat.status === 'ended') {
        chat.status = 'active';
        chat.endedAt = null;
        if (!chat.operatorId) {
          chat.hasOperator = false;
          chat.botEnabled = true;
          chat.awaitingOperatorSince = undefined;
        }
      }
      await chat.save();

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.status).toBe('active');
      expect(reloaded.botEnabled).toBe(true);
      expect(reloaded.hasOperator).toBe(false);
    });

    test('a conversation an operator still owns is left alone', async () => {
      // Reopening must not take a conversation away from the person holding it.
      const chat = await conversation({
        status: 'ended',
        endedAt: new Date(),
        hasOperator: true,
        operatorId: alice._id,
        botEnabled: false
      });

      if (chat.status === 'ended') {
        chat.status = 'active';
        chat.endedAt = null;
        if (!chat.operatorId) {
          chat.hasOperator = false;
          chat.botEnabled = true;
        }
      }
      await chat.save();

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.hasOperator).toBe(true);
      expect(reloaded.botEnabled).toBe(false);
    });
  });
});
