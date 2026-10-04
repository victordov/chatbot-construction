/**
 * Identity verification: the tenant signs a signed-in visitor's id on their
 * own server, and only a visitor vouched for that way counts as verified.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, errorMessage, logger, showToast } from './utils.js';

let identityExamples = {};

function renderIdentitySnippet() {
  const origin = window.location.origin;
  document.getElementById('identity-snippet').textContent = [
    '<script',
    `  src="${origin}/widget/js/widget-loader.js"`,
    '  data-widget-key="YOUR_WIDGET_KEY"',
    '  data-user-id="<%= user.id %>"',
    '  data-user-hash="<%= userHash %>"',
    '  defer><' + '/script>'
  ].join('\n');
}

async function loadIdentitySecret() {
  try {
    const { secret, examples } = await api('/api/contacts/identity/secret');
    identityExamples = examples;

    document.getElementById('identity-secret').value = secret;
    document.getElementById('identity-example').textContent = examples.node;
    renderIdentitySnippet();
  } catch (error) {
    logger.error('Could not load identity secret:', error);
    showToast(errorMessage(error, 'Could not load the identity secret'), 'danger');
  }
}

async function rotateSecret() {
  const ok = await confirmDialog({
    title: 'Rotate the identity secret?',
    message: 'Every hash your application has already generated stops working, so signed-in visitors become anonymous until you deploy the new secret.',
    confirmLabel: 'Rotate secret',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    const { secret } = await api('/api/contacts/identity/secret/rotate', { method: 'POST' });
    document.getElementById('identity-secret').value = secret;
    showToast('Secret rotated — update your server', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function setupIdentitySection() {
  document.getElementById('reveal-secret-btn').addEventListener('click', event => {
    const field = document.getElementById('identity-secret');
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    event.target.textContent = hidden ? 'Hide' : 'Show';
  });

  document.getElementById('copy-secret-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('identity-secret').value)
      .then(() => showToast('Secret copied — keep it server-side', 'success'))
      .catch(() => showToast('Could not copy', 'warning'));
  });

  document.getElementById('rotate-secret-btn').addEventListener('click', rotateSecret);

  document.querySelectorAll('#identity-lang-tabs [data-lang]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('#identity-lang-tabs [data-lang]')
        .forEach(other => other.classList.remove('active'));
      button.classList.add('active');
      document.getElementById('identity-example').textContent =
        identityExamples[button.dataset.lang] || '';
    });
  });

  loadIdentitySecret();
}

registerSection('identity', { setup: setupIdentitySection });
