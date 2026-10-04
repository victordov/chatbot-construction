/**
 * The audit log.
 *
 * Read-only, because the log is. The job here is only to make it legible: a
 * wall of `operator.role_changed` rows nobody can parse is barely better than
 * no log at all, so every action gets a plain-English description and the
 * details are rendered rather than dumped as JSON.
 */

(function() {
  const state = { skip: 0, limit: 50, action: '', outcome: '', days: 30 };


  /**
   * What each action means, in words somebody who was not there can read.
   *
   * Anything not listed falls back to the raw action name, so a new event type
   * shows up rather than silently rendering blank.
   */
  const DESCRIPTIONS = {
    'auth.login': 'Signed in',
    'user.created': 'Created an account',
    'superadmin.created': 'Created a platform superadmin',
    'operator.activated': 'Reactivated an account',
    'operator.deactivated': 'Deactivated an account',
    'operator.updated': 'Edited an account',
    'operator.role_changed': 'Changed a role',
    'conversation.deleted': 'Deleted a conversation',
    'plan.changed': 'Changed the plan',
    'identity_secret.rotated': 'Rotated the identity secret',
    'workflow.published': 'Published a workflow',
    'workflow.rolled_back': 'Rolled a workflow back',
    'workflow.deleted': 'Deleted a workflow',
    'gdpr.data_read': 'Read a person\'s data',
    'gdpr.exported': 'Exported a person\'s data',
    'gdpr.erased': 'Erased a person\'s data'
  };

  /**
   * Actions where a failure is worth noticing rather than shrugging at.
   */
  const OUTCOME_STYLE = {
    success: '',
    failure: 'table-warning',
    denied: 'table-danger'
  };

  function describe(entry) {
    return DESCRIPTIONS[entry.action] || entry.action;
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
      const shown = value === null || value === undefined
        ? '—'
        : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      parts.push(`<span class="text-muted">${escapeHtml(key)}:</span> ${escapeHtml(shown)}`);
    });

    if (entry.ip) {
      parts.push(`<span class="text-muted">from</span> ${escapeHtml(entry.ip)}`);
    }

    return parts.join(' · ') || '<span class="text-muted">—</span>';
  }

  async function load() {
    const table = document.getElementById('audit-table');
    if (!table) {
      return;
    }

    table.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Loading…</td></tr>';

    const params = new URLSearchParams({
      limit: String(state.limit),
      skip: String(state.skip)
    });

    if (state.action) {
      params.set('action', state.action);
    }
    if (state.outcome) {
      params.set('outcome', state.outcome);
    }
    if (state.days) {
      params.set('since', new Date(Date.now() - state.days * 86400000).toISOString());
    }

    try {
      const response = await fetch(`/api/admin/audit?${params.toString()}`, {
        headers: { 'x-auth-token': authToken() }
      });

      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error || 'Could not load the log');
      }

      const { entries, total, retentionDays } = await response.json();

      const retentionEl = document.getElementById('audit-retention-days');
      if (retentionEl && retentionDays) {
        retentionEl.textContent = retentionDays;
      }

      if (entries.length === 0) {
        table.innerHTML = `
          <tr><td colspan="4" class="text-center text-muted py-4">
            Nothing recorded${state.action || state.outcome ? ' for this filter' : ' yet'}.
          </td></tr>`;
      } else {
        table.innerHTML = entries.map(entry => `
          <tr class="${OUTCOME_STYLE[entry.outcome] || ''}">
            <td class="small text-nowrap" title="${escapeHtml(new Date(entry.at).toISOString())}">
              ${escapeHtml(new Date(entry.at).toLocaleString())}
            </td>
            <td class="small">
              ${escapeHtml(entry.actor?.displayName || entry.actor?.username || 'System')}
              ${entry.actor?.role ? `<span class="text-muted">· ${escapeHtml(entry.actor.role)}</span>` : ''}
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

  async function loadActions() {
    try {
      const response = await fetch('/api/admin/audit/actions', {
        headers: { 'x-auth-token': authToken() }
      });

      if (!response.ok) {
        return;
      }

      const { actions } = await response.json();
      const select = document.getElementById('audit-action-filter');

      select.innerHTML = '<option value="">All actions</option>' +
        actions.map(action =>
          `<option value="${escapeHtml(action)}">${escapeHtml(DESCRIPTIONS[action] || action)}</option>`
        ).join('');
    } catch {
      // The filter is a convenience; the log still loads without it.
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

    loadActions();
    load();
  }

  window.setupAudit = setupAudit;
  window.reloadAudit = load;
})();
