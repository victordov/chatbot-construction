const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('./models/conversation');
const Company = require('./models/company');
const Contact = require('./models/contact');
const User = require('./models/user');
const tenantService = require('./services/tenant');
const usageService = require('./services/usage');
const contactService = require('./services/contacts');
const emailChannel = require('./services/email-channel');
const channels = require('./services/channels');
const csatService = require('./services/csat');
const assignmentService = require('./services/assignment');
const webhookService = require('./services/webhooks');
const sessionToken = require('./services/session-token');
const lifecycle = require('./services/conversation-lifecycle');
const NotificationService = require('./services/notification');
const { isRevoked } = require('./middleware/auth');
const { notice, wantsAPerson } = require('./services/visitor-notices');
const { operatorRoom, userRoom, visitorRoom, GLOBAL_OPERATOR_ROOM } = require('./socketManager');
const { logger } = require('./services/logging');

const STAFF_ROLES = ['operator', 'company_admin', 'superadmin'];
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SESSION_ID_LENGTH = 128;
/** How much of a conversation is replayed to a returning visitor. */
const HISTORY_REPLAY = 50;

/** Rooms a client may never ask to join by name: they are joined by role. */
const RESERVED_ROOM_PREFIXES = ['operators:', 'user:', 'visitor:'];

/**
 * The id a widget gives its own message, so it can recognise the message when
 * history is replayed after a reconnect. Short and plain, because it is
 * stored and echoed back.
 */
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What `services/session-token.js` issues: 32 bytes as hex. */
const SESSION_TOKEN_FORMAT = /^[0-9a-f]{64}$/;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** What an operator can record when closing a conversation. */
const OUTCOMES = ['resolved', 'follow_up', 'unresolved', 'spam'];
const MAX_OUTCOME_NOTE = 500;

/** A rating at or below this is somebody's bad day, and someone should look. */
const LOW_RATING = 2;

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

/**
 * The shape a stored message is replayed to the visitor in.
 *
 * Transcript events (`system`) are filtered out before this is called: they
 * are for operators. `clientMessageId` is the widget's own id for a message
 * it sent, so after a reconnect it can recognise its own messages rather than
 * showing them twice.
 */
function toReplayPayload(message) {
  const payload = {
    id: message._id ? message._id.toString() : undefined,
    text: message.content,
    sender: message.sender,
    isOperator: message.sender === 'operator',
    operatorName: message.operatorName || undefined,
    timestamp: message.timestamp || new Date()
  };

  if (message.sender === 'user' && message.messageId && CLIENT_MESSAGE_ID.test(message.messageId)) {
    payload.clientMessageId = message.messageId;
  }

  if (message.sender === 'bot') {
    payload.path = message.path || undefined;
    payload.sources = message.sources && message.sources.length ? message.sources : [];
    payload.canRate = lifecycle.canRate(message);
    if (message.feedback && message.feedback.rating) {
      payload.feedback = { rating: message.feedback.rating, at: message.feedback.at };
    }
  }

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

/** The last message on a conversation, as stored. */
function lastMessage(conversation) {
  return conversation.messages[conversation.messages.length - 1];
}

const { recordConsent } = lifecycle;

/** Whether the bot's most recent message on a conversation was an "I don't know". */
function lastBotMessageUnanswered(conversation) {
  const messages = conversation.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].sender === 'bot') {
      return Boolean(messages[i].unanswered);
    }
    if (messages[i].sender === 'operator') {
      return false;
    }
  }
  return false;
}

async function companyIsActive(companyId) {
  const company = await Company.findById(companyId).select('isActive').lean();
  return Boolean(company) && company.isActive !== false;
}

/**
 * Whether an operator's connection should still be open.
 *
 * A socket is authenticated once, when it connects, and a dashboard stays
 * connected for a whole shift. Without a second look an operator who was
 * removed from the team, or whose password was reset because it leaked, went
 * on receiving the tenant's conversations until they closed the tab.
 *
 * @param {string} userId
 * @param {number|undefined} issuedVersion the `tv` the socket's token carried
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function stillAuthorised(userId, issuedVersion, jti) {
  const user = await User.findById(userId).select('isActive tokenVersion company').lean();

  if (!user || !user.isActive) {
    return { ok: false, reason: 'deactivated' };
  }

  // Signed out on this device: the token is revoked by its id while the
  // person's other sessions carry on.
  if (await isRevoked(jti)) {
    return { ok: false, reason: 'signed-out' };
  }

  const current = user.tokenVersion || 0;
  const stale = issuedVersion !== undefined ? issuedVersion !== current : current > 0;
  if (stale) {
    return { ok: false, reason: 'signed-out' };
  }

  if (user.company && !(await companyIsActive(user.company))) {
    return { ok: false, reason: 'company-inactive' };
  }

  return { ok: true };
}

/**
 * How to reach `NotificationService.notifyUser`, whichever way it is exposed,
 * or null where it does not exist yet.
 */
function notificationSender() {
  if (typeof NotificationService.notifyUser === 'function') {
    return (...args) => NotificationService.notifyUser(...args);
  }
  if (NotificationService.prototype && typeof NotificationService.prototype.notifyUser === 'function') {
    const instance = new NotificationService();
    return (...args) => instance.notifyUser(...args);
  }
  return null;
}

/**
 * Somebody rated a conversation badly: tell the person who handled it, or,
 * when the bot handled it alone, the company's admins.
 *
 * A low score that nobody sees until the monthly report is a customer lost
 * twice - once to the bad experience and again to the silence after it.
 */
async function notifyLowRating(sessionId, result) {
  const send = notificationSender();
  if (!send || !result || !result.rating) {
    return;
  }

  try {
    let recipients = [];
    if (result.rating.operatorId) {
      recipients = [result.rating.operatorId];
    } else if (result.company) {
      const admins = await User.find({
        company: result.company,
        role: 'company_admin',
        isActive: { $ne: false }
      }).select('_id').lean();
      recipients = admins.map(admin => admin._id);
    }

    const comment = result.rating.comment ? `: "${String(result.rating.comment).slice(0, 80)}"` : '';
    const message = `A customer rated a conversation ${result.rating.score}/5${comment}`;

    await Promise.all(recipients.map(userId => Promise.resolve(send(String(userId), {
      type: 'low_rating',
      message,
      sessionId,
      link: `?section=history&chat=${encodeURIComponent(sessionId)}`
    })).catch(error => logger.warn('Could not send a low-rating notification', { error: error.message }))));
  } catch (error) {
    logger.warn('Could not notify about a low rating', { sessionId, error: error.message });
  }
}

/** The widget key a connection presented in its handshake, if any. */
function handshakeWidgetKey(socket) {
  const key = (socket.handshake.auth && socket.handshake.auth.widgetKey) ||
    (socket.handshake.query && socket.handshake.query.widgetKey);
  return typeof key === 'string' && key ? key : null;
}

/**
 * Origins this server is itself served from, where the dashboard and the
 * widget preview run. The Host header is what the browser actually reached,
 * so a page on another site cannot claim it.
 */
function selfOrigins(handshake = {}) {
  const headers = handshake.headers || {};
  const port = process.env.PORT || 3000;
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();

  return [
    process.env.PUBLIC_URL,
    headers.host ? `${handshake.secure ? 'https' : 'http'}://${headers.host}` : null,
    headers.host && forwarded ? `${forwarded}://${headers.host}` : null,
    ...(process.env.NODE_ENV === 'production'
      ? []
      : [`http://localhost:${port}`, `http://127.0.0.1:${port}`])
  ]
    .map(value => tenantService.normaliseOrigin(value))
    .filter(Boolean);
}

function isSelfOrigin(origin, handshake) {
  const normalised = tenantService.normaliseOrigin(origin);
  return Boolean(normalised) && selfOrigins(handshake).includes(normalised);
}

/**
 * Let a visitor's connection in, if the page it comes from may use the widget
 * it names.
 *
 * The widget key is public - it is in the page source of every site that
 * embeds it - so the page's origin is checked against the domains of the
 * company that key belongs to. This used to accept any origin any tenant had
 * registered: a domain listed under one (free) account could embed every
 * other tenant's widget, bill them for the conversations and wear their name.
 *
 * No Origin header means a client that is not a browser; nothing it claims
 * about where it is could be checked anyway.
 */
async function admitVisitor(socket, next) {
  socket.user = { role: 'user' };
  socket.data.visitor = true;

  const origin = socket.handshake.headers && socket.handshake.headers.origin;
  if (!origin || isSelfOrigin(origin, socket.handshake)) {
    return next();
  }

  const widgetKey = handshakeWidgetKey(socket);

  try {
    const allowed = await tenantService.isOriginAllowed(origin, widgetKey ? { widgetKey } : {});

    if (!allowed) {
      logger.warn('Widget connection refused: this site is not allowed for the widget it uses', {
        origin,
        widgetKey: widgetKey ? `${widgetKey.slice(0, 8)}…` : null
      });
      return next(new Error('This website is not allowed to use this chat'));
    }

    return next();
  } catch (error) {
    logger.error('Could not check a widget connection\'s origin', { origin, error: error.message });
    return next(new Error('This chat could not be started'));
  }
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
        if (isSelfOrigin(origin)) {
          return callback(null, true);
        }

        // Which widget a connection uses is only known once it is in, so the
        // per-tenant check is the connection middleware's (`admitVisitor`);
        // this only keeps out origins no tenant has registered at all.
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
      const token = socket.handshake.auth && socket.handshake.auth.token;

      // If no token, client is a regular user (not an operator)
      if (!token) {
        return admitVisitor(socket, next);
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');

      // Check if user still exists and is active
      const user = await User.findById(decoded.id)
        .select('username displayName role company isActive tokenVersion acceptingChats invitePending');
      // An invitation not yet accepted is not an account anybody can use, and
      // a token signed out on this device stays signed out here too.
      if (!user || !user.isActive || user.invitePending || await isRevoked(decoded.jti)) {
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
        return admitVisitor(socket, next);
      }

      // A suspended company's staff get nothing, the same as an inactive
      // user: the dashboard reads this as "sign in again".
      if (user.company && !(await companyIsActive(user.company))) {
        return next(new Error('Authentication failed: this account is suspended'));
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
      // An agency working in a client's dashboard hears that client's
      // conversations, not its own; throws when that session has ended.
      if (decoded.actingAs) {
        Object.assign(socket.user, await require('./middleware/auth').actingSocketScope(decoded, user));
      }
      // The token version this connection was admitted under, so the
      // periodic re-check can tell a later password change.
      socket.authVersion = decoded.tv;
      socket.authJti = decoded.jti;
      socket.data.staff = true;

      next();
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        // Treat as regular user if token is invalid
        return admitVisitor(socket, next);
      }
      next(new Error('Authentication failed'));
    }
  });

  /**
   * Everything said to a visitor goes to their own connections only. A
   * customer on WhatsApp, Messenger or Instagram has no connection: what the
   * widget would have shown them - an operator joining, the chat ending - is
   * sent to their app instead (services/channels/outbound.js).
   */
  const toVisitor = (sessionId, event, payload) => {
    io.to(visitorRoom(sessionId)).emit(event, payload);
    if (channels.isChannelSession(sessionId)) {
      channels.toCustomer(sessionId, event, payload);
    }
  };

  /** Whether the visitor has the chat open anywhere, on any process. */
  const visitorConnected = async sessionId => {
    try {
      return (await io.in(visitorRoom(sessionId)).fetchSockets()).length > 0;
    } catch (error) {
      logger.warn('Could not tell whether a visitor is connected', { sessionId, error: error.message });
      // Assume they are: an email they did not need is worse than a chat
      // message they will see.
      return true;
    }
  };

  /** To one tenant's operators and every superadmin. */
  const toTenantOperators = (companyId, event, payload) => {
    io.to(operatorRoom(companyId)).emit(event, payload);
    io.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
  };

  /**
   * An operator who did not come back: move their conversations on.
   *
   * Each open conversation is offered to a colleague; failing that it goes
   * back to the queue with the bot answering, and the visitor is told rather
   * than left wondering why the person they were talking to has gone quiet.
   */
  const releaseOperatorChats = async (userId, username, displayName) => {
    graceTimers.delete(String(userId));
    const name = displayName || username;

    try {
      const held = await Conversation.find({ operatorId: userId, status: 'active' });

      for (const conversation of held) {
        const result = await assignmentService.release(conversation, { exclude: [userId] });
        const sessionId = conversation.sessionId;
        const companyId = conversation.company;

        const line = lifecycle.addSystemLine(conversation, result.assigned
          ? `${name} disconnected; reassigned to ${result.operator.displayName}`
          : `${name} disconnected; returned to the queue`);
        await conversation.save();
        lifecycle.announceMessages(conversation, [line], {
          operators: (event, payload) => toTenantOperators(companyId, event, payload)
        });

        toVisitor(sessionId, 'operator-left', {
          sessionId,
          operatorName: name,
          ...notice('operator_left', { operatorName: name })
        });

        if (result.assigned) {
          toVisitor(sessionId, 'operator-joined', {
            sessionId,
            operatorName: result.operator.displayName,
            ...notice('operator_joined', { operatorName: result.operator.displayName })
          });
        }

        io.to(operatorRoom(companyId)).emit('operator-left', {
          sessionId,
          operatorId: userId,
          operatorName: name,
          reason: 'disconnected',
          reassignedTo: result.assigned ? result.operator.displayName : null,
          timestamp: new Date()
        });
        io.to(GLOBAL_OPERATOR_ROOM).emit('operator-left', {
          sessionId,
          operatorId: userId,
          operatorName: name,
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

    /**
     * The token this socket holds for that session: the one it presented, or
     * the one it was issued. A conversation created from this socket stores
     * its hash, so the widget's copy is the key to it from then on.
     */
    let boundToken = null;

    /**
     * Bound to a session whose conversation does not exist yet.
     *
     * Opening a page with the widget used to create, meter and announce a
     * conversation, so every page view was billed and queued as one. Now the
     * socket is bound and the visitor holds a token, but nothing is written
     * until they do something - see `ensureConversation`.
     */
    let pendingSession = false;

    /** What `resume-session` said about the visitor, kept for creating it later. */
    let resumeHints = {};

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
    const allOperators = (companyId, event, payload) => toTenantOperators(companyId, event, payload);

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
      return isOperator ? operatorCompanyId : clientCompanyId;
    };

    /**
     * Where lifecycle events about a conversation go from this socket.
     *
     * A visitor's own events are answered on their own connection, as every
     * reply always has been; an operator's actions reach the visitor's
     * connections through the visitor room.
     */
    const emitFor = conversation => ({
      visitor: (event, payload) => (isOperator
        ? toVisitor(conversation.sessionId, event, payload)
        : socket.emit(event, payload)),
      operators: (event, payload) => allOperators(tenantOf(conversation), event, payload)
    });

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
     * Whether this operator may close or hand on a conversation a colleague
     * is holding. Two people deciding the fate of one visitor is worse than
     * one; an admin can still do it, but only deliberately: the dashboard
     * asks first, naming who holds it, and sends `force` once they confirm.
     */
    const heldByColleague = (conversation, force = false) => Boolean(
      conversation && conversation.operatorId &&
      String(conversation.operatorId) !== String(socket.user.id) &&
      !(canForceTakeover && force === true)
    );

    /**
     * Resolve and remember the tenant for the visitor's session, so later
     * events on this socket can be routed without another database lookup.
     *
     * The widget key from the handshake wins: that is the key the connection
     * was admitted with. A key that arrives only in an event payload has not
     * been through that check, so it is checked here before it is believed.
     */
    const resolveClientCompany = async (sessionId, hints = {}) => {
      if (clientCompanyId) {
        return clientCompanyId;
      }

      clientCompanyId = await lookupCompany(sessionId, hints);
      return clientCompanyId;
    };

    /** The tenant for a session, worked out afresh. See `resolveClientCompany`. */
    const lookupCompany = async (sessionId, hints = {}) => {
      const existing = sessionId
        ? await Conversation.findOne({ sessionId }).select('company').lean()
        : null;

      if (existing && existing.company) {
        return existing.company.toString();
      }

      const origin = socket.handshake.headers.origin;
      let widgetKey = handshakeWidgetKey(socket);

      if (!widgetKey && typeof hints.widgetKey === 'string' && hints.widgetKey) {
        const vouched = !origin || isSelfOrigin(origin, socket.handshake) ||
          await tenantService.isOriginAllowed(origin, { widgetKey: hints.widgetKey });
        if (vouched) {
          widgetKey = hints.widgetKey;
        }
      }

      const companyId = await tenantService.resolveCompanyId({
        widgetKey,
        origin: origin || socket.handshake.headers.referer
      });

      return companyId ? companyId.toString() : null;
    };

    /** Who the visitor says they are, from an event or the handshake. */
    const identityHints = (hints = {}) => ({
      externalId: hints.externalId || socket.handshake.auth?.externalId || resumeHints.externalId,
      userHash: hints.userHash || socket.handshake.auth?.userHash || resumeHints.userHash,
      userJwt: hints.userJwt || socket.handshake.auth?.userJwt,
      email: hints.email || resumeHints.userEmail,
      name: hints.name || resumeHints.userName,
      phone: hints.phone || resumeHints.userPhone
    });

    /**
     * The verified user id this socket presents, if the tenant signed it,
     * with a token or a hash (services/visitor-identity.js).
     */
    const presentedIdentity = async (companyId, hints = {}) =>
      require('./services/visitor-identity').presentedExternalId(companyId, identityHints(hints));

    // Email codes and identity re-checks for the visitor (services/visitor-verification.js).
    require('./services/visitor-verification').attach(socket, { isOperator, session: () => boundSessionId, company: () => clientCompanyId || (boundSessionId ? resolveClientCompany(boundSessionId) : null) });

    /**
     * Whether a resume may proceed as far as identity goes.
     *
     * A conversation that belongs to a person the tenant verified is that
     * person's, and a browser presenting a *different* verified person - the
     * next user of a shared computer, say - does not get to read it, whatever
     * session id and token are in its storage.
     */
    const identityMatches = async (conversation, hints) => {
      if (!conversation.contact) {
        return true;
      }

      const contact = await Contact.findById(conversation.contact).select('identityLevel externalId').lean();
      if (!contact || contact.identityLevel !== 'verified' || !contact.externalId) {
        return true;
      }

      const presented = await presentedIdentity(tenantOf(conversation), hints);
      return !presented || presented === String(contact.externalId);
    };

    /**
     * Bind this socket to a session: the only way a visitor socket gets one.
     * A widget that starts a clean session (a different person signed in,
     * say) leaves the old one's rooms and tenant behind.
     */
    const bindTo = (sessionId, token, pending, companyId) => {
      if (boundSessionId && boundSessionId !== sessionId) {
        socket.leave(boundSessionId);
        socket.leave(visitorRoom(boundSessionId));
      }
      boundSessionId = sessionId;
      boundToken = token;
      pendingSession = pending;
      clientCompanyId = companyId || null;
      socket.join(sessionId);
      socket.join(visitorRoom(sessionId));
    };

    /** Forget the session, and tell the widget to start a clean one. */
    const rejectSession = (sessionId) => {
      if (boundSessionId) {
        socket.leave(boundSessionId);
        socket.leave(visitorRoom(boundSessionId));
      }
      boundSessionId = null;
      boundToken = null;
      pendingSession = false;
      socket.emit('session-rejected', { sessionId });
    };

    /**
     * The conversation this socket is bound to, created if this is the first
     * thing the visitor has done.
     *
     * Creation is the moment a conversation is metered, gets a contact and is
     * announced, so it happens here - on a message, the pre-chat form, a
     * request for a person, a file or an email address left - and never on a
     * page load.
     *
     * A conversation that already exists has to match the token this socket
     * holds. Two tabs of one browser can both be waiting on the same session;
     * if the other one engaged first with a different token, this one is
     * holding the key to nothing and is told to start again.
     *
     * @returns {Promise<{conversation?: object, created?: boolean,
     *                    refused?: boolean, rejected?: boolean}>}
     */
    const ensureConversation = async (hints = {}, attempt = 0) => {
      const sessionId = boundSessionId;
      const origin = hints.pageUrl || resumeHints.pageUrl || connectionOrigin;

      const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');

      if (conversation) {
        if (conversation.sessionTokenHash && !sessionToken.verify(conversation.sessionTokenHash, boundToken)) {
          logger.warn('Session engaged by another connection with a different token', { sessionId });
          rejectSession(sessionId);
          return { rejected: true };
        }

        if (!conversation.sessionTokenHash && boundToken) {
          // Protected from now on, like every other.
          conversation.sessionTokenHash = sessionToken.hash(boundToken);
        }

        pendingSession = false;

        // Backfill on conversations created before the tenant or origin was
        // known.
        if (!conversation.company) {
          const companyId = await resolveClientCompany(sessionId, hints);
          if (companyId) {
            conversation.company = companyId;
          }
        }
        if (!conversation.domain && origin) {
          conversation.domain = origin;
        }
        if (conversation.company) {
          clientCompanyId = conversation.company.toString();
        }

        // Attach the person behind the session. Identity claims are only
        // trusted when the tenant signed them; see services/contacts.js.
        if (clientCompanyId && !conversation.contact) {
          const contact = await contactService.resolve({
            companyId: clientCompanyId,
            sessionId,
            ...identityHints(hints)
          });
          if (contact) {
            await contactService.linkConversation(contact, conversation);
          }
        }

        return { conversation, created: false };
      }

      const companyId = await resolveClientCompany(sessionId, hints);

      const result = await lifecycle.createConversation({
        sessionId,
        companyId,
        domain: origin,
        sessionTokenHash: boundToken ? sessionToken.hash(boundToken) : undefined,
        identity: identityHints(hints)
      });

      if (result.refused) {
        return { refused: true };
      }

      if (result.duplicate) {
        // Another connection created it a moment ago; check our token
        // against what it stored.
        return attempt === 0 ? ensureConversation(hints, 1) : { rejected: true };
      }

      pendingSession = false;
      clientCompanyId = companyId ? String(companyId) : null;
      logger.info(`Conversation started: ${sessionId}`);

      return { conversation: result.conversation, created: true };
    };

    /**
     * Tell the visitor nobody can take their conversation, in the bot's
     * voice. Only when no conversation could be started: once one exists, a
     * spent allowance hands over to the team instead.
     */
    const sendUnavailable = () => {
      const unavailable = notice('unavailable');
      socket.emit('bot-message', {
        text: unavailable.message,
        canRate: false,
        sources: [],
        ...unavailable,
        timestamp: new Date()
      });
    };

    /**
     * The tail of the engagements already under way on this socket.
     *
     * A widget that reconnects sends what it had queued all at once, and the
     * first of those messages is the one that creates the conversation. Run
     * side by side, each found no conversation and tried to create one - and
     * the plan check behind creation is not safe to race either. So the
     * finding-or-creating happens one event at a time, in the order they
     * arrived; what follows it (the reply) still runs side by side.
     */
    let engaging = Promise.resolve();

    /**
     * The first step of every visitor action that engages: find or create the
     * conversation, or say why there is none.
     *
     * @returns {Promise<{conversation: object, created: boolean}|null>}
     */
    const engage = async (hints = {}) => {
      const turn = engaging.then(() => ensureConversation(hints));
      engaging = turn.catch(() => {});
      const result = await turn;

      if (result.refused) {
        sendUnavailable();
        return null;
      }

      if (result.rejected) {
        return null;
      }

      return result;
    };

    /**
     * Draft a reply for the operator holding a conversation.
     *
     * One helper for the three places that want it, which used to be three
     * copies of the same block. The draft goes to the holding operator's own
     * room rather than to every operator of the tenant (see
     * `lifecycle.offerSuggestion`, which a messaging channel uses too).
     */
    const offerSuggestion = (conversation, targetMessage, options = {}) => lifecycle.offerSuggestion(
      conversation,
      targetMessage,
      {
        ...options,
        companyId: tenantOf(conversation),
        toUser: (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload)
      }
    );

    /**
     * Persist and deliver an operator's message, over whichever channel the
     * conversation lives on.
     *
     * A chat visitor who has gone - closed the tab, walked away while the
     * operator looked into it - is answered by email when we have an address
     * for them, because a reply they never see is no reply. Without one the
     * message waits in the conversation for them to come back.
     *
     * @returns {Promise<{ok: boolean, error?: string, warning?: string,
     *                    messageId?: string, emailedTo?: string}>}
     */
    const deliverOperatorMessage = async (conversation, text) => {
      const now = new Date();
      let warning;
      // WhatsApp, Messenger or Instagram: the customer is always reachable
      // there, within the provider's rules, and never by email instead.
      const viaApp = channels.isMessagingChannel(conversation.channel);

      if (conversation.channel !== 'email' && !viaApp && !(await visitorConnected(conversation.sessionId)) &&
          await emailChannel.visitorEmail(conversation)) {
        const emailed = await emailChannel.sendFollowUp(conversation, text, {
          id: socket.user.id,
          displayName: operatorDisplayName,
          username: socket.user.username
        });

        if (emailed.sent) {
          return { ok: true, messageId: emailed.replyId, emailedTo: emailed.to };
        }

        // Kept in the conversation either way, so the visitor sees it if they
        // come back; the operator is told it did not reach them.
        warning = `Saved to the conversation, but the email to the visitor could not be sent: ${emailed.reason}`;
      }

      // An email thread is answered from the same composer; only delivery
      // differs. Sent before persisting so a failure can be reported to the
      // operator rather than leaving a message that never went out.
      let delivery = { sent: true };

      if (conversation.channel === 'email') {
        delivery = await emailChannel.sendReply(conversation, text, operatorDisplayName);

        if (!delivery.sent) {
          return { ok: false, error: `Could not send that email: ${delivery.reason}` };
        }
      } else if (viaApp) {
        delivery = await channels.sendOperatorReply(conversation, text);

        if (!delivery.sent) {
          // Outside the reply window the provider's rule is the whole
          // explanation; anything else is a failure to send.
          return { ok: false, error: delivery.window ? delivery.reason : `Could not send that message: ${delivery.reason}` };
        }
      }

      conversation.messages.push({
        content: text,
        sender: 'operator',
        operatorId: socket.user.id,
        operatorName: operatorDisplayName,
        emailMessageId: conversation.channel === 'email' ? delivery.messageId : undefined,
        // The provider's id for it, so a later "not delivered" report finds it.
        messageId: viaApp ? delivery.messageId : undefined,
        timestamp: now
      });
      const stored = lastMessage(conversation);

      // Answering is taking part, whether or not they pressed "take over".
      conversation.operatorEverJoined = true;
      if (!conversation.firstOperatorJoinedAt) {
        conversation.firstOperatorJoinedAt = now;
      }
      if (!conversation.firstOperatorReplyAt) {
        conversation.firstOperatorReplyAt = now;
      }

      conversation.lastActivity = now;
      await conversation.save();

      usageService.record(conversation.company, { operatorMessages: 1, messages: 1 });

      const messageId = lastMessageId(conversation);

      // Chat visitors get it over the socket. Email visitors already have it
      // in their inbox. Answering is reading: what they wrote before it gets
      // its second tick.
      if (conversation.channel !== 'email') {
        tellVisitorRead(conversation);
        toVisitor(conversation.sessionId, 'operator-message', {
          id: messageId,
          text,
          senderName: operatorDisplayName,
          timestamp: now
        });
      }

      // Colleagues with the conversation open see the reply too. Until this
      // an operator's message reached the visitor and nobody else.
      lifecycle.announceMessages(conversation, [stored], emitFor(conversation));

      return { ok: true, messageId, warning };
    };

    /**
     * Tell the visitor a person has read what they wrote.
     *
     * Distinct from the acknowledgement sent when a message is stored, which
     * carries no `reader`: the widget's second tick means somebody looked,
     * and it used to appear the moment the server saved a message nobody had
     * seen.
     */
    const tellVisitorRead = (conversation, message) => {
      const target = message || lifecycle.lastVisitorMessage(conversation);
      if (!target || conversation.channel === 'email') {
        return;
      }

      toVisitor(conversation.sessionId, 'message-read', {
        // The widget knows its own messages by the id it gave them.
        messageId: target.messageId || String(target._id),
        id: String(target._id),
        reader: 'operator',
        timestamp: new Date()
      });
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

      // Looked at again at most once a minute, on whatever the dashboard
      // sends next (it sends a heartbeat every thirty seconds). A socket whose
      // person was deactivated, signed out everywhere or whose company was
      // suspended is closed rather than left listening to the tenant's
      // conversations. `socketManager.disconnectUser` does the same at once.
      let verifiedAt = Date.now();
      let checking = null;

      socket.use((packet, next) => {
        if (Date.now() - verifiedAt < envInt('SOCKET_REAUTH_MS', 60 * 1000)) {
          return next();
        }

        if (!checking) {
          checking = stillAuthorised(socket.user.id, socket.authVersion, socket.authJti)
            .finally(() => {
              checking = null;
            });
        }

        checking.then(result => {
          if (result.ok) {
            verifiedAt = Date.now();
            return next();
          }

          logger.warn('Closing a connection that is no longer authorised', {
            operator: socket.user.username,
            reason: result.reason
          });
          socket.emit('session-expired', { reason: result.reason });
          socket.disconnect(true);
        }, error => {
          // A database blip is not a reason to throw somebody out mid-shift;
          // the next event checks again.
          logger.warn('Could not re-check an operator connection', { error: error.message });
          next();
        });
      });
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
     *
     * A session with no conversation yet writes nothing. The socket is bound
     * and given a token (`pending: true`) and the conversation is created on
     * the visitor's first real action. Until then there is nothing to
     * protect, so a well-formed token the widget already holds is kept - two
     * tabs of one browser then agree on it - and anything else is replaced
     * with a fresh one.
     */
    socket.on('resume-session', async (data = {}) => {
      const sessionId = data && data.sessionId;

      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
        return socket.emit('session-rejected', { sessionId: sessionId || null });
      }

      try {
        const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');

        resumeHints = {
          pageUrl: typeof data.pageUrl === 'string' ? data.pageUrl.slice(0, 500) : undefined,
          userName: typeof data.userName === 'string' ? data.userName.slice(0, 200) : undefined,
          userEmail: typeof data.userEmail === 'string' && EMAIL_ADDRESS.test(data.userEmail) ? data.userEmail : undefined,
          userPhone: typeof data.userPhone === 'string' ? data.userPhone.slice(0, 50) : undefined,
          externalId: data.externalId,
          userHash: data.userHash
        };

        if (!conversation) {
          const token = typeof data.sessionToken === 'string' && SESSION_TOKEN_FORMAT.test(data.sessionToken)
            ? data.sessionToken
            : sessionToken.issue();

          bindTo(sessionId, token, true, await lookupCompany(sessionId, data));

          socket.emit('session-ready', { sessionId, sessionToken: token, pending: true });
          socket.emit('session-history', { sessionId, messages: [] });
          return;
        }

        // A WhatsApp, Messenger or Instagram conversation belongs to
        // somebody on that app. No browser holds the key to it, whatever
        // session id it presents.
        if (channels.isMessagingChannel(conversation.channel)) {
          logger.warn('Session resume rejected: it is a messaging-app conversation', { sessionId });
          return socket.emit('session-rejected', { sessionId });
        }

        let token = null;

        if (conversation.sessionTokenHash) {
          if (!sessionToken.verify(conversation.sessionTokenHash, data.sessionToken)) {
            logger.warn('Session resume rejected: token mismatch', { sessionId });
            return socket.emit('session-rejected', { sessionId });
          }
          // The token they presented is the token; hand it back so the widget
          // has one place to read it from.
          token = data.sessionToken;
        } else {
          // Created before tokens existed. Accepted this once, and given a
          // token so that from now on it is protected like every other.
          token = sessionToken.issue();
          conversation.sessionTokenHash = sessionToken.hash(token);
          await conversation.save();
        }

        if (!(await identityMatches(conversation, data))) {
          logger.warn('Session resume rejected: it belongs to a different verified person', { sessionId });
          return socket.emit('session-rejected', { sessionId });
        }

        bindTo(sessionId, token, false, conversation.company
          ? conversation.company.toString()
          : await lookupCompany(sessionId, data));

        // Who is answering, so the widget's header is right after a reload
        // rather than saying "Assistant" while a person types.
        const holder = conversation.operatorId && conversation.operatorName
          ? { operatorName: conversation.operatorName, operator: { name: conversation.operatorName } }
          : {};

        socket.emit('session-ready', { sessionId, sessionToken: token, ...holder });

        // History goes out as one event rather than replayed as live
        // messages, so the widget can tell "what was said" from "what was
        // just said" and drop what it already has by id. Transcript events
        // are for operators and stay out of it.
        const messages = (conversation.messages || [])
          .filter(message => message.sender !== 'system')
          .slice(-HISTORY_REPLAY)
          .map(toReplayPayload);
        socket.emit('session-history', { sessionId, messages });

        logger.info(`Session resumed: ${sessionId}`);
      } catch (error) {
        logger.error('Error resuming session', { sessionId, error: error.message });
        socket.emit('session-rejected', { sessionId });
      }
    });

    // Handle chat opened event
    socket.on('chat-opened', async () => {
      // Nothing to show an operator for a session that has no conversation.
      if (isOperator || !boundSessionId || pendingSession) {
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

        // Submitting the form is engaging: this may start the conversation.
        const engaged = await engage(data);
        if (!engaged) {
          return;
        }
        const { conversation, created } = engaged;

        // Initialize metadata if it doesn't exist
        if (!conversation.metadata) {
          conversation.metadata = new Map();
        }

        // Update metadata with user details
        conversation.metadata.set('name', name || '');
        conversation.metadata.set('email', email || '');
        conversation.metadata.set('phone', phone || '');
        recordConsent(conversation, data.consent);

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

        if (created) {
          await lifecycle.announceStart(conversation, { preview: '', emit: emitFor(conversation) });
        }

        logger.info(`User details updated for session: ${sessionId}`);
      } catch (error) {
        logger.error('Error handling user details:', error);
        socket.emit('error', { sessionId, message: 'Failed to save user details' });
      }
    });

    /**
     * The bot's turn: `lifecycle.answerAutomatically`, which the messaging
     * channels share, with the answer going back on this socket and "the
     * bot is typing" to the session's room.
     */
    const answerAutomatically = (conversation, message) => lifecycle.answerAutomatically(conversation, message, {
      emit: emitFor(conversation),
      companyId: tenantOf(conversation),
      typing: typing => io.to(conversation.sessionId).emit('bot-typing', { sessionId: conversation.sessionId, typing })
    });

    // Handle user messages from widget
    socket.on('user-message', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return socket.emit('error', { message: 'Session not established' });
      }

      const sessionId = boundSessionId;
      const { timestamp } = data;

      // The widget's own id for the message. `messageId` is what older
      // widgets send.
      const offeredId = data.clientMessageId !== undefined ? data.clientMessageId : data.messageId;
      const clientMessageId = typeof offeredId === 'string' && CLIENT_MESSAGE_ID.test(offeredId)
        ? offeredId
        : undefined;

      const validated = validateMessage(data.message);
      if (validated.error) {
        return socket.emit('error', { sessionId, message: validated.error });
      }
      const message = validated.text;

      if (!rateLimit()) {
        logger.warn('Visitor message rate limit exceeded', { sessionId });
        return socket.emit('error', { sessionId, message: 'You are sending messages too quickly. Please wait a moment.' });
      }

      try {
        const engaged = await engage(data);
        if (!engaged) {
          return;
        }
        const { conversation, created } = engaged;

        // A widget that lost its connection mid-send sends the message again
        // when it is back. The same id twice is the same message: it is
        // acknowledged, not stored or answered a second time.
        if (clientMessageId && conversation.messages.some(
          stored => stored.sender === 'user' && stored.messageId === clientMessageId
        )) {
          socket.emit('message-read', { messageId: clientMessageId, timestamp: new Date() });
          return;
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

        recordConsent(conversation, data.consent);

        const sentAt = timestamp ? new Date(timestamp) : new Date();

        const messageDoc = {
          content: message,
          sender: 'user',
          messageId: clientMessageId,
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
        const storedUserMessage = lastMessage(conversation);

        // Broadcast to operators (admin dashboard)
        const broadcastData = {
          sessionId,
          message,
          sender: 'user',
          messageId: dbMessageId,
          clientMessageId,
          timestamp: new Date()
        };

        // Add user name to broadcast if available
        if (messageDoc.userName) {
          broadcastData.userName = messageDoc.userName;
        }

        toOperators(clientCompanyId, 'new-message', broadcastData);
        lifecycle.announceMessages(conversation, [storedUserMessage], emitFor(conversation));

        usageService.record(clientCompanyId, { messages: 1 });

        // Send read receipt for the user message before any reply is
        // generated, so a slow model does not look like a lost message.
        socket.emit('message-read', {
          messageId: clientMessageId,
          timestamp: new Date()
        });

        if (created) {
          // Announced once the first message is stored, so the queue shows
          // what they asked; and routed before anyone answers, so a tenant
          // that assigns on start gets a person on the first message.
          await lifecycle.announceStart(conversation, { preview: message, emit: emitFor(conversation) });
        }

        if (conversation.hasOperator) {
          // A person has it: draft them a reply rather than answering.
          await offerSuggestion(conversation, storedUserMessage);
        } else if (wantsAPerson(message)) {
          // "Can I talk to a person?" typed rather than tapped. The bot
          // answering that with a paragraph about itself is the most
          // frustrating thing a support bot does.
          const reason = lastBotMessageUnanswered(conversation) ? 'bot_unanswered' : 'visitor_request';
          await lifecycle.handOver(conversation, reason, { emit: emitFor(conversation) });
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
        const engaged = await engage(data);
        if (!engaged) {
          return;
        }
        const { conversation, created } = engaged;

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

        recordConsent(conversation, data.consent);
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

        if (!alreadyRecorded && recorded) {
          lifecycle.announceMessages(conversation, [recorded], emitFor(conversation));
        }

        if (created) {
          await lifecycle.announceStart(conversation, { preview: `[File uploaded: ${storedName}]`, emit: emitFor(conversation) });
        }

        socket.emit('message-read', { messageId: fileId, timestamp: new Date() });
      } catch (error) {
        logger.error('Error handling file upload:', { error });
      }
    });

    // Handle typing indicators from users
    socket.on('user-typing', (data = {}) => {
      if (isOperator || !boundSessionId || pendingSession) {
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
      toVisitor(sessionId, 'operator-typing', {
        isTyping,
        operatorName: operatorDisplayName,
        timestamp: new Date()
      });
    });

    /**
     * An operator has read a conversation - opened it, or scrolled to the
     * end. Without a `messageId` it is everything the visitor has written.
     */
    socket.on('operator-read', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, messageId } = data;

      if (!(await canOperateOn(sessionId))) {
        return;
      }

      try {
        const conversation = await Conversation.findOne({ sessionId })
          .select('sessionId channel messages._id messages.messageId messages.sender')
          .lean();
        if (!conversation) {
          return;
        }

        const target = typeof messageId === 'string' && messageId
          ? conversation.messages.find(message => message.sender === 'user' &&
              (String(message._id) === messageId || message.messageId === messageId))
          : lifecycle.lastVisitorMessage(conversation);

        if (target) {
          tellVisitorRead(conversation, target);
        }
      } catch (error) {
        logger.warn('Could not send a read receipt', { sessionId, error: error.message });
      }
    });

    // Handle message read receipts
    socket.on('message-read', (data = {}) => {
      if (isOperator || !boundSessionId || pendingSession) {
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
      if (isOperator || !boundSessionId || pendingSession) {
        return;
      }

      // Broadcast to operators
      toOperators(clientCompanyId, 'all-messages-read', {
        sessionId: boundSessionId,
        timestamp: new Date()
      });
    });

    /**
     * A visitor's thumbs up or down on one of the bot's answers.
     *
     * Only on a bot message of the conversation this socket is bound to: the
     * message id is checked against that conversation, never looked up on its
     * own, so nobody can rate somebody else's transcript. A visitor may
     * change their mind; the latest rating stands.
     */
    socket.on('message-feedback', async (data = {}) => {
      if (isOperator || !boundSessionId || pendingSession) {
        return;
      }

      const sessionId = boundSessionId;
      const { messageId, rating } = data;

      if (typeof messageId !== 'string' || !/^[0-9a-f]{24}$/i.test(messageId) || !['up', 'down'].includes(rating)) {
        return socket.emit('error', { sessionId, message: 'That rating could not be recorded' });
      }

      if (!rateLimit()) {
        return;
      }

      try {
        const at = new Date();
        const updated = await Conversation.findOneAndUpdate(
          { sessionId, messages: { $elemMatch: { _id: messageId, sender: 'bot' } } },
          { $set: { 'messages.$.feedback': { rating, at } } },
          { new: true, projection: { company: 1, sessionId: 1 } }
        ).lean();

        if (!updated) {
          return socket.emit('error', { sessionId, message: 'That rating could not be recorded' });
        }

        allOperators(tenantOf(updated), 'message-feedback', { sessionId, messageId, rating, timestamp: at });
      } catch (error) {
        logger.error('Error recording message feedback', { sessionId, error: error.message });
      }
    });

    /**
     * A visitor leaving their email address for a reply.
     *
     * The way out when nobody can answer now: closed, nobody at the desk, or
     * the bot could not help. The conversation is created if this is the
     * first thing they did, marked as waiting with the reason, and the team
     * is told - and an operator's reply to it goes by email when the visitor
     * is no longer here to read it in the chat.
     */
    socket.on('leave-message', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      const sessionId = boundSessionId;
      const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';

      if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_ADDRESS.test(email)) {
        return socket.emit('error', { sessionId, message: 'Please enter a valid email address' });
      }

      let text = null;
      if (typeof data.message === 'string' && data.message.trim()) {
        const validated = validateMessage(data.message);
        if (validated.error) {
          return socket.emit('error', { sessionId, message: validated.error });
        }
        text = validated.text;
      }

      if (!rateLimit()) {
        return socket.emit('error', { sessionId, message: 'You are sending messages too quickly. Please wait a moment.' });
      }

      try {
        const engaged = await engage({ ...data, email });
        if (!engaged) {
          return;
        }
        const { conversation, created } = engaged;
        const now = new Date();
        const stored = [];

        conversation.followUp = {
          email,
          requestedAt: now,
          lastSentAt: conversation.followUp ? conversation.followUp.lastSentAt : undefined
        };

        if (!conversation.metadata) {
          conversation.metadata = new Map();
        }
        if (!conversation.metadata.get('email')) {
          conversation.metadata.set('email', email);
        }
        recordConsent(conversation, data.consent);

        if (text) {
          conversation.messages.push({ content: text, sender: 'user', timestamp: now });
          stored.push(lastMessage(conversation));
          usageService.record(clientCompanyId, { messages: 1 });
        }

        stored.push(lifecycle.addSystemLine(conversation, `Left an email address for a reply: ${email}`));

        if (!conversation.operatorId) {
          const reach = await lifecycle.reachability(tenantOf(conversation));
          const current = conversation.handoff && conversation.handoff.reason;
          const reason = !reach.canReach ? 'offline_message' : (current || 'visitor_request');

          conversation.handoff = {
            requestedAt: (conversation.handoff && conversation.handoff.requestedAt) || now,
            reason,
            summary: lifecycle.handoverSummary(conversation)
          };
          conversation.awaitingOperatorSince = conversation.awaitingOperatorSince || now;
        }

        // An address they typed is a claim, not a verified identity; it
        // threads this conversation onto anyone we know by that address.
        const contact = await contactService.resolve({
          companyId: clientCompanyId,
          sessionId,
          externalId: socket.handshake.auth?.externalId,
          userHash: socket.handshake.auth?.userHash,
          email
        });
        if (contact) {
          await contactService.linkConversation(contact, conversation);
        }

        conversation.lastActivity = now;
        await conversation.save();

        const emit = emitFor(conversation);
        lifecycle.announceMessages(conversation, stored, emit);

        socket.emit('followup-saved', { email, ...notice('followup_saved', { email }) });

        emit.operators('handoff-requested', {
          sessionId,
          visitorName: lifecycle.visitorName(conversation) || email,
          reason: conversation.handoff ? conversation.handoff.reason : 'offline_message',
          requestedAt: conversation.handoff ? conversation.handoff.requestedAt : now,
          preview: lifecycle.preview(text || lifecycle.lastVisitorMessage(conversation)?.content),
          email
        });

        if (created) {
          await lifecycle.announceStart(conversation, { preview: text || '', emit });
        }
      } catch (error) {
        logger.error('Error saving a follow-up request', { sessionId, error: error.message });
        socket.emit('error', { sessionId, message: 'Your message could not be saved. Please try again.' });
      }
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
          .select('operatorId operatorName company firstOperatorJoinedAt')
          .lean();

        if (!current) {
          return socket.emit('error', { sessionId, message: 'Conversation not found' });
        }

        // The person who already holds it, coming back - a refresh, a second
        // tab, a reconnect. They rejoin the room and nothing else happens:
        // announcing them to the visitor again, wiping the workflow and
        // drafting another suggestion was what every page reload used to do.
        if (current.operatorId && String(current.operatorId) === String(socket.user.id)) {
          socket.join(sessionId);
          socket.emit('operator-rejoined', { sessionId, timestamp: new Date() });
          return;
        }

        const heldByAnother = Boolean(current.operatorId);

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

        const now = new Date();
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              hasOperator: true,
              // The workflow stops here. Two of them asking questions at once
              // — a person and a half-finished flow — is worse than either.
              workflowState: { awaiting: null, variables: {}, updatedAt: now },
              operatorId: socket.user.id,
              operatorName: operatorDisplayName,
              assignment: { method: 'manual', at: now },
              operatorEverJoined: true,
              ...(current.firstOperatorJoinedAt ? {} : { firstOperatorJoinedAt: now })
            },
            $push: {
              messages: {
                content: heldByAnother
                  ? `${operatorDisplayName} took over from ${current.operatorName || 'a colleague'}`
                  : `${operatorDisplayName} joined`,
                sender: 'system',
                path: 'system',
                timestamp: now
              }
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
        const emit = emitFor(conversation);

        lifecycle.announceMessages(conversation, [lastMessage(conversation)], emit);

        // The visitor sees who they are talking to now.
        toVisitor(sessionId, 'operator-joined', {
          sessionId,
          operatorName: operatorDisplayName,
          ...notice('operator_joined', { operatorName: operatorDisplayName })
        });

        if (heldByAnother) {
          // The person who had it is told it has been taken, by name.
          io.to(userRoom(current.operatorId)).emit('chat-taken-from-you', {
            sessionId,
            takenBy: operatorDisplayName,
            timestamp: now
          });
        }

        // Notify all operators that an operator has joined this chat
        allOperators(tenantId, 'operator-joined', {
          sessionId,
          operatorId: socket.user.id,
          operatorName: operatorDisplayName,
          timestamp: now
        });

        // Draft a reply to whatever the visitor last said, for the person
        // who has just taken over.
        const lastUserMessage = lifecycle.lastVisitorMessage(conversation);

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
        } else if (result.warning) {
          socket.emit('error', { sessionId, message: result.warning });
        } else if (result.emailedTo) {
          socket.emit('operator-message-emailed', { sessionId, messageId: result.messageId, to: result.emailedTo });
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
          targetMessage = lifecycle.lastVisitorMessage(conversation);
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
        if (result.warning) {
          socket.emit('error', { sessionId, message: result.warning });
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

      toVisitor(sessionId, 'request-user-details');
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

        if (heldByColleague(conversation, data.force)) {
          return socket.emit('error', {
            sessionId,
            message: `${conversation.operatorName || 'Another operator'} is handling this conversation`
          });
        }

        const tenantId = tenantOf(conversation);
        const emit = emitFor(conversation);
        let line;

        if (passToBot === false) {
          // Not "leave it for the next person" - that used to mean nobody:
          // bot off, operator gone, every further message unanswered. The
          // conversation goes back into the queue and is offered to a
          // colleague now.
          const result = await assignmentService.release(conversation, { exclude: [socket.user.id] });

          line = lifecycle.addSystemLine(conversation, result.assigned
            ? `${operatorDisplayName} passed this to ${result.operator.displayName}`
            : `${operatorDisplayName} returned this to the queue`);
          await conversation.save();

          toVisitor(sessionId, 'operator-left', {
            sessionId,
            operatorName: operatorDisplayName,
            ...notice('operator_left', { operatorName: operatorDisplayName })
          });

          if (result.assigned) {
            toVisitor(sessionId, 'operator-joined', {
              sessionId,
              operatorName: result.operator.displayName,
              ...notice('operator_joined', { operatorName: result.operator.displayName })
            });
          }
        } else {
          conversation.hasOperator = false;
          conversation.operatorId = null;
          conversation.operatorName = null;
          conversation.botEnabled = true;
          conversation.awaitingOperatorSince = undefined;
          line = lifecycle.addSystemLine(conversation, `${operatorDisplayName} handed this back to the bot`);
          await conversation.save();

          toVisitor(sessionId, 'operator-left', {
            sessionId,
            operatorName: operatorDisplayName,
            ...notice('handed_back', { operatorName: operatorDisplayName })
          });
        }

        lifecycle.announceMessages(conversation, [line], emit);

        socket.leave(sessionId);

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

    /**
     * An operator closing a conversation, with how it ended.
     *
     * The outcome - resolved, needs a follow-up, not resolved, spam - is what
     * lets a tenant tell a bot that deflects from a bot that helps, and it is
     * only known to the person who closed it.
     */
    socket.on('end-chat', async (data = {}) => {
      if (!isOperator) {
        return;
      }

      const { sessionId } = data;

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(sessionId))) {
        return socket.emit('error', { sessionId, message: 'You do not have access to this conversation' });
      }

      let outcome = null;
      if (data.outcome !== undefined && data.outcome !== null) {
        const status = data.outcome && data.outcome.status;
        if (!OUTCOMES.includes(status)) {
          return socket.emit('error', { sessionId, message: 'Choose how the conversation ended' });
        }
        const note = typeof data.outcome.note === 'string' ? data.outcome.note.trim().slice(0, MAX_OUTCOME_NOTE) : '';
        outcome = { status, note: note || undefined, by: socket.user.id, at: new Date() };
      }

      try {
        const current = await Conversation.findOne({ sessionId }).select('operatorId operatorName').lean();
        if (heldByColleague(current, data.force)) {
          return socket.emit('error', {
            sessionId,
            message: `${current.operatorName || 'Another operator'} is handling this conversation`
          });
        }

        const now = new Date();

        // Update conversation status in database
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              status: 'ended',
              endedAt: now,
              hasOperator: false,
              operatorId: null,
              operatorName: null,
              // A visitor returning days later should not be answered as
              // though they were still half way through answering a question.
              workflowState: { awaiting: null, variables: {}, updatedAt: now },
              ...(outcome ? { outcome } : {})
            },
            $push: {
              messages: {
                content: outcome
                  ? `Ended by ${operatorDisplayName} (${outcome.status.replace('_', ' ')})`
                  : `Ended by ${operatorDisplayName}`,
                sender: 'system',
                path: 'system',
                timestamp: now
              }
            },
            $unset: { awaitingOperatorSince: 1 }
          },
          { new: true }
        );

        if (conversation) {
          const tenantId = tenantOf(conversation);

          lifecycle.announceMessages(conversation, [lastMessage(conversation)], emitFor(conversation));

          // Ask for a rating on the way out. This is the only moment the
          // customer is both still present and finished — asking earlier
          // interrupts, and asking later means emailing them.
          // Not on a messaging app, where there is no rating form to show.
          const askForRating = !channels.isMessagingChannel(conversation.channel) &&
            csatService.shouldRequestRating(conversation);

          if (askForRating) {
            await csatService.markRequested(sessionId);
          }

          webhookService.dispatch(conversation.company, 'conversation.ended', {
            sessionId,
            endedBy: 'operator',
            operatorName: operatorDisplayName,
            messages: conversation.messages.filter(message => message.sender !== 'system').length,
            startedAt: conversation.startedAt,
            endedAt: conversation.endedAt,
            outcome: outcome ? outcome.status : null,
            tags: conversation.tags || []
          });

          // Notify user that chat has ended
          toVisitor(sessionId, 'chat-ended', {
            requestRating: askForRating,
            ...notice('chat_ended'),
            timestamp: now
          });

          // Notify all operators that this chat has ended
          allOperators(tenantId, 'chat-ended', {
            sessionId,
            outcome: outcome ? { status: outcome.status, note: outcome.note } : undefined,
            timestamp: now
          });

          // Notify all operators that the operator has left this chat
          allOperators(tenantId, 'operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: operatorDisplayName,
            timestamp: now
          });
        }
      } catch (error) {
        logger.error('Error ending chat:', { error });
      }
    });

    /**
     * A visitor asking for a person.
     *
     * Explicit, from the widget's button. Whether anyone can actually answer
     * is checked - opening hours, and somebody connected and taking chats -
     * and a visitor nobody can answer now is asked for an email address
     * rather than left in a queue nobody is watching.
     */
    socket.on('request-operator', async (data = {}) => {
      if (isOperator || !boundSessionId) {
        return;
      }

      try {
        const engaged = await engage(data || {});
        if (!engaged) {
          return;
        }
        const { conversation, created } = engaged;
        const emit = emitFor(conversation);

        if (created) {
          await lifecycle.announceStart(conversation, { preview: '', emit });
        }

        const reason = lastBotMessageUnanswered(conversation) ? 'bot_unanswered' : 'visitor_request';
        await lifecycle.handOver(conversation, reason, { emit });
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

          // Once per rating, on the score rather than on a comment added to it.
          if (!result.commentAdded && result.rating.score <= LOW_RATING) {
            notifyLowRating(sessionId, result);
          }
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
      if (!isOperator && boundSessionId && !pendingSession) {
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
          releaseOperatorChats(socket.user.id, socket.user.username, operatorDisplayName);
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
