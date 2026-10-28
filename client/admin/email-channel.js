/**
 * Email as a second channel: messages to the support address land in the same
 * queue as chat and are answered from the same composer.
 */

import { registerSection } from './nav.js';
import { api, errorMessage, formatRelativeTime, setLoading, showToast } from './utils.js';

/**
 * Say so when the settings could not be read.
 *
 * This used to log the failure to the console and leave the form blank, which
 * looks exactly like "email is not set up" - and saving that blank form would
 * then switch the channel off.
 */
function showLoadError(message) {
  const box = document.getElementById('email-load-error');
  box.textContent = message || '';
  box.classList.toggle('d-none', !message);
  document.getElementById('save-email-btn').disabled = Boolean(message);
}

async function loadEmailSettings() {
  try {
    const settings = await api('/api/companies/me/email');
    showLoadError(null);

    document.getElementById('email-enabled').checked = settings.enabled;
    document.getElementById('email-inbound-address').value = settings.inboundAddress;
    document.getElementById('email-from-name').value = settings.fromName;
    document.getElementById('email-from-address').value = settings.fromAddress;
    document.getElementById('email-signature').value = settings.signature;

    renderInbound(settings);
    renderSender(settings.sender);

    // Inbound works without SMTP; replies do not. Say so rather than letting
    // an operator discover it when a reply silently fails.
    document.getElementById('email-smtp-warning')
      .classList.toggle('d-none', settings.smtpConfigured);
  } catch (error) {
    showLoadError(`The email settings could not be loaded: ${errorMessage(error)}. Reload the page to try again.`);
  }
}

/** The address to post to, the header that carries the secret, and when mail last arrived. */
function renderInbound(settings) {
  const block = document.getElementById('email-inbound-url-block');
  block.classList.toggle('d-none', !settings.inboundUrl);

  if (!settings.inboundUrl) {
    return;
  }

  document.getElementById('email-inbound-url-base').textContent = settings.inboundUrlBase || '';
  document.getElementById('email-inbound-header').textContent = settings.inboundSecret
    ? `X-Inbound-Secret: ${settings.inboundSecret}`
    : '';
  document.getElementById('email-inbound-url').textContent = settings.inboundUrl;

  document.getElementById('email-last-inbound').textContent = settings.lastInboundAt
    ? `Last email received ${formatRelativeTime(settings.lastInboundAt)}.`
    : 'No email has arrived yet. Once forwarding is set up, send yourself one to check.';
}

/** What a customer sees in their inbox when somebody replies. */
function renderSender(sender) {
  const preview = document.getElementById('email-sender-preview');

  if (!sender) {
    preview.textContent = 'Replies cannot be sent yet: this server has no sending address (EMAIL_FROM).';
    return;
  }

  preview.textContent = sender.replyTo
    ? `Customers see replies from ${sender.from}, and their answers go to ${sender.replyTo}.`
    : `Customers see replies from ${sender.from}. Add a support address so their answers come back to you.`;
}

async function saveEmailSettings() {
  const button = document.getElementById('save-email-btn');
  setLoading(button, true);

  try {
    await api('/api/companies/me/email', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('email-enabled').checked,
        inboundAddress: document.getElementById('email-inbound-address').value.trim(),
        fromName: document.getElementById('email-from-name').value.trim(),
        fromAddress: document.getElementById('email-from-address').value.trim(),
        signature: document.getElementById('email-signature').value.trim()
      })
    });

    showToast('Email settings saved', 'success');
    loadEmailSettings();
  } catch (error) {
    showToast(errorMessage(error), 'danger');
  } finally {
    setLoading(button, false);
  }
}

/** Send a test email to the signed-in admin, through the path replies take. */
async function sendTestEmail() {
  const button = document.getElementById('send-test-email-btn');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/email/test', { method: 'POST' });
    showToast(`Test email sent to ${result.to}. If it lands in spam, check the sending domain's SPF and DKIM.`, 'success');
  } catch (error) {
    showToast(errorMessage(error), 'danger');
  } finally {
    setLoading(button, false);
  }
}

/** Copy the text of an element, saying whether it worked. */
function copyFrom(elementId, done) {
  navigator.clipboard.writeText(document.getElementById(elementId).textContent)
    .then(() => showToast(done, 'success'))
    .catch(() => showToast('Could not copy', 'warning'));
}

registerSection('email', {
  setup() {
    document.getElementById('save-email-btn').addEventListener('click', saveEmailSettings);
    document.getElementById('send-test-email-btn').addEventListener('click', sendTestEmail);
    document.getElementById('copy-inbound-url-base-btn').addEventListener('click', () =>
      copyFrom('email-inbound-url-base', 'Address copied'));
    document.getElementById('copy-inbound-header-btn').addEventListener('click', () =>
      copyFrom('email-inbound-header', 'Header copied — it contains a secret'));
    document.getElementById('copy-inbound-url-btn').addEventListener('click', () =>
      copyFrom('email-inbound-url', 'Inbound URL copied — it contains a secret'));
  },
  show: loadEmailSettings
});
