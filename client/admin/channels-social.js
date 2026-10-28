/**
 * WhatsApp, Messenger and Instagram: the two settings screens that connect
 * them, and what the inbox shows about a conversation that came from one -
 * which app it is on, and what may be sent in it now.
 *
 * Each app only allows a free reply within 24 hours of the customer's last
 * message (services/channels). The composer says so before an operator types
 * a reply that cannot be sent, rather than after.
 */

import { registerSection } from './nav.js';
import { state } from './state.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, setLoading, showToast
} from './utils.js';

const APPS = {
  email: { label: 'Email', icon: '✉' },
  whatsapp: { label: 'WhatsApp', icon: 'WA' },
  messenger: { label: 'Messenger', icon: 'M' },
  instagram: { label: 'Instagram', icon: 'IG' }
};

/** Whether a conversation's customer is on a messaging app. */
export function isAppChannel(channel) {
  return channel === 'whatsapp' || channel === 'messenger' || channel === 'instagram';
}

/** The badge a queue row shows for a conversation that is not a web chat. */
export function channelBadge(channel) {
  const app = APPS[channel];
  if (!app) {
    return '';
  }
  return `<span class="channel-badge channel-badge-${escapeHtml(channel)}" title="${escapeHtml(app.label)}">${escapeHtml(app.icon)}</span>`;
}

// ------------------------------------------------------------------ inbox

let windowSequence = 0;
let windowTimer = null;

/** "14:32" today, "Tue 14:32" otherwise. */
function untilLabel(value) {
  const date = new Date(value);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** The line above the composer, created the first time it is needed. */
function windowLine() {
  const composer = document.getElementById('operator-input');
  if (!composer) {
    return null;
  }
  let line = composer.querySelector('.channel-window');
  if (!line) {
    line = document.createElement('div');
    line.className = 'channel-window small';
    composer.prepend(line);
  }
  return line;
}

/** Whether the operator may type; a closed window means the send would fail. */
function setComposerOpen(open) {
  const input = document.getElementById('operator-message');
  const send = document.getElementById('send-operator-message');
  if (input) {
    input.disabled = !open;
  }
  if (send) {
    send.disabled = !open;
  }
}

/** The app's badge beside the conversation's title. */
function headerBadge(conversation) {
  const title = document.getElementById('selected-chat-title');
  if (!title) {
    return;
  }
  let badge = title.parentElement.querySelector('.conversation-channel');
  const app = conversation && isAppChannel(conversation.channel) ? APPS[conversation.channel] : null;
  if (!app) {
    badge?.remove();
    return;
  }
  if (!badge) {
    // Before the title, which takes the free space and pushes the actions
    // to the right.
    badge = document.createElement('span');
    title.before(badge);
  }
  badge.className = `conversation-channel channel-pill channel-pill-${conversation.channel}`;
  badge.textContent = app.label;
}

async function sendTemplate(sessionId, button) {
  setLoading(button, true);
  try {
    await api(`/api/channels/conversations/${encodeURIComponent(sessionId)}/template`, { method: 'POST' });
    showToast('Template sent. Once they answer, you can reply freely for 24 hours.', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not send the template'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

function renderWindow(sessionId, info) {
  const line = windowLine();
  if (!line) {
    return;
  }
  const label = escapeHtml(info.label || 'This app');

  if (info.mode === 'open') {
    line.className = 'channel-window small text-muted';
    line.innerHTML = `${label} · Can reply until ${escapeHtml(untilLabel(info.until))}`;
    setComposerOpen(true);
  } else if (info.mode === 'human_agent') {
    line.className = 'channel-window small text-warning-emphasis';
    line.innerHTML = `${label} · More than 24 hours since they wrote: a person may still reply until ${escapeHtml(untilLabel(info.until))}`;
    setComposerOpen(true);
  } else if (info.mode === 'template') {
    line.className = 'channel-window small channel-window-closed';
    line.innerHTML = `<strong>Template only.</strong> ${escapeHtml(info.reason || '')}`;
    if (info.template) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-outline-primary ms-2';
      button.textContent = `Send "${info.template}"`;
      button.addEventListener('click', () => sendTemplate(sessionId, button));
      line.appendChild(button);
    }
    setComposerOpen(false);
  } else {
    line.className = 'channel-window small channel-window-closed';
    line.innerHTML = `<strong>Cannot reply.</strong> ${escapeHtml(info.reason || '')}`;
    setComposerOpen(false);
  }

  // Read again when it changes, so the composer closes on time rather than
  // when the operator tries to send.
  if (info.until) {
    const wait = new Date(info.until).getTime() - Date.now() + 1000;
    if (wait > 0 && wait < 25 * 60 * 60 * 1000) {
      windowTimer = setTimeout(() => showConversationChannel(state.currentConversation), wait);
    }
  }
}

/**
 * Show which app the open conversation is on, and what may be sent in it.
 * Called with null when nothing is open.
 */
export async function showConversationChannel(conversation) {
  const sequence = ++windowSequence;
  clearTimeout(windowTimer);
  headerBadge(conversation);

  const line = document.querySelector('#operator-input .channel-window');
  if (!conversation || !isAppChannel(conversation.channel)) {
    line?.remove();
    setComposerOpen(true);
    return;
  }

  try {
    const info = await api(`/api/channels/conversations/${encodeURIComponent(conversation.sessionId)}/window`);
    if (sequence !== windowSequence) {
      return;
    }
    renderWindow(conversation.sessionId, info);
  } catch (error) {
    if (sequence === windowSequence) {
      const current = windowLine();
      if (current) {
        current.className = 'channel-window small text-muted';
        current.textContent = errorMessage(error, 'Could not check how long you can reply');
      }
      setComposerOpen(true);
    }
  }
}

/**
 * A message arrived in some conversation. When it is the customer writing in
 * the open one, their window has just reopened.
 */
export function noteChannelMessage(sessionId, message) {
  const conversation = state.currentConversation;
  if (conversation && conversation.sessionId === sessionId && isAppChannel(conversation.channel) &&
      message && message.sender === 'user') {
    showConversationChannel(conversation);
  }
}

// --------------------------------------------------------------- settings

let settings = null;

function show(id, visible) {
  document.getElementById(id).classList.toggle('d-none', !visible);
}

function copyFrom(elementId, done) {
  navigator.clipboard.writeText(document.getElementById(elementId).textContent)
    .then(() => showToast(done, 'success'))
    .catch(() => showToast('Could not copy', 'warning'));
}

const STATUS_TEXT = {
  pending: 'Saved. Waiting for Meta to verify the webhook or for the first message.',
  connected: 'Connected.',
  error: 'Something is wrong.',
  disabled: 'Switched off: messages are not being received.'
};

/** One account's status, as a sentence. */
function statusLine(name, account) {
  if (!account) {
    return `${name}: not connected.`;
  }
  const parts = [`${name}: ${STATUS_TEXT[account.status] || ''}`];
  if (account.webhookVerifiedAt) {
    parts.push(`Webhook verified ${formatRelativeTime(account.webhookVerifiedAt)}.`);
  }
  parts.push(account.lastInboundAt
    ? `Last message ${formatRelativeTime(account.lastInboundAt)}.`
    : 'No message received yet.');
  if (account.lastError) {
    parts.push(`Last problem (${formatRelativeTime(account.lastError.at)}): ${account.lastError.message}`);
  }
  return parts.join(' ');
}

function renderBadge(id, account) {
  const badge = document.getElementById(id);
  const status = account ? account.status : 'none';
  badge.className = `channel-status-badge badge ${{
    connected: 'bg-success',
    pending: 'bg-secondary',
    error: 'bg-danger',
    disabled: 'bg-light text-dark'
  }[status] || 'bg-light text-dark'}`;
  badge.textContent = { connected: 'Connected', pending: 'Waiting', error: 'Problem', disabled: 'Off' }[status] || 'Not connected';
}

/** A secret field: empty, saying whether one is stored. */
function secretField(id, stored) {
  const input = document.getElementById(id);
  input.value = '';
  input.placeholder = stored ? 'Saved. Leave empty to keep it.' : '';
}

function showLoadError(prefix, message) {
  const box = document.getElementById(`${prefix}-load-error`);
  box.textContent = message || '';
  box.classList.toggle('d-none', !message);
  document.getElementById(`save-${prefix}-btn`).disabled = Boolean(message);
}

function applyPlan(prefix, allowed) {
  show(`${prefix}-plan-lock`, !allowed);
  document.getElementById(`save-${prefix}-btn`).disabled = !allowed;
}

function renderWhatsapp() {
  const account = settings.whatsapp;
  applyPlan('whatsapp', settings.allowed);
  renderBadge('whatsapp-status-badge', account);
  document.getElementById('whatsapp-status').textContent = statusLine('WhatsApp', account);

  document.getElementById('whatsapp-enabled').checked = account ? account.enabled : true;
  document.getElementById('whatsapp-phone-number-id').value = account ? account.phoneNumberId : '';
  document.getElementById('whatsapp-waba-id').value = account ? account.wabaId : '';
  document.getElementById('whatsapp-display-phone').value = account ? account.displayPhoneNumber : '';
  secretField('whatsapp-access-token', account && account.hasAccessToken);
  secretField('whatsapp-app-secret', account && account.hasAppSecret);

  const template = account ? account.template : { name: '', language: 'en_US', param: 'positional', paramName: '' };
  document.getElementById('whatsapp-template-name').value = template.name;
  document.getElementById('whatsapp-template-language').value = template.language;
  document.getElementById('whatsapp-template-param').value = template.param;
  document.getElementById('whatsapp-template-param-name').value = template.paramName;
  syncParamName();

  show('whatsapp-webhook-block', Boolean(account));
  show('whatsapp-test-block', Boolean(account) && settings.allowed);
  show('disconnect-whatsapp-btn', Boolean(account));
  document.getElementById('whatsapp-webhook-url').textContent = settings.webhookUrls.whatsapp;
  document.getElementById('whatsapp-verify-token').textContent = account ? account.verifyToken : '';
}

function renderMessenger() {
  const page = settings.messenger;
  const instagram = settings.instagram;
  const account = page || instagram;
  applyPlan('messenger', settings.allowed);
  renderBadge('messenger-status-badge', account);
  document.getElementById('messenger-status').textContent = statusLine('Messenger', page);
  document.getElementById('instagram-status').textContent = statusLine('Instagram', instagram);

  document.getElementById('messenger-enabled').checked = account ? account.enabled : true;
  document.getElementById('messenger-page-id').value = account ? account.pageId : '';
  document.getElementById('messenger-ig-user-id').value = instagram ? instagram.igUserId : '';
  document.getElementById('messenger-human-agent').checked = Boolean(account && account.humanAgentTag);
  secretField('messenger-access-token', account && account.hasAccessToken);
  secretField('messenger-app-secret', account && account.hasAppSecret);

  show('messenger-webhook-block', Boolean(account));
  show('disconnect-messenger-btn', Boolean(account));
  document.getElementById('messenger-webhook-url').textContent = settings.webhookUrls.messenger;
  document.getElementById('instagram-webhook-url').textContent = settings.webhookUrls.instagram;
  document.getElementById('messenger-verify-token').textContent = account ? account.verifyToken : '';
}

function render() {
  renderWhatsapp();
  renderMessenger();
}

async function loadSettings(prefix) {
  try {
    settings = await api('/api/channels/settings');
    showLoadError(prefix, null);
    render();
  } catch (error) {
    showLoadError(prefix, `The settings could not be loaded: ${errorMessage(error, 'try again')}. Reload the page to try again.`);
  }
}

function syncParamName() {
  const named = document.getElementById('whatsapp-template-param').value === 'named';
  document.getElementById('whatsapp-template-param-name').disabled = !named;
}

async function save(prefix, path, body) {
  const button = document.getElementById(`save-${prefix}-btn`);
  setLoading(button, true);
  try {
    settings = await api(path, { method: 'PUT', body: JSON.stringify(body) });
    render();
    showToast('Saved. Paste the webhook URL and verify token into your Meta app if you have not yet.', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not save'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

function saveWhatsapp() {
  return save('whatsapp', '/api/channels/whatsapp', {
    enabled: document.getElementById('whatsapp-enabled').checked,
    phoneNumberId: document.getElementById('whatsapp-phone-number-id').value.trim(),
    wabaId: document.getElementById('whatsapp-waba-id').value.trim(),
    displayPhoneNumber: document.getElementById('whatsapp-display-phone').value.trim(),
    accessToken: document.getElementById('whatsapp-access-token').value.trim(),
    appSecret: document.getElementById('whatsapp-app-secret').value.trim(),
    template: {
      name: document.getElementById('whatsapp-template-name').value.trim(),
      language: document.getElementById('whatsapp-template-language').value.trim(),
      param: document.getElementById('whatsapp-template-param').value,
      paramName: document.getElementById('whatsapp-template-param-name').value.trim()
    }
  });
}

function saveMessenger() {
  return save('messenger', '/api/channels/messenger', {
    enabled: document.getElementById('messenger-enabled').checked,
    pageId: document.getElementById('messenger-page-id').value.trim(),
    igUserId: document.getElementById('messenger-ig-user-id').value.trim(),
    accessToken: document.getElementById('messenger-access-token').value.trim(),
    appSecret: document.getElementById('messenger-app-secret').value.trim(),
    humanAgentTag: document.getElementById('messenger-human-agent').checked
  });
}

async function rotateVerifyToken(provider) {
  const ok = await confirmDialog({
    title: 'Make a new verify token?',
    message: 'The old one stops working. Paste the new one into your Meta app before Meta next checks the webhook.',
    confirmLabel: 'Make a new token'
  });
  if (!ok) {
    return;
  }
  try {
    settings = await api(`/api/channels/${provider}/verify-token`, { method: 'POST' });
    render();
    showToast('New verify token made', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not make a new token'), 'danger');
  }
}

async function disconnect(provider, label) {
  const ok = await confirmDialog({
    title: `Disconnect ${label}?`,
    message: 'Messages will stop arriving and the saved token and app secret are deleted. Past conversations stay in the inbox, but cannot be answered.',
    confirmLabel: 'Disconnect',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    settings = await api(`/api/channels/${provider}`, { method: 'DELETE' });
    render();
    showToast(`${label} disconnected`, 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not disconnect'), 'danger');
  }
}

async function sendWhatsappTest() {
  const button = document.getElementById('send-whatsapp-test-btn');
  const to = document.getElementById('whatsapp-test-number').value.trim();
  if (!to) {
    showToast('Enter your phone number, with the country code', 'warning');
    return;
  }
  setLoading(button, true);
  try {
    const result = await api('/api/channels/whatsapp/test', { method: 'POST', body: JSON.stringify({ to }) });
    showToast(`Test message sent to ${result.to}`, 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not send the test message'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

registerSection('whatsapp', {
  setup() {
    document.getElementById('save-whatsapp-btn').addEventListener('click', saveWhatsapp);
    document.getElementById('send-whatsapp-test-btn').addEventListener('click', sendWhatsappTest);
    document.getElementById('disconnect-whatsapp-btn').addEventListener('click', () => disconnect('whatsapp', 'WhatsApp'));
    document.getElementById('rotate-whatsapp-verify-token-btn').addEventListener('click', () => rotateVerifyToken('whatsapp'));
    document.getElementById('whatsapp-template-param').addEventListener('change', syncParamName);
    document.getElementById('copy-whatsapp-webhook-btn').addEventListener('click', () =>
      copyFrom('whatsapp-webhook-url', 'Callback URL copied'));
    document.getElementById('copy-whatsapp-verify-token-btn').addEventListener('click', () =>
      copyFrom('whatsapp-verify-token', 'Verify token copied'));
  },
  show: () => loadSettings('whatsapp')
});

registerSection('messenger', {
  setup() {
    document.getElementById('save-messenger-btn').addEventListener('click', saveMessenger);
    document.getElementById('disconnect-messenger-btn').addEventListener('click', () => disconnect('messenger', 'Messenger and Instagram'));
    document.getElementById('rotate-messenger-verify-token-btn').addEventListener('click', () => rotateVerifyToken('messenger'));
    document.getElementById('copy-messenger-webhook-btn').addEventListener('click', () =>
      copyFrom('messenger-webhook-url', 'Callback URL copied'));
    document.getElementById('copy-instagram-webhook-btn').addEventListener('click', () =>
      copyFrom('instagram-webhook-url', 'Callback URL copied'));
    document.getElementById('copy-messenger-verify-token-btn').addEventListener('click', () =>
      copyFrom('messenger-verify-token', 'Verify token copied'));
  },
  show: () => loadSettings('messenger')
});
