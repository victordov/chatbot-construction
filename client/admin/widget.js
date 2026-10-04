/**
 * Install Widget section.
 *
 * Completes the multi-tenant story from the operator's side: without a widget
 * key in the embed snippet, incoming chats cannot be attributed to a company
 * and the dashboard stays empty.
 */

import feather from 'feather-icons';
import { state } from './state.js';
import { api, escapeHtml, logger, setLoading, showToast } from './utils.js';

let config = null;


function snippet() {
  if (!config) {
    return '';
  }
  const origin = window.location.origin;
  const settings = config.widgetSettings || {};
  return [
    '<script',
    `  src="${origin}/widget/js/widget-loader.js"`,
    `  data-widget-key="${config.widgetKey}"`,
    `  data-server-url="${origin}"`,
    `  data-chatbot-name="${settings.chatbotName || 'Assistant'}"`,
    `  data-primary-color="${settings.primaryColor || '#2196f3'}"`,
    `  data-position="${settings.position || 'right'}"`,
    '  defer><' + '/script>'
  ].join('\n');
}

function renderDomains() {
  const list = document.getElementById('domain-list');
  const domains = config.allowedDomains || [];

  if (domains.length === 0) {
    list.innerHTML = `
      <li class="list-group-item text-muted">
        No domains added yet. Until you add one, the widget will only work on this server's own origin.
      </li>`;
    return;
  }

  list.innerHTML = domains.map(domain => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <span class="font-monospace">${escapeHtml(domain)}</span>
      <button class="btn btn-sm btn-outline-danger remove-domain-btn" data-domain="${escapeHtml(domain)}">
        Remove
      </button>
    </li>`).join('');

  list.querySelectorAll('.remove-domain-btn').forEach(btn => {
    btn.addEventListener('click', () => removeDomain(btn.dataset.domain));
  });
}

function render() {
  if (!config) {
    return;
  }

  document.getElementById('embed-snippet').textContent = snippet();
  document.getElementById('widget-key').value = config.widgetKey || '';

  const settings = config.widgetSettings || {};
  document.getElementById('widget-name').value = settings.chatbotName || '';
  document.getElementById('widget-color').value = settings.primaryColor || '#2196f3';
  document.getElementById('widget-position').value = settings.position || 'right';
  document.getElementById('widget-welcome').value = settings.welcomeMessage || '';

  // Pre-chat form. Name and email default to required, phone to optional,
  // matching what the widget does when the setting is absent.
  document.getElementById('widget-require-name').checked = settings.requireName !== false;
  document.getElementById('widget-require-email').checked = settings.requireEmail !== false;
  document.getElementById('widget-require-phone').checked = settings.requirePhone === true;
  document.getElementById('widget-privacy-url').value = settings.privacyPolicyUrl || '';

  renderDomains();

  if (typeof feather !== 'undefined') {
    feather.replace();
  }
}

async function load() {
  try {
    config = await api('/api/companies/me/widget');
    render();
  } catch (error) {
    logger.error('Failed to load widget configuration:', error);
    document.getElementById('embed-snippet').textContent =
      `Could not load widget configuration: ${error.message}`;
  }
}

async function save(patch, successMessage) {
  try {
    const result = await api('/api/companies/me/widget', { method: 'PUT', body: JSON.stringify(patch) });
    config.allowedDomains = result.allowedDomains;
    config.widgetSettings = result.widgetSettings;
    render();
    showToast(successMessage, 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function addDomain() {
  const input = document.getElementById('new-domain-input');
  const value = input.value.trim();
  if (!value) {
    return;
  }

  const domains = [...(config.allowedDomains || []), value];
  input.value = '';
  save({ allowedDomains: domains }, 'Domain added');
}

function removeDomain(domain) {
  const domains = (config.allowedDomains || []).filter(d => d !== domain);
  save({ allowedDomains: domains }, 'Domain removed');
}

function copySnippet() {
  navigator.clipboard.writeText(snippet())
    .then(() => showToast('Snippet copied to clipboard', 'success'))
    .catch(() => showToast('Could not copy - select the snippet and copy manually', 'warning'));
}

async function rotateKey() {
  if (!confirm('Rotate the widget key? Any site still using the old snippet will stop being recognised until you update it.')) {
    return;
  }

  try {
    const result = await api('/api/companies/me/widget/rotate-key', { method: 'POST' });
    config.widgetKey = result.widgetKey;
    render();
    showToast('Widget key rotated - update your embed snippet', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

// -------------------------------------------------------------- email channel

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

// ------------------------------------------------------------ business hours

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Minutes past midnight -> "09:00", for a time input. */
const toTimeValue = minutes => {
  const value = Number.isFinite(minutes) ? minutes : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

const fromTimeValue = value => {
  const [hours, minutes] = String(value || '0:00').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

function renderHoursTable(days) {
  // Monday first: a business week does not start on Sunday, whatever the
  // date API thinks.
  const order = [1, 2, 3, 4, 5, 6, 0];

  document.getElementById('hours-table').innerHTML = order.map(day => {
    const rule = days.find(entry => entry.day === day) ||
      { day, closed: day === 0 || day === 6, opensAt: 540, closesAt: 1020 };

    return `
      <tr data-day="${day}">
        <td>${escapeHtml(DAY_NAMES[day])}</td>
        <td>
          <input class="form-check-input" type="checkbox" data-day-open
                 ${rule.closed ? '' : 'checked'}>
        </td>
        <td><input type="time" class="form-control form-control-sm" data-day-from
                   value="${toTimeValue(rule.opensAt)}" ${rule.closed ? 'disabled' : ''}></td>
        <td><input type="time" class="form-control form-control-sm" data-day-to
                   value="${toTimeValue(rule.closesAt)}" ${rule.closed ? 'disabled' : ''}></td>
      </tr>`;
  }).join('');

  document.querySelectorAll('#hours-table [data-day-open]').forEach(checkbox => {
    checkbox.addEventListener('change', event => {
      const row = event.target.closest('tr');
      row.querySelector('[data-day-from]').disabled = !event.target.checked;
      row.querySelector('[data-day-to]').disabled = !event.target.checked;
    });
  });
}

function collectHours() {
  return [...document.querySelectorAll('#hours-table tr')].map(row => ({
    day: Number(row.dataset.day),
    closed: !row.querySelector('[data-day-open]').checked,
    opensAt: fromTimeValue(row.querySelector('[data-day-from]').value),
    closesAt: fromTimeValue(row.querySelector('[data-day-to]').value)
  }));
}

function renderCurrentStatus(current) {
  const element = document.getElementById('hours-current');
  if (!current) {
    element.textContent = '';
    return;
  }

  const parts = [];
  parts.push(current.open ? '<span class="text-success">Open</span>' : '<span class="text-danger">Closed</span>');
  parts.push(`${current.operatorsOnline} operator${current.operatorsOnline === 1 ? '' : 's'} online`);
  if (!current.open && current.opensAt) {
    parts.push(`opens ${escapeHtml(current.opensAt)}`);
  }
  element.innerHTML = parts.join(' · ');
}

function populateTimezones(selected) {
  const select = document.getElementById('hours-timezone');

  // Supported timezones come from the platform where available, so the list
  // is always valid for the runtime rather than a hardcoded subset.
  const zones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];

  const chosen = selected || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  select.innerHTML = zones.map(zone =>
    `<option value="${escapeHtml(zone)}" ${zone === chosen ? 'selected' : ''}>${escapeHtml(zone)}</option>`
  ).join('');
}

function syncHoursEnabled() {
  const enabled = document.getElementById('hours-enabled').checked;
  document.getElementById('hours-config').style.opacity = enabled ? '1' : '0.5';
  document.getElementById('hours-config').querySelectorAll('input, select, textarea')
    .forEach(field => {
      field.disabled = !enabled;
    });

  if (enabled) {
    // Re-apply the per-row closed state, which the blanket enable above lost.
    document.querySelectorAll('#hours-table tr').forEach(row => {
      const open = row.querySelector('[data-day-open]').checked;
      row.querySelector('[data-day-from]').disabled = !open;
      row.querySelector('[data-day-to]').disabled = !open;
    });
  }
}

async function loadHours() {
  try {
    const { businessHours, current } = await api('/api/companies/me/hours');

    document.getElementById('hours-enabled').checked = Boolean(businessHours.enabled);
    populateTimezones(businessHours.timezone);
    renderHoursTable(businessHours.days || []);
    document.getElementById('hours-offline-message').value = businessHours.offlineMessage || '';
    renderCurrentStatus(current);
    syncHoursEnabled();
  } catch (error) {
    logger.error('Failed to load business hours:', error);
  }
}

async function saveHours() {
  const button = document.getElementById('save-hours-btn');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/hours', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('hours-enabled').checked,
        timezone: document.getElementById('hours-timezone').value,
        days: collectHours(),
        offlineMessage: document.getElementById('hours-offline-message').value
      })
    });

    renderCurrentStatus(result.current);
    showToast('Business hours saved', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

export function setupWidgetSection() {
  // Operators have no company-level settings to manage.
  const user = state.currentUser;
  if (!user || (user.role !== 'superadmin' && user.role !== 'company_admin')) {
    return;
  }

  // A superadmin belongs to no tenant, so there is no widget of their own to
  // configure. Say so rather than erroring on a request that cannot succeed.
  if (!user.company) {
    const snippet = document.getElementById('embed-snippet');
    if (snippet) {
      snippet.textContent =
        'Widget installation is configured per company. Open a company from the ' +
        'Companies section to manage its widget.';
    }
    return;
  }

  document.getElementById('copy-snippet-btn')?.addEventListener('click', copySnippet);
  document.getElementById('rotate-widget-key-btn')?.addEventListener('click', rotateKey);
  document.getElementById('add-domain-btn')?.addEventListener('click', addDomain);

  document.getElementById('new-domain-input')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDomain();
    }
  });

  document.getElementById('widget-settings-form')?.addEventListener('submit', e => {
    e.preventDefault();

    const privacyPolicyUrl = document.getElementById('widget-privacy-url').value.trim();
    if (privacyPolicyUrl && !/^https?:\/\//i.test(privacyPolicyUrl)) {
      showToast('The privacy policy link must start with http:// or https://', 'warning');
      return;
    }

    save({
      widgetSettings: {
        chatbotName: document.getElementById('widget-name').value.trim(),
        primaryColor: document.getElementById('widget-color').value,
        position: document.getElementById('widget-position').value,
        welcomeMessage: document.getElementById('widget-welcome').value.trim(),
        requireName: document.getElementById('widget-require-name').checked,
        requireEmail: document.getElementById('widget-require-email').checked,
        requirePhone: document.getElementById('widget-require-phone').checked,
        privacyPolicyUrl: privacyPolicyUrl || null
      }
    }, 'Appearance saved');
  });

  document.getElementById('hours-enabled')?.addEventListener('change', syncHoursEnabled);
  document.getElementById('save-hours-btn')?.addEventListener('click', saveHours);

  document.getElementById('save-email-btn')?.addEventListener('click', saveEmailSettings);
  document.getElementById('copy-inbound-url-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('email-inbound-url').textContent)
      .then(() => showToast('Inbound URL copied — it contains a secret', 'success'))
      .catch(() => showToast('Could not copy', 'warning'));
  });

  load();
  loadHours();
  loadEmailSettings();
}
