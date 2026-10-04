/**
 * Plan & billing.
 *
 * Shows a tenant what they are paying for and how close they are to their
 * limits, so that hitting one is never the first they hear of it, and lets
 * them pay: choosing a plan goes to Stripe's own checkout page, so card
 * details never reach this server.
 */

import Chart from 'chart.js/auto';
import feather from 'feather-icons';
import { registerSection } from './nav.js';
import { api, errorMessage, escapeHtml, logger, setLoading, showToast } from './utils.js';

let usageHistoryChart = null;
let catalogue = [];
let summary = null;


export const formatNumber = value => Number(value || 0).toLocaleString();

/**
 * Turn a camelCase feature key into a label. Acronyms are spelled out
 * explicitly, because naive title-casing renders `apiAccess` as
 * "Api Access" and `aiSuggestions` as "Ai Suggestions".
 */
const FEATURE_LABELS = {
  workflows: 'Workflows',
  knowledgeBase: 'Knowledge base',
  aiSuggestions: 'AI suggestions',
  analytics: 'Analytics',
  fileUploads: 'File uploads',
  apiAccess: 'API access',
  customBranding: 'Custom branding',
  prioritySupport: 'Priority support'
};

const featureLabel = key => FEATURE_LABELS[key] ||
  key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

/** `null` limits mean unlimited, which reads better than "null". */
const formatLimit = limit => (limit === null || limit === undefined ? 'Unlimited' : formatNumber(limit));

/**
 * Colour a usage bar by how close it is to the limit. The thresholds matter
 * more than the exact colours: an operator should see "nearly out" before
 * they are actually out.
 */
function meterVariant(percentage) {
  if (percentage === null) {
    return 'secondary';
  }
  if (percentage >= 100) {
    return 'danger';
  }
  if (percentage >= 80) {
    return 'warning';
  }
  return 'success';
}

function renderPlan(summary) {
  const { plan, subscription } = summary;

  const statusBadge = document.getElementById('plan-status');
  statusBadge.textContent = subscription.status.replace('_', ' ');
  statusBadge.className = `badge bg-${
    subscription.status === 'active' ? 'success'
      : subscription.status === 'trialing' ? 'info'
        : subscription.status === 'past_due' ? 'warning text-dark'
          : 'danger'}`;

  const features = Object.entries(plan.features)
    .map(([key, value]) => {
      const label = featureLabel(key);
      // `analytics` is a tier string, not a boolean.
      const enabled = Boolean(value);
      const detail = typeof value === 'string' ? ` (${value})` : '';
      return `
        <li class="d-flex align-items-center gap-2 ${enabled ? '' : 'text-muted'}">
          <i data-feather="${enabled ? 'check' : 'x'}" class="${enabled ? 'text-success' : 'text-muted'}"></i>
          <span>${escapeHtml(label)}${escapeHtml(detail)}</span>
        </li>`;
    }).join('');

  let expiry = '';
  if (subscription.status === 'trialing' && subscription.trialEndsAt) {
    const days = Math.ceil((new Date(subscription.trialEndsAt) - Date.now()) / 86400000);
    expiry = days > 0
      ? `<div class="alert alert-info py-2 px-3 small mb-3">Trial ends in ${days} day${days === 1 ? '' : 's'}.</div>`
      : '<div class="alert alert-danger py-2 px-3 small mb-3">Your trial has ended. Choose a plan to continue.</div>';
  }

  document.getElementById('plan-summary').innerHTML = `
    ${expiry}
    <h3 class="mb-1">${escapeHtml(plan.name)}</h3>
    <p class="text-muted">${escapeHtml(plan.description)}</p>
    <p class="h5 mb-3">
      ${plan.price === null ? 'Custom pricing' : `$${plan.price}<span class="text-muted fs-6">/${escapeHtml(plan.interval)}</span>`}
    </p>
    ${subscription.overageAllowed
    ? '<div class="alert alert-warning py-2 px-3 small">Overage is enabled: usage beyond your limits is allowed and will be billed.</div>'
    : ''}
    <ul class="list-unstyled d-flex flex-column gap-1 mb-0">${features}</ul>`;
}

function renderMeters(summary) {
  document.getElementById('usage-meters').innerHTML = summary.meters.map(meter => {
    const variant = meterVariant(meter.percentage);
    const scope = meter.resets === 'monthly' ? 'this month' : 'total';

    return `
      <div class="mb-3">
        <div class="d-flex justify-content-between align-items-baseline mb-1">
          <span class="fw-semibold">${escapeHtml(meter.label)}</span>
          <span class="small text-muted">
            ${formatNumber(meter.used)} / ${formatLimit(meter.limit)} ${escapeHtml(scope)}
          </span>
        </div>
        ${meter.percentage === null
    ? '<div class="small text-muted">No limit on this plan.</div>'
    : `<div class="progress" style="height: 8px;" role="progressbar"
               aria-valuenow="${meter.percentage}" aria-valuemin="0" aria-valuemax="100">
               <div class="progress-bar bg-${variant}" style="width: ${Math.min(100, meter.percentage)}%"></div>
             </div>`}
      </div>`;
  }).join('');

  if (summary.detail.limitHits > 0) {
    document.getElementById('usage-meters').insertAdjacentHTML('beforeend', `
      <div class="alert alert-warning py-2 px-3 small mb-0">
        ${formatNumber(summary.detail.limitHits)} action${summary.detail.limitHits === 1 ? ' was' : 's were'}
        blocked this month because a limit was reached.
      </div>`);
  }
}

/** The plans a tenant can buy online right now. */
function buyable() {
  return summary && summary.checkout && summary.checkout.available ? summary.checkout.plans || [] : [];
}

function renderCatalogue(currentPlanId) {
  const canBuy = buyable();

  document.getElementById('plan-catalogue').innerHTML = catalogue.map(plan => {
    const current = plan.id === currentPlanId;
    const purchasable = !current && canBuy.includes(plan.id);
    return `
      <div class="col-md-6 col-xl-3">
        <div class="card h-100 ${current ? 'border-primary' : ''}">
          <div class="card-body d-flex flex-column">
            <div class="d-flex justify-content-between align-items-start">
              <h6 class="card-title mb-1">${escapeHtml(plan.name)}</h6>
              ${current ? '<span class="badge bg-primary">Current</span>' : ''}
            </div>
            <p class="h5 mb-2">
              ${plan.price === null ? 'Custom' : `$${plan.price}<span class="text-muted fs-6">/mo</span>`}
            </p>
            <p class="small text-muted">${escapeHtml(plan.description)}</p>
            <ul class="small text-muted ps-3 mb-3">
              <li>${formatLimit(plan.limits.conversationsPerMonth)} conversations/mo</li>
              <li>${formatLimit(plan.limits.operators)} operator seats</li>
              <li>${formatLimit(plan.limits.workflows)} workflows</li>
            </ul>
            ${purchasable ? `
              <button type="button" class="btn btn-sm btn-primary mt-auto checkout-btn" data-plan="${escapeHtml(plan.id)}">
                Choose ${escapeHtml(plan.name)}
              </button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const note = document.getElementById('plan-change-note');
  if (summary && summary.portalAvailable) {
    note.innerHTML = 'Already paying? <button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="billing-portal-link">Manage your subscription, card and invoices</button>.';
  } else if (canBuy.length) {
    note.textContent = 'You pay on Stripe\'s secure page; your plan changes here as soon as the payment goes through.';
  } else {
    note.textContent = 'Online payment is not set up on this service yet. To change plan, contact the team that runs it.';
  }
}

async function startCheckout(planId, button) {
  setLoading(button, true);
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan: planId } });
    window.location.href = url;
  } catch (error) {
    setLoading(button, false);
    if (error.status === 409 && error.body && error.body.portalAvailable) {
      // Already subscribed: a second checkout would bill them twice, so
      // plan changes go through Stripe's portal instead.
      openPortal();
      return;
    }
    showToast(errorMessage(error, 'Could not start the payment'), 'danger');
  }
}

async function openPortal() {
  try {
    const { url } = await api('/api/billing/portal', { method: 'POST' });
    window.location.href = url;
  } catch (error) {
    showToast(errorMessage(error, 'Could not open the billing portal'), 'danger');
  }
}

async function renderHistory() {
  try {
    const { history } = await api('/api/billing/me/history?months=12');
    const canvas = document.getElementById('usage-history-chart');

    if (!history.length) {
      canvas.parentElement.innerHTML = '<p class="text-muted mb-0">No usage recorded yet.</p>';
      return;
    }

    if (usageHistoryChart) {
      usageHistoryChart.destroy();
    }

    usageHistoryChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: history.map(row => row.period),
        datasets: [
          { label: 'Conversations', data: history.map(r => r.conversations), backgroundColor: '#0d6efd' },
          { label: 'AI replies', data: history.map(r => r.aiResponses), backgroundColor: '#20c997' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 3,
        scales: { y: { beginAtZero: true, suggestedMax: 10, ticks: { precision: 0 } } }
      }
    });

    // Built while the section may still be hidden, in which case the canvas
    // measured zero and Chart.js pinned it there with inline styles.
    requestAnimationFrame(() => {
      if (!usageHistoryChart) {
        return;
      }
      canvas.style.width = '';
      canvas.style.height = '';
      usageHistoryChart.resize();
    });
  } catch (error) {
    logger.error('Failed to load usage history:', error);
  }
}

async function loadBilling() {
  try {
    catalogue = (await api('/api/billing/plans')).plans;
  } catch (error) {
    logger.error('Failed to load the plan catalogue:', error);
  }

  try {
    summary = await api('/api/billing/me');
    renderPlan(summary);
    renderMeters(summary);
    renderCatalogue(summary.plan.id);
    renderHistory();
  } catch (error) {
    logger.error('Failed to load billing:', error);
    document.getElementById('plan-summary').innerHTML =
      `<div class="text-danger">Could not load your plan: ${escapeHtml(error.message)}</div>`;
  }

  feather.replace();
}

function setupBilling() {
  document.getElementById('billing-section').addEventListener('click', event => {
    const checkout = event.target.closest('.checkout-btn');
    if (checkout) {
      startCheckout(checkout.dataset.plan, checkout);
    } else if (event.target.closest('#billing-portal-link')) {
      openPortal();
    }
  });
}

registerSection('billing', {
  setup: setupBilling,
  show(params) {
    // Back from Stripe's checkout page.
    if (params.checkout === 'success') {
      showToast('Thank you - your plan updates as soon as Stripe confirms the payment.', 'success', 8000);
    } else if (params.checkout === 'cancelled') {
      showToast('Payment cancelled. Nothing was charged.', 'info');
    }
    loadBilling();
  }
});
