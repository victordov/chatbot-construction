// Socket.io instance manager
// Shares the socket.io instance across modules and centralises the room naming
// convention so that events are never broadcast across tenant boundaries.

const { logger } = require('./services/logging');

let io;

// Set the socket.io instance
function setIo(socketIo) {
  io = socketIo;
}

// Get the socket.io instance
function getIo() {
  if (!io) {
    throw new Error('Socket.io has not been initialized');
  }
  return io;
}

/**
 * Room that every operator of a given company joins. Operators only ever see
 * events for their own tenant; superadmins additionally join `operators:all`.
 */
function operatorRoom(companyId) {
  return companyId ? `operators:${companyId.toString()}` : 'operators:unassigned';
}

const GLOBAL_OPERATOR_ROOM = 'operators:all';

/**
 * Emit an event to every operator of one company plus all superadmins.
 * Falls back to a no-op (with a log) when sockets are not initialised, so a
 * missing socket layer can never take down an HTTP request.
 */
function emitToOperators(companyId, event, payload) {
  try {
    const target = getIo();
    target.to(operatorRoom(companyId)).emit(event, payload);
    target.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
    return true;
  } catch (error) {
    logger.warn(`Unable to emit "${event}" to operators`, { error: error.message });
    return false;
  }
}

/**
 * Emit to everyone associated with a tenant (operators and superadmins).
 * Used by the workflow runtime for hot-swap notifications.
 */
function broadcastToTenant(tenantId, event, payload) {
  return emitToOperators(tenantId, event, payload);
}

/**
 * Emit to a single chat session room (the visitor plus any joined operators).
 */
function emitToSession(sessionId, event, payload) {
  try {
    getIo().to(sessionId).emit(event, payload);
    return true;
  } catch (error) {
    logger.warn(`Unable to emit "${event}" to session ${sessionId}`, { error: error.message });
    return false;
  }
}

/**
 * Room only the visitor's own connections join, alongside the session room.
 *
 * Operators who open a conversation join the session room too, so an event
 * meant for the widget - "Ada has joined", "leave your email" - sent to the
 * session room also reached every operator watching it, under an event name
 * the dashboard uses for something else.
 */
function visitorRoom(sessionId) {
  return `visitor:${sessionId}`;
}

/** Emit to the visitor's widget(s) on a session, and nobody else. */
function emitToVisitor(sessionId, event, payload) {
  try {
    getIo().to(visitorRoom(sessionId)).emit(event, payload);
    return true;
  } catch (error) {
    logger.warn(`Unable to emit "${event}" to the visitor on ${sessionId}`, { error: error.message });
    return false;
  }
}

/**
 * Whether the visitor on a session has a connection open right now, on any
 * process. Used to decide whether an operator's reply can be read in the chat
 * or has to go by email.
 */
async function visitorConnected(sessionId) {
  try {
    const sockets = await getIo().in(visitorRoom(sessionId)).fetchSockets();
    return sockets.length > 0;
  } catch (error) {
    // Sockets not initialised (tests, scripts): nobody is connected.
    return false;
  }
}

/**
 * Room one member of staff joins on connect (`websockets.js`), so anything
 * addressed to a person reaches that person.
 */
function userRoom(userId) {
  return `user:${userId.toString()}`;
}

/**
 * Emit to one member of staff.
 *
 * The notification routes used to do this with a bare `io.emit`, which is not a
 * room at all: it reaches every connected socket on the platform - every
 * operator of every tenant, and every website visitor with the widget open -
 * carrying the whole notification document. A notification belongs to one
 * person, so it goes to one person.
 */
function emitToUser(userId, event, payload) {
  if (!userId) {
    return false;
  }

  try {
    getIo().to(userRoom(userId)).emit(event, payload);
    return true;
  } catch (error) {
    logger.warn(`Unable to emit "${event}" to user ${userId}`, { error: error.message });
    return false;
  }
}

/**
 * Close every socket one member of staff has open, on every process.
 *
 * For the moments a session must end now rather than at the next periodic
 * check: an account deactivated, a password changed, a sign-out everywhere.
 * Without this an operator removed from the team kept receiving the tenant's
 * conversations until they happened to close the tab, because a socket is
 * only authenticated when it connects.
 *
 * Each socket is told why first, so the dashboard can send the person to the
 * sign-in page instead of showing "reconnecting" forever.
 *
 * @param {string} userId
 * @param {string} [reason] e.g. 'deactivated', 'signed-out'
 * @returns {boolean} whether the request went out
 */
function disconnectUser(userId, reason = 'signed-out') {
  if (!userId) {
    return false;
  }

  try {
    const target = getIo();
    target.to(userRoom(userId)).emit('session-expired', { reason });
    target.in(userRoom(userId)).disconnectSockets(true);
    return true;
  } catch (error) {
    logger.warn(`Unable to disconnect user ${userId}`, { error: error.message });
    return false;
  }
}

module.exports = {
  setIo,
  getIo,
  operatorRoom,
  userRoom,
  visitorRoom,
  emitToOperators,
  emitToUser,
  broadcastToTenant,
  emitToSession,
  emitToVisitor,
  visitorConnected,
  disconnectUser,
  GLOBAL_OPERATOR_ROOM
};
