const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('./models/conversation');
const Company = require('./models/company');
const User = require('./models/user');
const AIService = require('./services/ai');
const tenantService = require('./services/tenant');
const usageService = require('./services/usage');
const contactService = require('./services/contacts');
const emailChannel = require('./services/email-channel');
const csatService = require('./services/csat');
const assignmentService = require('./services/assignment');
const replyService = require('./services/reply');
const webhookService = require('./services/webhooks');
const sessionToken = require('./services/session-token');
const { operatorRoom, userRoom, GLOBAL_OPERATOR_ROOM } = require('./socketManager');
const { logger } = require('./services/logging');

const STAFF_ROLES = ['operator', 'company_admin', 'superadmin'];
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SESSION_ID_LENGTH = 128;
/** How much of a conversation is replayed to a returning visitor. */
const HISTORY_REPLAY = 50;

/** Rooms a client may never ask to join by name: they are joined by role. */
const RESERVED_ROOM_PREFIXES = ['operators:', 'user:'];

/**
 * Grace timers for operators who have dropped off, keyed by user id.
 *
 * A page refresh is a disconnect followed a second later by a reconnect, and
 * releasing somebody's chats on every refresh would hand them to a colleague
 * mid-sentence. So a disconnect starts a clock, and only when it runs out
 * without the person coming back do their conversations move on.
 */
const graceTimers = new Map();

function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class QuotaRefusedError extends Error {
  constructor(quota) {
    super(quota.reason || 'refused by plan');
    this.name = 'QuotaRefusedError';
    this.quota = quota;
  }
}

/**
 * Share rooms across processes when a Redis is configured.
 *
 * With one process the in-memory adapter is exactly right. With two, an
 * operator connected to one process never hears a visitor connected to the
 * other, which looks like messages silently vanishing. Failure here is logged
 * and the in-memory adapter kept, because a Redis outage at boot should not
 * take chat down with it.
 */
async function attachRedisAdapter(io) {
  const url = process.env.REDIS_URL;
  if (!url) {
    return false;
  }

  try {
    const { createClient } = require('redis');
    const { createAdapter } = require('@socket.io/redis-adapter');

    const pub = createClient({ url });
    const sub = pub.duplicate();
    // Without a listener a client error is an unhandled 'error' event, which
    // is a crash.
    pub.on('error', error => logger.error('Redis pub client error', { error: error.message }));
    sub.on('error', error => logger.error('Redis sub client error', { error: error.message }));

    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    logger.info('Socket.io using the Redis adapter');
    return true;
  } catch (error) {
    logger.warn('Redis adapter unavailable; continuing with the in-memory adapter', {
      error: error.message
    });
    return false;
  }
}

/** The shape a stored message is replayed in. */
function toReplayPayload(message) {
  const payload = {
    id: message._id ? message._id.toString() : undefined,
    text: message.content,
    sender: message.sender,
    isOperator: message.sender === 'operator',
    operatorName: message.operatorName || undefined,
    timestamp: message.timestamp || new Date()
  };

  if (message.fileId) {
    payload.fileId = message.fileId;
    payload.fileName = message.fileName;
    payload.fileUrl = `/api/upload/${message.fileId}`;
  }

  return payload;
}

/** The last message on a conversation, once saved, has a database id. */
function lastMessageId(conversation) {
  const last = conversation.messages && conversation.messages[conversation.messages.length - 1];
  return last && last._id ? last._id.toString() : 'temp-id';
}

function setupWebSockets(server) {
  const io = socketIO(server, {
    cors: {
      origin: function (origin, callback) {
        // No Origin means a non-browser client; tenant domains are resolved
        // from the database so onboarding a customer does not require an env
        // change and redeploy.
        if (!origin) {
          return callback(null, true);
        }

        // The admin dashboard connects from the server's own origin.
        const selfOrigins = [
          `http://localhost:${process.env.PORT || 3000}`,
          `http://127.0.0.1:${process.env.PORT || 3000}`,
          process.env.PUBLIC_URL
        ].filter(Boolean);
        if (selfOrigins.includes(origin)) {
          return callback(null, true);
        }

        tenantService.isOriginAllowed(origin)
          .then(allowed => callback(allowed ? null : new Error('Not allowed by CORS'), allowed))
          .catch(error => callback(error));
      },
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  attachRedisAdapter(io).catch(error => {
    logger.warn('Redis adapter setup failed', { error: error.message });
  });

  // Middleware for authenticating operators
  io.use(async (socket, next) => {
    try {
      // Get token from socket handshake auth
      const token = socket.handshake.auth.token;

      // If no token, client is a regular user (not an operator)
      if (!token) {
        socket.user = { role: 'user' };
        return next();
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');

      // Check if user still exists and is active
      const user = await User.findById(decoded.id)
        .select('username displayName role company isActive tokenVersion acceptingChats');
      if (!user || !user.isActive) {
        return next(new Error('Authentication failed'));
      }

      // A token issued before a password change or reset is a token somebody
      // else may hold. It is treated like a forged one: the connection becomes
      // a visitor's, with nothing operator-only reachable from it.
      const currentVersion = user.tokenVersion || 0;
      const stale = decoded.tv !== undefined
        ? decoded.tv !== currentVersion
        : currentVersion > 0;

      if (stale) {
        logger.warn('Socket token refused: stale token version', { user: user.username });
        socket.user = { role: 'user' };
        return next();
      }

      // Add user info to socket. `company` is required so operator events can
      // be scoped to a single tenant instead of a global broadcast room.
      socket.user = {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        companyId: user.company ? user.company.toString() : null,
        acceptingChats: user.acceptingChats !== false
      };

      next();
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        socket.user = { role: 'user' }; // Treat as regular user if token is invalid
        return next();
      }
      next(new Error('Authentication failed'));
    }
  });

  /**
   * An operator who did not come back: move their conversations on.
   *
   * Each open conversation is offered to a colleague; failing that it goes
   * back to the queue with the bot answering, and the visitor is told rather
   * than left wondering why the person they were talking to has gone quiet.
   */
  const releaseOperatorChats = async (userId, username) => {
    graceTimers.delete(String(userId));

    try {
      const held = await Conversation.find({ operatorId: userId, status: 'active' });

      for (const conversation of held) {
        const result = await assignmentService.release(conversation, { exclude: [userId] });
        const sessionId = conversation.sessionId;

        io.to(sessionId).emit('operator-message', {
          text: result.assigned
            ? `${result.operator.displayName} has joined the conversation and will assist you.`
            : 'Your operator has been disconnected. Someone will be with you shortly; in the meantime the assistant can help.',
          senderName: result.assigned ? result.operator.displayName : 'Support',
          timestamp: new Date()
        });

        io.to(operatorRoom(conversation.company)).emit('operator-left', {
          sessionId,
          operatorId: userId,
          operatorName: username,
          reason: 'disconnected',
          reassignedTo: result.assigned ? result.operator.displayName : null,
          timestamp: new Date()
        });
        io.to(GLOBAL_OPERATOR_ROOM).emit('operator-left', {
          sessionId,
          operatorId: userId,
          operatorName: username,
          reason: 'disconnected',
          timestamp: new Date()
        });
      }

      if (held.length > 0) {
        logger.info('Released conversations of a disconnected operator', {
          operator: username,
          count: held.length
        });
      }
    } catch (error) {
      logger.error('Failed to release a disconnected operator\'s conversations', {
        operator: username,
        error: error.message
      });
    }
  };

  // Handle socket connections
  io.on('connection', (socket) => {
    logger.info('New client connected');

    // Every staff role counts as an operator here. The old check looked for a
    // role named 'admin', which does not exist in the User schema, so
    // superadmins and company admins were silently treated as visitors.
    const isOperator = Boolean(socket.user && STAFF_ROLES.includes(socket.user.role));
    const isSuperadmin = Boolean(socket.user && socket.user.role === 'superadmin');
    const canForceTakeover = Boolean(
      socket.user && ['company_admin', 'superadmin'].includes(socket.user.role)
    );
    // Null for a superadmin, who belongs to no tenant.
    const operatorCompanyId = socket.user ? socket.user.companyId : null;
    // The name every operator-originated message carries. Server-side only:
    // a name in the payload would let anyone claim to be anyone.
    const operatorDisplayName = socket.user
      ? (socket.user.displayName || socket.user.username || 'Operator')
      : 'Operator';

    /**
     * The one conversation this socket has proved it owns.
     *
     * Set only by a successful `resume-session`, and the only session any
     * visitor event may act on. A session id in a payload is ignored: it is
     * not a credential, and honouring it let one visitor write into another's
     * conversation.
     */
    let boundSessionId = null;

    // Company of the visitor on the other end of this socket, resolved from the
    // widget key / origin so their events reach only their tenant's operators.
    let clientCompanyId = null;

    /**
     * Messages per minute this socket may send, as a token bucket.
     *
     * Per socket rather than per IP, so a shared office address is not
     * throttled by its neighbours, and in memory because the count only has
     * to be right for the life of one connection.
     */
    const rateLimit = (() => {
      const capacity = envInt('RATE_LIMIT_CHAT_MAX', 20);
      let tokens = capacity;
      let refilledAt = Date.now();

      return () => {
        const now = Date.now();
        tokens = Math.min(capacity, tokens + ((now - refilledAt) * capacity) / 60000);
        refilledAt = now;
        if (tokens < 1) {
          return false;
        }
        tokens -= 1;
        return true;
      };
    })();

    /**
     * Where this socket connected from, captured once at connection time.
     *
     * Operators use this to see which site a conversation came from, and it
     * drives the traffic-source chart. Different transports populate different
     * headers, so try each in turn rather than relying on `origin` alone.
     */
    const connectionOrigin = (() => {
      const headers = socket.handshake.headers || {};
      const candidate = headers.origin || headers.referer;

      if (candidate) {
        try {
          return new URL(candidate).origin;
        } catch {
          return candidate;
        }
      }

      // Last resort: the Host header tells us the server the client reached,
      // which for a first-party install is also the site they are on.
      if (headers.host) {
        return `${socket.handshake.secure ? 'https' : 'http'}://${headers.host}`;
      }

      return null;
    })();

    /**
     * Emit to the operators of one tenant (plus superadmins), excluding this
     * socket. Replaces the previous global 'operators' room, which delivered
     * every tenant's messages to every tenant's operators.
     */
    const toOperators = (companyId, event, payload) => {
      socket.to(operatorRoom(companyId)).emit(event, payload);
      socket.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
    };

    /** Same, but including this socket (used for operator-originated events). */
    const allOperators = (companyId, event, payload) => {
      io.to(operatorRoom(companyId)).emit(event, payload);
      io.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
    };

    /**
     * The tenant an operator-originated event about a conversation belongs
     * to. For an operator that is their own company; for a superadmin, who
     * has none, it is the conversation's - otherwise their actions would be
     * announced to an `operators:unassigned` room nobody is in.
     */
    const tenantOf = conversation => {
      if (conversation && conversation.company) {
        return conversation.company.toString();
      }
      return operatorCompanyId;
    };

    /**
     * Guard for operator actions on a specific conversation. Without this an
     * operator could join, read, answer or end any session id they can guess,
     * including conversations belonging to another company.
     */
    const canOperateOn = async (sessionId) => {
      if (!isOperator || typeof sessionId !== 'string' || !sessionId) {
        return false;
      }
      if (isSuperadmin) {
        return true;
      }
      const conversation = await Conversation.findOne({ sessionId }).select('company').lean();
      if (!conversation) {
        return false;
      }
      const convCompany = conversation.company ? conversation.company.toString() : null;
      return Boolean(convCompany && operatorCompanyId && convCompany === operatorCompanyId);
    };

    /**
     * Resolve and remember the tenant for the visitor's session, so later
     * events on this socket can be routed without another database lookup.
     */
    const resolveClientCompany = async (sessionId, hints = {}) => {
      if (clientCompanyId) {
        return clientCompanyId;
      }

      const existing = sessionId
        ? await Conversation.findOne({ sessionId }).select('company').lean()
        : null;

      if (existing && existing.company) {
        clientCompanyId = existing.company.toString();
        return clientCompanyId;
      }

      const companyId = await tenantService.resolveCompanyId({
        widgetKey: hints.widgetKey || socket.handshake.auth?.widgetKey || socket.handshake.query?.widgetKey,
        origin: socket.handshake.headers.origin || socket.handshake.headers.referer
      });

      clientCompanyId = companyId ? companyId.toString() : null;
      return clientCompanyId;
    };

    /**
     * Find or create the conversation for a session, always stamping the
     * resolved company so multi-tenant filtering works downstream.
     *
     * @throws {QuotaRefusedError} when the tenant may not start another
     *         conversation this month; nothing is created
     */
    const getOrCreateConversation = async (sessionId, hints = {}) => {
      // Where the visitor is chatting from. Operators use this to know which
      // site a conversation came from, and it drives the traffic-source chart.
      const origin = hints.pageUrl || connectionOrigin;

      let conversation = await Conversation.findOne({ sessionId });

      if (!conversation) {
        const companyId = await resolveClientCompany(sessionId, hints);

        // Checked before anything is written: a conversation the plan does
        // not allow must not exist, or it would be counted next month too.
        const quota = await usageService.check(companyId, 'conversationsPerMonth');
        if (!quota.allowed) {
          logger.warn('Conversation refused by plan', {
            companyId: companyId ? String(companyId) : null,
            reason: quota.reason
          });
          usageService.recordLimitHit(companyId);
          throw new QuotaRefusedError(quota);
        }

        conversation = new Conversation({
          sessionId,
          company: companyId || undefined,
          domain: origin,
          messages: []
        });

        // Metered once, at creation, so a long conversation counts as one.
        usageService.record(companyId, { conversations: 1 });

        // Some teams run no bot at all, and for them a conversation that sits
        // unassigned until somebody notices it is the whole problem. Saved
        // first, because assignment needs a document with an id.
        if (companyId) {
          conversation.company = companyId;
          await conversation.save();

          const company = await Company.findById(companyId).select('routing').lean();
          if (company?.routing?.autoAssign && company.routing.assignOnStart) {
            await assignmentService.autoAssign(conversation);
          }
        }
      } else {
        // Backfill on conversations created before the tenant or origin was
        // known - for example by a `join` that arrived before `user-details`.
        if (!conversation.company) {
          const companyId = await resolveClientCompany(sessionId, hints);
          if (companyId) {
            conversation.company = companyId;
          }
        }
        if (!conversation.domain && origin) {
          conversation.domain = origin;
        }
      }

      if (conversation.company) {
        clientCompanyId = conversation.company.toString();
      }

      // Attach the person behind the session. Identity claims are only trusted
      // when the tenant signed them; see services/contacts.js.
      if (clientCompanyId && !conversation.contact) {
        const contact = await contactService.resolve({
          companyId: clientCompanyId,
          sessionId,
          externalId: hints.externalId || socket.handshake.auth?.externalId,
          userHash: hints.userHash || socket.handshake.auth?.userHash,
          email: hints.email,
          name: hints.name,
          phone: hints.phone
        });

        if (contact) {
          await contactService.linkConversation(contact, conversation);
        }
      }

      return conversation;
    };

    /**
     * Tell the visitor the chat is unavailable, in the bot's voice.
     *
     * Persisted when there is a conversation to persist it on, so the
     * transcript an operator reads later explains the gap.
     */
    const sendUnavailable = async (sessionId, conversation) => {
      const payload = { text: usageService.UNAVAILABLE_MESSAGE, timestamp: new Date() };

      if (conversation) {
        conversation.messages.push({ content: payload.text, sender: 'bot', timestamp: payload.timestamp });
        conversation.lastActivity = new Date();
        await conversation.save();
        payload.id = lastMessageId(conversation);
      }

      socket.emit('bot-message', payload);
    };

    /**
     * Draft a reply for the operator holding a conversation.
     *
     * One helper for the three places that want it, which used to be three
     * copies of the same block. The draft goes to the holding operator's own
     * room rather than to every operator of the tenant: it is a suggestion
     * for the person answering, not an announcement.
     *
     * A suggestion is a model call, so it is metered as one and only offered
     * on plans that include the feature.
     */
    const offerSuggestion = async (conversation, targetMessage, options = {}) => {
      if (!conversation || !targetMessage || conversation.suggestionsEnabled === false) {
        return;
      }

      const recipientId = options.to || conversation.operatorId;
      if (!recipientId) {
        // Nobody holding it means nobody to draft for.
        return;
      }

      const companyId = tenantOf(conversation);

      if (!(await usageService.hasFeature(companyId, 'aiSuggestions'))) {
        return;
      }

      const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
      if (!quota.allowed) {
        logger.warn('Operator suggestion refused by plan', {
          companyId: companyId ? String(companyId) : null,
          reason: quota.reason
        });
        usageService.recordLimitHit(companyId);
        return;
      }

      const history = conversation.messages
        .slice(-10)
        .map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.content
        }));

      const aiService = await AIService.forCompany(companyId);
      const suggestion = await aiService.generateOperatorSuggestion(targetMessage.content, history);

      usageService.record(companyId, { aiResponses: 1 });

      io.to(userRoom(recipientId)).emit('operator-suggestion', {
        sessionId: conversation.sessionId,
        userMessageId: targetMessage._id ? targetMessage._id.toString() : undefined,
        userMessage: targetMessage.content,
        suggestion,
        timestamp: new Date()
      });
    };

    /**
     * Persist and deliver an operator's message, over whichever channel the
     * conversation lives on.
     *
     * @returns {Promise<{ok: boolean, error?: string, messageId?: string}>}
     */
    const deliverOperatorMessage = async (conversation, text) => {
      // An email thread is answered from the same composer; only delivery
      // differs. Sent before persisting so a failure can be reported to the
      // operator rather than leaving a message that never went out.
      let delivery = { sent: true };

      if (conversation.channel === 'email') {
        delivery = await emailChannel.sendReply(conversation, text, operatorDisplayName);

        if (!delivery.sent) {
          return { ok: false, error: `Could not send that email: ${delivery.reason}` };
        }
      }

      conversation.messages.push({
        content: text,
        sender: 'operator',
        operatorId: socket.user.id,
        operatorName: operatorDisplayName,
        emailMessageId: delivery.messageId,
        timestamp: new Date()
      });

      conversation.lastActivity = new Date();
      await conversation.save();

      usageService.record(conversation.company, { operatorMessages: 1, messages: 1 });

      const messageId = lastMessageId(conversation);

      // Chat visitors get it over the socket. Email visitors already have it
      // in their inbox.
      if (conversation.channel !== 'email') {
        io.to(conversation.sessionId).emit('operator-message', {
          id: messageId,
          text,
          senderName: operatorDisplayName,
          timestamp: new Date()
        });
      }

      return { ok: true, messageId };
    };

    /** A valid chat message, or the reason it is not one. */
    const validateMessage = (value) => {
      if (typeof value !== 'string') {
        return { error: 'Message must be text' };
      }
      const text = value.trim();
      if (text.length === 0) {
        return { error: 'Message cannot be empty' };
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        return { error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` };
      }
      return { text };
    };

    // Staff get a personal room so notifications can be delivered to one user
    // rather than broadcast to every connected client - and coming back
    // within the grace period cancels the release of their conversations.
    if (isOperator && socket.user.id) {
      socket.join(userRoom(socket.user.id));

      const pending = graceTimers.get(String(socket.user.id));
      if (pending) {
        clearTimeout(pending);
        graceTimers.delete(String(socket.user.id));
        logger.info('Operator reconnected within the grace period', { operator: socket.user.username });
      }
    }

    // Join a chat session room
    socket.on('join', async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) {
        return socket.emit('joined-room', { success: false, error: 'Invalid session' });
      }

      // Role rooms are joined by role, never by name. A visitor asking for
      // `operators:all` used to be let in, and from then on received every
      // tenant's traffic.
      if (RESERVED_ROOM_PREFIXES.some(prefix => sessionId.startsWith(prefix))) {
        logger.warn('Join denied for reserved room', { room: sessionId });
        return socket.emit('joined-room', { success: false, error: 'Access denied' });
      }

      if (isOperator) {
        // Operators must prove they own the tenant before eavesdropping on a room.
        if (!(await canOperateOn(sessionId))) {
          logger.warn('Operator denied join for out-of-tenant session', {
            sessionId,
            operator: socket.user.username
          });
          return socket.emit('joined-room', { success: false, error: 'Access denied' });
        }
      } else if (sessionId !== boundSessionId) {
        // A visitor is in exactly one room: the session they resumed with the
        // right token. Anything else is somebody else's conversation.
        logger.warn('Visitor denied join for a session they do not own', { sessionId });
        return socket.emit('joined-room', { success: false, error: 'Access denied' });
      }

      socket.join(sessionId);
      logger.info(`Client joined room: ${sessionId}`);
      socket.emit('joined-room', {
        success: true,
        room: sessionId
      });
    });

    /**
     * A visitor establishing, or coming back to, their conversation.
     *
     * This is the only way a socket becomes bound to a session, and the token
     * is what makes the binding worth anything. A session id is public-ish -
     * it is in dashboard URLs and exports - so a conversation that has a
     * token demands it, and a resume without the right one gets nothing: no
     * room, no history, no binding.
     */
    socket.on('resume-session', async (data = {}) => {
      const sessionId = data && data.sessionId;

      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
        return socket.emit('session-rejected', { sessionId: sessionId || null });
      }

      try {
        let conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
        let token = null;

        if (conversation && conversation.sessionTokenHash) {
          if (!sessionToken.verify(conversation.sessionTokenHash, data.sessionToken)) {
            logger.warn('Session resume rejected: token mismatch', { sessionId });
            return socket.emit('session-rejected', { sessionId });
          }
          // The token they presented is the token; hand it back so the widget
          // has one place to read it from.
          token = data.sessionToken;
        } else if (conversation) {
          // Created before tokens existed. Accepted this once, and given a
          // token so that from now on it is protected like every other.
          token = sessionToken.issue();
          conversation.sessionTokenHash = sessionToken.hash(token);
          await conversation.save();
        } else {
          try {
            conversation = await getOrCreateConversation(sessionId, data);
          } catch (error) {
            if (!(error instanceof QuotaRefusedError)) {
              throw error;
            }
            // Nothing exists to hijack, so the socket may hold the id; the
            // visitor is told why nobody is answering.
            boundSessionId = sessionId;
            socket.join(sessionId);
            socket.emit('session-ready', { sessionId, sessionToken: null });
            await sendUnavailable(sessionId, null);
            return;
          }

          token = sessionToken.issue();
          conversation.sessionTokenHash = sessionToken.hash(token);
          await conversation.save();
        }

        if (conversation.company) {
          clientCompanyId = conversation.company.toString();
        } else {
          await resolveClientCompany(sessionId, data);
        }

        boundSessionId = sessionId;
        socket.join(sessionId);

        socket.emit('session-ready', { sessionId, sessionToken: token });

        // History goes out as one event rather than replayed as live
        // messages, so the widget can tell "what was said" from "what was
        // just said" and drop what it already has by id.
        const messages = (conversation.messages || []).slice(-HISTORY_REPLAY).map(toReplayPayload);
        socket.emit('session-history', { sessionId, messages });

        logger.info(`Session resumed: ${sessionId}`);
      } catch (error) {
        logger.error('Error resuming session', { sessionId, error: error.message });
        socket.emit('session-rejected', { sessionId });
      }
    });

    // Handle chat opened event
    socket.on('chat-opened', async () => {
      if (isOperator || !boundSessionId) {
        return;
      }

      // Notify operators that a chat has been opened
      await resolveClientCompany(boundSessionId);
      toOperators(clientCompanyId, 'chat-activity', {
        type: 'opened',
        sessionId: boundSessionId,
        timestamp: new Date()
      });
    });

    // Handle user details from widget
    socket.on('user-details', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        // The widget may send the pre-chat form before the session is
        // established; the details arrive again with the first message.
        return;
      }

      const sessionId = boundSessionId;

      try {
        const { name, email, phone } = data;

        // Save user details to conversation metadata
        const conversation = await getOrCreateConversation(sessionId, data);

        // Initialize metadata if it doesn't exist
        if (!conversation.metadata) {
          conversation.metadata = new Map();
        }

        // Update metadata with user details
        conversation.metadata.set('name', name || '');
        conversation.metadata.set('email', email || '');
        conversation.metadata.set('phone', phone || '');

        // Now that they have told us who they are, re-resolve: an email may
        // merge this session with a person we already know.
        const contact = await contactService.resolve({
          companyId: clientCompanyId,
          sessionId,
          externalId: data.externalId || socket.handshake.auth?.externalId,
          userHash: data.userHash || socket.handshake.auth?.userHash,
          email,
          name,
          phone
        });

        if (contact) {
          await contactService.linkConversation(contact, conversation);
        }

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();

        // Notify operators that user details have been updated
        toOperators(clientCompanyId, 'user-details-updated', {
          sessionId,
          name,
          email,
          phone,
          timestamp: new Date()
        });

        logger.info(`User details updated for session: ${sessionId}`);
      } catch (error) {
        if (error instanceof QuotaRefusedError) {
          return sendUnavailable(sessionId, null);
        }
        logger.error('Error handling user details:', error);
        socket.emit('error', { sessionId, message: 'Failed to save user details' });
      }
    });

    /**
     * The bot's turn.
     *
     * The published workflow answers if the tenant has one, otherwise the
     * assistant. This used to call the assistant directly, which is why a
     * published workflow had no effect on any live conversation.
     *
     * The plan is checked first and the model is not called when it says no;
     * and a failure to produce a reply is said out loud, in the bot's voice,
     * rather than left as an error event the widget may or may not show.
     */
    const answerAutomatically = async (conversation, message) => {
      const sessionId = conversation.sessionId;
      const companyId = clientCompanyId;

      const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
      if (!quota.allowed) {
        logger.warn('Automated reply refused by plan', {
          companyId: companyId ? String(companyId) : null,
          reason: quota.reason
        });
        usageService.recordLimitHit(companyId);
        return sendUnavailable(sessionId, conversation);
      }

      const messageHistory = conversation.messages
        .slice(-10)
        .map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.content
        }));

      io.to(sessionId).emit('bot-typing', { sessionId, typing: true });

      let reply;
      try {
        reply = await replyService.generate({
          conversation,
          message,
          history: messageHistory
        });
      } catch (error) {
        logger.error('Failed to generate a reply', { sessionId, error: error.message });
        io.to(sessionId).emit('bot-typing', { sessionId, typing: false });

        // Said in the bot's voice, and saved, so the transcript shows the gap
        // and the visitor is not staring at a typing indicator that ends in
        // nothing.
        conversation.messages.push({
          content: usageService.REPLY_FAILED_MESSAGE,
          sender: 'bot',
          timestamp: new Date()
        });
        conversation.lastActivity = new Date();
        await conversation.save();

        socket.emit('bot-message', {
          id: lastMessageId(conversation),
          text: usageService.REPLY_FAILED_MESSAGE,
          timestamp: new Date()
        });
        socket.emit('error', { sessionId, message: 'Failed to generate a reply' });
        return;
      }

      const botResponse = reply.text;
      // The knowledge sources the answer drew on, for the widget to cite.
      const sources = Array.isArray(reply.sources) ? reply.sources : [];

      // Create a message ID for the bot response
      const botMessageId = 'bot_' + Date.now();

      conversation.messages.push({
        content: botResponse,
        sender: 'bot',
        messageId: botMessageId,
        sources: sources.length ? sources : undefined,
        timestamp: new Date()
      });
      conversation.lastActivity = new Date();
      await conversation.save();

      const dbBotMessageId = lastMessageId(conversation);

      io.to(sessionId).emit('bot-typing', { sessionId, typing: false });

      socket.emit('bot-message', {
        id: dbBotMessageId,
        clientId: botMessageId,
        text: botResponse,
        // Quick replies, when the workflow offered a set of choices. The
        // widget renders them as buttons; a visitor tapping one is
        // unambiguous in a way that typing never is.
        choices: reply.choices || undefined,
        // Products or appointment times for the widget to render.
        cards: reply.cards || undefined,
        // Always an array, so the widget can test its length without a guard.
        sources,
        timestamp: new Date()
      });

      // A workflow node can ask for a person. Honour it here rather than
      // leaving the escalation as a sentence the visitor has to act on.
      if (reply.escalate && reply.escalate.enabled !== false) {
        const escalated = await assignmentService.autoAssign(conversation);
        allOperators(companyId, 'operator-requested', {
          sessionId,
          assigned: escalated.assigned,
          timestamp: new Date()
        });
      }

      // Only an assistant reply is a model call. A workflow that answered
      // from a fixed template or a lookup did not use the model, and
      // metering it as one would overcharge the tenant.
      usageService.record(companyId, reply.source === 'workflow'
        ? { messages: 1 }
        : { aiResponses: 1, messages: 1 });

      toOperators(companyId, 'new-message', {
        sessionId,
        message: botResponse,
        sender: 'bot',
        messageId: dbBotMessageId,
        sources,
        timestamp: new Date()
      });
    };

    // Handle user messages from widget
    socket.on('user-message', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return socket.emit('error', { message: 'Session not established' });
      }

      const sessionId = boundSessionId;
      const { messageId, timestamp } = data;

      const validated = validateMessage(data.message);
      if (validated.error) {
        return socket.emit('error', { sessionId, message: validated.error });
      }
      const message = validated.text;

      if (!rateLimit()) {
        logger.warn('Visitor message rate limit exceeded', { sessionId });
        return socket.emit('error', { sessionId, message: 'You are sending messages too quickly. Please wait a moment.' });
      }

      let conversation;

      try {
        // Save message to database
        try {
          conversation = await getOrCreateConversation(sessionId, data);
        } catch (error) {
          if (error instanceof QuotaRefusedError) {
            return sendUnavailable(sessionId, null);
          }
          throw error;
        }

        // Check if the conversation was ended and reactivate it if needed
        if (conversation.status === 'ended') {
          conversation.status = 'active';
          conversation.endedAt = null;

          // A reopened conversation is a fresh one, so whatever was true about
          // who owned it no longer is. Without this a visitor who was escalated,
          // never picked up, and had the chat closed came back days later to a
          // bot that had been switched off for them and an operator who was long
          // gone — silence from their first message.
          if (!conversation.operatorId) {
            conversation.hasOperator = false;
            conversation.botEnabled = true;
            conversation.awaitingOperatorSince = undefined;
          }

          // Notify operators that this chat has been reactivated
          toOperators(clientCompanyId, 'chat-reactivated', {
            sessionId,
            timestamp: new Date()
          });
        }

        const sentAt = timestamp ? new Date(timestamp) : new Date();

        // Add the new message with messageId
        const messageDoc = {
          content: message,
          sender: 'user',
          messageId, // Store client-generated message ID for tracking
          timestamp: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt
        };

        // Add user name to message if available in data or metadata
        if (data.userName) {
          messageDoc.userName = data.userName;
        } else if (conversation.metadata && conversation.metadata.get('name')) {
          messageDoc.userName = conversation.metadata.get('name');
        }

        conversation.messages.push(messageDoc);

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();
        const dbMessageId = lastMessageId(conversation);
        const storedUserMessage = conversation.messages[conversation.messages.length - 1];

        // Broadcast to operators (admin dashboard)
        const broadcastData = {
          sessionId,
          message,
          sender: 'user',
          messageId: dbMessageId,
          clientMessageId: messageId,
          timestamp: new Date()
        };

        // Add user name to broadcast if available
        if (messageDoc.userName) {
          broadcastData.userName = messageDoc.userName;
        }

        toOperators(clientCompanyId, 'new-message', broadcastData);

        usageService.record(clientCompanyId, { messages: 1 });

        // Send read receipt for the user message before any reply is
        // generated, so a slow model does not look like a lost message.
        socket.emit('message-read', {
          messageId,
          timestamp: new Date()
        });

        if (conversation.hasOperator) {
          // A person has it: draft them a reply rather than answering.
          await offerSuggestion(conversation, storedUserMessage);
        } else if (conversation.botEnabled !== false) {
          await answerAutomatically(conversation, message);
        }
      } catch (error) {
        logger.error('Error handling message:', { error });
        socket.emit('error', { sessionId, message: 'Failed to process message' });
      }
    });

    // Handle file uploads
    socket.on('file-uploaded', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      const sessionId = boundSessionId;
      const { fileId, fileName, timestamp } = data;

      try {
        const conversation = await getOrCreateConversation(sessionId, data);

        // POST /api/upload already recorded the message. This event is the
        // widget telling us the upload finished, so only append when the
        // message is missing - otherwise every attachment appears twice.
        const alreadyRecorded = fileId &&
          conversation.messages.some(message => message.fileId === fileId);

        if (!alreadyRecorded) {
          conversation.messages.push({
            content: `[File uploaded: ${fileName}]`,
            sender: 'user',
            fileId,
            fileName,
            timestamp: timestamp ? new Date(timestamp) : new Date()
          });
        }

        conversation.lastActivity = new Date();
        await conversation.save();

        // Tell the operators, so an attachment shows up in their queue.
        // The previous handler instead waited two seconds and sent a canned
        // "I've received your file" from the bot, which was a placeholder for
        // file analysis that does not exist - and it fired even when a human
        // operator was already handling the conversation.
        // `fileId`/`fileName`/`fileUrl` at the top level match what an
        // operator-sent file carries, so the dashboard renders both the same
        // way; `fileInfo` stays for anything still reading the older shape.
        const recorded = conversation.messages.find(message => message.fileId === fileId);
        const storedName = (recorded && recorded.fileName) || fileName;
        const fileUrl = `/api/upload/${fileId}`;
        toOperators(clientCompanyId, 'new-message', {
          sessionId,
          message: `[File uploaded: ${storedName}]`,
          sender: 'user',
          messageId: recorded && recorded._id ? recorded._id.toString() : undefined,
          timestamp: new Date(),
          fileId,
          fileName: storedName,
          fileUrl,
          fileInfo: { fileName: storedName, fileId, url: fileUrl }
        });

        socket.emit('message-read', { messageId: fileId, timestamp: new Date() });
      } catch (error) {
        if (error instanceof QuotaRefusedError) {
          return sendUnavailable(sessionId, null);
        }
        logger.error('Error handling file upload:', { error });
      }
    });

    // Handle typing indicators from users
    socket.on('user-typing', (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      // Broadcast typing status to operators
      toOperators(clientCompanyId, 'user-typing', {
        sessionId: boundSessionId,
        isTyping: Boolean(data.isTyping),
        timestamp: new Date()
      });
    });

    // Handle typing indicators from operators
    socket.on('operator-typing', async (data = {}) => {
      const { sessionId, isTyping } = data;

      // Being an operator somewhere is not permission to type into somebody
      // else's conversation. Every other operator handler checks this; this one
      // did not, so an operator at one tenant could make "someone is typing"
      // appear in another tenant's chat window.
      if (!await canOperateOn(sessionId)) {
        return;
      }

      // Broadcast typing status to users in the session
      io.to(sessionId).emit('operator-typing', {
        isTyping,
        operatorName: operatorDisplayName,
        timestamp: new Date()
      });
    });

    // Handle message read receipts
    socket.on('message-read', (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      const { messageId, timestamp } = data;
      const readAt = timestamp ? new Date(timestamp) : new Date();

      // Broadcast read receipt to operators
      toOperators(clientCompanyId, 'message-read', {
        sessionId: boundSessionId,
        messageId,
        timestamp: Number.isNaN(readAt.getTime()) ? new Date() : readAt
      });
    });

    // Handle marking all messages as read
    socket.on('mark-all-read', () => {
      if (isOperator || !boundSessionId) {
        return;
      }

      // Broadcast to operators
      toOperators(clientCompanyId, 'all-messages-read', {
        sessionId: boundSessionId,
        timestamp: new Date()
      });
    });

    // Handle operator joining monitoring room
    socket.on('join-operator-room', () => {
      if (!isOperator) {
        return;
      }
      if (isSuperadmin) {
        socket.join(GLOBAL_OPERATOR_ROOM);
      } else {
        socket.join(operatorRoom(operatorCompanyId));
      }
      logger.info('Operator joined monitoring room', {
        role: socket.user.role,
        company: operatorCompanyId
      });
    });

    // Handle operator taking over chat
    socket.on('operator-takeover', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId } = data;

      if (!(await canOperateOn(sessionId))) {
        logger.warn('Operator takeover denied', { sessionId, operator: socket.user.username });
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      try {
        const current = await Conversation.findOne({ sessionId })
          .select('operatorId operatorName company')
          .lean();

        if (!current) {
          return socket.emit('error', { sessionId, message: 'Conversation not found' });
        }

        const heldByAnother = current.operatorId &&
          String(current.operatorId) !== String(socket.user.id);

        // Two people answering one visitor is worse than one. A colleague's
        // conversation can be taken only deliberately, and only by someone
        // whose job includes reassigning work.
        if (heldByAnother && !(data.force === true && canForceTakeover)) {
          return socket.emit('error', {
            sessionId,
            message: `${current.operatorName || 'Another operator'} is already handling this conversation`,
            heldBy: { id: String(current.operatorId), name: current.operatorName || null }
          });
        }

        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              hasOperator: true,
              // The workflow stops here. Two of them asking questions at once
              // — a person and a half-finished flow — is worse than either.
              workflowState: { awaiting: null, variables: {}, updatedAt: new Date() },
              operatorId: socket.user.id,
              operatorName: operatorDisplayName,
              assignment: { method: 'manual', at: new Date() }
            },
            $unset: { awaitingOperatorSince: 1 }
          },
          { new: true }
        );

        if (!conversation) {
          return socket.emit('error', { sessionId, message: 'Conversation not found' });
        }

        // Join the session room to receive real-time updates
        socket.join(sessionId);
        logger.info(`Operator joined session room: ${sessionId}`);

        const tenantId = tenantOf(conversation);

        // Notify user that operator has joined
        io.to(sessionId).emit('operator-message', {
          text: `${operatorDisplayName} has joined the conversation and will assist you.`,
          senderName: operatorDisplayName,
          timestamp: new Date()
        });

        if (heldByAnother) {
          // The person who had it is told it has been taken, by name.
          io.to(userRoom(current.operatorId)).emit('chat-taken-from-you', {
            sessionId,
            takenBy: operatorDisplayName,
            timestamp: new Date()
          });
        }

        // Notify all operators that an operator has joined this chat
        allOperators(tenantId, 'operator-joined', {
          sessionId,
          operatorId: socket.user.id,
          operatorName: operatorDisplayName,
          timestamp: new Date()
        });

        // Draft a reply to whatever the visitor last said, for the person
        // who has just taken over.
        const lastUserMessage = [...conversation.messages]
          .reverse()
          .find(msg => msg.sender === 'user');

        if (lastUserMessage) {
          await offerSuggestion(conversation, lastUserMessage, { to: socket.user.id });
        }
      } catch (error) {
        logger.error('Error taking over conversation:', { error });
        socket.emit('error', { sessionId, message: 'Failed to take over the conversation' });
      }
    });

    // Handle operator message
    // Operator replies are metered separately from bot replies: they are what
    // a "human hours" style plan would price on.
    socket.on('operator-message', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      const validated = validateMessage(data.message);
      if (validated.error) {
        return socket.emit('error', { sessionId, message: validated.error });
      }

      try {
        // Save to database
        const conversation = await Conversation.findOne({ sessionId });
        if (!conversation) {
          return socket.emit('error', { sessionId, message: 'Conversation not found' });
        }

        const result = await deliverOperatorMessage(conversation, validated.text);
        if (!result.ok) {
          socket.emit('error', { sessionId, message: result.error });
        }
      } catch (error) {
        logger.error('Error handling operator message:', { error });
        socket.emit('error', { sessionId, message: 'Failed to send message' });
      }
    });

    // Add a new handler for when an operator requests suggestions
    socket.on('request-suggestions', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, messageId } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      try {
        // Find the conversation
        const conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          return;
        }

        // Find the specific message if messageId is provided, otherwise use the last user message
        let targetMessage;
        if (messageId) {
          targetMessage = conversation.messages.find(
            msg => msg._id.toString() === messageId && msg.sender === 'user'
          );
        } else {
          targetMessage = [...conversation.messages]
            .reverse()
            .find(msg => msg.sender === 'user');
        }

        if (!targetMessage) {
          return;
        }

        // Whoever asked gets the draft, whether or not they hold the chat.
        await offerSuggestion(conversation, targetMessage, { to: socket.user.id });
      } catch (error) {
        logger.error('Error generating suggestions:', { error });
      }
    });

    // Handle operator using a suggestion
    socket.on('use-suggestion', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, suggestion, edited } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      // The text travels with the event. Suggestions used to be written to a
      // collection nothing ever read back, purely so this handler could look
      // one up by id.
      const validated = validateMessage(
        typeof edited === 'string' && edited.trim() ? edited : suggestion
      );
      if (validated.error) {
        return socket.emit('error', { sessionId, message: validated.error });
      }

      try {
        const conversation = await Conversation.findOne({ sessionId });
        if (!conversation) {
          return socket.emit('error', { sessionId, message: 'Conversation not found' });
        }

        const result = await deliverOperatorMessage(conversation, validated.text);
        if (!result.ok) {
          return socket.emit('error', { sessionId, message: result.error });
        }

        // Notify all operators that the suggestion was used
        allOperators(tenantOf(conversation), 'suggestion-used', {
          sessionId,
          messageId: result.messageId,
          operatorId: socket.user.id,
          operatorName: operatorDisplayName,
          wasEdited: Boolean(edited),
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling suggestion use:', { error });
        socket.emit('error', { sessionId, message: 'Failed to use suggestion' });
      }
    });

    // Operator requests the user to provide contact details
    socket.on('request-user-details', async (data = {}) => {
      const { sessionId } = data;

      // Same reasoning as `operator-typing`: this prompts a stranger's visitor
      // for their name, email and phone number, so it has to be an operator of
      // that conversation's tenant rather than an operator of anything.
      if (!await canOperateOn(sessionId)) {
        return;
      }

      io.to(sessionId).emit('request-user-details');
    });

    // Handle toggling suggestions for a chat
    socket.on('toggle-suggestions', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, enabled } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      try {
        // Update conversation in database
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          { $set: { suggestionsEnabled: Boolean(enabled) } },
          { new: true }
        );

        if (conversation) {
          // Notify all operators about the change
          allOperators(tenantOf(conversation), 'suggestions-status-changed', {
            sessionId,
            enabled: Boolean(enabled),
            timestamp: new Date()
          });

          // Send confirmation to the requesting operator
          socket.emit('suggestions-toggled', {
            sessionId,
            enabled: Boolean(enabled),
            success: true,
            timestamp: new Date()
          });
        } else {
          socket.emit('suggestions-toggled', {
            sessionId,
            success: false,
            error: 'Conversation not found',
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error toggling suggestions:', { error });
        socket.emit('suggestions-toggled', {
          sessionId,
          success: false,
          error: 'Failed to toggle suggestions',
          timestamp: new Date()
        });
      }
    });

    // Handle operator leaving a chat without ending it
    socket.on('operator-leave', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, passToBot } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      try {
        const conversation = await Conversation.findOne({ sessionId });
        if (!conversation) {
          return;
        }

        const tenantId = tenantOf(conversation);
        let text;

        if (passToBot === false) {
          // Not "leave it for the next person" - that used to mean nobody:
          // bot off, operator gone, every further message unanswered. The
          // conversation goes back into the queue and is offered to a
          // colleague now.
          const result = await assignmentService.release(conversation, { exclude: [socket.user.id] });

          text = result.assigned
            ? `${operatorDisplayName} has left the conversation. ${result.operator.displayName} will assist you.`
            : `${operatorDisplayName} has left the conversation. The next available operator will be with you shortly; in the meantime the assistant can help.`;
        } else {
          conversation.hasOperator = false;
          conversation.operatorId = null;
          conversation.operatorName = null;
          conversation.botEnabled = true;
          conversation.awaitingOperatorSince = undefined;
          await conversation.save();

          text = `${operatorDisplayName} has left the conversation. The chatbot will assist you.`;
        }

        socket.leave(sessionId);

        io.to(sessionId).emit('operator-message', {
          text,
          senderName: operatorDisplayName,
          timestamp: new Date()
        });

        allOperators(tenantId, 'operator-left', {
          sessionId,
          operatorId: socket.user.id,
          operatorName: operatorDisplayName,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling operator leave:', { error });
      }
    });

    // Handle end chat
    socket.on('end-chat', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      try {
        // Update conversation status in database
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              status: 'ended',
              endedAt: new Date(),
              hasOperator: false,
              operatorId: null,
              operatorName: null,
              // A visitor returning days later should not be answered as
              // though they were still half way through answering a question.
              workflowState: { awaiting: null, variables: {}, updatedAt: new Date() }
            },
            $unset: { awaitingOperatorSince: 1 }
          },
          { new: true }
        );

        if (conversation) {
          const tenantId = tenantOf(conversation);

          // Ask for a rating on the way out. This is the only moment the
          // customer is both still present and finished — asking earlier
          // interrupts, and asking later means emailing them.
          const askForRating = csatService.shouldRequestRating(conversation);

          if (askForRating) {
            await csatService.markRequested(sessionId);
          }

          webhookService.dispatch(conversation.company, 'conversation.ended', {
            sessionId,
            endedBy: 'operator',
            operatorName: operatorDisplayName,
            messages: conversation.messages.length,
            startedAt: conversation.startedAt,
            endedAt: conversation.endedAt,
            tags: conversation.tags || []
          });

          // Notify user that chat has ended
          io.to(sessionId).emit('chat-ended', {
            message: 'This conversation has been ended by the operator.',
            requestRating: askForRating,
            timestamp: new Date()
          });

          // Notify all operators that this chat has ended
          allOperators(tenantId, 'chat-ended', {
            sessionId,
            timestamp: new Date()
          });

          // Notify all operators that the operator has left this chat
          allOperators(tenantId, 'operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: operatorDisplayName,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error ending chat:', { error });
      }
    });

    /**
     * A visitor asking for a person.
     *
     * Explicit rather than inferred. Guessing "this one wants a human" from the
     * message text gets it wrong in both directions — it escalates people who
     * were only being polite, and misses the ones who are quietly giving up.
     */
    socket.on('request-operator', async () => {
      if (isOperator || !boundSessionId) {
        return;
      }

      const sessionId = boundSessionId;

      try {
        const conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          return;
        }

        if (conversation.operatorId) {
          return socket.emit('operator-requested', {
            queued: false,
            connected: true,
            operatorName: conversation.operatorName
          });
        }

        // Marked as waiting so the queue shows who has asked for a person, not
        // only who already has one.
        conversation.awaitingOperatorSince = new Date();
        await conversation.save();

        allOperators(conversation.company, 'operator-requested', {
          sessionId,
          timestamp: new Date()
        });

        const result = await assignmentService.autoAssign(conversation);

        // The bot steps aside only once a person has actually taken the
        // conversation.
        //
        // This used to switch the bot off the moment somebody *asked* for a
        // human. If nobody ever claimed it, the bot would not answer and no
        // operator would either: every further message was stored and silently
        // left unanswered, with no timeout and no way back. Somebody who asked
        // for help got less help than if they had never asked.
        if (result.assigned) {
          conversation.botEnabled = false;
          await conversation.save();
        }

        socket.emit('operator-requested', {
          queued: !result.assigned,
          connected: result.assigned,
          operatorName: result.assigned ? result.operator.displayName : null
        });
      } catch (error) {
        logger.error('Error handling operator request:', { error: error.message });
      }
    });

    /**
     * A visitor rating the conversation.
     *
     * The session is taken from the socket, never from the payload: a session
     * id in the body would let anyone who guessed or obtained one rate somebody
     * else's conversation, and a wave of 1s against a competitor's operators is
     * exactly the sort of thing that would happen.
     */
    socket.on('submit-rating', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      const sessionId = boundSessionId;

      try {
        const result = await csatService.record(sessionId, data.score, data.comment);

        socket.emit('rating-recorded', {
          success: result.ok,
          error: result.ok ? undefined : result.error
        });

        if (result.ok && !result.duplicate) {
          // Also fires when a comment lands after the score, so an operator
          // sees the words as well as the number.
          // Shown against the conversation in the dashboard, so an operator
          // sees the score land rather than discovering it in a report.
          allOperators(result.company, 'conversation-rated', {
            sessionId,
            score: result.rating.score,
            comment: result.rating.comment,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error recording rating:', { error: error.message });
        socket.emit('rating-recorded', { success: false, error: 'Could not save your rating' });
      }
    });

    /**
     * A visitor declining to rate.
     *
     * Recorded so we do not ask the same person again on the next reconnect,
     * and so the response rate reflects who was asked rather than who answered.
     */
    socket.on('decline-rating', async () => {
      if (isOperator || !boundSessionId) {
        return;
      }
      await csatService.markRequested(boundSessionId).catch(() => {});
    });

    // Handle heartbeat to keep connection alive
    socket.on('heartbeat', (data = {}) => {
      // Respond with an acknowledgment
      socket.emit('heartbeat-ack', {
        timestamp: new Date().toISOString(),
        received: data && data.timestamp
      });

      // If this is an operator, make sure they're still in the operators room
      if (isOperator) {
        const room = isSuperadmin ? GLOBAL_OPERATOR_ROOM : operatorRoom(operatorCompanyId);
        if (!socket.rooms.has(room)) {
          socket.join(room);
          logger.info('Operator rejoined monitoring room during heartbeat');
        }
      }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
      logger.info('Client disconnected');

      // If it was a user (not an operator), notify operators
      if (!isOperator && boundSessionId) {
        toOperators(clientCompanyId, 'chat-activity', {
          type: 'closed',
          sessionId: boundSessionId,
          timestamp: new Date()
        });
      }

      // An operator's conversations are kept for a grace period, so a page
      // refresh does not hand their chats to somebody else. Only when the
      // period passes with no socket of theirs connected do the chats move.
      if (isOperator && socket.user.id) {
        const userId = String(socket.user.id);
        const stillConnected = io.sockets.adapter.rooms.get(userRoom(userId));

        if (stillConnected && stillConnected.size > 0) {
          return;
        }

        if (graceTimers.has(userId)) {
          clearTimeout(graceTimers.get(userId));
        }

        const grace = envInt('OPERATOR_GRACE_MS', 60 * 1000);
        const timer = setTimeout(() => {
          releaseOperatorChats(socket.user.id, socket.user.username);
        }, grace);
        // Never keep the process alive for this.
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        graceTimers.set(userId, timer);

        logger.info('Operator disconnected; holding their conversations', {
          operator: socket.user.username,
          graceMs: grace
        });
      }
    });
  });

  return io;
}

module.exports = setupWebSockets;
// Exposed for tests, so a release can be triggered without waiting.
module.exports.graceTimers = graceTimers;
