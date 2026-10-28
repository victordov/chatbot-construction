/**
 * Keys a company creates to read its own data over /api/v1.
 */

import { registerSection } from './nav.js';
import { api, confirmDialog, escapeHtml, setLoading, showToast } from './utils.js';

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
    table.innerHTML = '<tr><td colspan="6" class="text-muted text-center py-3">No keys yet</td></tr>';
    return;
  }

  const expired = key => !key.revokedAt && key.expiresAt && new Date(key.expiresAt) < new Date();

  table.innerHTML = keys.map(key => `
    <tr class="${key.active ? '' : 'text-muted'}">
      <td>${escapeHtml(key.name)}</td>
      <td><code>${escapeHtml(key.prefix)}…</code></td>
      <td class="small">${key.scopes.map(scope => escapeHtml(SCOPE_LABELS[scope] || scope)).join(', ')}</td>
      <td class="small">${key.lastUsedAt ? escapeHtml(new Date(key.lastUsedAt).toLocaleString()) : 'Never'}</td>
      <td class="small">${key.expiresAt ? escapeHtml(new Date(key.expiresAt).toLocaleDateString()) : 'Never'}</td>
      <td class="text-end">
        ${key.active
    ? `<button class="btn btn-sm btn-outline-danger" data-revoke="${escapeHtml(key.id)}">Revoke</button>`
    : `<span class="badge bg-secondary">${expired(key) ? 'Expired' : 'Revoked'}</span>`}
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
      `<tr><td colspan="6" class="text-danger">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function createKey() {
  const button = document.getElementById('api-key-create');
  const scopes = [...document.querySelectorAll('#api-key-scopes input:checked')].map(input => input.value);

  if (!scopes.length) {
    showToast('Choose what the key may read', 'warning');
    return;
  }

  // The end of the chosen day, in the admin's own timezone: "stops working
  // on the 30th" should include the 30th.
  const expiry = document.getElementById('api-key-expiry').value;
  const expiresAt = expiry ? new Date(`${expiry}T23:59:59`).toISOString() : undefined;
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    showToast('Choose a date in the future, or leave it empty', 'warning');
    return;
  }

  setLoading(button, true);
  try {
    const result = await api('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('api-key-name').value || 'API key',
        scopes,
        expiresAt
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
    document.getElementById('api-key-expiry').value = '';
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
  const ok = await confirmDialog({
    title: 'Revoke this key?',
    message: 'Anything using it stops working immediately. The key stays in the list as a record that it existed.',
    confirmLabel: 'Revoke',
    danger: true
  });
  if (!ok) {
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

registerSection('api-keys', {
  setup() {
    document.getElementById('api-key-create').addEventListener('click', createKey);
  },
  show: loadKeys
});
