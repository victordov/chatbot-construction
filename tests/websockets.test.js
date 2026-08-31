/**
 * The socket layer.
 *
 * This is the application's primary request path and the largest file in it,
 * and the previous four tests mocked the database, the encryption service, the
 * model and JWT before asserting that an event fired. The last of them called
 * `done()` from a one-second timeout, so it passed whether or not the server
 * replied at all.
 *
 * Here the database, the encryption, the tenant resolution and the assignment
 * queue are real. Only `services/reply` and `services/ai` are stubbed - what
 * the model says is not this file's business, and a real call would be slow,
 * billable and non-deterministic.
 */

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
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
const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');

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

describe('WebSockets', () => {
  let httpServer;
  let io;
  let port;
  let acme;
  let globex;
  let acmeOperator;
  let globexOperator;
  const sockets = [];

  const connect = (options = {}) => {
    const socket = Client(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...options
    });

    // The server sends this the moment the connection is accepted, so the
    // listener has to exist before anything is awaited or the packet has been
    // and gone by the time a test asks for it.
    socket.encryptionInit = new Promise(resolve => socket.once('encryption-init', resolve));

    sockets.push(socket);
    return socket;
  };

  const connectVisitor = async (widgetKey) => {
    const socket = connect(widgetKey ? { auth: { widgetKey } } : {});
    await waitFor(socket, 'connect');
    return socket;
  };

  const connectOperator = async (user) => {
    const token = jwt.sign(
      { id: String(user._id), username: user.username, role: user.role, company: user.company },
      process.env.JWT_SECRET
    );
    const socket = connect({ auth: { token } });
    await waitFor(socket, 'connect');
    return socket;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({ name: 'Acme Sockets', allowedDomains: ['https://acme-sockets.test'] });
    globex = await Company.create({ name: 'Globex Sockets' });

    acmeOperator = await User.create({
      username: 'acme-socket-op', email: 'acme@sockets.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Ada', company: acme._id
    });
    globexOperator = await User.create({
      username: 'globex-socket-op', email: 'globex@sockets.example',
      password: 'TestPassword123!', role: 'operator', displayName: 'Gus', company: globex._id
    });

    httpServer = http.createServer();
    io = setupWebSockets(httpServer);
    // Assignment reads who is online from the socket rooms, so it needs the
    // same io instance the server is running.
    socketManager.setIo(io);

    await new Promise(resolve => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(() => {
    while (sockets.length) {
      sockets.pop().close();
    }
    replyService.generate.mockResolvedValue({ text: 'A reply from the bot', source: 'assistant' });
  });

  afterAll(async () => {
    io.close();
    await new Promise(resolve => httpServer.close(resolve));
    await Conversation.deleteMany({ sessionId: /^ws-/ });
    await User.deleteMany({ email: /@sockets\.example$/ });
    await Company.deleteMany({ name: /Sockets$/ });
    await mongoose.connection.close();
  });

  describe('encryption', () => {
    it('completes a real key exchange and decrypts what the visitor sent', async () => {
      const socket = await connectVisitor(acme.widgetKey);
      const { serverPublicKey } = await socket.encryptionInit;

      // A real keypair, encrypting with the key the server actually sent. A
      // mocked service would pass this test with the crypto removed entirely.
      const clientKeys = nacl.box.keyPair();
      const sessionId = `ws-encrypted-${Date.now()}`;

      socket.emit('client-public-key', {
        sessionId,
        publicKey: naclUtil.encodeBase64(clientKeys.publicKey)
      });
      expect((await waitFor(socket, 'encryption-ready')).success).toBe(true);

      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const box = nacl.box(
        naclUtil.decodeUTF8('my order has not arrived'),
        nonce,
        naclUtil.decodeBase64(serverPublicKey),
        clientKeys.secretKey
      );

      socket.emit('user-message', {
        sessionId,
        messageId: 'm1',
        encrypted: true,
        encryptedMessage: naclUtil.encodeBase64(box),
        nonce: naclUtil.encodeBase64(nonce),
        timestamp: new Date().toISOString()
      });

      const stored = await eventually(async () => {
        const conversation = await Conversation.findOne({ sessionId });
        return conversation && conversation.messages.length ? conversation : null;
      });

      expect(stored.messages[0].content).toBe('my order has not arrived');
      expect(stored.messages[0].encrypted).toBe(true);
    });

    it('refuses a public key it cannot decode rather than pretending to be secure', async () => {
      const socket = await connectVisitor(acme.widgetKey);
      await socket.encryptionInit;

      socket.emit('client-public-key', { sessionId: 'ws-bad-key', publicKey: 'not base64 at all!!' });

      expect((await waitFor(socket, 'encryption-ready')).success).toBe(false);
    });
  });

  describe('a visitor message', () => {
    it('creates the conversation, stamps the tenant and answers', async () => {
      const socket = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-plain-${Date.now()}`;

      socket.emit('join', sessionId);
      expect((await waitFor(socket, 'joined-room')).success).toBe(true);

      socket.emit('user-message', {
        sessionId, messageId: 'm1', message: 'hello there', timestamp: new Date().toISOString()
      });

      const reply = await waitFor(socket, 'bot-message');
      expect(reply.text).toBe('A reply from the bot');

      const conversation = await Conversation.findOne({ sessionId });
      // Without the tenant stamp the conversation belongs to nobody and the
      // company's own dashboard never shows it.
      expect(String(conversation.company)).toBe(String(acme._id));
      expect(conversation.messages.map(m => m.sender)).toEqual(['user', 'bot']);
    });

    it('reaches that tenant\'s operators and no others', async () => {
      const acmeSocket = await connectOperator(acmeOperator);
      const globexSocket = await connectOperator(globexOperator);
      acmeSocket.emit('join-operator-room');
      globexSocket.emit('join-operator-room');
      await new Promise(resolve => setTimeout(resolve, 50));

      const heardByGlobex = jest.fn();
      globexSocket.on('new-message', heardByGlobex);

      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-routing-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');
      visitor.emit('user-message', {
        sessionId, messageId: 'm1', message: 'a private question', timestamp: new Date().toISOString()
      });

      const seen = await waitFor(acmeSocket, 'new-message');
      expect(seen.message).toBe('a private question');
      expect(heardByGlobex).not.toHaveBeenCalled();
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
      socket.emit('join', sessionId);
      await waitFor(socket, 'joined-room');
      socket.emit('user-message', {
        sessionId, messageId: 'm2', message: 'are you there?', timestamp: new Date().toISOString()
      });

      // Somebody coming back days later must not meet the silence left behind
      // by an escalation that never happened.
      expect((await waitFor(socket, 'bot-message')).text).toBe('A reply from the bot');

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.status).toBe('active');
      expect(conversation.botEnabled).toBe(true);
    });

    it('says so rather than going quiet when the reply cannot be produced', async () => {
      replyService.generate.mockRejectedValueOnce(new Error('model unavailable'));

      const socket = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-failure-${Date.now()}`;
      socket.emit('join', sessionId);
      await waitFor(socket, 'joined-room');

      socket.emit('user-message', {
        sessionId, messageId: 'm1', message: 'hello', timestamp: new Date().toISOString()
      });

      expect((await waitFor(socket, 'error')).message).toMatch(/Failed to process message/);

      // The visitor's message is still stored, so an operator can pick it up.
      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.messages).toHaveLength(1);
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
      intruder.emit('operator-takeover', { sessionId, operatorName: 'Gus' });

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

    it('takes over their own tenant\'s conversation and the visitor hears about it', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-takeover-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');
      visitor.emit('user-message', {
        sessionId, messageId: 'm1', message: 'I need help', timestamp: new Date().toISOString()
      });
      await waitFor(visitor, 'bot-message');

      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId, operatorName: 'Ada' });

      const announcement = await waitFor(visitor, 'operator-message');
      expect(announcement.text).toMatch(/Ada has joined/);

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found && found.hasOperator ? found : null;
      });
      expect(conversation.operatorName).toBe('Ada');
    });

    it('answers, and the visitor gets the words the operator typed', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-operator-reply-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');
      visitor.emit('user-message', {
        sessionId, messageId: 'm1', message: 'where is my order', timestamp: new Date().toISOString()
      });
      await waitFor(visitor, 'bot-message');

      const operator = await connectOperator(acmeOperator);
      operator.emit('operator-takeover', { sessionId, operatorName: 'Ada' });
      await waitFor(visitor, 'operator-message');

      operator.emit('operator-message', { sessionId, message: 'It went out this morning.' });

      const delivered = await waitFor(visitor, 'operator-message');
      expect(delivered.text).toBe('It went out this morning.');

      const conversation = await eventually(async () => {
        const found = await Conversation.findOne({ sessionId });
        return found.messages.some(m => m.sender === 'operator') ? found : null;
      });
      expect(conversation.messages.at(-1).content).toBe('It went out this morning.');
    });

    it('ends a chat, and the visitor is asked to rate it', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-end-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');

      for (const text of ['first', 'second']) {
        visitor.emit('user-message', {
          sessionId, messageId: text, message: text, timestamp: new Date().toISOString()
        });
        await waitFor(visitor, 'bot-message');
      }

      const operator = await connectOperator(acmeOperator);
      operator.emit('end-chat', { sessionId });

      const ended = await waitFor(visitor, 'chat-ended');
      expect(ended.requestRating).toBe(true);
      expect((await Conversation.findOne({ sessionId })).status).toBe('ended');
    });
  });

  describe('a visitor asking for a person', () => {
    it('is queued rather than abandoned when nobody is available', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-queue-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');
      visitor.emit('user-message', {
        sessionId, messageId: 'm1', message: 'can I speak to someone', timestamp: new Date().toISOString()
      });
      await waitFor(visitor, 'bot-message');

      visitor.emit('request-operator');

      const result = await waitFor(visitor, 'operator-requested');
      expect(result).toMatchObject({ queued: true, connected: false });

      const conversation = await Conversation.findOne({ sessionId });
      expect(conversation.awaitingOperatorSince).toBeInstanceOf(Date);
      // The bot stays on: switching it off while nobody picks up is how a
      // visitor ends up talking to no one at all.
      expect(conversation.botEnabled).not.toBe(false);
    });
  });

  describe('ratings', () => {
    it('records the score against the socket\'s own session', async () => {
      const visitor = await connectVisitor(acme.widgetKey);
      const sessionId = `ws-rating-${Date.now()}`;
      visitor.emit('join', sessionId);
      await waitFor(visitor, 'joined-room');
      visitor.emit('user-message', {
        sessionId, messageId: 'm1', message: 'thanks', timestamp: new Date().toISOString()
      });
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

      const attacker = await connectVisitor(acme.widgetKey);
      const ownSessionId = `ws-attacker-${Date.now()}`;
      attacker.emit('join', ownSessionId);
      await waitFor(attacker, 'joined-room');
      attacker.emit('user-message', {
        sessionId: ownSessionId, messageId: 'm1', message: 'hello', timestamp: new Date().toISOString()
      });
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
      sockets.push(socket);
      await waitFor(socket, 'connect');

      const sessionId = `ws-forged-${Date.now()}`;
      await Conversation.create({ sessionId, company: acme._id, messages: [] });

      // As a visitor the join succeeds, but it is a visitor's join: nothing
      // operator-only follows from it.
      socket.emit('operator-message', { sessionId, message: 'I should not be able to say this' });
      await new Promise(resolve => setTimeout(resolve, 150));

      expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(0);
    });

    it('answers a heartbeat, which is how the widget knows it is still connected', async () => {
      const socket = await connectVisitor(acme.widgetKey);
      const sent = new Date().toISOString();

      socket.emit('heartbeat', { timestamp: sent });

      expect((await waitFor(socket, 'heartbeat-ack')).received).toBe(sent);
    });
  });
});
