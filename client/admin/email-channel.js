/**
 * Email as a second channel: messages to the support address land in the same
 * queue as chat and are answered from the same composer.
 */

import { registerSection } from './nav.js';
import { api, logger, setLoading, showToast } from './utils.js';

async function loadEmailSettings() {
  try {
    const settings = await api('/api/companies/me/email');

    document.getElementById('email-enabled').checked = settings.enabled;
    document.getElementById('email-inbound-address').value = settings.inboundAddress;
    document.getElementById('email-from-name').value = settings.fromName;
    document.getElementById('email-from-address').value = settings.fromAddress;
    document.getElementById('email-signature').value = settings.signature;

    renderInboundUrl(settings.inboundUrl);

    // Inbound works without SMTP; replies do not. Say so rather than letting
    // an operator discover it when a reply silently fails.
    document.getElementById('email-smtp-warning')
      .classList.toggle('d-none', settings.smtpConfigured || !settings.enabled);
  } catch (error) {
    logger.error('Failed to load email settings:', error);
  }
}

function renderInboundUrl(url) {
  const block = document.getElementById('email-inbound-url-block');
  block.classList.toggle('d-none', !url);
  if (url) {
    document.getElementById('email-inbound-url').textContent = url;
  }
}

async function saveEmailSettings() {
  const button = document.getElementById('save-email-btn');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/email', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('email-enabled').checked,
        inboundAddress: document.getElementById('email-inbound-address').value.trim(),
        fromName: document.getElementById('email-from-name').value.trim(),
        fromAddress: document.getElementById('email-from-address').value.trim(),
        signature: document.getElementById('email-signature').value.trim()
      })
    });

    renderInboundUrl(result.inboundUrl);
    showToast('Email settings saved', 'success');
    loadEmailSettings();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

registerSection('email', {
  setup() {
    document.getElementById('save-email-btn').addEventListener('click', saveEmailSettings);
    document.getElementById('copy-inbound-url-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(document.getElementById('email-inbound-url').textContent)
        .then(() => showToast('Inbound URL copied — it contains a secret', 'success'))
        .catch(() => showToast('Could not copy', 'warning'));
    });
  },
  show: loadEmailSettings
});
