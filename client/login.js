/**
 * Admin login page.
 *
 * External rather than inline so the dashboard's Content-Security-Policy can
 * refuse inline script altogether. Three flows share the page: signing in,
 * asking for a reset link, and choosing a new password from that link
 * (`login.html?reset=<token>`). Google sign-in, when it is set up, comes back
 * here with the session in the URL fragment.
 */

import {
  applyBrand, clearToken, messageFor, nextDestination, postJson, readResponse, readToken,
  setupPasswordToggles, showMessage, storeSession
} from './auth-common.js';

const params = new URLSearchParams(window.location.search);

/** Show one of the three panels and hide the others. */
function showPanel(name) {
  ['login', 'forgot', 'reset'].forEach(panel => {
    const element = document.getElementById(`${panel}-panel`);
    if (element) {
      element.hidden = panel !== name;
    }
  });
}

/**
 * Why somebody has arrived at the sign-in page, when it was not by choice.
 * Saying so is the difference between "sign in again" and "why did it log me
 * out?" - and, for a switched-off company, between trying again and calling
 * somebody.
 */
function arrivalMessage() {
  const reason = params.get('reason');
  if (reason === 'company_inactive') {
    return ['Your company\'s account has been deactivated. Contact the people who run this service to restore it.', 'text-danger'];
  }
  if (reason === 'account_disabled') {
    return ['Your account has been deactivated. Ask an admin on your team if you think this is a mistake.', 'text-danger'];
  }
  if (reason === 'signed_out') {
    return ['You were signed out on every device. Sign in again to carry on.', 'text-warning'];
  }
  if (reason === 'password_changed') {
    return ['Your password was changed, so you were signed out. Sign in with the new one.', 'text-warning'];
  }
  if (params.get('expired')) {
    return ['Your session expired. Please sign in again.', 'text-warning'];
  }
  if (params.get('reset-done')) {
    return ['Your password has been changed. Sign in with the new one.', 'text-success'];
  }

  const google = params.get('google');
  const googleMessages = {
    no_account: 'There is no active account with that Google address here. Sign in with your password, or ask an admin to invite that address.',
    unverified: 'Google has not confirmed that address, so it cannot be used to sign in.',
    company_inactive: 'Your company\'s account has been deactivated. Contact the people who run this service to restore it.',
    expired: 'That Google sign-in took too long or started in another browser. Try again.',
    cancelled: 'Google sign-in was cancelled.',
    unavailable: 'Google sign-in is not set up on this service.',
    error: 'Google sign-in did not work this time. Try again, or use your password.'
  };
  if (google && googleMessages[google]) {
    return [googleMessages[google], 'text-danger'];
  }

  return null;
}

// ------------------------------------------------------------------ login

function setupLogin(config) {
  const form = document.getElementById('login-form');
  const message = document.getElementById('login-error');

  const arrival = arrivalMessage();
  if (arrival) {
    showMessage(message, arrival[0], arrival[1]);
  }

  // A trial is one click from here, carrying the deep link along.
  const trial = document.getElementById('signup-link');
  if (trial) {
    trial.hidden = !config.signupEnabled;
    trial.querySelector('a').href = `/admin/signup.html${params.get('next') ? `?next=${encodeURIComponent(params.get('next'))}` : ''}`;
  }

  const google = document.getElementById('google-signin');
  if (google) {
    google.hidden = !config.googleSignIn;
    google.href = `/api/auth/google/start?next=${encodeURIComponent(nextDestination(params))}`;
  }

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const button = form.querySelector('button[type="submit"]');

    if (!username || !password) {
      showMessage(message, 'Enter your email (or username) and password.', 'text-danger');
      return;
    }

    showMessage(message, '', '');
    button.disabled = true;

    try {
      const response = await postJson('/api/auth/login', { username, password });
      const { ok, status, body } = await readResponse(response);

      if (ok && body.token) {
        storeSession(body.token, body.user);
        window.location.href = nextDestination(params);
        return;
      }

      showMessage(message, messageFor(status, body, 'Wrong email, username or password'), 'text-danger');
    } catch (error) {
      console.error('Login error:', error);
      showMessage(message, 'Could not reach the server. Try again.', 'text-danger');
    } finally {
      button.disabled = false;
    }
  });
}

// ----------------------------------------------------------------- forgot

function setupForgot() {
  const form = document.getElementById('forgot-form');
  const message = document.getElementById('forgot-message');

  document.getElementById('forgot-link').addEventListener('click', event => {
    event.preventDefault();
    showMessage(message, '', '');
    showPanel('forgot');
    const typed = document.getElementById('username').value.trim();
    if (typed.includes('@')) {
      document.getElementById('forgot-email').value = typed;
    }
    document.getElementById('forgot-email').focus();
  });

  document.getElementById('forgot-back').addEventListener('click', event => {
    event.preventDefault();
    showPanel('login');
  });

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const email = document.getElementById('forgot-email').value.trim();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    try {
      const response = await postJson('/api/auth/forgot-password', { email });
      const { ok, status, body } = await readResponse(response);

      if (ok) {
        // The server answers 200 whether or not the address is known, so
        // that this page cannot be used to find out who has an account.
        showMessage(message,
          'If that address belongs to an account, a reset link is on its way.',
          'text-success');
        return;
      }

      showMessage(message, messageFor(status, body, 'Could not send a reset link. Try again.'), 'text-danger');
    } catch (error) {
      console.error('Forgot password error:', error);
      showMessage(message, 'Could not reach the server. Try again.', 'text-danger');
    } finally {
      button.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ reset

async function setupReset(token) {
  const form = document.getElementById('reset-form');
  const message = document.getElementById('reset-message');
  const hint = document.getElementById('reset-length-hint');
  // A superadmin's password is longer than everyone else's. The form used to
  // say eight to everybody and then let the server refuse twelve.
  let minLength = 8;

  document.getElementById('reset-back').addEventListener('click', event => {
    event.preventDefault();
    // Drop the token from the URL so a refresh does not reopen this panel.
    window.history.replaceState({}, '', window.location.pathname);
    showPanel('login');
  });

  try {
    const response = await fetch(`/api/auth/reset-info?token=${encodeURIComponent(token)}`);
    const { ok, status, body } = await readResponse(response);
    if (ok) {
      minLength = body.minLength || minLength;
    } else {
      showMessage(message, messageFor(status, body, 'That reset link is no longer valid. Request a new one.'), 'text-danger');
    }
  } catch (error) {
    // The form still works; the server checks the length either way.
  }

  if (hint) {
    hint.textContent = `At least ${minLength} characters.`;
  }
  ['reset-password', 'reset-password-confirm'].forEach(id => {
    document.getElementById(id).minLength = minLength;
  });

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const newPassword = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password-confirm').value;
    const button = form.querySelector('button[type="submit"]');

    if (newPassword.length < minLength) {
      showMessage(message, `Use at least ${minLength} characters.`, 'text-danger');
      return;
    }
    if (newPassword !== confirm) {
      showMessage(message, 'The two passwords do not match.', 'text-danger');
      return;
    }

    button.disabled = true;

    try {
      const response = await postJson('/api/auth/reset-password', { token, newPassword });
      const { ok, status, body } = await readResponse(response);

      if (ok) {
        // Any session this browser had belonged to the old password.
        clearToken();
        window.location.replace(`${window.location.pathname}?reset-done=1`);
        return;
      }

      showMessage(message,
        messageFor(status, body, 'That reset link is no longer valid. Request a new one.'),
        'text-danger');
    } catch (error) {
      console.error('Reset password error:', error);
      showMessage(message, 'Could not reach the server. Try again.', 'text-danger');
    } finally {
      button.disabled = false;
    }
  });
}

// ------------------------------------------------------------------- boot

/**
 * Back from Google with a session in the fragment: keep it, take it out of
 * the address bar and the history, and go on.
 */
function adoptSessionFromFragment() {
  const match = window.location.hash.match(/^#token=([A-Za-z0-9._-]+)$/);
  if (!match) {
    return false;
  }
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  storeSession(match[1], null);
  window.location.replace(nextDestination(params));
  return true;
}

document.addEventListener('DOMContentLoaded', async function() {
  if (adoptSessionFromFragment()) {
    return;
  }

  setupPasswordToggles();
  const config = await applyBrand();
  const resetToken = params.get('reset');

  setupLogin(config);
  setupForgot();

  if (resetToken) {
    showPanel('reset');
    document.getElementById('reset-password').focus();
    setupReset(resetToken);
    return;
  }

  if (params.get('forgot')) {
    // Linked from sign-up, for an address that already has an account.
    document.getElementById('forgot-link').click();
  } else {
    showPanel('login');
    document.getElementById('username').focus();
  }

  // Already signed in? Skip the form - unless the session was refused for a
  // reason worth reading.
  const token = readToken();
  if (!token || params.get('reason')) {
    if (params.get('reason')) {
      clearToken();
    }
    return;
  }

  fetch('/api/auth/verify', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token }
  })
    .then(response => {
      if (response.ok) {
        window.location.href = nextDestination(params);
      } else {
        clearToken();
      }
    })
    .catch(error => {
      console.error('Error verifying token:', error);
      clearToken();
    });
});
