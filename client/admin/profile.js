/**
 * My settings: the signed-in person's own preferences and password. Kept
 * apart from company configuration, which an operator cannot change anyway.
 */

import { registerSection } from './nav.js';
import { state } from './state.js';
import { api, errorMessage, setAuthToken, setLoading, showToast } from './utils.js';

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
    setupNotificationPreferences();
    setupPassword();
  }
});
