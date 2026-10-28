/**
 * Usage by tenant, for whoever runs the platform: consumption across every
 * company for a month, the trials about to end and the tenants who never
 * installed the widget, and changing a company's plan by hand.
 */

import * as bootstrap from 'bootstrap';
import { formatNumber } from './billing.js';
import { registerSection } from './nav.js';
import { api, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast } from './utils.js';

let catalogue = [];
let period = '';
let tenants = [];

const STATUS_TONE = {
  active: 'success',
  trialing: 'info text-dark',
  trial_expired: 'danger',
  past_due: 'warning text-dark',
  cancelled: 'secondary',
  suspended: 'danger'
};

const money = value => `$${Number(value || 0).toFixed(2)}`;

function renderLists(data) {
  const trials = document.getElementById('tenant-trials-ending');
  trials.innerHTML = data.trialsEndingSoon.length
    ? `<ul class="list-unstyled mb-0">${data.trialsEndingSoon.map(row => `
        <li class="d-flex justify-content-between py-1 border-bottom">
          <span>${escapeHtml(row.companyName || 'Unknown')}</span>
          <span class="small text-muted">ends ${escapeHtml(new Date(row.trialEndsAt).toLocaleDateString())}</span>
        </li>`).join('')}</ul>`
    : '<span class="text-muted small">None this week.</span>';

  const never = document.getElementById('tenant-never-installed');
  never.innerHTML = data.neverInstalled.length
    ? `<ul class="list-unstyled mb-0">${data.neverInstalled.slice(0, 15).map(row => `
        <li class="d-flex justify-content-between py-1 border-bottom">
          <span>${escapeHtml(row.companyName || 'Unknown')}</span>
          <span class="small text-muted">joined ${escapeHtml(formatRelativeTime(row.createdAt))}</span>
        </li>`).join('')}</ul>${data.neverInstalled.length > 15
      ? `<div class="small text-muted mt-1">and ${data.neverInstalled.length - 15} more</div>` : ''}`
    : '<span class="text-muted small">Every active company has the widget on a site.</span>';
}

async function renderTenantUsage() {
  const table = document.getElementById('tenant-usage-table');

  try {
    const data = await api(`/api/billing/usage${period ? `?period=${encodeURIComponent(period)}` : ''}`);
    tenants = data.tenants;

    document.getElementById('tenant-usage-period').textContent =
      data.period === data.currentPeriod ? 'this month so far' : '';
    const picker = document.getElementById('tenant-usage-month');
    if (picker && !picker.value) {
      picker.value = data.period;
    }
    document.getElementById('tenant-usage-cost-note').textContent =
      `AI cost is an estimate: replies × $${data.aiCostPerReply} each (AI_COST_PER_REPLY), for spotting a tenant who costs more than they pay.`;

    renderLists(data);

    if (!tenants.length) {
      table.innerHTML = '<tr><td colspan="10" class="text-muted text-center py-3">No companies yet</td></tr>';
      return;
    }

    table.innerHTML = tenants.map(row => `
      <tr class="${row.isActive ? '' : 'text-muted'}">
        <td>${escapeHtml(row.companyName || 'Unknown')}${row.isActive ? '' : ' <span class="badge bg-secondary">off</span>'}</td>
        <td><span class="badge bg-light text-dark">${escapeHtml(row.planId)}</span></td>
        <td><span class="badge bg-${STATUS_TONE[row.status] || 'secondary'}">${escapeHtml(String(row.status).replace('_', ' '))}</span></td>
        <td class="small">${row.installed
    ? `<span title="${escapeHtml(row.widgetOrigin || '')}">${escapeHtml(formatRelativeTime(row.widgetSeenAt))}</span>`
    : '<span class="text-muted">never</span>'}</td>
        <td class="text-end">${formatNumber(row.conversations)}</td>
        <td class="text-end">${formatNumber(row.messages)}</td>
        <td class="text-end">${formatNumber(row.aiResponses)}</td>
        <td class="text-end">${money(row.estimatedAiCost)}</td>
        <td class="text-end ${row.limitHits ? 'text-danger fw-semibold' : 'text-muted'}">${formatNumber(row.limitHits)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary change-plan-btn"
                  data-company-id="${escapeHtml(row.companyId)}">Change plan</button>
        </td>
      </tr>`).join('') + `
      <tr class="table-light fw-semibold">
        <td colspan="4">Total</td>
        <td class="text-end">${formatNumber(data.totals.conversations)}</td>
        <td class="text-end">${formatNumber(data.totals.messages)}</td>
        <td class="text-end">${formatNumber(data.totals.aiResponses)}</td>
        <td class="text-end">${money(data.totals.estimatedAiCost)}</td>
        <td class="text-end">${formatNumber(data.totals.limitHits)}</td>
        <td></td>
      </tr>`;
  } catch (error) {
    logger.error('Failed to load tenant usage:', error);
    table.innerHTML = `<tr><td colspan="10" class="text-danger text-center py-3">${escapeHtml(errorMessage(error, 'Could not load usage'))}</td></tr>`;
  }
}

/**
 * Open "Change plan" with what the company has now - the plan, the status and
 * whether overage is on. The overage box used to open unticked whatever the
 * tenant had, so saving any change quietly switched their overage off.
 */
function openPlanModal(companyId) {
  const row = tenants.find(tenant => String(tenant.companyId) === String(companyId));
  if (!row) {
    return;
  }

  document.getElementById('change-plan-company-id').value = row.companyId;
  document.getElementById('change-plan-company-name').textContent = row.companyName || '';

  const select = document.getElementById('change-plan-select');
  select.innerHTML = catalogue.map(plan =>
    `<option value="${escapeHtml(plan.id)}" ${plan.id === row.planId ? 'selected' : ''}>
      ${escapeHtml(plan.name)}${plan.price === null ? ' (custom)' : ` ($${plan.price}/mo)`}
    </option>`).join('');

  // An ended trial is stored as `trialing`; offering that keeps it ended.
  document.getElementById('change-plan-status').value = row.status === 'trial_expired' ? 'trialing' : (row.status || 'active');
  document.getElementById('change-plan-overage').checked = Boolean(row.overageAllowed);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('changePlanModal')).show();
}

async function savePlan() {
  const companyId = document.getElementById('change-plan-company-id').value;
  const button = document.getElementById('save-plan-btn');

  setLoading(button, true);
  try {
    await api(`/api/billing/companies/${encodeURIComponent(companyId)}/subscription`, {
      method: 'PATCH',
      body: JSON.stringify({
        planId: document.getElementById('change-plan-select').value,
        status: document.getElementById('change-plan-status').value,
        overageAllowed: document.getElementById('change-plan-overage').checked
      })
    });

    bootstrap.Modal.getOrCreateInstance(document.getElementById('changePlanModal')).hide();
    showToast('Plan updated', 'success');
    renderTenantUsage();
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setLoading(button, false);
  }
}

registerSection('platform-usage', {
  setup() {
    document.getElementById('save-plan-btn').addEventListener('click', savePlan);
    document.getElementById('tenant-usage-table').addEventListener('click', event => {
      const button = event.target.closest('.change-plan-btn');
      if (button) {
        openPlanModal(button.dataset.companyId);
      }
    });
    document.getElementById('tenant-usage-month').addEventListener('change', event => {
      period = event.target.value;
      renderTenantUsage();
    });
  },
  async show() {
    try {
      catalogue = (await api('/api/billing/plans')).plans;
    } catch (error) {
      logger.error('Failed to load the plan catalogue:', error);
    }
    renderTenantUsage();
  }
});
