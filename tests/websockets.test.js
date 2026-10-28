/**
 * The socket layer.
 *
 * This is the application's primary request path and the largest file in it.
 * Here the database, the tenant resolution, the session tokens, the plan
 * checks and the assignment queue are real. Only `services/reply` and
 * `services/ai` are stubbed - what the model says is not this file's
 * business, and a real call would be slow, billable and non-deterministic.
 *
 * Most of what is tested is refusal: a visitor in the wrong room, a resume
 * with the wrong token, a message for a session the socket never proved it
 * owned. Those are the cases that decide whether one tenant's traffic can
 * reach another.
 */

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: Client } = require('socket.io-client');

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({
    generateResponse: jest.fn().mockResolvedValue('A reply from the bot'),
    generateOperatorSuggestion: jest.fn().mockResolvedValue('Try asking for their order number')
  })
}));

const setupWebSockets = require('../websockets');
const socketManager = require('../socketManager');
const replyService = require('../services/reply');
const sessionTokenService = require('../services/session-token');
const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');

/** Wait for one event, and fail loudly rather than hanging until the timeout. */
const waitFor = (socket, event, timeout = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Timed out waiting for "${event}"`)),
    timeout
  );
  socket.once(event, (payload) => {
    clearTimeout(timer);
    resolve(payload);
  });
});

/** Wait for whichever of several events arrives first. */
const waitForAny = (socket, events, timeout = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Timed out waiting for one of ${events.join(', ')}`)),
    timeout
  );
  const handlers = events.map(event => {
    const handler = payload => {
      clearTimeout(timer);
      events.forEach((other, i) => socket.off(other, handlers[i]));
      resolve({ event, payload });
    };
    socket.once(event, handler);
    return handler;
  });
});

/** A conversation is written asynchronously; wait for the state we care about. */
const eventually = async (check, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('Condition was never met');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('WebSockets', () => {
  let httpServer;
  let io;
  let port;
  let acme;
  let globex;
  let acmeOperator;
  let acmeSecondOperator;
  let acmeAdmin;
  let globexOperator;
  let superadmin;
  const sockets = [];

  const connect = (options = {}) => {
    const socket = Client(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...options
    });

    sockets.push(socket);
    return socket;
  };

  const connectVisitor = async (widgetKey) => {
    const socket = connect(widgetKey ? { auth: { widgetKey } } : {});
    await waitFor(socket, 'connect');
    return socket;
  };

  const tokenFor = (user, extra = {}) => jwt.sign(
    { id: String(user._id), username: user.username, role: user.role, company: user.company, ...extra },
    process.env.JWT_SECRET
  );

  const connectOperator = async (user, extra = {}) => {
    const socket = connect({ auth: { token: tokenFor(user, extra) } });
    await waitFor(socket, 'connect');
    return socket;
  };

  /**
   * Establish a session the way the widget does, and hand back what the
   * server said. Listeners go on before the emit, because `session-history`
   * follows `session-ready` immediately.
   */
  const resume = async (socket, sessionId, sessionToken) => {
    const outcome = waitForAny(socket, ['session-ready', 'session-rejected']);
    const history = new Promise(resolve => socket.once('session-history', resolve));

    socket.emit('resume-session', { sessionId, sessionToken });

    const result = await outcome;
    if (result.event === 'session-rejected') {
      return { rejected: true, ...result.payload };
    }
    return { rejected: false, ...result.payload, history };
  };

  /** A fresh visitor with a fresh, bound session. */
  const startVisitor = async (prefix, widgetKey = acme.widgetKey) => {
    const socket = await connectVisitor(widgetKey);
    const sessionId = `ws-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const session = await resume(socket, sessionId);
    expect(session.rejected).toBe(false);
    return { socket, sessionId, sessionToken: session.sessionToken };
  };

  const say = (socket, message, messageId = 'm1') => socket.emit('user-message', {
    messageId, message, timestamp: new Date().toISOString()
  });

  /**
   * A visitor whose conversation exists. A resume alone no longer creates
   * one - the first message does - so anything that needs a conversation to
   * act on starts here.
   */
  const startEngagedVisitor = async (prefix, widgetKey = acme.widgetKey) => {
    const visitor = await startVisitor(prefix, widgetKey);
    say(visitor.socket, 'hello');
    await waitFor(visitor.socket, 'bot-message');
    return visitor;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({
      name: 'Acme Sockets',
      allowedDomains: ['https://acme-sockets.test'],
      routing: { autoAssign: true, maxConcurrent: 3 }
    });
    globex = await Company.create({ name: 'Globex Sockets' });

    acmeOperator = await User.create({
      username: 'acme-socket-op', email: 'acme@sockets.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Ada', company: acme._id
    });
    acmeSecondOperator = await User.create({
      username: 'acme-socket-op2', email: 'acme2@sockets.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Bea', company: acme._id
    });
    acmeAdmin = await User.create({
      username: 'acme-socket-admin', email: 'admin@sockets.example',
      password: 'TestPassword123!', role: 'company_admin', displayName: 'Dana', company: acme._id
    });
    globexOperator = await User.create({
      username: 'globex-socket-op', email: 'globex@sockets.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Gus', company: globex._id
    });
    superadmin = await User.create({
      username: 'socket-superadmin', email: 'root@sockets.example',
      password: 'TestPassword123!', role: 'superadmin', displayName: 'Root'
    });

    httpServer = http.createServer();
    io = setupWebSockets(httpServer);
    // Assignment reads who is online from the socket rooms, so it needs the
    // same io instance the server is running.
    socketManager.setIo(io);

    await new Promise(resolve => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    while (sockets.length) {
      sockets.pop().close();
    }
    replyService.generate.mockResolvedValue({ text: 'A reply from the bot', source: 'assistant' });
    // Let the server see the disconnects before the next test connects.
    await pause(20);
  });

  afterAll(async () => {
    setupWebSockets.graceTimers.forEach(timer => clearTimeout(timer));
    io.close();
    await new Promise(resolve => httpServer.close(resolve));
    await Conversation.deleteMany({ sessionId: /^ws-/ });
    await Subscription.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await User.deleteMany({ email: /@sockets\.example$/ });
    await Company.deleteMany({ name: /Sockets$/ });
    await mongoose.connection.close();
  });

  describe('establishing a session', () => {
    it('hands a new visitor a token, and creates the conversation under it on the first message', async () => {
      const { socket, sessionId, sessionToken } = await startVisitor('new');

      expect(typeof sessionToken).toBe('string');
      expect(sessionToken).toHaveLength(64);
      // Opening the widget is not a conversation: nothing is written yet.
      expect(await Conversation.findOne({ sessionId })).toBeNull();

      say(socket, 'hello');
      await waitFor(socket, 'bot-message');

      const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash company');
      expect(conversation).not.toBeNull();
      expect(conversation.sessionTokenHash).toBe(sessionTokenService.hash(sessionToken));
      expect(String(conversation.company)).toBe(String(acme._id));
    });

    it('rejects a resume with the wrong token and binds nothing', async () => {
      const { sessionId } = await startEngagedVisitor('wrong-token');

      const intruder = await connectVisitor(acme.widgetKey);
      const attempt = await resume(intruder, sessionId, 'not-the-token');
      expect(attempt).toMatchObject({ rejected: true, sessionId });

      // Not bound, so a message cannot follow.
      say(intruder, 'I am in your conversation');
      expect((await waitFor(intruder, 'error')).message).toMatch(/Session not established/);

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.map(m => m.content)).not.toContain('I am in your conversation');
    });

    it('rejects a resume with no token for a conversation that has one', async () => {
      const { sessionId } = await startEngagedVisitor('no-token');

      const intruder = await connectVisitor(acme.widgetKey);
      expect((await resume(intruder, sessionId)).rejected).toBe(true);
    });

    it('replays history under session-history, with ids, on a resume with the right token', async () => {
      const { socket, sessionId, sessionToken } = await startVisitor('history');
      say(socket, 'first question');
      await waitFor(socket, 'bot-message');
      socket.close();

      const returning = await connectVisitor(acme.widgetKey);
      const session = await resume(returning, sessionId, sessionToken);
      expect(session.rejected).toBe(false);

      const history = await session.history;
      expect(history.sessionId).toBe(sessionId);
      expect(history.messages.map(m => m.sender)).toEqual(['user', 'bot']);
      expect(history.messages.map(m => m.text)).toEqual(['first question', 'A reply from the bot']);
      // Ids let the widget drop what it already has rather than showing the
      // conversation twice.
      history.messages.forEach(message => expect(message.id).toMatch(/^[0-9a-f]{24}$/));
    });

    it('accepts a conversation from before tokens existed, and gives it one', async () => {
      const sessionId = `ws-legacy-${Date.now()}`;
      await Conversation.create({
        sessionId, company: acme._id,
        messages: [{ content: 'from the old days', sender: 'user' }]
      });

      const socket = await connectVisitor(acme.widgetKey);
      const session = await resume(socket, sessionId);

      expect(session.rejected).toBe(false);
      expect(typeof session.sessionToken).toBe('string');

      const upgraded = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
      expect(upgraded.sessionTokenHash).toBe(sessionTokenService.hash(session.sessionToken));

      // From now on the token is required.
      const intruder = await connectVisitor(acme.widgetKey);
      expect((await resume(intruder, sessionId)).rejected).toBe(true);
    });
  });

  describe('rooms', () => {
    it('does not let a visitor join the operators room, or hear what goes through it', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const heard = jest.fn();
      visitor.on('new-message', heard);

      for (const room of ['operators:all', `operators:${acme._id}`, `user:${acmeOperator._id}`]) {
        visitor.emit('join', room);
        expect(await waitFor(visitor, 'joined-room')).toMatchObject({ success: false, error: 'Access denied' });
      }

      // Traffic that would have reached `operators:all` under the old code.
      const { socket: other } = await startVisitor('leak-source');
      say(other, 'a private question');
      await waitFor(other, 'bot-message');

      expect(heard).not.toHaveBeenCalled();
    });

    it('does not let a visitor join a session they did not resume', async () => {
      const { sessionId: victimSessionId } = await startVisitor('victim-room');

      const { socket: attacker } = await startVisitor('attacker-room');
      attacker.emit('join', victimSessionId);

      expect(await waitFor(attacker, 'joined-room')).toMatchObject({ success: false });
    });

    it('lets a visitor re-join their own session', async () => {
      const { socket, sessionId } = await startVisitor('own-room');
      socket.emit('join', sessionId);

      expect(await waitFor(socket, 'joined-room')).toMatchObject({ success: true, room: sessionId });
    });

    it('writes a message into the bound session, whatever the payload names', async () => {
      const { sessionId: victimSessionId } = await startEngagedVisitor('victim-write');
      const { socket: attacker, sessionId: ownSessionId } = await startVisitor('attacker-write');

      attacker.emit('user-message', {
        sessionId: victimSessionId, messageId: 'm1', message: 'planted', timestamp: new Date().toISOString()
      });
      await waitFor(attacker, 'bot-message');

      const victim = await Conversation.findOne({ sessionId: victimSessionId });
      expect(victim.messages.map(m => m.content)).not.toContain('planted');
      expect((await Conversation.findOne({ sessionId: ownSessionId })).messages[0].content).toBe('planted');
    });
  });

  describe('a visitor message', () => {
    it('creates the conversation, stamps the tenant and answers', async () => {
      const { socket, sessionId } = await startVisitor('plain');

      say(socket, 'hello there');

      const reply = await waitFor(socket, 'bot-message');
      expect(reply.text).toBe('A reply from the bot');
      expect(reply.id).toMatch(/^[0-9a-f]{24}$/);

      const conversation = await Conversation.findOne({ sessionId });
      // Without the tenant stamp the conversation belongs to nobody and the
      // company's own dashboard never shows it.
      expect(String(conversation.company)).toBe(String(acme._id));
      expect(conversation.messages.map(m => m.sender)).toEqual(['user', 'bot']);
    });

    it('carries the sources the answer drew on, and keeps them on the message', async () => {
      const sources = [
        { title: 'Returns policy', url: 'https://acme-sockets.test/returns' },
        { title: 'price-list.csv', url: null }
      ];
      replyService.generate.mockResolvedValueOnce({ text: 'Thirty days.', source: 'assistant', sources });

      const { socket, sessionId } = await startVisitor('sources');
      say(socket, 'how long do I have to return something?');

      const reply = await waitFor(socket, 'bot-message');
      expect(reply.text).toBe('Thirty days.');
      expect(reply.sources).toEqual(sources);

      const conversation = await Conversation.findOne({ sessionId }).lean();
      expect(conversation.messages.at(-1).sources).toEqual(sources);
      // Only a grounded bot reply carries the field at all.
      expect(conversation.messages[0].sources).toBeUndefined();
    });

    it('sends an empty sources list when the answer drew on nothing', async () => {
      const { socket } = await startVisitor('no-sources');
      say(socket, 'hello');

      expect((await waitFor(socket, 'bot-message')).sources).toEqual([]);
    });

    it('shows the bot typing while the reply is being produced, and stops when it lands', async () => {
      const { socket } = await startVisitor('typing');
      const seen = [];
      socket.on('bot-typing', payload => seen.push(payload.typing));

      say(socket, 'hello');
      await waitFor(socket, 'bot-message');
      await pause(30);

      expect(seen).toEqual([true, false]);
    });

    it('reaches that tenant\'s operators and no others', async () => {
      const acmeSocket = await connectOperator(acmeOperator);
      const globexSocket = await connectOperator(globexOperator);
      acmeSocket.emit('join-operator-room');
      globexSocket.emit('join-operator-room');
      await pause(50);

      const heardByGlobex = jest.fn();
      globexSocket.on('new-message', heardByGlobex);

      const { socket: visitor } = await startVisitor('routing');
      say(visitor, 'a private question');

      const seen = await waitFor(acmeSocket, 'new-message');
      expect(seen.message).toBe('a private question');
      expect(heardByGlobex).not.toHaveBeenCalled();
    });

    it('tells operators about a visitor\'s file with a link they can open', async () => {
      // POST /api/upload needs a conversation to attach to, so the visitor has
      // already written.
      const { socket: visitor, sessionId } = await startEngagedVisitor('file');

      const acmeSocket = await connectOperator(acmeOperator);
      acmeSocket.emit('join-operator-room');
      await pause(50);

      // What POST /api/upload records before the widget announces the file.
      const fileId = 'a'.repeat(32);
      await Conversation.updateOne({ sessionId }, {
        $push: { messages: { content: '[File uploaded: receipt.pdf]', sender: 'user', fileId, fileName: 'receipt.pdf' } }
      });

      visitor.emit('file-uploaded', { fileId, fileName: 'ignored-client-name.pdf' });

      const seen = await waitFor(acmeSocket, 'new-message');
      expect(seen).toMatchObject({
        sessionId,
        sender: 'user',
        fileId,
        fileName: 'receipt.pdf',
        fileUrl: `/api/upload/${fileId}`
      });
      expect(seen.messageId).toBeTruthy();
    });

    it('reactivates an ended conversation and switches the bot back on', async () => {
      const sessionId = `ws-reactivate-${Date.now()}`;
      await Conversation.create({
        sessionId,
        company: acme._id,
        status: 'ended',
        endedAt: new Date(),
        // Left over from an escalation nobody picked up.
        hasOperator: true,
        botEnabled: false,
        awaitingOperatorSince: new Date(),
        messages: [{ content: 'earlier question', sender: 'user' }]
      });

      const socket = await connectVisitor(acme.widgetKey);
      await resume(socket, sessionId);
      say(socket, 'are you there?', 'm2');

      // Somebody coming back days later must not meet the silence left behind
      // by an escalation that never happened.
      expect((await waitFor(socket, 'bot-message')).text).toBe('A reply from the bot');

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.status).toBe('active');
      expect(conversation.botEnabled).toBe(true);
    });

    it('hands over to the team, never with an error, when the reply cannot be produced', async () => {
      // Behaviour changed on purpose: this used to apologise and emit an
      // `error` the widget showed as "Failed to generate a reply" - a dead end.
      replyService.generate.mockRejectedValueOnce(new Error('model unavailable'));

      const { socket, sessionId } = await startVisitor('failure');
      const errors = [];
      socket.on('error', payload => errors.push(payload));
      const typing = [];
      socket.on('bot-typing', payload => typing.push(payload.typing));
      const status = waitFor(socket, 'operator-requested');
      const followUp = waitFor(socket, 'followup-request');

      say(socket, 'hello');

      const line = await waitFor(socket, 'bot-message');
      expect(line).toMatchObject({ code: 'reply_failed', path: 'handoff', canRate: false });
      // Nobody from acme is connected, so the visitor is asked for an email.
      expect(await status).toMatchObject({ queued: true, offline: true, code: 'queued_offline' });
      expect(await followUp).toMatchObject({ sessionId, reason: 'model_error' });
      // The typing indicator does not get stuck on.
      expect(typing).toEqual([true, false]);
      expect(errors).toEqual([]);

      // The visitor's message is still stored, so an operator can pick it up,
      // and the conversation says why it is waiting.
      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.map(m => m.sender)).toEqual(['user', 'bot', 'system']);
      expect(conversation.handoff.reason).toBe('model_error');
      expect(conversation.awaitingOperatorSince).toBeInstanceOf(Date);
    });

    it.each([
      ['a number', 42],
      ['an object', { text: 'hi' }],
      ['whitespace', '   '],
      ['too long', 'x'.repeat(4001)]
    ])('refuses %s as a message', async (_label, message) => {
      const { socket, sessionId } = await startVisitor('invalid');

      socket.emit('user-message', { messageId: 'bad', message, timestamp: new Date().toISOString() });

      expect((await waitFor(socket, 'error')).message).toMatch(/Message/);
      // Not even a conversation: a refused message is not engagement.
      expect(await Conversation.findOne({ sessionId })).toBeNull();
      expect(replyService.generate).not.toHaveBeenCalled();
    });

    it('drops messages beyond the per-socket rate limit', async () => {
      const previous = process.env.RATE_LIMIT_CHAT_MAX;
      process.env.RATE_LIMIT_CHAT_MAX = '3';

      try {
        const { socket, sessionId } = await startVisitor('rate');
        const limited = waitFor(socket, 'error');

        for (let i = 0; i < 5; i += 1) {
          say(socket, `message ${i}`, `m${i}`);
        }

        expect((await limited).message).toMatch(/too quickly/);

        const conversation = await eventually(async () => {
          const found = await Conversation.findOne({ sessionId });
          return found && found.messages.filter(m => m.sender === 'user').length >= 3 ? found : null;
        });
        await pause(100);
        const reloaded = await Conversation.findOne({ sessionId });
        expect(reloaded.messages.filter(m => m.sender === 'user')).toHaveLength(3);
        expect(conversation).not.toBeNull();
      } finally {
        if (previous === undefined) {
          delete process.env.RATE_LIMIT_CHAT_MAX;
        } else {
          process.env.RATE_LIMIT_CHAT_MAX = previous;
        }
      }
    });
  });

  describe('the plan', () => {
    let capped;
    let lapsed;

    beforeAll(async () => {
      capped = await Company.create({ name: 'Capped Sockets' });
      await Subscription.create({
        company: capped._id, planId: 'basic', status: 'active',
        limitOverrides: { aiResponsesPerMonth: 0 }
      });

      lapsed = await Company.create({ name: 'Lapsed Sockets' });
      await Subscription.create({ company: lapsed._id, planId: 'basic', status: 'suspended' });
    });

    afterAll(async () => {
      await Subscription.deleteMany({ company: { $in: [capped._id, lapsed._id] } });
    });

    it('hands over to the team, without calling the model, when replies are used up', async () => {
      // Behaviour changed on purpose: this used to say "unavailable" and stop.
      const { socket, sessionId } = await startVisitor('capped', capped.widgetKey);
      const status = waitFor(socket, 'operator-requested');

      say(socket, 'hello');

      expect(await status).toMatchObject({ queued: true, code: 'queued_offline' });
      expect(replyService.generate).not.toHaveBeenCalled();

      // The transcript says why, so an operator reading it later understands
      // the gap; nothing about quotas is said to the visitor.
      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.map(m => m.sender)).toEqual(['user', 'system']);
      expect(conversation.handoff.reason).toBe('quota');
    });

    it('starts no conversation for a suspended tenant, and says so when they write', async () => {
      const socket = await connectVisitor(lapsed.widgetKey);
      const sessionId = `ws-lapsed-${Date.now()}`;

      // Opening the widget writes nothing and refuses nothing.
      const session = await resume(socket, sessionId);
      expect(session.rejected).toBe(false);
      expect(session.pending).toBe(true);

      say(socket, 'anyone there?');
      const reply = await waitFor(socket, 'bot-message');
      expect(reply).toMatchObject({ code: 'unavailable', text: reply.message });

      expect(await Conversation.findOne({ sessionId })).toBeNull();
      expect(replyService.generate).not.toHaveBeenCalled();
    });
  });

  describe('an operator', () => {
    it('cannot join another company\'s conversation', async () => {
      const sessionId = `ws-tenant-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      const intruder = await connectOperator(globexOperator);
      intruder.emit('join', sessionId);

      const result = await waitFor(intruder, 'joined-room');
      expect(result).toMatchObject({ success: false, error: 'Access denied' });
    });

    it('cannot take over another company\'s conversation', async () => {
      const sessionId = `ws-takeover-denied-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      const intruder = await connectOperator(globexOperator);
      intruder.emit('operator-takeover', { sessionId });

      expect((await waitFor(intruder, 'error')).message).toMatch(/do not have access/);
      expect((await Conversation.findOne({ sessionId })).hasOperator).toBe(false);
    });

    it('cannot answer into another company\'s conversation', async () => {
      const sessionId = `ws-message-denied-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      const intruder = await connectOperator(globexOperator);
      intruder.emit('operator-message', { sessionId, message: 'hello from the wrong company' });

      await waitFor(intruder, 'error');
      expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(0);
    });

    it('takes over under the name on their account, not the name in the payload', async () => {
      const { socket: visitor, sessionId } = await startVisitor('takeover');
      say(visitor, 'I need help');
      await waitFor(visitor, 'bot-message');

      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId, operatorName: 'Mallory from Head Office' });

      // Its own event with a notice code, so the widget can put the person in
      // its header and say it in the visitor's language.
      const announcement = await waitFor(visitor, 'operator-joined');
      expect(announcement).toMatchObject({ operatorName: 'Ada', code: 'operator_joined', params: { operatorName: 'Ada' } });
      expect(announcement.message).toMatch(/^Ada has joined/);

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found && found.hasOperator ? found : null;
      });
      expect(conversation.operatorName).toBe('Ada');
      expect(String(conversation.operatorId)).toBe(String(acmeOperator._id));
    });

    it('cannot take a conversation a colleague is holding, unless an admin forces it', async () => {
      const { socket: visitor, sessionId } = await startEngagedVisitor('held');
      const ada = await connectOperator(acmeOperator);
      ada.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      const bea = await connectOperator(acmeSecondOperator);
      bea.emit('operator-takeover', { sessionId });
      expect((await waitFor(bea, 'error')).message).toMatch(/Ada is already handling/);

      // Force from a plain operator counts for nothing.
      bea.emit('operator-takeover', { sessionId, force: true });
      expect((await waitFor(bea, 'error')).message).toMatch(/already handling/);
      expect((await Conversation.findOne({ sessionId })).operatorName).toBe('Ada');

      const dana = await connectOperator(acmeAdmin);
      const taken = waitFor(ada, 'chat-taken-from-you');
      dana.emit('operator-takeover', { sessionId, force: true });

      expect((await waitFor(visitor, 'operator-joined')).operatorName).toBe('Dana');
      expect((await taken).takenBy).toBe('Dana');
      expect((await Conversation.findOne({ sessionId })).operatorName).toBe('Dana');
    });

    it('answers, and the visitor gets the words the operator typed', async () => {
      const { socket: visitor, sessionId } = await startVisitor('operator-reply');
      say(visitor, 'where is my order');
      await waitFor(visitor, 'bot-message');

      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      operator.emit('operator-message', { sessionId, message: 'It went out this morning.' });

      const delivered = await waitFor(visitor, 'operator-message');
      expect(delivered.text).toBe('It went out this morning.');
      expect(delivered.senderName).toBe('Ada');

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found.messages.some(m => m.sender === 'operator') ? found : null;
      });
      expect(conversation.messages.at(-1).content).toBe('It went out this morning.');
    });

    it('gets a drafted reply in their own room, and colleagues do not', async () => {
      const ada = await connectOperator(acmeOperator);
      const bea = await connectOperator(acmeSecondOperator);
      ada.emit('join-operator-room');
      bea.emit('join-operator-room');
      await pause(50);

      const beaSaw = jest.fn();
      bea.on('operator-suggestion', beaSaw);

      const { socket: visitor, sessionId } = await startVisitor('suggest');
      say(visitor, 'first');
      await waitFor(visitor, 'bot-message');

      ada.emit('operator-takeover', { sessionId });
      // Taking over drafts a reply to the last thing the visitor said.
      expect((await waitFor(ada, 'operator-suggestion')).suggestion).toMatch(/order number/);

      say(visitor, 'can you check for me?', 'm2');
      const drafted = await waitFor(ada, 'operator-suggestion');
      expect(drafted.userMessage).toBe('can you check for me?');
      expect(drafted.sessionId).toBe(sessionId);

      expect(beaSaw).not.toHaveBeenCalled();
      expect(replyService.generate).toHaveBeenCalledTimes(1);
    });

    it('uses a suggestion from the text in the payload', async () => {
      const { socket: visitor, sessionId } = await startEngagedVisitor('use-suggestion');
      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      operator.emit('use-suggestion', { sessionId, suggestion: 'Try asking for their order number', edited: '' });

      const delivered = await waitFor(visitor, 'operator-message');
      expect(delivered.text).toBe('Try asking for their order number');
      expect(delivered.senderName).toBe('Ada');

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages.at(-1)).toMatchObject({ sender: 'operator', content: 'Try asking for their order number' });
    });

    it('is told when a suggestion could not be sent by email', async () => {
      const sessionId = `ws-email-${Date.now()}`;
      await Conversation.create({
        sessionId, company: acme._id, channel: 'email',
        email: { subject: 'Help', from: 'jordan@example.com', messageIds: [] },
        messages: [{ content: 'hello', sender: 'user' }]
      });

      const operator = await connectOperator(acmeOperator);
      operator.emit('use-suggestion', { sessionId, suggestion: 'We can help with that.' });

      // The email channel is not enabled for this company, so the reply
      // cannot go out - and the operator has to hear that, not assume it did.
      expect((await waitFor(operator, 'error')).message).toMatch(/Could not send that email/);
      expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(1);
    });

    it('leaving without handing to the bot puts the chat back in the queue rather than nowhere', async () => {
      const { socket: visitor, sessionId } = await startEngagedVisitor('leave');
      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId });
      await waitFor(visitor, 'operator-joined');

      operator.emit('operator-leave', { sessionId, passToBot: false });

      const farewell = await waitFor(visitor, 'operator-left');
      expect(farewell).toMatchObject({ code: 'operator_left', params: { operatorName: 'Ada' } });
      expect(farewell.message).toMatch(/Ada has left/);

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.operatorId).toBeNull();
      expect(conversation.hasOperator).toBe(false);
      expect(conversation.awaitingOperatorSince).toBeInstanceOf(Date);
      // Nobody else is online, so the bot answers in the meantime.
      expect(conversation.botEnabled).toBe(true);
    });

    it('keeps their chats through a refresh, and releases them if they do not come back', async () => {
      const previous = process.env.OPERATOR_GRACE_MS;
      process.env.OPERATOR_GRACE_MS = '150';

      try {
        const { socket: visitor, sessionId } = await startEngagedVisitor('grace');
        const operator = await connectOperator(acmeOperator);
        operator.emit('operator-takeover', { sessionId });
        await waitFor(visitor, 'operator-joined');

        // A refresh: gone and back inside the grace period.
        operator.close();
        await pause(40);
        const again = await connectOperator(acmeOperator);
        await pause(200);
        expect(String((await Conversation.findOne({ sessionId })).operatorId)).toBe(String(acmeOperator._id));

        // Gone for good.
        const notice = waitFor(visitor, 'operator-left');
        again.close();

        expect((await notice).code).toBe('operator_left');
        const released = await Conversation.findOne({ sessionId });
        expect(released.operatorId).toBeNull();
        expect(released.awaitingOperatorSince).toBeInstanceOf(Date);
        expect(released.botEnabled).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.OPERATOR_GRACE_MS;
        } else {
          process.env.OPERATOR_GRACE_MS = previous;
        }
      }
    });

    it('ends a chat, and the visitor is asked to rate it', async () => {
      const { socket: visitor, sessionId } = await startVisitor('end');

      for (const text of ['first', 'second']) {
        say(visitor, text, text);
        await waitFor(visitor, 'bot-message');
      }

      const operator = await connectOperator(acmeOperator);
      operator.emit('end-chat', { sessionId });

      const ended = await waitFor(visitor, 'chat-ended');
      expect(ended.requestRating).toBe(true);
      expect((await Conversation.findOne({ sessionId })).status).toBe('ended');
    });
  });

  describe('a superadmin', () => {
    it('acts on any tenant, and the tenant\'s operators hear about it', async () => {
      const ada = await connectOperator(acmeOperator);
      ada.emit('join-operator-room');
      await pause(50);

      const { socket: visitor, sessionId } = await startEngagedVisitor('root');
      const root = await connectOperator(superadmin);
      const heardByAda = waitFor(ada, 'operator-joined');
      root.emit('operator-takeover', { sessionId });

      expect((await waitFor(visitor, 'operator-joined')).operatorName).toBe('Root');
      // Announced to acme's room, resolved from the conversation, rather than
      // to an "unassigned" room nobody is in.
      expect((await heardByAda).operatorName).toBe('Root');
    });
  });

  describe('a visitor asking for a person', () => {
    it('is queued rather than abandoned when nobody is available, and asked for an email', async () => {
      const { socket: visitor, sessionId } = await startEngagedVisitor('queue');
      const followUp = waitFor(visitor, 'followup-request');

      visitor.emit('request-operator');

      const result = await waitFor(visitor, 'operator-requested');
      // Nobody from acme is connected: promising "someone will be with you"
      // would be the broken promise; an email address is the way out.
      expect(result).toMatchObject({ queued: true, connected: false, offline: true, code: 'queued_offline' });
      expect(await followUp).toMatchObject({ sessionId, reason: 'visitor_request' });

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.awaitingOperatorSince).toBeInstanceOf(Date);
      // The bot stays on: switching it off while nobody picks up is how a
      // visitor ends up talking to no one at all.
      expect(conversation.botEnabled).not.toBe(false);
    });
  });

  describe('ratings', () => {
    it('records the score against the socket\'s own session', async () => {
      const { socket: visitor, sessionId } = await startVisitor('rating');
      say(visitor, 'thanks');
      await waitFor(visitor, 'bot-message');

      visitor.emit('submit-rating', { score: 5, comment: 'quick and clear' });
      expect((await waitFor(visitor, 'rating-recorded')).success).toBe(true);

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.rating.score).toBe(5);
    });

    it('ignores a session id in the payload, so nobody can rate somebody else\'s chat', async () => {
      const victimSessionId = `ws-victim-${Date.now()}`;
      await Conversation.create({
        sessionId: victimSessionId,
        company: acme._id,
        messages: [{ content: 'hello', sender: 'user' }, { content: 'hi', sender: 'bot' }]
      });

      const { socket: attacker } = await startVisitor('attacker');
      say(attacker, 'hello');
      await waitFor(attacker, 'bot-message');

      attacker.emit('submit-rating', { sessionId: victimSessionId, score: 1, comment: 'sabotage' });
      await waitFor(attacker, 'rating-recorded');

      const victim = await Conversation.findOne({ sessionId: victimSessionId });
      expect(victim.rating?.score).toBeUndefined();
    });
  });

  describe('the connection itself', () => {
    it('treats a request with no token as a visitor rather than refusing it', async () => {
      const socket = await connectVisitor();
      expect(socket.connected).toBe(true);
    });

    it('treats a forged token as a visitor, not as an operator', async () => {
      const forged = jwt.sign(
        { id: String(acmeOperator._id), role: 'operator', company: String(acme._id) },
        'not-the-real-secret'
      );

      const socket = connect({ auth: { token: forged } });
      await waitFor(socket, 'connect');

      const sessionId = `ws-forged-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      // As a visitor the join succeeds, but it is a visitor's join: nothing
      // operator-only follows from it.
      socket.emit('operator-message', { sessionId, message: 'I should not be able to say this' });
      await pause(150);

      expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(0);
    });

    it('treats a token from before a password change as a visitor', async () => {
      await User.findByIdAndUpdate(acmeOperator._id, { tokenVersion: 2 });
      const sessionId = `ws-stale-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      try {
        // Issued before versions existed, and issued against the old version.
        for (const extra of [{}, { tv: 1 }]) {
          const stale = await connectOperator(acmeOperator, extra);
          stale.emit('operator-message', { sessionId, message: 'from an old session' });
          await pause(150);
          expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(0);
        }

        // The current version still works.
        const current = await connectOperator(acmeOperator, { tv: 2 });
        current.emit('operator-message', { sessionId, message: 'from a fresh login' });
        const conversation = await eventually(async () => {
          const found = await Conversation.findOne({ sessionId });
          return found.messages.length ? found : null;
        });
        expect(conversation.messages[0].content).toBe('from a fresh login');
      } finally {
        await User.findByIdAndUpdate(acmeOperator._id, { tokenVersion: 0 });
      }
    });

    it('answers a heartbeat, which is how the widget knows it is still connected', async () => {
      const socket = await connectVisitor(acme.widgetKey);
      const sent = new Date().toISOString();

      socket.emit('heartbeat', { timestamp: sent });

      expect((await waitFor(socket, 'heartbeat-ack')).received).toBe(sent);
    });
  });
});
