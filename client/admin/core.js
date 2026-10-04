/**
 * Dashboard boot: verify the session, open the socket, start what has to be
 * live on every screen, then hand over to the section registry (nav.js).
 *
 * Everything else - knowledge, billing, webhooks and the rest - sets itself
 * up the first time its section is opened.
 */

import feather from 'feather-icons';
import { setupConnectionHandlers, startHeartbeat } from './connection.js';
import { setupContactInfoManagement } from './contact-info.js';
import { setupInbox } from './inbox.js';
import { initNavigation } from './nav.js';
import { setupNotifications } from './notifications.js';
import { setupOperatorTools } from './operator-tools.js';
import { restoreJoinedChats, state } from './state.js';
import { setupTags } from './tags.js';
import { setupTaskManagement } from './tasks.js';
import { api, authToken, logger, setAuthToken, setStoredUser } from './utils.js';

/**
 * Sign out, on the server as well as here. Clearing localStorage alone left
 * the token valid until it expired; the local clean-up happens whether or not
 * the server call succeeds, so a dead server cannot keep somebody signed in.
 */
async function logout() {
  try {
    if (authToken()) {
      await api('/api/auth/logout', { method: 'POST' });
    }
  } catch (error) {
    logger.warn('Logout request failed; clearing the session locally', error);
  } finally {
    setAuthToken(null);
    setStoredUser(null);
    window.location.href = '/admin/login.html';
  }
}

function initials(user) {
  const name = (user.displayName || user.username || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function showProfile(user) {
  const company = user.company && user.company.name;
  document.getElementById('company-badge').textContent = company || '';
  document.getElementById('sidebar-company').textContent =
    company || (user.role === 'superadmin' ? 'Platform admin' : 'Support');
  document.getElementById('profile-name').textContent = user.displayName || user.username;
  document.getElementById('profile-email').textContent = user.email || '';
  document.getElementById('profile-initials').textContent = initials(user);
  document.getElementById('logout-btn').addEventListener('click', logout);
}

function connect(token) {
  return io({
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });
}

async function boot() {
  if (!authToken()) {
    window.location.href = '/admin/login.html';
    return;
  }

  let user;
  try {
    ({ user } = await api('/api/auth/verify'));
  } catch (error) {
    logger.error('Auth error:', error);
    setAuthToken(null);
    window.location.href = '/admin/login.html';
    return;
  }

  setStoredUser(user);
  state.currentUser = user;
  restoreJoinedChats();
  showProfile(user);

  const socket = connect(authToken());
  state.socket = socket;

  // Live on every screen: the queue and its counts, notifications, the
  // connection indicator, and what the inbox's buttons need.
  setupConnectionHandlers(socket);
  startHeartbeat(socket);
  setupInbox(socket);
  setupOperatorTools(socket);
  setupTags(socket);
  setupTaskManagement();
  setupContactInfoManagement();
  setupNotifications(socket);

  initNavigation(user);
  feather.replace();
}

document.addEventListener('DOMContentLoaded', boot);
