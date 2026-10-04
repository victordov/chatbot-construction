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

module.exports = {
  setIo,
  getIo,
  operatorRoom,
  userRoom,
  emitToOperators,
  emitToUser,
  broadcastToTenant,
  emitToSession,
  GLOBAL_OPERATOR_ROOM
};
