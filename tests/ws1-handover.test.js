/**
 * Never a dead end, and every operator sees the same conversation.
 *
 * What happens when the bot cannot answer, when the visitor asks for a person,
 * when nobody is there to ask, and what operators see while that goes on:
 * every stored message, why a conversation is waiting, a re-join that does
 * not re-announce, and an outcome when it is closed.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

const mockSuggestion = jest.fn().mockResolvedValue('Try asking for their order number');
jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockImplementation(async () => {
    const service = { lastFailed: false };
    service.generateOperatorSuggestion = async (...args) => {
      const text = await mockSuggestion(...args);
      service.lastFailed = text === null;
      return text;
    };
    return service;
  })
}));

const mongoose = require('mongoose');
const { createHarness, waitFor, collect, pause, eventually } = require('./ws1-socket-harness');
const replyService = require('../services/reply');
const AIService = require('../services/ai');
const NotificationService = require('../services/notification');

const realNotifyUser = NotificationService.notifyUser;
const { getResponseTemplateService } = require('../services/responseTemplates');
const Company = require('../models/company');
const User = require('../models/user');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const ResponseTemplate = require('../models/response-template');
const Usage = require('../models/usage');

describe('WS1: never a dead end', () => {
  const harness = createHarness();
  let queueCo;
  let assignCo;
  let closedCo;
  let quinn;
  let ada;
  let bea;
  let dana;
  let carl;

  const usage = async companyId =>
    (await Usage.findOne({ company: companyId, period: Usage.currentPeriod() }).lean()) || {};

  const engaged = async (prefix, company, text = 'hello') => {
    const visitor = await harness.startVisitor(prefix, company.widgetKey);
    harness.say(visitor.socket, text);
    await waitFor(visitor.socket, 'bot-message');
    return visitor;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    // Somebody online, nobody auto-assigned: the visitor waits in a queue.
    queueCo = await Company.create({ name: 'Queue WS1 Handover', routing: { autoAssign: false } });
    // Auto-assignment on: whoever is online gets it.
    assignCo = await Company.create({ name: 'Assign WS1 Handover', routing: { autoAssign: true, maxConcurrent: 3 } });
    // Closed every day of the week, so nobody can be promised.
    closedCo = await Company.create({
      name: 'Closed WS1 Handover',
      businessHours: { enabled: true, timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, closed: true })) }
    });

    const make = (username, displayName, company, role = 'operator') => User.create({
      username, email: `${username}@handover-ws1.example`, password: 'TestPassword123!',
      role, displayName, company: company._id
    });
    quinn = await make('quinn-ws1', 'Quinn', queueCo);
    ada = await make('ada-ws1', 'Ada', assignCo);
    bea = await make('bea-ws1', 'Bea', assignCo);
    dana = await make('dana-ws1', 'Dana', assignCo, 'company_admin');
    carl = await make('carl-ws1', 'Carl', closedCo);

    await harness.start();
  });

  afterEach(async () => {
    harness.closeAll();
    replyService.generate.mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' });
    mockSuggestion.mockResolvedValue('Try asking for their order number');
    // Put back the real one: assignment notifies through it too, and a test
    // that leaves it deleted breaks every assignment after it.
    NotificationService.notifyUser = realNotifyUser;
    await pause(40);
  });

  afterAll(async () => {
    await harness.stop();
    const companies = [queueCo, assignCo, closedCo].map(company => company._id);
    await Conversation.deleteMany({ sessionId: /^ws1-/ });
    await ResponseTemplate.deleteMany({ company: { $in: companies } });
    await Contact.deleteMany({ company: { $in: companies } });
    await Usage.deleteMany({ company: { $in: companies } });
    await User.deleteMany({ email: /@handover-ws1\.example$/ });
    await Company.deleteMany({ name: /WS1 Handover$/ });
    await mongoose.connection.close();
  });

  describe('an answer the bot did not have', () => {
    it('is stored as unanswered, cites nothing, cannot be rated and offers a person', async () => {
      replyService.generate.mockResolvedValueOnce({
        text: 'I do not have that information.', source: 'assistant', path: 'assistant',
        unanswered: true, sources: [{ title: 'Irrelevant', url: null }]
      });

      const { socket, sessionId } = await harness.startVisitor('unanswered', queueCo.widgetKey);
      harness.say(socket, 'Do you ship to Mars?');

      const reply = await waitFor(socket, 'bot-message');
      expect(reply).toMatchObject({ unanswered: true, canRate: false, sources: [] });
      expect(reply.choices).toEqual([expect.objectContaining({ action: 'handoff', code: 'handoff_offer' })]);

      const stored = (await Conversation.findOne({ sessionId }).lean()).messages.at(-1);
      expect(stored).toMatchObject({ sender: 'bot', unanswered: true, path: 'assistant' });
    });

    it('is said in the tenant\'s own words when they wrote a fallback reply', async () => {
      await ResponseTemplate.create({
        company: queueCo._id, name: 'When we do not know', role: 'fallback',
        responses: ['Good question {name}- let me find someone at {company} who knows.']
      });
      getResponseTemplateService().invalidate(queueCo._id);
      replyService.generate.mockResolvedValueOnce({
        text: 'I do not know.', source: 'assistant', path: 'assistant', unanswered: true
      });

      try {
        const { socket } = await harness.startVisitor('fallback', queueCo.widgetKey);
        harness.say(socket, 'What is the meaning of life?');

        const reply = await waitFor(socket, 'bot-message');
        // `{name}` dropped (they never gave one), `{company}` filled in.
        expect(reply).toMatchObject({
          text: 'Good question- let me find someone at Queue WS1 Handover who knows.',
          path: 'fallback'
        });
      } finally {
        await ResponseTemplate.deleteMany({ company: queueCo._id });
        getResponseTemplateService().invalidate(queueCo._id);
      }
    });

    it('pressing the offer afterwards records that the bot could not answer', async () => {
      replyService.generate.mockResolvedValueOnce({
        text: 'I do not know.', source: 'assistant', path: 'assistant', unanswered: true
      });
      await harness.connectOperatorInRoom(quinn);
      const { socket, sessionId } = await harness.startVisitor('offer', queueCo.widgetKey);
      harness.say(socket, 'Odd question');
      await waitFor(socket, 'bot-message');

      socket.emit('request-operator');
      await waitFor(socket, 'operator-requested');

      expect((await Conversation.findOne({ sessionId })).handoff.reason).toBe('bot_unanswered');
    });
  });

  describe('asking for a person', () => {
    it('in words, hands over instead of answering, and the team is told why and what was asked', async () => {
      const op = await harness.connectOperatorInRoom(quinn);
      const alert = waitFor(op, 'handoff-requested');
      const { socket, sessionId } = await harness.startVisitor('typed', queueCo.widgetKey);
      const bot = collect(socket, 'bot-message');

      harness.say(socket, 'Can I talk to a person please?');

      // Quinn is online and taking chats, but nobody is auto-assigned: queued.
      expect(await waitFor(socket, 'operator-requested')).toMatchObject({ queued: true, connected: false, code: 'queued' });
      expect(await alert).toMatchObject({
        sessionId, reason: 'visitor_request', preview: 'Can I talk to a person please?'
      });
      expect(bot).toEqual([]);
      expect(replyService.generate).not.toHaveBeenCalled();

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.handoff.reason).toBe('visitor_request');
      expect(conversation.awaitingOperatorSince).toBeInstanceOf(Date);
      expect(conversation.messages.filter(m => m.sender === 'system').map(m => m.content)).toEqual(['Asked for a person']);
    });

    it('with somebody available and auto-assignment on, says who has them', async () => {
      await harness.connectOperatorInRoom(ada);
      const { socket, sessionId } = await engaged('assigned', assignCo);

      socket.emit('request-operator');

      const answer = await waitFor(socket, 'operator-requested');
      expect(answer).toMatchObject({ connected: true, operatorName: 'Ada', code: 'operator_joined' });
      const conversation = await Conversation.findOne({ sessionId });
      expect(String(conversation.operatorId)).toBe(String(ada._id));
      expect(conversation.botEnabled).toBe(false);
    });

    it('outside opening hours promises nobody, and asks for an email instead', async () => {
      // Carl is online, but the company is closed.
      await harness.connectOperatorInRoom(carl);
      const { socket, sessionId } = await engaged('closed', closedCo);
      const followUp = waitFor(socket, 'followup-request');

      socket.emit('request-operator');

      expect(await waitFor(socket, 'operator-requested')).toMatchObject({ offline: true, code: 'queued_offline' });
      expect(await followUp).toMatchObject({ sessionId, reason: 'visitor_request' });
    });

    it('a second request while waiting does not alert the team again', async () => {
      const op = await harness.connectOperatorInRoom(quinn);
      const alerts = collect(op, 'handoff-requested');
      const { socket } = await engaged('twice', queueCo);

      socket.emit('request-operator');
      await waitFor(socket, 'operator-requested');
      socket.emit('request-operator');
      await waitFor(socket, 'operator-requested');
      await pause(60);

      expect(alerts).toHaveLength(1);
    });
  });

  describe('leaving an email', () => {
    it('stores the follow-up, confirms it to the visitor and tells the team', async () => {
      const op = await harness.connectOperatorInRoom(carl);
      const alert = waitFor(op, 'handoff-requested');
      const { socket, sessionId } = await harness.startVisitor('leave', closedCo.widgetKey);

      socket.emit('leave-message', { email: ' Jo@Example.COM ', message: 'Please call me back about my order' });

      expect(await waitFor(socket, 'followup-saved')).toMatchObject({
        email: 'jo@example.com', code: 'followup_saved', params: { email: 'jo@example.com' }
      });
      expect(await alert).toMatchObject({ sessionId, reason: 'offline_message', email: 'jo@example.com' });

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.followUp.email).toBe('jo@example.com');
      expect(conversation.handoff.reason).toBe('offline_message');
      expect(conversation.messages.map(m => [m.sender, m.content])).toEqual([
        ['user', 'Please call me back about my order'],
        ['system', 'Left an email address for a reply: jo@example.com']
      ]);
    });

    it('refuses an address that is not one, and creates nothing', async () => {
      const { socket, sessionId } = await harness.startVisitor('bad-email', closedCo.widgetKey);

      socket.emit('leave-message', { email: 'not an address' });

      expect((await waitFor(socket, 'error')).message).toMatch(/valid email/);
      expect(await Conversation.findOne({ sessionId })).toBeNull();
    });
  });

  describe('operators', () => {
    it('see every stored message, a colleague\'s replies included', async () => {
      const beaSocket = await harness.connectOperatorInRoom(bea);
      const seen = collect(beaSocket, 'conversation-message');

      const { socket: visitor, sessionId } = await engaged('sync', assignCo, 'Where is it?');
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');
      adaSocket.emit('operator-message', { sessionId, message: 'On its way.' });
      await waitFor(visitor, 'operator-message');
      await pause(60);

      const forThis = seen.filter(event => event.sessionId === sessionId).map(event => event.message);
      expect(forThis.map(m => [m.sender, m.content])).toEqual([
        ['user', 'Where is it?'],
        ['bot', 'A reply from the bot'],
        ['system', 'Ada joined'],
        ['operator', 'On its way.']
      ]);
      forThis.forEach(message => expect(message._id).toMatch(/^[0-9a-f]{24}$/));
      expect(forThis[3]).toMatchObject({ operatorName: 'Ada', operatorId: String(ada._id) });
    });

    it('a takeover records that a person joined, and the first reply when they answered', async () => {
      const { socket: visitor, sessionId } = await engaged('joined', assignCo);
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      let conversation = await Conversation.findOne({ sessionId });
      expect(conversation.operatorEverJoined).toBe(true);
      expect(conversation.firstOperatorJoinedAt).toBeInstanceOf(Date);
      expect(conversation.firstOperatorReplyAt).toBeUndefined();

      adaSocket.emit('operator-message', { sessionId, message: 'Hi, Ada here.' });
      await waitFor(visitor, 'operator-message');
      conversation = await Conversation.findOne({ sessionId });
      expect(conversation.firstOperatorReplyAt).toBeInstanceOf(Date);
    });

    it('the operator who already holds a chat re-joins it silently', async () => {
      const { socket: visitor, sessionId } = await engaged('rejoin', assignCo);
      const first = await harness.connectOperator(ada);
      first.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');
      await pause(60);

      // Half way through a workflow question when the page is refreshed.
      await Conversation.updateOne({ sessionId }, { $set: { 'workflowState.awaiting': { node: 'ask-order' } } });
      const announcements = collect(visitor, 'operator-joined');
      AIService.forCompany.mockClear();

      const refreshed = await harness.connectOperator(ada);
      refreshed.emit('operator-takeover', { sessionId });

      expect(await waitFor(refreshed, 'operator-rejoined')).toMatchObject({ sessionId });
      await pause(80);
      expect(announcements).toEqual([]);
      expect(AIService.forCompany).not.toHaveBeenCalled();
      const conversation = await Conversation.findOne({ sessionId }).lean();
      expect(conversation.workflowState.awaiting).toEqual({ node: 'ask-order' });
      expect(conversation.messages.filter(m => m.sender === 'system')).toHaveLength(1);

      // And the re-joined socket is in the room again.
      refreshed.emit('operator-message', { sessionId, message: 'Still here.' });
      expect((await waitFor(visitor, 'operator-message')).text).toBe('Still here.');
    });

    it('are told a suggestion could not be drafted, with no text to send by mistake', async () => {
      mockSuggestion.mockResolvedValue(null);
      const { sessionId } = await engaged('no-draft', assignCo);
      const adaSocket = await harness.connectOperator(ada);

      adaSocket.emit('operator-takeover', { sessionId });

      const suggestion = await waitFor(adaSocket, 'operator-suggestion');
      expect(suggestion).toMatchObject({ sessionId, error: true });
      expect(suggestion.suggestion).toBeUndefined();
    });

    it('cannot end or hand back a colleague\'s chat; an admin can, with an outcome', async () => {
      const { socket: visitor, sessionId } = await engaged('outcome', assignCo);
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      const beaSocket = await harness.connectOperator(bea);
      beaSocket.emit('end-chat', { sessionId });
      expect((await waitFor(beaSocket, 'error')).message).toMatch(/Ada is handling/);
      beaSocket.emit('operator-leave', { sessionId });
      expect((await waitFor(beaSocket, 'error')).message).toMatch(/Ada is handling/);
      expect((await Conversation.findOne({ sessionId })).status).toBe('active');

      // An admin is refused too until they say they mean it (the dashboard
      // asks, naming who holds the chat, then sends `force`).
      const danaSocket = await harness.connectOperator(dana);
      danaSocket.emit('end-chat', { sessionId, outcome: { status: 'resolved' } });
      expect((await waitFor(danaSocket, 'error')).message).toMatch(/Ada is handling/);

      danaSocket.emit('end-chat', { sessionId, force: true, outcome: { status: 'resolved', note: '  Sent a replacement.  ' } });

      const ended = await waitFor(visitor, 'chat-ended');
      expect(ended).toMatchObject({ code: 'chat_ended', requestRating: true });

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.outcome).toMatchObject({ status: 'resolved', note: 'Sent a replacement.' });
      expect(String(conversation.outcome.by)).toBe(String(dana._id));
      expect(conversation.messages.at(-1)).toMatchObject({ sender: 'system', content: 'Ended by Dana (resolved)' });
    });

    it('cannot record an outcome that is not one of the four', async () => {
      const { sessionId } = await engaged('bad-outcome', assignCo);
      const danaSocket = await harness.connectOperator(dana);

      danaSocket.emit('end-chat', { sessionId, outcome: { status: 'brilliant' } });

      expect((await waitFor(danaSocket, 'error')).message).toMatch(/how the conversation ended/);
      expect((await Conversation.findOne({ sessionId })).status).toBe('active');
    });

    it('a visitor who reloads while a person has the chat is told who it is', async () => {
      const { socket: visitor, sessionId, sessionToken } = await engaged('reload', assignCo);
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');
      visitor.close();

      const returning = await harness.connectVisitor(assignCo.widgetKey);
      const session = await harness.resume(returning, sessionId, sessionToken);

      expect(session).toMatchObject({ operatorName: 'Ada', operator: { name: 'Ada' } });
    });

    it('a visitor\'s message is marked read by a person only when a person has read it', async () => {
      const { socket: visitor, sessionId } = await harness.startVisitor('read', assignCo.widgetKey);
      const stored = waitFor(visitor, 'message-read');
      harness.say(visitor, 'Is anyone there?', 'read-1');
      // Stored is not read: the acknowledgement says nothing about a reader.
      expect((await stored).reader).toBeUndefined();
      await waitFor(visitor, 'bot-message');

      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      const opened = waitFor(visitor, 'message-read');
      adaSocket.emit('operator-read', { sessionId });
      expect(await opened).toMatchObject({ messageId: 'read-1', reader: 'operator' });

      // Answering is reading too.
      const answered = waitFor(visitor, 'message-read');
      adaSocket.emit('operator-message', { sessionId, message: 'Yes, Ada here.' });
      expect(await answered).toMatchObject({ messageId: 'read-1', reader: 'operator' });
    });

    it('an operator of another company cannot mark a conversation read', async () => {
      const { socket: visitor, sessionId } = await engaged('read-other', assignCo);
      const reads = collect(visitor, 'message-read');
      const quinnSocket = await harness.connectOperator(quinn);

      quinnSocket.emit('operator-read', { sessionId });
      await pause(80);

      expect(reads.filter(read => read.reader === 'operator')).toEqual([]);
    });

    it('handing back to the bot says so to the visitor, with its own code', async () => {
      const { socket: visitor, sessionId } = await engaged('hand-back', assignCo);
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      adaSocket.emit('operator-leave', { sessionId, passToBot: true });

      expect(await waitFor(visitor, 'operator-left')).toMatchObject({ code: 'handed_back', operatorName: 'Ada' });
      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.at(-1).content).toBe('Ada handed this back to the bot');
    });
  });

  describe('ratings', () => {
    it('a low score tells the operator who handled it', async () => {
      const notifyUser = jest.fn().mockResolvedValue({});
      NotificationService.notifyUser = notifyUser;

      const { socket: visitor, sessionId } = await engaged('low', assignCo);
      const adaSocket = await harness.connectOperator(ada);
      adaSocket.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');
      adaSocket.emit('operator-message', { sessionId, message: 'Sorted.' });
      await waitFor(visitor, 'operator-message');

      visitor.emit('submit-rating', { score: 1, comment: 'It was not sorted' });
      await waitFor(visitor, 'rating-recorded');
      await eventually(() => notifyUser.mock.calls.length > 0);

      expect(notifyUser).toHaveBeenCalledWith(String(ada._id), expect.objectContaining({
        type: 'low_rating',
        sessionId,
        link: expect.stringContaining(sessionId)
      }));
    });

    it('a low score on a conversation the bot handled alone goes to the admins', async () => {
      const notifyUser = jest.fn().mockResolvedValue({});
      NotificationService.notifyUser = notifyUser;

      const { socket: visitor } = await engaged('low-bot', assignCo);
      visitor.emit('submit-rating', { score: 2 });
      await waitFor(visitor, 'rating-recorded');
      await eventually(() => notifyUser.mock.calls.length > 0);

      expect(notifyUser.mock.calls.map(([userId]) => String(userId))).toEqual([String(dana._id)]);
    });

    it('a good score notifies nobody', async () => {
      const notifyUser = jest.fn().mockResolvedValue({});
      NotificationService.notifyUser = notifyUser;

      const { socket: visitor } = await engaged('high', assignCo);
      visitor.emit('submit-rating', { score: 5 });
      await waitFor(visitor, 'rating-recorded');
      await pause(80);

      expect(notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('consent', () => {
    it('is kept on the conversation, with when and to what, from the message that started it', async () => {
      const { socket, sessionId } = await harness.startVisitor('consent', queueCo.widgetKey);
      const at = new Date(Date.now() - 5000).toISOString();

      socket.emit('user-message', {
        message: 'hello', clientMessageId: 'consent-1',
        consent: { given: true, at, text: 'I agree to the privacy policy' }
      });
      await waitFor(socket, 'bot-message');

      const { metadata } = await Conversation.findOne({ sessionId }).lean();
      expect(metadata).toMatchObject({ consent: 'true', consentAt: at, consentText: 'I agree to the privacy policy' });
    });

    it('is kept from an email left, too', async () => {
      const { socket, sessionId } = await harness.startVisitor('consent-mail', closedCo.widgetKey);

      socket.emit('leave-message', { email: 'jo@example.com', consent: true });
      await waitFor(socket, 'followup-saved');

      expect((await Conversation.findOne({ sessionId }).lean()).metadata.consent).toBe('true');
    });
  });

  describe('thumbs on an answer', () => {
    it('are stored on the bot\'s message and reach the operators', async () => {
      const op = await harness.connectOperatorInRoom(quinn);
      const { socket, sessionId } = await harness.startVisitor('thumbs', queueCo.widgetKey);
      harness.say(socket, 'Opening hours?');
      const answer = await waitFor(socket, 'bot-message');
      const heard = waitFor(op, 'message-feedback');

      socket.emit('message-feedback', { messageId: answer.id, rating: 'down' });

      expect(await heard).toMatchObject({ sessionId, messageId: answer.id, rating: 'down' });
      const stored = (await Conversation.findOne({ sessionId }).lean()).messages.find(m => String(m._id) === answer.id);
      expect(stored.feedback.rating).toBe('down');
    });

    it('cannot be put on a visitor\'s own message, or on another conversation', async () => {
      const { socket: other, sessionId: otherSession } = await harness.startVisitor('thumbs-other', queueCo.widgetKey);
      harness.say(other, 'Their question');
      const theirAnswer = await waitFor(other, 'bot-message');

      const { socket, sessionId } = await harness.startVisitor('thumbs-mine', queueCo.widgetKey);
      harness.say(socket, 'My question');
      await waitFor(socket, 'bot-message');
      const mine = (await Conversation.findOne({ sessionId }).lean()).messages[0];

      socket.emit('message-feedback', { messageId: String(mine._id), rating: 'up' });
      await waitFor(socket, 'error');
      socket.emit('message-feedback', { messageId: theirAnswer.id, rating: 'down' });
      await waitFor(socket, 'error');

      const theirs = (await Conversation.findOne({ sessionId: otherSession }).lean()).messages;
      expect(theirs.some(m => m.feedback && m.feedback.rating)).toBe(false);
    });
  });

  describe('metering', () => {
    it('counts an AI response only when a model wrote the text', async () => {
      const { socket } = await harness.startVisitor('meter', queueCo.widgetKey);
      const before = await usage(queueCo._id);

      replyService.generate.mockResolvedValueOnce({ text: 'We open at nine.', source: 'assistant', path: 'canned' });
      harness.say(socket, 'When do you open?', 'm-1');
      await waitFor(socket, 'bot-message');

      replyService.generate.mockResolvedValueOnce({ text: 'Which order?', source: 'workflow', path: 'workflow', metered: false });
      harness.say(socket, 'Track my order', 'm-2');
      await waitFor(socket, 'bot-message');

      replyService.generate.mockResolvedValueOnce({ text: 'It ships Monday.', source: 'workflow', path: 'workflow', metered: true });
      harness.say(socket, 'Number 123', 'm-3');
      await waitFor(socket, 'bot-message');

      const after = await eventually(async () => {
        const now = await usage(queueCo._id);
        return (now.messages || 0) - (before.messages || 0) >= 6 ? now : null;
      });
      expect((after.aiResponses || 0) - (before.aiResponses || 0)).toBe(1);
    });

    it('does not count a reply that failed', async () => {
      replyService.generate.mockRejectedValueOnce(new Error('model down'));
      const { socket } = await harness.startVisitor('meter-fail', queueCo.widgetKey);
      const before = await usage(queueCo._id);

      harness.say(socket, 'hello');
      await waitFor(socket, 'operator-requested');
      await pause(60);

      expect(((await usage(queueCo._id)).aiResponses || 0)).toBe(before.aiResponses || 0);
    });
  });
});
