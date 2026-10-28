/**
 * Plan & billing.
 *
 * Shows a tenant what they are paying for and how close they are to their
 * limits, so that hitting one is never the first they hear of it, and lets
 * them pay: choosing a plan goes to Stripe's own checkout page, so card
 * details never reach this server.
 *
 * A plan that can be paid per resolution gets a card of its own: how the
 * plan is paid for, in a sentence; this month's resolutions and what they
 * cost, with the definition of a resolution one click away; the projected
 * bill; and the monthly cap, which billing never goes past.
 */

import Chart from 'chart.js/auto';
import feather from 'feather-icons';
import { refreshPlanStatus } from './core.js';
import { registerSection } from './nav.js';
import { api, errorMessage, escapeHtml, logger, safeHref, setLoading, showToast } from './utils.js';

let usageHistoryChart = null;
let catalogue = [];
let summary = null;


export const formatNumber = value => Number(value || 0).toLocaleString();

/**
 * Turn a camelCase feature key into a label. Acronyms are spelled out
 * explicitly, because naive title-casing renders `apiAccess` as
 * "Api Access" and `aiSuggestions` as "Ai Suggestions".
 *
 * Only what the product actually does is listed: priority support was on
 * the cards but was never built, and promising it is how a customer ends up
 * asking for a refund. Custom branding is listed now that agencies have it.
 */
const FEATURE_LABELS = {
  workflows: 'Workflows',
  knowledgeBase: 'Knowledge base',
  aiSuggestions: 'AI suggested replies',
  analytics: 'Reports',
  fileUploads: 'File uploads',
  actions: 'Actions',
  apiAccess: 'API access',
  customBranding: 'Your brand on your clients\' dashboards and mail'
};

/** "$64.68", "$100". */
const money = amount => {
  const fixed = Number(amount || 0).toFixed(2);
  return `$${fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed}`;
};

const featureLabel = key => FEATURE_LABELS[key] ||
  key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

/** `null` limits mean unlimited, which reads better than "null". */
const formatLimit = limit => (limit === null || limit === undefined ? 'Unlimited' : formatNumber(limit));

/** "1 operator seat", "3 operator seats", "Unlimited operator seats". */
function counted(limit, singular, plural) {
  if (limit === null || limit === undefined) {
    return `Unlimited ${plural}`;
  }
  return `${formatNumber(limit)} ${Number(limit) === 1 ? singular : plural}`;
}

/** The status as a person would say it. */
const STATUS_WORDS = {
  active: 'Active',
  trialing: 'Trial',
  trial_expired: 'Trial ended',
  past_due: 'Payment overdue',
  cancelled: 'Cancelled',
  suspended: 'Suspended'
};

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

/**
 * The alert at the top of the screen when the plan needs doing something
 * about. An ended trial used to show nothing here at all: the check looked
 * for `trialing`, and the server says `trial_expired`.
 */
function renderAlert(summary) {
  const alert = document.getElementById('billing-alert');
  const { subscription } = summary;
  const canBuy = buyable().length > 0;
  const action = canBuy
    ? '<a href="#plan-catalogue" class="alert-link">Choose a plan below</a>'
    : 'Contact the team that runs this service to choose a plan.';

  if (subscription.status === 'trial_expired') {
    alert.innerHTML = `
      <div class="alert alert-danger">
        <strong>Your trial has ended.</strong> The bot has stopped answering your visitors and
        nothing new can be added. Your settings and conversations are kept. ${action}
      </div>`;
  } else if (subscription.status === 'past_due') {
    alert.innerHTML = `
      <div class="alert alert-warning">
        <strong>The last payment did not go through.</strong> Everything keeps working for now.
        ${summary.portalAvailable ? '<button type="button" class="btn btn-link alert-link p-0 align-baseline" id="billing-portal-alert">Update your card</button>.' : ''}
      </div>`;
  } else if (subscription.status === 'cancelled' || subscription.status === 'suspended') {
    alert.innerHTML = `
      <div class="alert alert-danger">
        <strong>This account is ${escapeHtml(STATUS_WORDS[subscription.status].toLowerCase())}.</strong>
        The bot is not answering. ${action}
      </div>`;
  } else {
    alert.innerHTML = '';
  }
}

function renderPlan(summary) {
  const { plan, subscription } = summary;

  const statusBadge = document.getElementById('plan-status');
  statusBadge.textContent = STATUS_WORDS[subscription.status] || subscription.status.replace('_', ' ');
  statusBadge.className = `badge bg-${
    subscription.status === 'active' ? 'success'
      : subscription.status === 'trialing' ? 'info'
        : subscription.status === 'past_due' ? 'warning text-dark'
          : 'danger'}`;

  const features = Object.entries(plan.features)
    .filter(([key]) => FEATURE_LABELS[key])
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
      ? `<div class="alert alert-info py-2 px-3 small mb-3">Trial ends in ${days} day${days === 1 ? '' : 's'}, on ${escapeHtml(new Date(subscription.trialEndsAt).toLocaleDateString())}.</div>`
      : '';
  }

  const pricing = summary.pricing;
  const perResolution = pricing && pricing.model === 'per_resolution';
  const price = perResolution
    ? `${money(pricing.pricing.baseFee)}<span class="text-muted fs-6">/${escapeHtml(plan.interval)}</span>
       <span class="fs-6">+ ${money(pricing.pricing.perResolution)} per resolution</span>`
    : plan.price === null ? 'Custom pricing' : `$${plan.price}<span class="text-muted fs-6">/${escapeHtml(plan.interval)}</span>`;

  document.getElementById('plan-summary').innerHTML = `
    ${expiry}
    <h3 class="mb-1">${escapeHtml(plan.name)}</h3>
    <p class="text-muted">${escapeHtml(plan.description)}</p>
    <p class="h5 mb-3">${price}</p>
    ${subscription.overageAllowed
    ? '<div class="alert alert-warning py-2 px-3 small">Overage is on for your account: going past a limit does not stop anything, and the extra is billed.</div>'
    : ''}
    <ul class="list-unstyled d-flex flex-column gap-1 mb-0">${features}</ul>`;
}

function renderMeters(summary) {
  document.getElementById('usage-meters').innerHTML = summary.meters.map(meter => {
    const variant = meterVariant(meter.percentage);
    const scope = meter.resets === 'monthly' ? 'this month' : 'in use';

    // The spending cap is in money, and is a line billing stops at rather
    // than one the bot stops at.
    if (meter.money) {
      return `
      <div class="mb-3">
        <div class="d-flex justify-content-between align-items-baseline mb-1">
          <span class="fw-semibold">${escapeHtml(meter.label)}</span>
          <span class="small text-muted">${money(meter.used)} / ${money(meter.limit)} ${escapeHtml(scope)}</span>
        </div>
        <div class="progress" style="height: 8px;" role="progressbar"
             aria-label="${escapeHtml(meter.label)}"
             aria-valuenow="${meter.percentage}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar bg-${variant}" style="width: ${Math.min(100, meter.percentage || 0)}%"></div>
        </div>
      </div>`;
    }

    if (meter.limit === 0) {
      return `
        <div class="mb-3">
          <div class="d-flex justify-content-between align-items-baseline mb-1">
            <span class="fw-semibold">${escapeHtml(meter.label)}</span>
            <span class="small text-muted">Not on this plan</span>
          </div>
        </div>`;
    }

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
               aria-label="${escapeHtml(meter.label)}"
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

/**
 * The pricing card: how the plan is paid for, this month's resolutions and
 * what they cost against the cap, the projection, and the cap itself. Only
 * on a plan that can be paid per resolution.
 */
function renderPricing(summary) {
  const card = document.getElementById('billing-pricing-card');
  const pricing = summary.pricing;

  if (!pricing || !pricing.available || !pricing.bill) {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');

  const perResolution = pricing.model === 'per_resolution';
  const terms = pricing.pricing;
  const bill = pricing.bill;
  const badge = document.getElementById('billing-pricing-model');
  badge.textContent = perResolution ? 'Per resolution' : 'Flat price';
  badge.className = `badge ${perResolution ? 'bg-primary' : 'bg-secondary'}`;

  const included = terms.includedResolutions
    ? `, after the first ${formatNumber(terms.includedResolutions)} each month`
    : '';
  const model = perResolution
    ? `You pay ${money(terms.baseFee)} a month, plus ${money(terms.perResolution)} for each conversation the bot resolves${included}.`
    : `You pay a flat ${money(pricing.flatPrice)} a month. The same plan can instead be paid per resolution: ${money(terms.baseFee)} a month plus ${money(terms.perResolution)} for each conversation the bot resolves${included}.`;

  const cap = bill.cap === null ? 'no cap' : `cap ${money(bill.cap)}`;
  const count = `${formatNumber(bill.billable)} resolution${bill.billable === 1 ? '' : 's'} × ${money(bill.price)} = ${money(bill.amount)}`;
  const month = perResolution
    ? `<p class="h5 mb-1">This month: ${escapeHtml(count)} <span class="text-muted fs-6">(${escapeHtml(cap)})</span></p>`
    : `<p class="mb-1">This month the bot resolved <strong>${formatNumber(bill.resolutions)}</strong> conversation${bill.resolutions === 1 ? '' : 's'}. Per resolution, the month so far would come to ${money(pricing.total)} with the base fee, against your flat ${money(pricing.flatPrice)}.</p>`;

  const notes = [];
  if (perResolution && bill.included && bill.resolutions) {
    notes.push(`${formatNumber(Math.min(bill.resolutions, bill.included))} of ${formatNumber(bill.resolutions)} were in the free allowance.`);
  }
  if (perResolution && bill.unbilled > 0) {
    notes.push(`${formatNumber(bill.unbilled)} more ${bill.unbilled === 1 ? 'was' : 'were'} not billed: the cap was reached. The bot kept answering.`);
  }
  if (perResolution && pricing.projected) {
    notes.push(`Projected for the month: about ${formatNumber(pricing.projected.resolutions)} resolutions, ${money(pricing.projected.total)} with the base fee${pricing.projected.capReached ? ' - the cap stops it there' : ''}.`);
  }
  if (perResolution) {
    notes.push(`So far this month: ${money(pricing.total)} with the base fee.`);
  }
  if (perResolution && !pricing.metered) {
    notes.push('Resolutions are counted here; how they are invoiced is arranged with the team that runs this service.');
  }

  document.getElementById('billing-pricing').innerHTML = `
    <p class="mb-2">${escapeHtml(model)}</p>
    ${month}
    ${notes.map(note => `<p class="small text-muted mb-1">${escapeHtml(note)}</p>`).join('')}`;

  document.getElementById('resolution-definition').textContent =
    `${pricing.definition} A conversation is counted once it has ended or been quiet for ${pricing.settleHours} hours, ` +
    'so one that turns into a handover is never billed. It is the same definition, and the same count, as the value report under Reports.';

  const form = document.getElementById('spend-cap-form');
  form.classList.toggle('d-none', !perResolution);
  document.getElementById('spend-cap-input').value = bill.cap === null ? '' : bill.cap;
  form.querySelectorAll('input, button').forEach(element => {
    element.disabled = Boolean(summary.actingAs);
  });
  if (summary.actingAs) {
    document.getElementById('spend-cap-help').textContent =
      'The cap is set by the client\'s own admins, not while you are working in their account.';
  }
}

async function saveCap(event) {
  event.preventDefault();
  const raw = document.getElementById('spend-cap-input').value.trim();
  const cap = raw === '' ? null : Number(raw);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
    showToast('Enter an amount from 0 upwards, or leave it empty for no cap', 'warning');
    return;
  }

  const button = document.getElementById('spend-cap-save');
  setLoading(button, true);
  try {
    const { pricing } = await api('/api/billing/me/spend-cap', { method: 'PUT', body: { cap } });
    summary.pricing = pricing;
    renderPricing(summary);
    showToast(cap === null ? 'Cap removed.' : `Cap set: resolutions past ${money(cap)} this month are not billed.`, 'success');
    refreshPlanStatus();
  } catch (error) {
    showToast(errorMessage(error, 'Could not save the cap'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

/** The plans a tenant can buy online right now. */
function buyable() {
  if (summary && summary.actingAs) {
    return [];
  }
  return summary && summary.checkout && summary.checkout.available ? summary.checkout.plans || [] : [];
}

/** The plans a tenant can buy per resolution online right now. */
function buyablePerResolution() {
  if (summary && summary.actingAs) {
    return [];
  }
  return summary && summary.resolutionCheckout && summary.resolutionCheckout.available
    ? summary.resolutionCheckout.plans || []
    : [];
}

function renderCatalogue(currentPlanId) {
  const canBuy = buyable();
  const canBuyPerResolution = buyablePerResolution();

  document.getElementById('plan-catalogue').innerHTML = catalogue
    // The trial is where everyone starts, not something to choose; the
    // Agency plan is only for a company we have made an agency.
    .filter(plan => plan.id !== 'trial' || plan.id === currentPlanId)
    .filter(plan => plan.id !== 'agency' || plan.id === currentPlanId || (summary && summary.isAgency))
    .map(plan => {
      const current = plan.id === currentPlanId;
      const purchasable = !current && canBuy.includes(plan.id);
      const perResolution = !current && canBuyPerResolution.includes(plan.id);
      const resolutionOption = plan.pricing && plan.pricing.options && plan.pricing.options.includes('per_resolution')
        ? `<li>Or ${money(plan.pricing.baseFee)}/mo + ${money(plan.pricing.perResolution)} per resolution, with a monthly cap you set</li>`
        : '';
      const agencyTerms = plan.agency
        ? `<li>${formatNumber(plan.agency.clientsIncluded)} client companies included, ${money(plan.agency.perClientPrice)}/mo for each one more</li>`
        : '';
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
              <li>${counted(plan.limits.conversationsPerMonth, 'conversation', 'conversations')} a month</li>
              <li>${counted(plan.limits.aiResponsesPerMonth, 'AI reply', 'AI replies')} a month</li>
              <li>${counted(plan.limits.operators, 'operator seat', 'operator seats')}</li>
              <li>${counted(plan.limits.workflows, 'live workflow', 'live workflows')}</li>
              <li>${plan.limits.actions === 0 ? 'No actions' : counted(plan.limits.actions, 'action', 'actions')}</li>
              ${plan.features.apiAccess ? '<li>API access and webhooks</li>' : ''}
              ${plan.features.analytics === 'advanced' ? '<li>Full reports</li>' : ''}
              ${agencyTerms}
              ${resolutionOption}
            </ul>
            <div class="mt-auto d-grid gap-1">
            ${purchasable ? `
              <button type="button" class="btn btn-sm btn-primary checkout-btn" data-plan="${escapeHtml(plan.id)}">
                Choose ${escapeHtml(plan.name)}
              </button>` : ''}
            ${perResolution ? `
              <button type="button" class="btn btn-sm btn-outline-primary checkout-btn" data-plan="${escapeHtml(plan.id)}" data-pricing="per_resolution">
                ${escapeHtml(plan.name)}, per resolution
              </button>` : ''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

  const note = document.getElementById('plan-change-note');
  if (summary && summary.actingAs) {
    note.textContent = 'You are working in this client\'s account. Its plan and payment are changed by its own admins.';
  } else if (summary && summary.portalAvailable) {
    note.innerHTML = 'Already paying? <button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="billing-portal-link">Manage your subscription, card and invoices</button>.';
  } else if (canBuy.length) {
    note.textContent = 'You pay on Stripe\'s secure page; your plan changes here as soon as the payment goes through.';
  } else {
    note.textContent = 'Online payment is not set up on this service yet. To change plan, contact the team that runs it.';
  }
}

async function startCheckout(planId, button, pricing) {
  setLoading(button, true);
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan: planId, pricing } });
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
    const container = canvas.parentElement;
    let empty = container.querySelector('.chart-empty-state');

    // An empty period used to replace the canvas with a sentence, so the
    // chart could never come back without a reload. The canvas stays; the
    // sentence sits beside it.
    if (!history.length) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'chart-empty-state text-muted mb-0';
        container.appendChild(empty);
      }
      empty.textContent = 'No usage recorded yet.';
      canvas.style.display = 'none';
      return;
    }

    if (empty) {
      empty.remove();
    }
    canvas.style.display = '';

    if (usageHistoryChart) {
      usageHistoryChart.destroy();
    }

    usageHistoryChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: history.map(row => row.period),
        datasets: [
          { label: 'Conversations', data: history.map(r => r.conversations || 0), backgroundColor: '#0d6efd' },
          { label: 'AI replies', data: history.map(r => r.aiResponses || 0), backgroundColor: '#20c997' },
          { label: 'Resolved by the bot', data: history.map(r => r.resolutions || 0), backgroundColor: '#6f42c1' }
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

/** Stripe's invoices, when Stripe is how this tenant pays. */
async function renderInvoices() {
  const card = document.getElementById('billing-invoices-card');
  const container = document.getElementById('billing-invoices');

  try {
    const { available, invoices } = await api('/api/billing/invoices');
    card.classList.toggle('d-none', !available);
    if (!available) {
      return;
    }

    if (!invoices.length) {
      container.innerHTML = '<p class="text-muted small mb-0">No invoices yet. They appear here after your first payment.</p>';
      return;
    }

    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
          <thead><tr><th>Date</th><th>Number</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${invoices.map(invoice => {
    const href = safeHref(invoice.hostedUrl || invoice.pdfUrl || '');
    return `
              <tr>
                <td>${escapeHtml(invoice.created ? new Date(invoice.created).toLocaleDateString() : '')}</td>
                <td>${escapeHtml(invoice.number || '—')}</td>
                <td>${invoice.total === null ? '—' : `${escapeHtml(invoice.total.toFixed(2))} ${escapeHtml(invoice.currency || '')}`}</td>
                <td><span class="badge bg-${invoice.status === 'paid' ? 'success' : invoice.status === 'open' ? 'warning text-dark' : 'secondary'}">${escapeHtml(invoice.status)}</span></td>
                <td class="text-end">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}</td>
              </tr>`;
  }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (error) {
    card.classList.remove('d-none');
    container.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(errorMessage(error, 'Could not load your invoices'))}</p>`;
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
    renderPricing(summary);
    renderCatalogue(summary.plan.id);
    renderAlert(summary);
    renderHistory();
    renderInvoices();
  } catch (error) {
    logger.error('Failed to load billing:', error);
    document.getElementById('plan-summary').innerHTML =
      `<div class="text-danger">Could not load your plan: ${escapeHtml(error.message)}</div>`;
  }

  feather.replace();
}

function setupBilling() {
  document.getElementById('spend-cap-form').addEventListener('submit', saveCap);
  document.getElementById('billing-section').addEventListener('click', event => {
    const checkout = event.target.closest('.checkout-btn');
    if (checkout) {
      startCheckout(checkout.dataset.plan, checkout, checkout.dataset.pricing);
    } else if (event.target.closest('#billing-portal-link, #billing-portal-alert')) {
      openPortal();
    }
  });
}

/**
 * Stripe sends the customer back with `?checkout=` in the address. Read it
 * once and take it out, so a reload or coming back to this screen later does
 * not thank them for paying again.
 */
function consumeCheckoutReturn(params) {
  const outcome = params.checkout;
  if (!outcome) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete('checkout');
  url.hash = url.hash.replace(/\?.*$/, '');
  if (!url.searchParams.get('section')) {
    url.searchParams.set('section', 'billing');
  }
  window.history.replaceState({}, '', url);

  if (outcome === 'success') {
    showToast('Thank you - your plan updates as soon as Stripe confirms the payment.', 'success', 8000);
    // The banner may still say the trial has ended until it does.
    setTimeout(refreshPlanStatus, 5000);
  } else if (outcome === 'cancelled') {
    showToast('Payment cancelled. Nothing was charged.', 'info');
  }
}

registerSection('billing', {
  setup: setupBilling,
  show(params) {
    consumeCheckoutReturn(params);
    loadBilling();
  }
});
