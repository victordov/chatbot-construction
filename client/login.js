/**
 * Admin login page.
 *
 * External rather than inline so the dashboard's Content-Security-Policy can
 * refuse inline script altogether. Three flows share the page: signing in,
 * asking for a reset link, and choosing a new password from that link
 * (`login.html?reset=<token>`).
 */

const AUTH_TOKEN_KEY = 'chatbot-auth-token';
const STORED_USER_KEY = 'chatbot-user';

function readToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

function clearToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(STORED_USER_KEY);
  } catch (error) {
    // Ignore.
  }
}

function storeSession(token, user) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(STORED_USER_KEY, JSON.stringify(user || null));
  } catch (error) {
    // Storage blocked: the dashboard will send them straight back here.
  }
}

/** Show one of the three panels and hide the others. */
function showPanel(name) {
  ['login', 'forgot', 'reset'].forEach(panel => {
    const element = document.getElementById(`${panel}-panel`);
    if (element) {
      element.hidden = panel !== name;
    }
  });
}

function showMessage(element, text, kind) {
  element.textContent = text;
  element.className = `form-message ${kind}`;
  element.style.display = text ? 'block' : 'none';
}

/**
 * Parse a JSON body without throwing on an empty one, and say whether the
 * request was rate limited: a 429 is "slow down", not "wrong password", and
 * telling somebody their password is wrong when it is not sends them to
 * reset it.
 */
async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function messageFor(status, body, fallback) {
  if (status === 429) {
    return 'Too many attempts, try again later.';
  }
  return (body && (body.error || body.message)) || fallback;
}

// ------------------------------------------------------------------ login

function setupLogin() {
  const form = document.getElementById('login-form');
  const message = document.getElementById('login-error');
  const params = new URLSearchParams(window.location.search);

  // Arriving here because a token expired mid-shift, rather than by
  // signing out. Saying so is the difference between "sign in again"
  // and "why did it log me out?".
  if (params.get('expired')) {
    showMessage(message, 'Your session expired. Please sign in again.', 'text-warning');
  }
  if (params.get('reset-done')) {
    showMessage(message, 'Your password has been changed. Sign in with the new one.', 'text-success');
  }

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const button = form.querySelector('button[type="submit"]');

    showMessage(message, '', '');
    button.disabled = true;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const { ok, status, body } = await readResponse(response);

      if (ok && body.token) {
        storeSession(body.token, body.user);
        window.location.href = '/admin/';
        return;
      }

      showMessage(message, messageFor(status, body, 'Invalid username or password'), 'text-danger');
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
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
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

function setupReset(token) {
  const form = document.getElementById('reset-form');
  const message = document.getElementById('reset-message');

  document.getElementById('reset-back').addEventListener('click', event => {
    event.preventDefault();
    // Drop the token from the URL so a refresh does not reopen this panel.
    window.history.replaceState({}, '', window.location.pathname);
    showPanel('login');
  });

  form.addEventListener('submit', async function(event) {
    event.preventDefault();

    const newPassword = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password-confirm').value;
    const button = form.querySelector('button[type="submit"]');

    if (newPassword.length < 8) {
      showMessage(message, 'Use at least 8 characters.', 'text-danger');
      return;
    }
    if (newPassword !== confirm) {
      showMessage(message, 'The two passwords do not match.', 'text-danger');
      return;
    }

    button.disabled = true;

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
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

document.addEventListener('DOMContentLoaded', function() {
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('reset');

  setupLogin();
  setupForgot();

  if (resetToken) {
    setupReset(resetToken);
    showPanel('reset');
    document.getElementById('reset-password').focus();
    return;
  }

  showPanel('login');

  // Already signed in? Skip the form.
  const token = readToken();
  if (!token) {
    return;
  }

  fetch('/api/auth/verify', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token }
  })
    .then(response => {
      if (response.ok) {
        window.location.href = '/admin/';
      } else {
        clearToken();
      }
    })
    .catch(error => {
      console.error('Error verifying token:', error);
      clearToken();
    });
});
