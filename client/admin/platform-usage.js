/**
 * Usage by tenant, for whoever runs the platform: consumption across every
 * company this month, and changing a company's plan by hand.
 */

import * as bootstrap from 'bootstrap';
import { formatNumber } from './billing.js';
import { registerSection } from './nav.js';
import { api, escapeHtml, logger, setLoading, showToast } from './utils.js';

let catalogue = [];

async function renderTenantUsage() {
  try {
    const { period, tenants, totals } = await api('/api/billing/usage');
    document.getElementById('tenant-usage-period').textContent = period;

    const table = document.getElementById('tenant-usage-table');

    if (!tenants.length) {
      table.innerHTML = '<tr><td colspan="8" class="text-muted text-center py-3">No usage recorded this month</td></tr>';
      return;
    }

    table.innerHTML = tenants.map(row => `
      <tr>
        <td>${escapeHtml(row.companyName || 'Unknown')}</td>
        <td><span class="badge bg-light text-dark">${escapeHtml(row.planId)}</span></td>
        <td><span class="badge bg-${row.status === 'active' ? 'success' : row.status === 'trialing' ? 'info' : 'warning text-dark'}">${escapeHtml(row.status)}</span></td>
        <td class="text-end">${formatNumber(row.conversations)}</td>
        <td class="text-end">${formatNumber(row.messages)}</td>
        <td class="text-end">${formatNumber(row.aiResponses)}</td>
        <td class="text-end ${row.limitHits ? 'text-danger fw-semibold' : 'text-muted'}">${formatNumber(row.limitHits)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary change-plan-btn"
                  data-company-id="${escapeHtml(row.companyId)}"
                  data-company-name="${escapeHtml(row.companyName || '')}"
                  data-plan-id="${escapeHtml(row.planId)}"
                  data-status="${escapeHtml(row.status)}">Change plan</button>
        </td>
      </tr>`).join('') + `
      <tr class="table-light fw-semibold">
        <td colspan="3">Total</td>
        <td class="text-end">${formatNumber(totals.conversations)}</td>
        <td class="text-end">${formatNumber(totals.messages)}</td>
        <td class="text-end">${formatNumber(totals.aiResponses)}</td>
        <td class="text-end">${formatNumber(totals.limitHits)}</td>
        <td></td>
      </tr>`;

    table.querySelectorAll('.change-plan-btn').forEach(btn => {
      btn.addEventListener('click', () => openPlanModal(btn.dataset));
    });
  } catch (error) {
    logger.error('Failed to load tenant usage:', error);
  }
}

function openPlanModal(data) {
  document.getElementById('change-plan-company-id').value = data.companyId;
  document.getElementById('change-plan-company-name').textContent = data.companyName;

  const select = document.getElementById('change-plan-select');
  select.innerHTML = catalogue.map(plan =>
    `<option value="${escapeHtml(plan.id)}" ${plan.id === data.planId ? 'selected' : ''}>
      ${escapeHtml(plan.name)}${plan.price === null ? ' (custom)' : ` ($${plan.price}/mo)`}
    </option>`).join('');

  document.getElementById('change-plan-status').value = data.status || 'active';
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
