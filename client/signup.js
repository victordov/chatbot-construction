/**
 * Starting a free trial: a company, its first admin, and straight into the
 * dashboard.
 *
 * The server signs the new admin in as part of creating the account, so the
 * next screen is Home with the setup checklist rather than a "now sign in"
 * detour. The address is confirmed by email afterwards; the dashboard says so
 * until it is.
 */

import {
  applyBrand, messageFor, nextDestination, postJson, readResponse, readToken,
  setupPasswordToggles, showMessage, storeSession
} from './auth-common.js';

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function value(id) {
  return document.getElementById(id).value.trim();
}

/** The first field that is not right, with what to say about it. */
function problem() {
  if (value('signup-company').length < 2) {
    return ['signup-company', 'Enter your company\'s name.'];
  }
  if (!EMAIL_PATTERN.test(value('signup-email'))) {
    return ['signup-email', 'Enter a valid email address.'];
  }
  if (document.getElementById('signup-password').value.length < MIN_PASSWORD_LENGTH) {
    return ['signup-password', `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`];
  }
  return null;
}

function setupForm() {
  const form = document.getElementById('signup-form');
  const message = document.getElementById('signup-message');
  const params = new URLSearchParams(window.location.search);

  const signin = document.getElementById('signin-link');
  if (signin && params.get('next')) {
    signin.href = `/admin/login.html?next=${encodeURIComponent(params.get('next'))}`;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    showMessage(message, '', '');

    const wrong = problem();
    if (wrong) {
      showMessage(message, wrong[1], 'text-danger');
      document.getElementById(wrong[0]).focus();
      return;
    }

    const button = document.getElementById('signup-submit');
    button.disabled = true;
    button.textContent = 'Creating your account…';

    try {
      const response = await postJson('/api/auth/signup', {
        companyName: value('signup-company'),
        website: value('signup-website') || undefined,
        name: value('signup-name') || undefined,
        email: value('signup-email'),
        password: document.getElementById('signup-password').value
      });
      const { ok, status, body } = await readResponse(response);

      if (ok && body.token) {
        storeSession(body.token, body.user);
        // Home, with a note that the website is being read if one was given.
        const destination = nextDestination(params);
        window.location.href = destination === '/admin/'
          ? `/admin/?section=home&welcome=1${body.crawling ? '&crawling=1' : ''}`
          : destination;
        return;
      }

      if (body && body.code === 'EMAIL_TAKEN') {
        message.innerHTML = '';
        showMessage(message, body.error, 'text-danger');
        const link = document.createElement('div');
        link.innerHTML = '<a href="/admin/login.html">Sign in</a> or <a href="/admin/login.html?forgot=1">reset your password</a>.';
        message.appendChild(link);
        return;
      }

      showMessage(message, messageFor(status, body, 'Could not create your account. Try again.'), 'text-danger');
    } catch (error) {
      console.error('Sign-up error:', error);
      showMessage(message, 'Could not reach the server. Try again.', 'text-danger');
    } finally {
      button.disabled = false;
      button.textContent = 'Start free trial';
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // Already signed in: there is nothing to sign up for.
  if (readToken()) {
    const response = await fetch('/api/auth/verify', { headers: { 'x-auth-token': readToken() } }).catch(() => null);
    if (response && response.ok) {
      window.location.href = '/admin/';
      return;
    }
  }

  setupPasswordToggles();
  const config = await applyBrand();

  if (!config.signupEnabled) {
    document.getElementById('signup-form').hidden = true;
    document.getElementById('signup-closed').hidden = false;
    return;
  }

  setupForm();
  document.getElementById('signup-company').focus();
});
