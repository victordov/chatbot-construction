/**
 * Accepting an invitation: the link in the email lands here, the person
 * chooses a password, and they are in.
 *
 * The invitation is looked up first so the page can say who invited them and
 * to which team - an email from an unfamiliar product asking for a password
 * is otherwise indistinguishable from phishing.
 */

import {
  applyBrand, clearToken, messageFor, postJson, readResponse, setupPasswordToggles, showMessage, storeSession
} from './auth-common.js';

const ROLE_WORDS = { operator: 'an operator', company_admin: 'an admin' };

function showInvalid(text) {
  document.getElementById('invite-heading').textContent = 'This link does not work';
  if (text) {
    document.getElementById('invite-invalid-text').textContent = text;
  }
  document.getElementById('invite-invalid').hidden = false;
}

async function start() {
  const token = new URLSearchParams(window.location.search).get('token');

  if (!token) {
    showInvalid('This page needs the link from your invitation email.');
    return;
  }

  let invitation;
  try {
    const response = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`);
    const { ok, status, body } = await readResponse(response);
    if (!ok) {
      showInvalid(messageFor(status, body, null));
      return;
    }
    invitation = body;
  } catch (error) {
    showMessage(document.getElementById('invite-message'), 'Could not reach the server. Try again.', 'text-danger');
    return;
  }

  const minLength = invitation.minLength || 8;
  const who = invitation.invitedBy ? `${invitation.invitedBy} invited you` : 'You have been invited';
  document.getElementById('invite-heading').textContent =
    `${who} to join ${invitation.companyName} as ${ROLE_WORDS[invitation.role] || 'a teammate'}.`;
  document.getElementById('invite-email').value = invitation.email;
  document.getElementById('invite-name').value = invitation.displayName || '';
  document.getElementById('invite-length-hint').textContent = `At least ${minLength} characters.`;
  document.getElementById('invite-password').minLength = minLength;

  const form = document.getElementById('invite-form');
  const message = document.getElementById('invite-message');
  form.hidden = false;
  document.getElementById(invitation.displayName ? 'invite-password' : 'invite-name').focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const password = document.getElementById('invite-password').value;
    if (password.length < minLength) {
      showMessage(message, `Use at least ${minLength} characters.`, 'text-danger');
      return;
    }

    const button = document.getElementById('invite-submit');
    button.disabled = true;

    try {
      const response = await postJson('/api/auth/accept-invite', {
        token,
        password,
        displayName: document.getElementById('invite-name').value.trim() || undefined
      });
      const { ok, status, body } = await readResponse(response);

      if (ok && body.token) {
        // Whoever was signed in on this browser before is not who this is.
        clearToken();
        storeSession(body.token, body.user);
        window.location.href = '/admin/?section=home&welcome=1';
        return;
      }

      showMessage(message, messageFor(status, body, 'Could not accept the invitation. Try again.'), 'text-danger');
    } catch (error) {
      showMessage(message, 'Could not reach the server. Try again.', 'text-danger');
    } finally {
      button.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupPasswordToggles();
  await applyBrand();
  start();
});
