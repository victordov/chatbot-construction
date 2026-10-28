/**
 * A socket server for the conversation-engine suites, built the way
 * tests/websockets.test.js builds one: a real database, real tenancy, tokens,
 * plans and assignment, and only what the model says stubbed. Each suite
 * mocks `services/reply` (and `services/ai`) itself before requiring this,
 * because jest hoists mocks per file.
 *
 * Not a test file: jest only runs `*.test.js`.
 */

const http = require('http');
const jwt = require('jsonwebtoken');
const { io: Client } = require('socket.io-client');

/** Wait for one event, and fail loudly rather than hanging until the timeout. */
const waitFor = (socket, event, timeout = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeout);
  socket.once(event, payload => {
    clearTimeout(timer);
    resolve(payload);
  });
});

/** Everything an event delivers from now on, for asserting on later. */
const collect = (socket, event) => {
  const seen = [];
  socket.on(event, payload => seen.push(payload));
  return seen;
};

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    await pause(25);
  }
};

let counter = 0;
const freshSessionId = prefix => `ws1-${prefix}-${Date.now()}-${(counter += 1)}`;

function createHarness() {
  const setupWebSockets = require('../websockets');
  const socketManager = require('../socketManager');
  const sockets = [];
  let httpServer;
  let io;
  let port;

  const harness = {
    get io() {
      return io;
    },

    async start() {
      httpServer = http.createServer();
      io = setupWebSockets(httpServer);
      // Assignment and availability read who is online from the socket rooms,
      // so they need the same io instance the server is running.
      socketManager.setIo(io);
      await new Promise(resolve => httpServer.listen(0, resolve));
      port = httpServer.address().port;
    },

    async stop() {
      harness.closeAll();
      setupWebSockets.graceTimers.forEach(timer => clearTimeout(timer));
      io.close();
      await new Promise(resolve => httpServer.close(resolve));
    },

    closeAll() {
      while (sockets.length) {
        sockets.pop().close();
      }
    },

    connect(options = {}) {
      const socket = Client(`http://localhost:${port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...options
      });
      sockets.push(socket);
      return socket;
    },

    async connectVisitor(widgetKey, options = {}) {
      const socket = harness.connect({
        ...options,
        auth: { ...(widgetKey ? { widgetKey } : {}), ...(options.auth || {}) }
      });
      await waitFor(socket, 'connect');
      return socket;
    },

    tokenFor(user, extra = {}) {
      return jwt.sign(
        { id: String(user._id), username: user.username, role: user.role, company: user.company, ...extra },
        process.env.JWT_SECRET
      );
    },

    async connectOperator(user, extra = {}) {
      const socket = harness.connect({ auth: { token: harness.tokenFor(user, extra) } });
      await waitFor(socket, 'connect');
      return socket;
    },

    /** An operator connected and listening to their tenant's room. */
    async connectOperatorInRoom(user, extra = {}) {
      const socket = await harness.connectOperator(user, extra);
      socket.emit('join-operator-room');
      await pause(60);
      return socket;
    },

    /**
     * Establish a session the way the widget does, and hand back what the
     * server said.
     */
    async resume(socket, sessionId, sessionToken, extra = {}) {
      const outcome = new Promise(resolve => {
        const onReady = payload => {
          socket.off('session-rejected', onRejected);
          resolve({ rejected: false, ...payload });
        };
        const onRejected = payload => {
          socket.off('session-ready', onReady);
          resolve({ rejected: true, ...payload });
        };
        socket.once('session-ready', onReady);
        socket.once('session-rejected', onRejected);
      });
      const history = new Promise(resolve => socket.once('session-history', resolve));

      socket.emit('resume-session', { sessionId, sessionToken, ...extra });

      const result = await outcome;
      return { ...result, history };
    },

    /** A fresh visitor bound to a fresh, still-pending session. */
    async startVisitor(prefix, widgetKey) {
      const socket = await harness.connectVisitor(widgetKey);
      const sessionId = freshSessionId(prefix);
      const session = await harness.resume(socket, sessionId);
      if (session.rejected) {
        throw new Error('The session was rejected');
      }
      return { socket, sessionId, sessionToken: session.sessionToken };
    },

    say(socket, message, clientMessageId) {
      socket.emit('user-message', {
        message,
        ...(clientMessageId ? { clientMessageId } : {}),
        timestamp: new Date().toISOString()
      });
    }
  };

  return harness;
}

module.exports = { createHarness, waitFor, collect, pause, eventually, freshSessionId };
