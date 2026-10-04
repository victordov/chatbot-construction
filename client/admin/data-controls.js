/**
 * Two settings a company owns rather than the platform: how long their
 * conversations are kept, and which keys can read their data.
 *
 * They share a file because they share a shape - an admin-only screen over a
 * small tenant-scoped API - and because a company thinking about one is
 * usually thinking about the other.
 */

import { state } from './state.js';
import { api, escapeHtml, setLoading, showToast } from './utils.js';


const number = value => Number(value || 0).toLocaleString();

// ------------------------------------------------------------- retention

/** An empty box means "follow the platform default", which is not zero. */
function readDays(id) {
  const value = document.getElementById(id).value.trim();
  return value === '' ? null : Number(value);
}

function describe(days) {
  if (days === 0) {
    return 'never';
  }
  return `after ${number(days)} days`;
}

function renderRetention(data) {
  const anonymize = document.getElementById('retention-anonymize');
  const remove = document.getElementById('retention-delete');
  const stored = data.dataRetention || {};

  anonymize.value = stored.anonymizeAfterDays ?? '';
  remove.value = stored.deleteAfterDays ?? '';

  const impact = document.getElementById('retention-impact');
  const effective = data.effective;

  // The counts come first: "delete after 30 days" means nothing next to
  // "this would remove 4,812 conversations tonight".
  impact.innerHTML = `
    <h6 class="mb-2">What happens tonight</h6>
    <p class="mb-2">
      <strong>${number(data.impact.toAnonymize)}</strong> conversations would be anonymised,
      <strong>${number(data.impact.toDelete)}</strong> deleted.
    </p>
    <p class="text-muted small mb-0">
      In force: anonymise ${escapeHtml(describe(effective.anonymizeAfterDays))}
      (${escapeHtml(effective.source.anonymizeAfterDays)}),
      delete ${escapeHtml(describe(effective.deleteAfterDays))}
      (${escapeHtml(effective.source.deleteAfterDays)}).
    </p>`;
}

async function loadRetention() {
  try {
    renderRetention(await api('/api/companies/me/retention'));
  } catch (error) {
    document.getElementById('retention-impact').innerHTML =
      `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

async function saveRetention() {
  const button = document.getElementById('retention-save');
  setLoading(button, true);

  try {
    const result = await api('/api/companies/me/retention', {
      method: 'PUT',
      body: JSON.stringify({
        anonymizeAfterDays: readDays('retention-anonymize'),
        deleteAfterDays: readDays('retention-delete')
      })
    });

    renderRetention({
      dataRetention: result.dataRetention,
      effective: result.effective,
      impact: result.impact
    });
    showToast('Retention policy saved', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

// -------------------------------------------------------------- API keys

const SCOPE_LABELS = {
  'conversations:read': 'Conversations',
  'contacts:read': 'Contacts',
  'tasks:read': 'Tasks'
};

function renderScopeChoices(scopes) {
  document.getElementById('api-key-scopes').innerHTML = scopes.map(scope => `
    <div class="form-check">
      <input class="form-check-input" type="checkbox" value="${escapeHtml(scope)}"
             id="scope-${escapeHtml(scope.replace(':', '-'))}">
      <label class="form-check-label small" for="scope-${escapeHtml(scope.replace(':', '-'))}">
        ${escapeHtml(SCOPE_LABELS[scope] || scope)}
      </label>
    </div>`).join('');
}

function renderKeys(keys) {
  const table = document.getElementById('api-keys-table');

  if (!keys.length) {
    table.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No keys yet</td></tr>';
    return;
  }

  table.innerHTML = keys.map(key => `
    <tr class="${key.active ? '' : 'text-muted'}">
      <td>${escapeHtml(key.name)}</td>
      <td><code>${escapeHtml(key.prefix)}…</code></td>
      <td class="small">${key.scopes.map(scope => escapeHtml(SCOPE_LABELS[scope] || scope)).join(', ')}</td>
      <td class="small">${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}</td>
      <td class="text-end">
        ${key.active
    ? `<button class="btn btn-sm btn-outline-danger" data-revoke="${escapeHtml(key.id)}">Revoke</button>`
    : '<span class="badge bg-secondary">Revoked</span>'}
      </td>
    </tr>`).join('');

  table.querySelectorAll('[data-revoke]').forEach(button => {
    button.addEventListener('click', () => revokeKey(button.dataset.revoke));
  });
}

async function loadKeys() {
  try {
    const { keys, scopes, enabled } = await api('/api/api-keys');

    document.getElementById('api-keys-unavailable').classList.toggle('d-none', enabled);
    document.getElementById('api-keys-form').classList.toggle('d-none', !enabled);

    renderScopeChoices(scopes);
    renderKeys(keys);
  } catch (error) {
    document.getElementById('api-keys-table').innerHTML =
      `<tr><td colspan="5" class="text-danger">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function createKey() {
  const button = document.getElementById('api-key-create');
  const scopes = [...document.querySelectorAll('#api-key-scopes input:checked')].map(input => input.value);

  if (!scopes.length) {
    showToast('Choose what the key may read', 'warning');
    return;
  }

  setLoading(button, true);
  try {
    const result = await api('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('api-key-name').value || 'API key',
        scopes
      })
    });

    // Deliberately not a toast: this is the only time the key exists, and a
    // message that fades after three seconds is how somebody loses it.
    document.getElementById('api-key-reveal').innerHTML = `
      <div class="alert alert-success">
        <h6 class="mb-2">Copy this now — it cannot be shown again</h6>
        <code class="user-select-all d-block mb-2">${escapeHtml(result.key)}</code>
        <p class="small mb-0">
          Send it as <code>Authorization: Bearer &lt;key&gt;</code>. We store only a hash,
          so if it is lost the only way forward is to revoke it and make another.
        </p>
      </div>`;

    document.getElementById('api-key-name').value = '';
    document.querySelectorAll('#api-key-scopes input:checked').forEach(input => {
      input.checked = false;
    });

    loadKeys();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function revokeKey(id) {
  if (!confirm('Revoke this key? Anything using it stops working immediately.')) {
    return;
  }

  try {
    await api(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Key revoked', 'success');
    loadKeys();
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

// ------------------------------------------------------------------ wiring

export function setupDataControls() {
  const user = state.currentUser;

  // Both screens are a company's own settings, and a superadmin has no
  // company of their own to configure.
  if (!user || user.role !== 'company_admin' || !document.getElementById('retention-pane')) {
    return;
  }

  document.getElementById('retention-save')?.addEventListener('click', saveRetention);
  document.getElementById('api-key-create')?.addEventListener('click', createKey);

  // Loaded when the tab is first opened rather than on every dashboard boot:
  // neither is needed to answer a chat.
  document.getElementById('retention-tab')?.addEventListener('shown.bs.tab', loadRetention, { once: true });
  document.getElementById('api-keys-tab')?.addEventListener('shown.bs.tab', loadKeys, { once: true });
}
