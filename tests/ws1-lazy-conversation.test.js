/**
 * A conversation starts when the visitor does something, not when a page with
 * the widget loads.
 *
 * Loading the widget used to create a conversation, meter it, make a contact,
 * fire `contact.created` and put an empty row in the queue - for every page
 * view. These are the rules that replaced that: a resume of an unknown session
 * writes nothing, and the first message, form, request for a person, file or
 * email address left is what creates (and bills, and announces) it.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({
    generateOperatorSuggestion: jest.fn().mockResolvedValue('A drafted reply')
  })
}));

const mongoose = require('mongoose');
const { createHarness, waitFor, collect, pause, eventually, freshSessionId } = require('./ws1-socket-harness');
const replyService = require('../services/reply');
const webhooks = require('../services/webhooks');
const sessionTokenService = require('../services/session-token');
const Company = require('../models/company');
const User = require('../models/user');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Usage = require('../models/usage');

describe('WS1: a conversation starts with the visitor\'s first action', () => {
  const harness = createHarness();
  let company;
  let routed;
  let operator;
  let routedOperator;

  const conversationsMetered = async companyId => {
    const usage = await Usage.findOne({ company: companyId, period: Usage.currentPeriod() }).lean();
    return usage ? usage.conversations || 0 : 0;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    company = await Company.create({ name: 'Lazy WS1 Sockets' });
    routed = await Company.create({
      name: 'Routed WS1 Sockets',
      routing: { autoAssign: true, assignOnStart: true, maxConcurrent: 3 }
    });

    operator = await User.create({
      username: 'lazy-ws1-op', email: 'op@lazy-ws1.example', password: 'TestPassword123!',
      role: 'operator', displayName: 'Ola', company: company._id
    });
    routedOperator = await User.create({
      username: 'routed-ws1-op', email: 'routed@lazy-ws1.example', password: 'TestPassword123!',
      role: 'operator', displayName: 'Rui', company: routed._id
    });

    await harness.start();
  });

  afterEach(async () => {
    harness.closeAll();
    jest.restoreAllMocks();
    replyService.generate.mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' });
    await pause(30);
  });

  afterAll(async () => {
    await harness.stop();
    await Conversation.deleteMany({ sessionId: /^ws1-/ });
    await Contact.deleteMany({ company: { $in: [company._id, routed._id] } });
    await Usage.deleteMany({ company: { $in: [company._id, routed._id] } });
    await User.deleteMany({ email: /@lazy-ws1\.example$/ });
    await Company.deleteMany({ name: /WS1 Sockets$/ });
    await mongoose.connection.close();
  });

  describe('opening the widget', () => {
    it('writes nothing: no conversation, no contact, no usage, no webhook', async () => {
      const dispatch = jest.spyOn(webhooks, 'dispatch');
      const before = await conversationsMetered(company._id);

      const socket = await harness.connectVisitor(company.widgetKey);
      const sessionId = freshSessionId('look');
      const session = await harness.resume(socket, sessionId, undefined, { userEmail: 'looker@example.com' });

      expect(session).toMatchObject({ rejected: false, sessionId, pending: true });
      expect(session.sessionToken).toMatch(/^[0-9a-f]{64}$/);
      expect(await session.history).toEqual({ sessionId, messages: [] });

      await pause(50);
      expect(await Conversation.findOne({ sessionId })).toBeNull();
      expect(await Contact.countDocuments({ company: company._id, sessionIds: sessionId })).toBe(0);
      expect(await conversationsMetered(company._id)).toBe(before);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('keeps a well-formed token the widget already holds, so two tabs agree on it', async () => {
      const sessionId = freshSessionId('tabs');
      const first = await harness.connectVisitor(company.widgetKey);
      const issued = (await harness.resume(first, sessionId)).sessionToken;

      // A second tab of the same browser reads the same storage.
      const second = await harness.connectVisitor(company.widgetKey);
      expect((await harness.resume(second, sessionId, issued)).sessionToken).toBe(issued);

      // Something that is not a token is replaced rather than adopted.
      const third = await harness.connectVisitor(company.widgetKey);
      const replaced = (await harness.resume(third, sessionId, 'not-a-token')).sessionToken;
      expect(replaced).toMatch(/^[0-9a-f]{64}$/);
      expect(replaced).not.toBe('not-a-token');
    });

    it('is invisible to operators until something happens', async () => {
      const op = await harness.connectOperatorInRoom(operator);
      const activity = collect(op, 'chat-activity');
      const typing = collect(op, 'user-typing');

      const { socket } = await harness.startVisitor('quiet', company.widgetKey);
      socket.emit('chat-opened');
      socket.emit('user-typing', { isTyping: true });
      await pause(80);
      socket.close();
      await pause(80);

      // A queue row for a page view is exactly what this is getting rid of.
      expect(activity).toEqual([]);
      expect(typing).toEqual([]);
    });
  });

  describe('the first message', () => {
    it('creates it once: metered, with a contact, a webhook and a new-chat that says what they asked', async () => {
      const dispatch = jest.spyOn(webhooks, 'dispatch');
      const op = await harness.connectOperatorInRoom(operator);
      const newChat = waitFor(op, 'new-chat');
      const before = await conversationsMetered(company._id);

      const { socket, sessionId, sessionToken } = await harness.startVisitor('first', company.widgetKey);
      harness.say(socket, 'Where is my parcel?');
      await waitFor(socket, 'bot-message');

      expect(await newChat).toMatchObject({ sessionId, channel: 'chat', preview: 'Where is my parcel?' });

      const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
      expect(conversation.sessionTokenHash).toBe(sessionTokenService.hash(sessionToken));
      expect(conversation.contact).toBeTruthy();
      expect(await Contact.countDocuments({ _id: conversation.contact, sessionIds: sessionId })).toBe(1);

      const started = dispatch.mock.calls.filter(([, event]) => event === 'conversation.started');
      expect(started).toHaveLength(1);
      expect(started[0][2]).toMatchObject({ sessionId, channel: 'chat' });

      // A second message is the same conversation, not another one.
      harness.say(socket, 'It was due Tuesday', 'c-2');
      await waitFor(socket, 'bot-message');
      await eventually(async () => (await conversationsMetered(company._id)) === before + 1);
      expect(dispatch.mock.calls.filter(([, event]) => event === 'conversation.started')).toHaveLength(1);
    });

    it('routes on start, before the bot answers, when the tenant assigns on start', async () => {
      await harness.connectOperatorInRoom(routedOperator);
      const { socket, sessionId } = await harness.startVisitor('routed', routed.widgetKey);
      const bot = collect(socket, 'bot-message');

      harness.say(socket, 'Hello?');

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found && found.operatorId ? found : null;
      });
      expect(String(conversation.operatorId)).toBe(String(routedOperator._id));
      await pause(80);
      expect(bot).toEqual([]);
      expect(replyService.generate).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['the pre-chat form', 'user-details', { name: 'Jo', email: 'jo@example.com' }],
    ['asking for a person', 'request-operator', undefined],
    ['leaving an email', 'leave-message', { email: 'jo@example.com' }]
  ])('%s', (_label, event, payload) => {
    it('starts the conversation under the visitor\'s token', async () => {
      const { socket, sessionId, sessionToken } = await harness.startVisitor(event, company.widgetKey);

      socket.emit(event, payload);

      const conversation = await eventually(() => Conversation.findOne({ sessionId }).select('+sessionTokenHash'));
      expect(conversation.sessionTokenHash).toBe(sessionTokenService.hash(sessionToken));
      expect(String(conversation.company)).toBe(String(company._id));
    });
  });

  describe('a burst of first messages', () => {
    it('creates one conversation and keeps every message, even for a tenant with no plan record yet', async () => {
      // A brand-new tenant: the first plan check creates its subscription,
      // which must not happen three times at once.
      const newcomer = await Company.create({ name: 'Newcomer WS1 Sockets' });
      const { socket, sessionId } = await harness.startVisitor('burst', newcomer.widgetKey);
      const errors = collect(socket, 'error');

      ['one', 'two', 'three'].forEach((text, i) => harness.say(socket, text, `burst-${i}`));

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found && found.messages.filter(m => m.sender === 'user').length === 3 ? found : null;
      });
      expect(conversation.messages.filter(m => m.sender === 'user').map(m => m.content).sort())
        .toEqual(['one', 'three', 'two']);
      expect(await Conversation.countDocuments({ sessionId })).toBe(1);
      expect(errors).toEqual([]);

      await Contact.deleteMany({ company: newcomer._id });
      await Usage.deleteMany({ company: newcomer._id });
      await require('../models/subscription').deleteMany({ company: newcomer._id });
    });
  });

  describe('two tabs, one session', () => {
    it('the tab holding a different token is told to start again once the other has engaged', async () => {
      const sessionId = freshSessionId('race');
      const first = await harness.connectVisitor(company.widgetKey);
      const second = await harness.connectVisitor(company.widgetKey);
      await harness.resume(first, sessionId);
      await harness.resume(second, sessionId, 'f'.repeat(64));

      harness.say(first, 'first tab');
      await waitFor(first, 'bot-message');

      const rejected = waitFor(second, 'session-rejected');
      harness.say(second, 'second tab');
      expect(await rejected).toMatchObject({ sessionId });

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.map(m => m.content)).not.toContain('second tab');
    });
  });

  describe('messages sent again after a reconnect', () => {
    it('are stored and answered once', async () => {
      const { socket, sessionId } = await harness.startVisitor('dupe', company.widgetKey);

      harness.say(socket, 'Is it in stock?', 'cid-1');
      await waitFor(socket, 'bot-message');

      const acknowledged = waitFor(socket, 'message-read');
      harness.say(socket, 'Is it in stock?', 'cid-1');
      expect((await acknowledged).messageId).toBe('cid-1');
      await pause(80);

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.filter(m => m.sender === 'user')).toHaveLength(1);
      expect(replyService.generate).toHaveBeenCalledTimes(1);
    });

    it('come back in history with their id, beside how each answer was made and what the visitor thought of it', async () => {
      const { socket, sessionId, sessionToken } = await harness.startVisitor('replay', company.widgetKey);
      harness.say(socket, 'Do you deliver?', 'cid-2');
      const answer = await waitFor(socket, 'bot-message');
      expect(answer).toMatchObject({ path: 'assistant', canRate: true });

      socket.emit('message-feedback', { messageId: answer.id, rating: 'up' });
      await eventually(async () => {
        const found = await Conversation.findOne({ sessionId }).lean();
        return found.messages.find(m => m.feedback && m.feedback.rating === 'up');
      });
      // A transcript event, which is for operators only.
      await Conversation.updateOne({ sessionId }, {
        $push: { messages: { content: 'Ola joined', sender: 'system', path: 'system' } }
      });
      socket.close();

      const returning = await harness.connectVisitor(company.widgetKey);
      const session = await harness.resume(returning, sessionId, sessionToken);
      const { messages } = await session.history;

      expect(messages.map(m => m.sender)).toEqual(['user', 'bot']);
      expect(messages[0].clientMessageId).toBe('cid-2');
      expect(messages[1]).toMatchObject({ path: 'assistant', canRate: true, feedback: { rating: 'up' } });
    });

    it('do not store an id that is not plain', async () => {
      const { socket, sessionId } = await harness.startVisitor('bad-id', company.widgetKey);
      harness.say(socket, 'hello', 'not an id; drop table');
      await waitFor(socket, 'bot-message');

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages[0].messageId).toBeUndefined();
    });
  });
});
