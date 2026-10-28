/**
 * The dashboard's realtime connection: status, heartbeat, and what to do
 * when it drops or the session behind it has expired.
 */

import { loadActiveChats } from './inbox.js';
import { logger, setAuthToken, setStoredUser } from './utils.js';

// Set up connection event handlers
export function setupConnectionHandlers(socket) {
  socket.on('connect', () => {
    logger.info('Socket connected');
    // Join operator room when connected
    socket.emit('join-operator-room');

    // Update UI to show connected status
    updateConnectionStatus(true);
  });

  socket.on('disconnect', (reason) => {
    logger.info('Socket disconnected:', reason);
    // Update UI to show disconnected status
    updateConnectionStatus(false);
  });

  socket.on('connect_error', (error) => {
    logger.error('Connection error:', error);

    // The handshake was refused because the token is no longer good. The
    // client would otherwise retry forever with the same dead token, showing
    // "Reconnecting…" for the rest of the shift.
    if (isAuthFailure(error)) {
      socket.disconnect();
      setAuthToken(null);
      setStoredUser(null);
      window.location.href = '/admin/login.html?expired=1';
      return;
    }

    // Update UI to show error status
    updateConnectionStatus(false, error.message);
  });

  // `reconnect` is emitted by the Manager, not the Socket: listening on the
  // socket never fired, so the queue was never refreshed after a drop. The
  // `connect` handler above already rejoins the operator room.
  socket.io.on('reconnect', (attemptNumber) => {
    logger.info(`Socket reconnected after ${attemptNumber} attempts`);

    // Reload active chats to ensure we have the latest data: anything that
    // started or ended while we were away was never pushed to us. It also
    // re-joins the rooms of the conversations the server says this person
    // holds - and only those: the reconnected socket is in none of them.
    loadActiveChats(socket);
  });
}

/**
 * Whether a connection error means the token was rejected rather than the
 * network being down. socket.io puts the server's middleware error message
 * on `error.message`, and the server's auth middleware says so in words.
 */
export function isAuthFailure(error) {
  const message = String((error && error.message) || '').toLowerCase();
  const data = error && error.data;
  return message.includes('authentication') ||
    message.includes('unauthorized') ||
    message.includes('invalid token') ||
    message.includes('token expired') ||
    message.includes('jwt') ||
    (data && (data.code === 401 || data.status === 401));
}

// Start heartbeat to keep socket connection alive
export function startHeartbeat(socket) {
  // Send a heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('heartbeat', { timestamp: new Date().toISOString() });
      logger.info('Heartbeat sent');
    }
  }, 30000);

  // Handle page visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // When page becomes visible, check socket connection and reconnect if needed
      if (socket && !socket.connected) {
        logger.info('Reconnecting socket on visibility change');
        socket.connect();
      }
    }
  });

  // Clean up interval when window is closed
  window.addEventListener('beforeunload', () => {
    clearInterval(heartbeatInterval);
  });
}

// Update connection status in UI
export function updateConnectionStatus(isConnected, errorMessage = null) {
  // This used to look for `.navbar-nav`, which this dashboard does not have,
  // so the indicator was never rendered and operators had no way to tell that
  // their realtime connection had dropped.
  const statusElement = document.getElementById('connection-status');
  if (!statusElement) {
    return;
  }

  statusElement.className = `connection-status ${isConnected ? 'is-online' : 'is-offline'}`;
  statusElement.textContent = isConnected ? 'Live' : 'Reconnecting…';
  statusElement.title = !isConnected && errorMessage
    ? errorMessage
    : (isConnected ? 'Realtime connection active' : 'Trying to reconnect');
}

