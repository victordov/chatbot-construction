/**
 * Website widget: the snippet, whether it is installed, where it may run, and
 * how it looks and behaves.
 *
 * The preview beside the form is the real widget in preview mode
 * (public/widget/preview.html): it opens no conversation and counts nothing,
 * and it redraws as the admin types instead of after a save and a trip to
 * their own website.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, debounce, escapeHtml, formatRelativeTime, logger, showToast } from './utils.js';

let config = null;
let previewReady = false;
let previewDevice = 'desktop';

const $ = id => document.getElementById(id);

/** Quote a value for an HTML attribute in the snippet the admin copies. */
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The snippet: which company, and which server. Nothing else - the name,
 * colour and position used to be in it too, and because the loader lets an
 * attribute on the tag win, every later change made here never reached a
 * site that had pasted the old snippet.
 */
function snippet() {
  if (!config) {
    return '';
  }
  const origin = window.location.origin;
  return [
    '<script',
    `  src="${origin}/widget/js/widget-loader.js"`,
    `  data-widget-key="${attr(config.widgetKey)}"`,
    `  data-server-url="${origin}"`,
    '  defer><' + '/script>'
  ].join('\n');
}

/** `https://www.example.com` -> `www.example.com`, for sentences. */
function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return String(origin || '');
  }
}

// ------------------------------------------------------------ installation

/** "Seen on example.com, 4 min ago", or "Not seen yet". */
function renderInstallStatus() {
  const element = $('widget-install-status');
  const seen = config && config.widgetSeen;

  if (seen && seen.at) {
    element.className = 'widget-install-status is-seen';
    element.textContent = `Seen on ${hostOf(seen.origin)}, ${formatRelativeTime(seen.at)}`;
    const others = (seen.origins || []).filter(origin => origin !== seen.origin).map(hostOf);
    element.title = others.length ? `Also seen on ${others.join(', ')}` : '';
  } else {
    element.className = 'widget-install-status is-unseen';
    element.textContent = 'Not seen yet';
    element.title = 'Shows here once a page with the snippet, on one of your allowed domains, is opened in a browser.';
  }
}

function showInstallTab(name) {
  document.querySelectorAll('#widget-install-tabs [data-install-tab]').forEach(tab => {
    const selected = tab.dataset.installTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('#widget-section [data-install-pane]').forEach(pane => {
    pane.hidden = pane.dataset.installPane !== name;
  });
  // Shopify has a snippet of its own; the HTML one beside it would only be a
  // second thing to paste.
  $('embed-snippet').parentElement.hidden = name === 'shopify';
}

// The Shopify snippet as last fetched, and for which key.
let shopifySnippet = { key: null, text: '' };

/**
 * The plugin and snippet downloads, filled in with this company's key and
 * this server's address (routes/downloads.js), and the Shopify snippet shown
 * so it can be copied.
 */
async function renderInstallDownloads() {
  const key = config && config.widgetKey ? encodeURIComponent(config.widgetKey) : '';
  $('widget-wordpress-download').href = `/api/downloads/wordpress/support-desk-chat.zip${key ? `?key=${key}` : ''}`;
  $('widget-shopify-download').href = `/api/downloads/shopify/support-desk-chat.liquid?download=1${key ? `&key=${key}` : ''}`;

  if (shopifySnippet.key === key && shopifySnippet.text) {
    return;
  }
  try {
    const response = await fetch(`/api/downloads/shopify/support-desk-chat.liquid${key ? `?key=${key}` : ''}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    shopifySnippet = { key, text: await response.text() };
    $('widget-shopify-snippet').textContent = shopifySnippet.text;
  } catch (error) {
    logger.warn('Could not load the Shopify snippet', error);
    $('widget-shopify-snippet').textContent = 'Could not load the snippet. Use the download link above.';
  }
}

function copyShopifySnippet() {
  navigator.clipboard.writeText(shopifySnippet.text || $('widget-shopify-snippet').textContent)
    .then(() => showToast('Snippet copied', 'success'))
    .catch(() => showToast('Could not copy - select the snippet and copy it yourself', 'warning'));
}

/** Arrow keys move between tabs, as they do in any tab list. */
function onInstallTabKey(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }
  const tabs = [...document.querySelectorAll('#widget-install-tabs [data-install-tab]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) {
    return;
  }
  event.preventDefault();
  let next = index;
  if (event.key === 'ArrowLeft') {
    next = (index - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'ArrowRight') {
    next = (index + 1) % tabs.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else {
    next = tabs.length - 1;
  }
  showInstallTab(tabs[next].dataset.installTab);
  tabs[next].focus();
}

/** What "Check my site" found, said as advice rather than as flags. */
function checkResultHtml(data) {
  if (!data.ok) {
    return `<div class="alert alert-danger py-2 small mb-0">${escapeHtml(data.error || 'The check failed.')}</div>`;
  }

  const page = escapeHtml(data.url);
  const lines = [];
  let tone = 'success';

  if (data.installed) {
    lines.push(`The widget is on <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener noreferrer">${page}</a>.`);
  } else if (data.loaderFound && data.otherKeys && data.otherKeys.length) {
    tone = 'warning';
    lines.push(`${page} loads the widget with a different key (<code>${data.otherKeys.map(escapeHtml).join('</code>, <code>')}</code>). ` +
      'If you rotated your key, paste the snippet above again.');
  } else if (data.loaderFound) {
    tone = 'warning';
    lines.push(`${page} loads the widget, but not with your key. Paste the snippet above in place of what is there.`);
  } else if (data.tagManager) {
    tone = 'info';
    lines.push(`The snippet is not in the HTML of ${page}, but the page uses Google Tag Manager, which adds tags after the page loads. ` +
      'If you installed it there, open the page in a browser: the status above changes to "Seen on…" within a minute.');
  } else {
    tone = 'warning';
    lines.push(`The snippet is not on ${page}. Paste it just before <code>&lt;/body&gt;</code>, ` +
      'or check a page that uses your site\'s main template.');
  }

  if (data.domainAllowed === false) {
    tone = tone === 'success' ? 'warning' : tone;
    lines.push(`<strong>${escapeHtml(hostOf(data.url))}</strong> is not in your allowed domains, so the widget will not answer there. Add it under Allowed domains.`);
  }

  if (data.legacyAttributes && data.legacyAttributes.length) {
    tone = tone === 'success' ? 'warning' : tone;
    lines.push(`The snippet on that page still sets <code>${data.legacyAttributes.map(escapeHtml).join('</code>, <code>')}</code>, ` +
      'which override the settings on this page. Replace it with the snippet above.');
  }

  return `<div class="alert alert-${tone} py-2 small mb-0">${lines.map(line => `<div>${line}</div>`).join('')}</div>`;
}

async function checkSite() {
  const button = $('widget-check-btn');
  const result = $('widget-check-result');
  const url = $('widget-check-url').value.trim();

  button.disabled = true;
  result.innerHTML = '<span class="small text-muted">Checking…</span>';

  try {
    const data = await api('/api/companies/me/widget/check', { method: 'POST', body: { url } });
    if (data.widgetSeen) {
      config.widgetSeen = data.widgetSeen;
      renderInstallStatus();
    }
    if (data.url && !url) {
      $('widget-check-url').value = data.url;
    }
    result.innerHTML = checkResultHtml(data);
  } catch (error) {
    result.innerHTML = `<div class="alert alert-danger py-2 small mb-0">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ domains

function renderDomains() {
  const list = $('domain-list');
  const domains = config.allowedDomains || [];

  if (domains.length === 0) {
    list.innerHTML = `
      <li class="list-group-item text-muted">
        No domains yet. The widget does not answer on your website until you add its address here.
      </li>`;
    return;
  }

  list.innerHTML = domains.map(domain => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <span class="font-monospace">${escapeHtml(domain)}</span>
      <button type="button" class="btn btn-sm btn-outline-danger remove-domain-btn" data-domain="${escapeHtml(domain)}">Remove</button>
    </li>`).join('');
}

async function removeDomain(domain) {
  const ok = await confirmDialog({
    title: `Remove ${domain}?`,
    message: 'The widget stops answering on this site straight away. Visitors there see it go quiet mid-conversation.',
    confirmLabel: 'Remove domain',
    danger: true
  });
  if (!ok) {
    return;
  }
  save({ allowedDomains: (config.allowedDomains || []).filter(d => d !== domain) }, 'Domain removed');
}

// --------------------------------------------------------------- the form

function questionInputs() {
  return [...document.querySelectorAll('#widget-settings-form .widget-question-input')];
}

function formValues() {
  const enabled = $('widget-proactive-enabled').checked;
  const typed = parseInt($('widget-proactive-delay').value, 10);
  // A delay typed while the message is off is kept in range rather than
  // refused: the field is greyed out, so it could not be corrected.
  const delay = Number.isNaN(typed) ? 20 : (enabled ? typed : Math.min(120, Math.max(5, typed)));
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
    logoUrl: $('widget-logo-url').value.trim() || null,
    suggestedQuestions: questionInputs().map(input => input.value.trim()).filter(Boolean),
    consentRequired: $('widget-consent-required').checked,
    consentText: $('widget-consent-text').value.trim(),
    proactive: {
      enabled,
      text: $('widget-proactive-text').value.trim(),
      delaySeconds: delay,
      pathContains: $('widget-proactive-path').value.trim()
    }
  };
}

function fillForm(settings) {
  $('widget-name').value = settings.chatbotName || '';
  $('widget-color').value = settings.primaryColor || '#2196f3';
  $('widget-position').value = settings.position || 'right';
  $('widget-welcome').value = settings.welcomeMessage || '';
  // All three are off unless the tenant turned them on: a form in front of
  // the first answer costs more conversations than it is worth.
  $('widget-require-name').checked = settings.requireName === true;
  $('widget-require-email').checked = settings.requireEmail === true;
  $('widget-require-phone').checked = settings.requirePhone === true;
  $('widget-privacy-url').value = settings.privacyPolicyUrl || '';
  $('widget-language').value = settings.language || 'auto';
  $('widget-logo-url').value = settings.logoUrl || '';

  const questions = Array.isArray(settings.suggestedQuestions) ? settings.suggestedQuestions : [];
  questionInputs().forEach((input, index) => {
    input.value = questions[index] || '';
  });

  $('widget-consent-required').checked = settings.consentRequired === true;
  $('widget-consent-text').value = settings.consentText || '';

  const proactive = settings.proactive || {};
  $('widget-proactive-enabled').checked = proactive.enabled === true;
  $('widget-proactive-text').value = proactive.text || '';
  $('widget-proactive-delay').value = proactive.delaySeconds || 20;
  $('widget-proactive-path').value = proactive.pathContains || '';

  updateFormHints();
}

/**
 * Warnings that depend on what is typed: no privacy policy, consent asked
 * without a policy to read.
 */
function updateFormHints() {
  const noPolicy = !$('widget-privacy-url').value.trim();
  $('widget-privacy-warning').hidden = !noPolicy;
  $('widget-consent-text').disabled = !$('widget-consent-required').checked;
  const proactiveOn = $('widget-proactive-enabled').checked;
  ['widget-proactive-text', 'widget-proactive-delay', 'widget-proactive-path'].forEach(id => {
    $(id).disabled = !proactiveOn;
  });
}

/** The reason the form cannot be saved as it is, or null. */
function formProblem(values) {
  if (values.privacyPolicyUrl && !/^https?:\/\//i.test(values.privacyPolicyUrl)) {
    return 'The privacy policy link must start with http:// or https://';
  }
  if (values.logoUrl && !/^https:\/\//i.test(values.logoUrl)) {
    return 'The logo must be an https:// address';
  }
  if (values.proactive.enabled && !values.proactive.text) {
    return 'Write the proactive message before switching it on';
  }
  const delay = values.proactive.delaySeconds;
  if (!Number.isInteger(delay) || delay < 5 || delay > 120) {
    return 'Show the proactive message after 5 to 120 seconds';
  }
  return null;
}

// ------------------------------------------------------------- the preview

/** The preview's frame size for each device; the frame is scaled to fit. */
const PREVIEW_SIZES = {
  // Wider than the widget's 480px phone breakpoint, so the desktop preview
  // shows the floating window rather than the full-screen phone view.
  desktop: { width: 560, height: 640 },
  phone: { width: 375, height: 667 }
};

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
    privacyUrl: values.privacyPolicyUrl || '',
    business: (config && config.companyName) || '',
    consent: values.consentRequired,
    consentText: values.consentText || '',
    questions: values.suggestedQuestions,
    proactive: values.proactive
  };
}

function loadPreview() {
  const frame = $('widget-preview-frame');
  const params = new URLSearchParams();
  Object.entries(previewConfig()).forEach(([key, value]) => {
    params.set(key, value && typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
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

/** Scale the frame to the card, keeping the device's real width inside it. */
function fitPreview() {
  const viewport = $('widget-preview-viewport');
  const frame = $('widget-preview-frame');
  const size = PREVIEW_SIZES[previewDevice];
  const available = Math.max(viewport.clientWidth - 24, 200);
  const scale = Math.min(1, available / size.width);

  frame.style.width = `${size.width}px`;
  frame.style.height = `${size.height}px`;
  // Centred, then scaled from its top edge: a transform leaves the layout
  // box at full size, so the frame is positioned rather than flowed.
  frame.style.transform = `translateX(-50%) scale(${scale})`;
  viewport.style.height = `${Math.ceil(size.height * scale) + 24}px`;
}

function setPreviewDevice(device) {
  previewDevice = PREVIEW_SIZES[device] ? device : 'desktop';
  $('widget-preview-viewport').dataset.device = previewDevice;
  [['widget-preview-desktop', 'desktop'], ['widget-preview-phone', 'phone']].forEach(([id, name]) => {
    const button = $(id);
    button.classList.toggle('active', name === previewDevice);
    button.setAttribute('aria-pressed', name === previewDevice ? 'true' : 'false');
  });
  fitPreview();
}

// ------------------------------------------------------------------ saving

function render() {
  $('embed-snippet').textContent = snippet();
  $('widget-key').value = config.widgetKey || '';
  fillForm(config.widgetSettings || {});
  renderDomains();
  renderInstallStatus();
  renderInstallDownloads();

  const checkInput = $('widget-check-url');
  if (!checkInput.value) {
    checkInput.value = (config.allowedDomains && config.allowedDomains[0]) || config.website || '';
  }
}

async function load() {
  try {
    config = await api('/api/companies/me/widget');
    render();
    loadPreview();
    fitPreview();
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
  $('widget-shopify-copy-btn').addEventListener('click', copyShopifySnippet);
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
      removeDomain(button.dataset.domain);
    }
  });

  const tabs = $('widget-install-tabs');
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-install-tab]');
    if (tab) {
      showInstallTab(tab.dataset.installTab);
    }
  });
  tabs.addEventListener('keydown', onInstallTabKey);

  $('widget-check-btn').addEventListener('click', checkSite);
  $('widget-check-url').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      checkSite();
    }
  });

  $('widget-preview-desktop').addEventListener('click', () => setPreviewDevice('desktop'));
  $('widget-preview-phone').addEventListener('click', () => setPreviewDevice('phone'));
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => fitPreview()).observe($('widget-preview-viewport'));
  } else {
    window.addEventListener('resize', fitPreview);
  }

  const form = $('widget-settings-form');
  form.addEventListener('input', () => {
    updateFormHints();
    updatePreview();
  });
  form.addEventListener('change', () => {
    updateFormHints();
    updatePreview();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = formValues();

    const problem = formProblem(values);
    if (problem) {
      showToast(problem, 'warning');
      return;
    }

    save({ widgetSettings: values }, 'Widget settings saved');
  });
}

registerSection('widget', {
  setup: setupWidget,
  show: load
});
