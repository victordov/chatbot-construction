/**
 * Connecting a tenant's own systems.
 *
 * The job here is to get somebody from "I have a shop" to a green tick, and to
 * make every failure say what to do about it. A connector that reports
 * "unauthorised" and nothing else is one people give up on.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, escapeHtml, formatRelativeTime, renderMarkdown, showToast } from './utils.js';

let contract = [];

/**
 * The package to install and its guide, from the SDK that actually ships.
 * The guide is the SDK's own README, rendered here rather than linked to a
 * repository a tenant may not be able to see.
 */
async function loadSdk() {
  const panel = document.getElementById('connector-sdk');
  if (!panel || panel.dataset.loaded) {
    return;
  }

  try {
    const sdk = await api('/api/companies/me/connector/sdk');
    panel.dataset.loaded = '1';
    panel.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <span class="small text-muted">Install</span>
        <code class="user-select-all p-1 bg-light rounded">${escapeHtml(sdk.install)}</code>
        <span class="small text-muted">version ${escapeHtml(sdk.version)}</span>
        ${sdk.readme ? `
          <button type="button" class="btn btn-sm btn-link p-0" data-bs-toggle="collapse"
                  data-bs-target="#connector-sdk-guide" aria-expanded="false" aria-controls="connector-sdk-guide">
            Read the guide
          </button>` : ''}
      </div>`;
    document.getElementById('connector-sdk-guide-body').innerHTML = renderMarkdown(sdk.readme || '');
  } catch (error) {
    panel.innerHTML = '<div class="small text-muted">Install the connector SDK from npm and follow its README.</div>';
  }
}

/**
 * "Use it in conversations" stays off until a Check has reached the
 * connector: a connector the bot cannot reach turns every catalogue question
 * into an apology in front of a customer.
 */
function syncEnableSwitch(connector) {
  const toggle = document.getElementById('connector-enabled');
  const hint = document.getElementById('connector-enabled-hint');
  const checkedOk = Boolean(connector.url && connector.lastCheckedAt && !connector.lastError);

  toggle.disabled = !checkedOk && !connector.enabled;
  hint.textContent = checkedOk || connector.enabled
    ? ''
    : 'Save the URL and press Check first. You can switch it on once it answers.';
}


/**
 * What they have implemented, against what they could.
 *
 * Shown as the full list with ticks rather than only what exists, so somebody
 * can see what else is available to them without reading documentation.
 */
function renderCapabilities(implemented) {
  const container = document.getElementById('connector-capabilities');

  if (!container) {
    return;
  }

  const have = new Set(implemented || []);

  container.innerHTML = contract.map(capability => `
    <div class="d-flex gap-2 align-items-start py-2 border-bottom">
      <span class="badge bg-${have.has(capability.id) ? 'success' : 'secondary-subtle text-secondary-emphasis'}">
        ${have.has(capability.id) ? '✓' : '—'}
      </span>
      <div class="flex-grow-1">
        <div class="small fw-semibold">
          ${escapeHtml(capability.label)}
          ${capability.kind === 'write'
    ? '<span class="badge bg-warning text-dark ms-1">changes your data</span>'
    : ''}
        </div>
        <div class="small text-muted">${escapeHtml(capability.description)}</div>
        <div class="small text-muted fst-italic">${escapeHtml(capability.example)}</div>
      </div>
      <code class="small text-muted text-nowrap">${escapeHtml(capability.id)}</code>
    </div>`).join('');
}

function renderStatus(connector) {
  const status = document.getElementById('connector-status');

  if (!connector.url) {
    status.innerHTML = '';
    return;
  }

  if (connector.lastError) {
    status.innerHTML = `
      <div class="alert alert-danger py-2 px-3 small mb-0">
        <strong>Could not reach it.</strong> ${escapeHtml(connector.lastError)}
      </div>`;
    return;
  }

  if (!connector.lastCheckedAt) {
    status.innerHTML = `
      <div class="alert alert-info py-2 px-3 small mb-0">
        Not checked yet. Press <strong>Check</strong> to see what it implements.
      </div>`;
    return;
  }

  const count = (connector.capabilities || []).length;

  status.innerHTML = `
    <div class="alert alert-${count ? 'success' : 'warning'} py-2 px-3 small mb-0">
      ${count
    ? `Reachable, implementing ${count} capabilit${count === 1 ? 'y' : 'ies'}.`
    : 'Reachable, but it implements nothing yet.'}
      Checked ${escapeHtml(formatRelativeTime(connector.lastCheckedAt))}.
    </div>`;
}

async function load() {
  try {
    const { connector, contract: shapes } = await api('/api/companies/me/connector');
    contract = shapes || [];

    document.getElementById('connector-url').value = connector.url || '';
    document.getElementById('connector-enabled').checked = Boolean(connector.enabled);
    syncEnableSwitch(connector);

    renderCapabilities(connector.capabilities);
    renderStatus(connector);
    loadSdk();

    document.getElementById('connector-secret-state').innerHTML = connector.hasSecret
      ? '<span class="text-success">A signing secret is set.</span>'
      : '<span class="text-warning">No signing secret yet — one is created when you save a URL.</span>';
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function showSecret(secret, notice) {
  const panel = document.getElementById('connector-secret-panel');

  panel.innerHTML = `
    <div class="alert alert-success alert-dismissible">
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Hide"></button>
      <div class="fw-semibold mb-1">${escapeHtml(notice)}</div>
      <code class="d-block p-2 bg-light text-dark rounded user-select-all mb-2">${escapeHtml(secret)}</code>
      <div class="small">
        Set this as <code>CHATBOT_CONNECTOR_SECRET</code> where your connector
        runs, then redeploy. Without it your connector will serve your data to
        anyone who finds the URL.
      </div>
    </div>`;
}

async function save(rotateSecret = false) {
  const button = document.getElementById('connector-save');
  button.disabled = true;

  try {
    const result = await api('/api/companies/me/connector', {
      method: 'PUT',
      body: JSON.stringify({
        url: document.getElementById('connector-url').value.trim(),
        enabled: document.getElementById('connector-enabled').checked,
        rotateSecret
      })
    });

    if (result.secret) {
      showSecret(result.secret, result.secretNotice);
    }

    showToast('Saved', 'success');
    load();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

async function check() {
  const button = document.getElementById('connector-check');
  button.disabled = true;
  button.textContent = 'Checking…';

  try {
    const result = await api('/api/companies/me/connector/check', { method: 'POST' });

    if (result.warning) {
      showToast(result.warning, 'warning');
    }

    if (result.unknown && result.unknown.length) {
      // Usually means their connector is newer than this platform. Saying so
      // beats leaving them wondering why a method they wrote is not listed.
      showToast(
        `Your connector offers ${result.unknown.join(', ')}, which this platform does not know about yet.`,
        'info'
      );
    }

    load();
  } catch (error) {
    showToast(error.message, 'danger');
    load();
  } finally {
    button.disabled = false;
    button.textContent = 'Check';
  }
}

function setupConnector() {
  document.getElementById('connector-save').addEventListener('click', () => save(false));
  document.getElementById('connector-check').addEventListener('click', check);
  document.getElementById('connector-rotate').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Make a new signing secret?',
      message: 'Your connector rejects our calls until you deploy the new secret.',
      confirmLabel: 'Make a new secret',
      danger: true
    });
    if (ok) {
      save(true);
    }
  });
}

registerSection('connector', { setup: setupConnector, show: load });
