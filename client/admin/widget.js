/**
 * Website widget: the snippet, where it may run, and how it looks.
 *
 * The preview beside the form is the real widget in preview mode
 * (public/widget/preview.html): it opens no conversation and counts nothing,
 * and it redraws as the admin types instead of after a save and a trip to
 * their own website.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, debounce, escapeHtml, logger, showToast } from './utils.js';

let config = null;
let previewReady = false;

const $ = id => document.getElementById(id);

/** Quote a value for an HTML attribute in the snippet the admin copies. */
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function snippet() {
  if (!config) {
    return '';
  }
  const origin = window.location.origin;
  const settings = config.widgetSettings || {};
  return [
    '<script',
    `  src="${origin}/widget/js/widget-loader.js"`,
    `  data-widget-key="${attr(config.widgetKey)}"`,
    `  data-server-url="${origin}"`,
    `  data-chatbot-name="${attr(settings.chatbotName || 'Assistant')}"`,
    `  data-primary-color="${attr(settings.primaryColor || '#2196f3')}"`,
    `  data-position="${attr(settings.position || 'right')}"`,
    '  defer><' + '/script>'
  ].join('\n');
}

function renderDomains() {
  const list = $('domain-list');
  const domains = config.allowedDomains || [];

  if (domains.length === 0) {
    list.innerHTML = `
      <li class="list-group-item text-muted">
        No domains yet. Until you add one, the widget only works on this server's own address.
      </li>`;
    return;
  }

  list.innerHTML = domains.map(domain => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <span class="font-monospace">${escapeHtml(domain)}</span>
      <button class="btn btn-sm btn-outline-danger remove-domain-btn" data-domain="${escapeHtml(domain)}">Remove</button>
    </li>`).join('');
}

// --------------------------------------------------------------- the form

function formValues() {
  return {
    chatbotName: $('widget-name').value.trim(),
    primaryColor: $('widget-color').value,
    position: $('widget-position').value,
    welcomeMessage: $('widget-welcome').value.trim(),
    requireName: $('widget-require-name').checked,
    requireEmail: $('widget-require-email').checked,
    requirePhone: $('widget-require-phone').checked,
    privacyPolicyUrl: $('widget-privacy-url').value.trim() || null,
    language: $('widget-language').value,
    logoUrl: $('widget-logo-url').value.trim() || null
  };
}

function fillForm(settings) {
  $('widget-name').value = settings.chatbotName || '';
  $('widget-color').value = settings.primaryColor || '#2196f3';
  $('widget-position').value = settings.position || 'right';
  $('widget-welcome').value = settings.welcomeMessage || '';
  // Name and email default to required, phone to optional, matching what the
  // widget does when the setting is absent.
  $('widget-require-name').checked = settings.requireName !== false;
  $('widget-require-email').checked = settings.requireEmail !== false;
  $('widget-require-phone').checked = settings.requirePhone === true;
  $('widget-privacy-url').value = settings.privacyPolicyUrl || '';
  $('widget-language').value = settings.language || 'auto';
  $('widget-logo-url').value = settings.logoUrl || '';
}

// ------------------------------------------------------------- the preview

function previewConfig(values = formValues()) {
  return {
    name: values.chatbotName || 'Assistant',
    color: values.primaryColor,
    position: values.position,
    welcome: values.welcomeMessage,
    language: values.language,
    logoUrl: values.logoUrl || '',
    requireName: values.requireName,
    requireEmail: values.requireEmail,
    requirePhone: values.requirePhone,
    privacyUrl: values.privacyPolicyUrl || ''
  };
}

function loadPreview() {
  const frame = $('widget-preview-frame');
  const params = new URLSearchParams();
  Object.entries(previewConfig()).forEach(([key, value]) => params.set(key, String(value)));
  previewReady = false;
  frame.addEventListener('load', () => {
    previewReady = true;
  }, { once: true });
  frame.src = `/widget/preview.html?${params.toString()}`;
}

/** Redraw the preview in place; the widget accepts this from our origin only. */
const updatePreview = debounce(() => {
  const frame = $('widget-preview-frame');
  if (!previewReady || !frame.contentWindow) {
    loadPreview();
    return;
  }
  frame.contentWindow.postMessage({ type: 'widget-preview', config: previewConfig() }, window.location.origin);
}, 200);

// ------------------------------------------------------------------ saving

function render() {
  $('embed-snippet').textContent = snippet();
  $('widget-key').value = config.widgetKey || '';
  fillForm(config.widgetSettings || {});
  renderDomains();
}

async function load() {
  try {
    config = await api('/api/companies/me/widget');
    render();
    loadPreview();
  } catch (error) {
    logger.error('Failed to load widget configuration:', error);
    $('embed-snippet').textContent = `Could not load the widget settings: ${error.message}`;
  }
}

async function save(patch, successMessage) {
  try {
    const result = await api('/api/companies/me/widget', { method: 'PUT', body: patch });
    config.allowedDomains = result.allowedDomains;
    config.widgetSettings = result.widgetSettings;
    render();
    showToast(successMessage, 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function addDomain() {
  const input = $('new-domain-input');
  const value = input.value.trim();
  if (!value) {
    return;
  }
  input.value = '';
  save({ allowedDomains: [...(config.allowedDomains || []), value] }, 'Domain added');
}

function copySnippet() {
  navigator.clipboard.writeText(snippet())
    .then(() => showToast('Snippet copied', 'success'))
    .catch(() => showToast('Could not copy - select the snippet and copy it yourself', 'warning'));
}

async function rotateKey() {
  const ok = await confirmDialog({
    title: 'Rotate the widget key?',
    message: 'Every site still using the old snippet stops being recognised until you paste the new one.',
    confirmLabel: 'Rotate key',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    const result = await api('/api/companies/me/widget/rotate-key', { method: 'POST' });
    config.widgetKey = result.widgetKey;
    render();
    showToast('Widget key rotated - update the snippet on your site', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function setupWidget() {
  $('copy-snippet-btn').addEventListener('click', copySnippet);
  $('rotate-widget-key-btn').addEventListener('click', rotateKey);
  $('add-domain-btn').addEventListener('click', addDomain);
  $('new-domain-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDomain();
    }
  });
  $('domain-list').addEventListener('click', event => {
    const button = event.target.closest('.remove-domain-btn');
    if (button) {
      save({ allowedDomains: (config.allowedDomains || []).filter(d => d !== button.dataset.domain) }, 'Domain removed');
    }
  });

  const form = $('widget-settings-form');
  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = formValues();

    if (values.privacyPolicyUrl && !/^https?:\/\//i.test(values.privacyPolicyUrl)) {
      showToast('The privacy policy link must start with http:// or https://', 'warning');
      return;
    }
    if (values.logoUrl && !/^https:\/\//i.test(values.logoUrl)) {
      showToast('The logo must be an https:// address', 'warning');
      return;
    }

    save({ widgetSettings: values }, 'Appearance saved');
  });
}

registerSection('widget', {
  setup: setupWidget,
  show: load
});
