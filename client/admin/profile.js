/**
 * My settings: the signed-in person's own preferences and password. Kept
 * apart from company configuration, which an operator cannot change anyway.
 */

import { logoutEverywhere, showProfile } from './core.js';
import { registerSection } from './nav.js';
import { state } from './state.js';
import { api, errorMessage, escapeHtml, setAuthToken, setLoading, setStoredUser, showToast } from './utils.js';

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (error) {
    return 'UTC';
  }
}

/**
 * The person's own name and timezone.
 *
 * The name is what colleagues see on notes and transfers and what a visitor
 * sees when an operator joins, so it is theirs to get right; it used to be
 * changeable only by an admin.
 */
function setupDetails() {
  const form = document.getElementById('profile-form');
  if (!form) {
    return;
  }

  const user = state.currentUser || {};
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  const chosen = user.timezone || '';
  const select = document.getElementById('profile-timezone');
  select.innerHTML = `<option value="">This browser's (${escapeHtml(browserZone())})</option>` +
    (chosen && !zones.includes(chosen) ? [chosen, ...zones] : zones).map(zone =>
      `<option value="${escapeHtml(zone)}" ${zone === chosen ? 'selected' : ''}>${escapeHtml(zone)}</option>`).join('');

  document.getElementById('profile-display-name').value = user.displayName || user.username || '';
  document.getElementById('profile-email-line').textContent = user.email
    ? `You sign in as ${user.email}${user.username ? ` (or ${user.username})` : ''}. Ask an admin to change your address.`
    : '';

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('profile-save-btn');
    const displayName = document.getElementById('profile-display-name').value.trim();

    if (!displayName) {
      showToast('Enter your name', 'warning');
      return;
    }

    setLoading(button, true);
    try {
      const { user: updated } = await api('/api/auth/me', {
        method: 'PUT',
        body: { displayName, timezone: select.value || null }
      });
      state.currentUser = { ...state.currentUser, ...updated };
      setStoredUser(state.currentUser);
      showProfile(state.currentUser);
      showToast('Saved', 'success');
    } catch (error) {
      showToast(errorMessage(error, 'Could not save your details'), 'danger');
    } finally {
      setLoading(button, false);
    }
  });
}

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function setupNotificationPreferences() {
  const form = document.getElementById('settings-form');
  const setting = document.getElementById('notification-setting');
  const sound = document.getElementById('sound-notifications');

  setting.value = readPreference('notification-setting', 'all');
  sound.checked = readPreference('sound-notifications', 'false') === 'true';

  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      localStorage.setItem('notification-setting', setting.value);
      localStorage.setItem('sound-notifications', String(sound.checked));
    } catch (error) {
      showToast('This browser is not keeping preferences', 'warning');
      return;
    }

    // Desktop notifications need the browser's permission, asked for once.
    if (setting.value !== 'none' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    showToast('Preferences saved', 'success');
  });
}

/**
 * The "Your password" form.
 *
 * A successful change returns a fresh token, because changing the password
 * invalidates every token issued before it - including the one this tab is
 * using. Storing the new one keeps this session alive while every other one
 * ends.
 */
function setupPassword() {
  const form = document.getElementById('change-password-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirm = document.getElementById('new-password-confirm').value;
    const button = document.getElementById('change-password-btn');

    // The server's rule: twelve for a superadmin, eight for everyone else.
    const minimum = state.currentUser && state.currentUser.role === 'superadmin' ? 12 : 8;
    if (newPassword.length < minimum) {
      showToast(`Use at least ${minimum} characters for the new password`, 'warning');
      return;
    }
    if (newPassword !== confirm) {
      showToast('The two new passwords do not match', 'warning');
      return;
    }
    if (newPassword === currentPassword) {
      showToast('The new password is the same as the current one', 'warning');
      return;
    }

    setLoading(button, true);
    try {
      const result = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });

      if (result && result.token) {
        setAuthToken(result.token);
        if (state.socket) {
          // The socket authenticated with the old token; give it the new one
          // so its next reconnect is not refused.
          state.socket.auth = { token: result.token };
        }
      }

      form.reset();
      showToast('Password changed. Other sessions have been signed out.', 'success');
    } catch (error) {
      showToast(errorMessage(error, 'Could not change the password'), 'danger');
    } finally {
      setLoading(button, false);
    }
  });
}

registerSection('profile', {
  setup() {
    setupDetails();
    setupNotificationPreferences();
    setupPassword();
    document.getElementById('profile-logout-everywhere')?.addEventListener('click', logoutEverywhere);
  }
});
