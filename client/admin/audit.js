/**
 * The audit log.
 *
 * Read-only, because the log is. The job here is only to make it legible: a
 * wall of `operator.role_changed` rows nobody can parse is barely better than
 * no log at all, so every action gets a plain-English description and the
 * details are rendered rather than dumped as JSON.
 *
 * The descriptions come from the server (services/audit.js), the same list
 * the CSV export uses, so the screen and the export cannot word one entry two
 * different ways - and an action added later reads as words, not as a code.
 */

import { registerSection } from './nav.js';
import { api, downloadFile, escapeHtml, showToast } from './utils.js';

const state = { skip: 0, limit: 50, action: '', outcome: '', actorId: '', days: 30 };

let descriptions = {};

/**
 * Actions where a failure is worth noticing rather than shrugging at.
 */
const OUTCOME_STYLE = {
  success: '',
  failure: 'table-warning',
  denied: 'table-danger'
};

/** What a role is called on screen. */
const ROLE_WORDS = { superadmin: 'platform admin', company_admin: 'admin', operator: 'operator', system: 'system' };

/** Words for an action name nobody has described yet: "Webhook: secret rotated". */
function fallbackDescription(action) {
  const [noun, ...rest] = String(action || '').split('.');
  const words = text => String(text || '').replace(/[_-]+/g, ' ').trim();
  const subject = words(noun);
  const verb = words(rest.join(' '));
  if (!subject) {
    return 'Unknown action';
  }
  const capitalised = subject.charAt(0).toUpperCase() + subject.slice(1);
  return verb ? `${capitalised}: ${verb}` : capitalised;
}

function describe(entry) {
  return descriptions[entry.action] || fallbackDescription(entry.action);
}

/** A details key as words: `chatsReturnedToQueue` -> "chats returned to queue". */
function keyWords(key) {
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

/**
 * Render the details object as readable pairs rather than raw JSON.
 */
function renderDetails(entry) {
  const parts = [];

  if (entry.target && entry.target.label) {
    parts.push(`<span class="fw-semibold">${escapeHtml(entry.target.label)}</span>`);
  }

  Object.entries(entry.details || {}).forEach(([key, value]) => {
    let shown;
    if (value === null || value === undefined) {
      shown = '—';
    } else if (typeof value === 'object' && !Array.isArray(value) && ('from' in value || 'to' in value)) {
      // A change, said as one.
      const side = side => (side && typeof side === 'object' ? JSON.stringify(side) : String(side ?? '—'));
      shown = `${side(value.from)} → ${side(value.to)}`;
    } else {
      shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    parts.push(`<span class="text-muted">${escapeHtml(keyWords(key))}:</span> ${escapeHtml(shown)}`);
  });

  if (entry.ip) {
    parts.push(`<span class="text-muted">from</span> ${escapeHtml(entry.ip)}`);
  }

  return parts.join(' · ') || '<span class="text-muted">—</span>';
}

/** The filters as a query string, the same for the page and the export. */
function filterParams() {
  const params = new URLSearchParams();
  if (state.action) {
    params.set('action', state.action);
  }
  if (state.outcome) {
    params.set('outcome', state.outcome);
  }
  if (state.actorId) {
    params.set('actorId', state.actorId);
  }
  if (state.days) {
    params.set('since', new Date(Date.now() - state.days * 86400000).toISOString());
  }
  return params;
}

async function load() {
  const table = document.getElementById('audit-table');
  if (!table) {
    return;
  }

  table.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Loading…</td></tr>';

  const params = filterParams();
  params.set('limit', String(state.limit));
  params.set('skip', String(state.skip));

  try {
    const { entries, total, retentionDays } = await api(`/api/admin/audit?${params.toString()}`);

    const retentionEl = document.getElementById('audit-retention-days');
    if (retentionEl && retentionDays) {
      retentionEl.textContent = retentionDays;
    }

    const filtered = state.action || state.outcome || state.actorId;

    if (entries.length === 0) {
      table.innerHTML = `
        <tr><td colspan="4" class="text-center text-muted py-4">
          Nothing recorded${filtered ? ' for this filter' : ' yet'}.
        </td></tr>`;
    } else {
      table.innerHTML = entries.map(entry => `
        <tr class="${OUTCOME_STYLE[entry.outcome] || ''}">
          <td class="small text-nowrap" title="${escapeHtml(new Date(entry.at).toISOString())}">
            ${escapeHtml(new Date(entry.at).toLocaleString())}
          </td>
          <td class="small">
            ${escapeHtml(entry.actor?.displayName || entry.actor?.username || 'System')}
            ${entry.actor?.role ? `<span class="text-muted">· ${escapeHtml(ROLE_WORDS[entry.actor.role] || entry.actor.role)}</span>` : ''}
          </td>
          <td class="small">
            ${escapeHtml(describe(entry))}
            ${entry.outcome !== 'success'
    ? `<span class="badge bg-${entry.outcome === 'denied' ? 'danger' : 'warning'} text-dark ms-1">${escapeHtml(entry.outcome)}</span>`
    : ''}
          </td>
          <td class="small">${renderDetails(entry)}</td>
        </tr>`).join('');
    }

    const first = total === 0 ? 0 : state.skip + 1;
    document.getElementById('audit-range-label').textContent = total === 0
      ? ''
      : `Showing ${first}–${state.skip + entries.length} of ${total}`;

    document.getElementById('audit-prev').disabled = state.skip === 0;
    document.getElementById('audit-next').disabled = state.skip + entries.length >= total;
  } catch (error) {
    table.innerHTML =
      `<tr><td colspan="4" class="text-danger text-center py-4">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadFilters() {
  try {
    const { actions, descriptions: words } = await api('/api/admin/audit/actions');
    descriptions = words || {};

    const select = document.getElementById('audit-action-filter');
    select.innerHTML = '<option value="">All actions</option>' +
      actions
        .map(action => ({ action, label: descriptions[action] || fallbackDescription(action) }))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(({ action, label }) => `<option value="${escapeHtml(action)}">${escapeHtml(label)}</option>`)
        .join('');
  } catch {
    // The filter is a convenience; the log still loads without it.
  }

  try {
    const { actors } = await api('/api/admin/audit/actors');
    document.getElementById('audit-actor-filter').innerHTML = '<option value="">Anyone</option>' +
      actors.map(actor =>
        `<option value="${escapeHtml(actor.id)}">${escapeHtml(actor.name)}${actor.role ? ` (${escapeHtml(ROLE_WORDS[actor.role] || actor.role)})` : ''}</option>`
      ).join('');
  } catch {
    // As above.
  }

  // The descriptions may have arrived after the first page did.
  load();
}

async function exportLog(button) {
  button.disabled = true;
  try {
    await downloadFile(`/api/admin/audit/export?${filterParams().toString()}`,
      `audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    showToast('Could not export the log', 'danger');
  } finally {
    button.disabled = false;
  }
}

function setupAudit() {
  const onChange = (id, key, transform = value => value) => {
    document.getElementById(id)?.addEventListener('change', event => {
      state[key] = transform(event.target.value);
      // Any filter change starts again from the top, or the pagination
      // refers to a result set that no longer exists.
      state.skip = 0;
      load();
    });
  };

  onChange('audit-action-filter', 'action');
  onChange('audit-actor-filter', 'actorId');
  onChange('audit-outcome-filter', 'outcome');
  onChange('audit-range-filter', 'days', value => (value ? Number(value) : 0));

  document.getElementById('audit-prev')?.addEventListener('click', () => {
    state.skip = Math.max(0, state.skip - state.limit);
    load();
  });

  document.getElementById('audit-next')?.addEventListener('click', () => {
    state.skip += state.limit;
    load();
  });

  document.getElementById('audit-export')?.addEventListener('click', event => exportLog(event.currentTarget));

  loadFilters();
}

registerSection('audit', { setup: setupAudit, show: () => load() });
