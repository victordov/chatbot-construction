/**
 * Actions: what the bot may do in the business's own systems.
 *
 * An action is defined once - what it needs, the request, which fields of
 * the response the bot may see - and is then either offered to the assistant
 * to use when a question matches ("Automatic"), or kept for the workflows an
 * admin draws. The server enforces the rules that matter (verified customers
 * only, confirmation before a change, a cap per reply); this screen explains
 * them in the words an admin would use.
 */

import { Modal } from 'bootstrap';
import feather from 'feather-icons';
import { registerSection } from './nav.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, setLoading, showToast
} from './utils.js';

let actions = [];
let presets = [];
let editing = null;

const $ = id => document.getElementById(id);

const SOURCE_LABELS = {
  visitor: 'The customer',
  verified: 'Verified customer',
  constant: 'Always the same'
};

// ------------------------------------------------------------------- list

function renderList() {
  const list = $('actions-list');

  if (!actions.length) {
    list.innerHTML = `
      <div class="card">
        <div class="card-body text-center py-5">
          <span data-feather="zap" class="text-muted mb-2"></span>
          <h3 class="h6">No actions yet</h3>
          <p class="text-muted small mb-3">
            Start from a template for Shopify, Stripe, Zendesk, Slack or HubSpot, or describe your own API.
          </p>
          <button type="button" class="btn btn-sm btn-primary" data-action-new>New action</button>
        </div>
      </div>`;
    feather.replace();
    return;
  }

  list.innerHTML = `
    <div class="card">
      <ul class="list-group list-group-flush">
        ${actions.map(action => `
          <li class="list-group-item d-flex align-items-start gap-3">
            <div class="form-check form-switch mt-1">
              <input class="form-check-input" type="checkbox" role="switch" data-action-toggle="${escapeHtml(action._id)}"
                     ${action.enabled ? 'checked' : ''} aria-label="Enabled">
            </div>
            <div class="me-auto">
              <div class="fw-semibold">${escapeHtml(action.title || action.name)}
                <code class="small text-muted ms-1">${escapeHtml(action.name)}</code></div>
              <div class="small text-muted">${escapeHtml(action.description)}</div>
              <div class="d-flex gap-1 flex-wrap mt-1">
                <span class="badge ${action.mode === 'auto' ? 'text-bg-primary' : 'text-bg-light border'}">
                  ${action.mode === 'auto' ? 'Automatic' : 'Workflow only'}
                </span>
                <span class="badge text-bg-light border">${escapeHtml(action.request.method)}</span>
                ${action.isWrite ? '<span class="badge text-bg-warning">Changes data · asks to confirm</span>' : ''}
                ${action.requiresVerified ? '<span class="badge text-bg-success">Verified customers only</span>' : ''}
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-action-edit="${escapeHtml(action._id)}">Edit</button>
          </li>`).join('')}
      </ul>
    </div>`;
}

async function load() {
  try {
    const [list, catalogue] = await Promise.all([
      api('/api/actions'),
      presets.length ? Promise.resolve({ presets }) : api('/api/actions/presets')
    ]);
    actions = list.actions || [];
    presets = catalogue.presets || [];
    $('actions-unavailable').classList.add('d-none');
    renderList();
    renderPresets();
  } catch (error) {
    if (error.status === 402) {
      // Not an error: the plan does not include actions.
      $('actions-unavailable').textContent = 'Actions are not included in your plan. Upgrade under Plan & billing to let your bot look things up in your systems.';
      $('actions-unavailable').classList.remove('d-none');
      $('actions-list').innerHTML = '';
      $('action-new-btn').disabled = true;
      // The templates menu would otherwise say "Loading…" for ever.
      $('action-presets-menu').innerHTML = `
        <li><span class="dropdown-item-text small text-muted">
          Templates come with actions, which your plan does not include.
          <a href="?section=billing" data-section-link="billing">See plans</a>
        </span></li>`;
      return;
    }
    showToast(errorMessage(error, 'Could not load your actions'), 'danger');
  }

  loadConnectorNote();
}

function renderPresets() {
  $('action-presets-menu').innerHTML = presets.length
    ? presets.map(preset => `
        <li>
          <button type="button" class="dropdown-item" data-action-preset="${escapeHtml(preset.id)}">
            ${escapeHtml(preset.label)}
            ${preset.note ? `<span class="d-block small text-muted">${escapeHtml(preset.note)}</span>` : ''}
          </button>
        </li>`).join('')
    : '<li><span class="dropdown-item-text small text-muted">No templates</span></li>';
}

/** Say that the connector's abilities are tools too, when it is switched on. */
async function loadConnectorNote() {
  const note = $('actions-connector-note');
  try {
    const { connector } = await api('/api/companies/me/connector');
    if (connector && connector.enabled) {
      note.innerHTML = 'Your systems connector is on, so the assistant can also use what it offers ' +
        `(${escapeHtml((connector.capabilities || []).join(', ') || 'catalogue and appointments')}) without an action here. ` +
        'Change that under <a href="?section=connector" data-section-link="connector">Developers → Your systems</a>.';
      note.classList.remove('d-none');
    } else {
      note.classList.add('d-none');
    }
  } catch (error) {
    note.classList.add('d-none');
  }
}

// ----------------------------------------------------------------- editor

function inputRow(input = {}) {
  const source = input.source || 'visitor';
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="form-control form-control-sm font-monospace" data-field="name"
               value="${escapeHtml(input.name || '')}" placeholder="order_id" aria-label="Input name"></td>
    <td><input type="text" class="form-control form-control-sm" data-field="description"
               value="${escapeHtml(input.description || '')}" placeholder="The order number on their receipt" aria-label="Description"></td>
    <td>
      <select class="form-select form-select-sm" data-field="source" aria-label="Comes from">
        ${Object.entries(SOURCE_LABELS).map(([value, label]) =>
    `<option value="${value}" ${value === source ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </td>
    <td>
      <input type="text" class="form-control form-control-sm ${source === 'constant' ? '' : 'd-none'}" data-field="value"
             value="${escapeHtml(input.value || '')}" placeholder="Value" aria-label="Value">
      <select class="form-select form-select-sm ${source === 'verified' ? '' : 'd-none'}" data-field="attribute" aria-label="Attribute">
        ${['externalId', 'email', 'name', 'phone'].map(value =>
    `<option value="${value}" ${value === (input.attribute || 'externalId') ? 'selected' : ''}>${value === 'externalId' ? 'Their user id' : value}</option>`).join('')}
      </select>
      <span class="small text-muted ${source === 'visitor' ? '' : 'd-none'}" data-field="visitor-hint">The bot asks for it</span>
    </td>
    <td class="text-center"><input class="form-check-input" type="checkbox" data-field="required"
               ${input.required !== false ? 'checked' : ''} aria-label="Required"></td>
    <td><button type="button" class="btn btn-sm btn-link text-danger p-0" data-remove-input aria-label="Remove input">✕</button></td>`;
  return row;
}

function syncInputRow(row) {
  const source = row.querySelector('[data-field="source"]').value;
  row.querySelector('[data-field="value"]').classList.toggle('d-none', source !== 'constant');
  row.querySelector('[data-field="attribute"]').classList.toggle('d-none', source !== 'verified');
  row.querySelector('[data-field="visitor-hint"]').classList.toggle('d-none', source !== 'visitor');
}

function headersToText(headers) {
  return Object.entries(headers || {}).map(([name, value]) => `${name}: ${value}`).join('\n');
}

function textToHeaders(text) {
  const headers = {};
  text.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
    const index = line.indexOf(':');
    if (index > 0) {
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  });
  return headers;
}

function outputsToText(outputs) {
  return (outputs || []).map(output => `${output.name} = ${output.path}`).join('\n');
}

function textToOutputs(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name, ...rest] = line.split('=');
    return { name: name.trim(), path: rest.join('=').trim() };
  }).filter(output => output.name && output.path);
}

function syncForm() {
  const method = $('action-method').value;
  $('action-body-group').classList.toggle('d-none', method === 'GET');

  const authType = $('action-auth-type').value;
  $('action-auth-header-group').classList.toggle('d-none', authType !== 'header');
  $('action-auth-value-group').classList.toggle('d-none', authType === 'none');

  const raw = document.querySelector('input[name="action-response-mode"]:checked').value === 'raw';
  $('action-outputs-group').classList.toggle('d-none', raw);
  $('action-maxbytes-group').classList.toggle('d-none', !raw);

  // The method in the form, not the saved one: Run once sends what the form
  // says, so the warning has to as well.
  const warning = $('action-test-write-warning');
  warning.classList.toggle('d-none', method === 'GET');
  warning.textContent = `This is a ${method}, not a GET: trying it really sends the request and may change data.`;
}

function renderTestInputs() {
  const names = [...document.querySelectorAll('#action-inputs tr')]
    .map(row => row.querySelector('[data-field="name"]').value.trim())
    .filter(Boolean);

  $('action-test-inputs').innerHTML = names.length
    ? names.map(name => `
        <div class="input-group input-group-sm mb-1">
          <span class="input-group-text font-monospace">${escapeHtml(name)}</span>
          <input type="text" class="form-control" data-test-input="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">
        </div>`).join('')
    : '<div class="small text-muted">This action needs no inputs.</div>';
}

/** "Email verification is enough" only means something for a verified-only action. */
function syncVerificationRow() {
  const row = $('action-verification-email-row');
  if (row) {
    row.classList.toggle('d-none', !$('action-requires-verified').checked);
  }
}

function fillForm(action) {
  editing = action && action._id ? action : null;
  $('actionModalLabel').textContent = editing ? `Edit ${action.title || action.name}` : 'New action';
  $('action-id').value = editing ? action._id : '';
  $('action-title').value = action.title || '';
  $('action-name').value = action.name || '';
  $('action-description').value = action.description || '';

  const inputs = $('action-inputs');
  inputs.innerHTML = '';
  (action.inputs || []).forEach(input => inputs.appendChild(inputRow(input)));

  const request = action.request || {};
  $('action-method').value = (request.method || 'GET').toUpperCase();
  $('action-url').value = request.url || '';
  $('action-headers').value = headersToText(request.headers);
  $('action-body').value = request.body || '';

  const auth = request.auth || {};
  $('action-auth-type').value = auth.type || 'none';
  $('action-auth-header').value = auth.header || '';
  $('action-auth-value').value = '';
  $('action-auth-hint').textContent = auth.hasCredential
    ? 'A secret is saved. Leave this empty to keep it.'
    : 'Stored encrypted and never shown again.';

  const response = action.response || {};
  document.getElementById(response.mode === 'raw' ? 'action-response-raw' : 'action-response-paths').checked = true;
  $('action-outputs').value = outputsToText(response.outputs);
  $('action-maxbytes').value = response.maxBytes || 4000;

  document.getElementById(action.mode === 'workflow_only' ? 'action-mode-workflow' : 'action-mode-auto').checked = true;
  $('action-requires-verified').checked = Boolean(action.requiresVerified);
  $('action-verification-email').checked = action.verification === 'email';
  syncVerificationRow();
  $('action-enabled').checked = action.enabled !== false;

  $('action-delete-btn').classList.toggle('d-none', !editing);
  $('action-test-hint').textContent =
    'Runs it once with what is in the form now, saved or not, and shows what came back and what the bot would see.';
  $('action-test-result').classList.add('d-none');

  syncForm();
  renderTestInputs();
  loadRuns();
}

// --------------------------------------------------------------- run log

const BY_LABELS = {
  assistant: 'Assistant',
  workflow: 'Workflow',
  test: 'Run once'
};

/** The last calls of the action being edited, from the audit trail. */
async function loadRuns() {
  const card = $('action-runs-card');
  const container = $('action-runs');

  if (!editing) {
    card.classList.add('d-none');
    return;
  }

  card.classList.remove('d-none');
  container.innerHTML = '<span class="text-muted">Loading…</span>';
  const id = editing._id;

  try {
    const { runs, lastError } = await api(`/api/actions/${encodeURIComponent(id)}/runs`);
    if (!editing || editing._id !== id) {
      return;
    }

    if (!runs.length) {
      container.innerHTML = '<span class="text-muted">Not called yet.</span>';
      return;
    }

    container.innerHTML = `
      ${lastError ? `
        <div class="alert alert-danger py-1 px-2 mb-2">
          Last error ${escapeHtml(formatRelativeTime(lastError.at))} (${escapeHtml(BY_LABELS[lastError.by] || lastError.by)}):
          ${escapeHtml(lastError.error)}
        </div>` : ''}
      <ul class="list-unstyled mb-0 action-runs">
        ${runs.map(run => `
          <li class="d-flex gap-2 align-items-baseline">
            <span class="${run.ok ? 'text-success' : 'text-danger'}">${run.ok ? '✓' : '✗'}</span>
            <span class="text-muted text-nowrap">${escapeHtml(formatRelativeTime(run.at))}</span>
            <span>${escapeHtml(BY_LABELS[run.by] || run.by)}</span>
            <span class="text-muted ms-auto text-nowrap">
              ${run.httpStatus ? `HTTP ${escapeHtml(run.httpStatus)}` : escapeHtml(run.status || '')}
              ${run.durationMs !== null ? ` · ${escapeHtml(run.durationMs)} ms` : ''}
            </span>
          </li>`).join('')}
      </ul>`;
  } catch (error) {
    container.innerHTML = `<span class="text-muted">${escapeHtml(errorMessage(error, 'Could not load the run log'))}</span>`;
  }
}

function collectForm() {
  const inputs = [...document.querySelectorAll('#action-inputs tr')].map(row => {
    const field = name => row.querySelector(`[data-field="${name}"]`);
    const source = field('source').value;
    return {
      name: field('name').value.trim(),
      description: field('description').value.trim(),
      type: 'string',
      required: field('required').checked,
      source,
      ...(source === 'constant' ? { value: field('value').value } : {}),
      ...(source === 'verified' ? { attribute: field('attribute').value } : {})
    };
  }).filter(input => input.name);

  const authType = $('action-auth-type').value;
  const auth = { type: authType };
  if (authType === 'header') {
    auth.header = $('action-auth-header').value.trim();
  }
  const secret = $('action-auth-value').value;
  if (authType !== 'none' && secret) {
    auth.value = secret;
  }

  const raw = document.querySelector('input[name="action-response-mode"]:checked').value === 'raw';
  const method = $('action-method').value;

  return {
    title: $('action-title').value.trim(),
    name: $('action-name').value.trim(),
    description: $('action-description').value.trim(),
    inputs,
    request: {
      method,
      url: $('action-url').value.trim(),
      headers: textToHeaders($('action-headers').value),
      body: method === 'GET' ? '' : $('action-body').value,
      auth
    },
    response: raw
      ? { mode: 'raw', maxBytes: Number($('action-maxbytes').value) || 4000, outputs: [] }
      : { mode: 'paths', outputs: textToOutputs($('action-outputs').value) },
    mode: document.querySelector('input[name="action-mode"]:checked').value,
    requiresVerified: $('action-requires-verified').checked,
    verification: $('action-requires-verified').checked && $('action-verification-email').checked ? 'email' : 'signed',
    enabled: $('action-enabled').checked
  };
}

function openEditor(action = {}) {
  fillForm(action);
  Modal.getOrCreateInstance($('actionModal')).show();
  feather.replace();
}

async function save() {
  const payload = collectForm();
  if (!payload.title || !payload.name || !payload.description || !payload.request.url) {
    showToast('A title, a name, "When to use it" and a URL are all needed', 'warning');
    return;
  }

  const button = $('action-save-btn');
  setLoading(button, true);
  try {
    const { action } = editing
      ? await api(`/api/actions/${encodeURIComponent(editing._id)}`, { method: 'PUT', body: payload })
      : await api('/api/actions', { method: 'POST', body: payload });
    showToast(editing ? 'Action saved' : 'Action created - you can try it now', 'success');
    fillForm(action);
    await load();
  } catch (error) {
    const detail = error.body && Array.isArray(error.body.errors) ? ` ${error.body.errors.join(' ')}` : '';
    showToast(errorMessage(error, 'Could not save the action') + detail, 'danger', 8000);
  } finally {
    setLoading(button, false);
  }
}

async function remove() {
  if (!editing) {
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete this action?',
    message: `"${editing.title || editing.name}" - the bot stops using it, and any workflow step that calls it takes its error path.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/actions/${encodeURIComponent(editing._id)}`, { method: 'DELETE' });
    Modal.getOrCreateInstance($('actionModal')).hide();
    showToast('Action deleted', 'success');
    await load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not delete the action'), 'danger');
  }
}

async function runTest() {
  const config = collectForm();
  if (!config.request.url) {
    showToast('Enter the URL to call first', 'warning');
    return;
  }

  const inputs = {};
  document.querySelectorAll('[data-test-input]').forEach(field => {
    inputs[field.dataset.testInput] = field.value;
  });

  const button = $('action-test-btn');
  const output = $('action-test-result');
  setLoading(button, true);
  try {
    // The form as it stands, saved or not: testing the saved copy while the
    // admin looks at an edited one tells them nothing about the edit.
    const path = editing ? `/api/actions/${encodeURIComponent(editing._id)}/test` : '/api/actions/test';
    const result = await api(path, { method: 'POST', body: { inputs, config } });
    const lines = [
      // Shown as text, not HTML, so nothing here needs escaping.
      `${result.ok ? '✓' : '✗'} ${result.method || ''} · HTTP ${result.status || '-'}${result.durationMs ? ` in ${result.durationMs} ms` : ''}`,
      result.error ? `Error: ${result.error}` : null,
      result.extracted && Object.keys(result.extracted).length
        ? `\nThe bot would see:\n${JSON.stringify(result.extracted, null, 2)}` : null,
      result.body ? `\nResponse${result.truncated ? ' (cut short)' : ''}:\n${typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}` : null
    ].filter(Boolean);
    output.textContent = lines.join('\n');
    output.classList.remove('d-none');
    loadRuns();
  } catch (error) {
    output.textContent = errorMessage(error, 'The test could not run');
    output.classList.remove('d-none');
  } finally {
    setLoading(button, false);
  }
}

async function toggle(id, enabled) {
  try {
    await api(`/api/actions/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } });
    const action = actions.find(item => item._id === id);
    if (action) {
      action.enabled = enabled;
    }
    showToast(enabled ? 'Action switched on' : 'Action switched off', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not change the action'), 'danger');
    load();
  }
}

function setupActions() {
  $('action-new-btn').addEventListener('click', () => openEditor({ mode: 'auto', enabled: true, inputs: [] }));
  $('action-requires-verified').addEventListener('change', syncVerificationRow);

  $('actions-section').addEventListener('click', event => {
    if (event.target.closest('[data-action-new]')) {
      openEditor({ mode: 'auto', enabled: true, inputs: [] });
      return;
    }
    const edit = event.target.closest('[data-action-edit]');
    if (edit) {
      openEditor(actions.find(action => action._id === edit.dataset.actionEdit) || {});
      return;
    }
    const preset = event.target.closest('[data-action-preset]');
    if (preset) {
      const chosen = presets.find(item => item.id === preset.dataset.actionPreset);
      if (chosen) {
        openEditor({ ...chosen.action, enabled: true });
      }
    }
  });

  $('actions-section').addEventListener('change', event => {
    const switchEl = event.target.closest('[data-action-toggle]');
    if (switchEl) {
      toggle(switchEl.dataset.actionToggle, switchEl.checked);
    }
  });

  const form = $('action-form');
  form.addEventListener('change', syncForm);
  form.addEventListener('input', event => {
    if (event.target.closest('#action-inputs')) {
      renderTestInputs();
    }
  });
  $('action-inputs').addEventListener('change', event => {
    const row = event.target.closest('tr');
    if (row && event.target.matches('[data-field="source"]')) {
      syncInputRow(row);
    }
  });
  $('action-inputs').addEventListener('click', event => {
    if (event.target.closest('[data-remove-input]')) {
      event.target.closest('tr').remove();
      renderTestInputs();
    }
  });
  $('action-add-input').addEventListener('click', () => {
    $('action-inputs').appendChild(inputRow());
    renderTestInputs();
  });

  // The name the model calls it by, suggested from the title.
  $('action-title').addEventListener('input', () => {
    if (!editing && !$('action-name').dataset.touched) {
      $('action-name').value = $('action-title').value.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 48);
    }
  });
  $('action-name').addEventListener('input', () => {
    $('action-name').dataset.touched = '1';
  });
  $('actionModal').addEventListener('hidden.bs.modal', () => {
    delete $('action-name').dataset.touched;
  });

  $('action-save-btn').addEventListener('click', save);
  $('action-delete-btn').addEventListener('click', remove);
  $('action-test-btn').addEventListener('click', runTest);
}

registerSection('actions', {
  setup: setupActions,
  show: load
});
