/**
 * Plan & Usage section.
 *
 * Shows a tenant what they are paying for and how close they are to their
 * limits, so that hitting one is never the first they hear of it. Superadmins
 * additionally get consumption across every tenant and can change plans.
 */

(function() {
  let usageHistoryChart = null;
  let catalogue = [];


  const formatNumber = value => Number(value || 0).toLocaleString();

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

  function renderCatalogue(currentPlanId) {
    document.getElementById('plan-catalogue').innerHTML = catalogue.map(plan => {
      const current = plan.id === currentPlanId;
      return `
        <div class="col-md-6 col-xl-3">
          <div class="card h-100 ${current ? 'border-primary' : ''}">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start">
                <h6 class="card-title mb-1">${escapeHtml(plan.name)}</h6>
                ${current ? '<span class="badge bg-primary">Current</span>' : ''}
              </div>
              <p class="h5 mb-2">
                ${plan.price === null ? 'Custom' : `$${plan.price}<span class="text-muted fs-6">/mo</span>`}
              </p>
              <p class="small text-muted">${escapeHtml(plan.description)}</p>
              <ul class="small text-muted ps-3 mb-0">
                <li>${formatLimit(plan.limits.conversationsPerMonth)} conversations/mo</li>
                <li>${formatLimit(plan.limits.operators)} operator seats</li>
                <li>${formatLimit(plan.limits.workflows)} workflows</li>
              </ul>
            </div>
          </div>
        </div>`;
    }).join('');
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

  async function renderTenantUsage() {
    if (!window.currentUser || window.currentUser.role !== 'superadmin') {
      return;
    }

    const card = document.getElementById('tenant-usage-card');
    card.style.display = '';

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

  async function loadBilling() {
    const user = window.currentUser || {};

    // A superadmin runs the platform rather than belonging to a tenant, so
    // they have no company and no plan of their own. Loading the per-company
    // summary for them used to fail and take the whole page down with it -
    // including the cross-tenant table, which needs no company at all.
    const hasOwnCompany = Boolean(user.company);

    try {
      catalogue = (await api('/api/billing/plans')).plans;
    } catch (error) {
      logger.error('Failed to load the plan catalogue:', error);
    }

    if (hasOwnCompany) {
      try {
        const summary = await api('/api/billing/me');
        renderPlan(summary);
        renderMeters(summary);
        renderCatalogue(summary.plan.id);
        renderHistory();
      } catch (error) {
        logger.error('Failed to load billing:', error);
        document.getElementById('plan-summary').innerHTML =
          `<div class="text-danger">Could not load plan: ${escapeHtml(error.message)}</div>`;
      }
    } else {
      renderPlatformView();
    }

    // Independent of the above: a failure to load one tenant's plan must not
    // hide platform-wide usage.
    await renderTenantUsage();

    if (typeof feather !== 'undefined') {
      feather.replace();
    }
  }

  /**
   * What a superadmin sees in place of "your plan": they administer tenants
   * rather than having a subscription themselves.
   */
  function renderPlatformView() {
    document.getElementById('plan-status').textContent = 'platform';
    document.getElementById('plan-status').className = 'badge bg-dark';

    document.getElementById('plan-summary').innerHTML = `
      <p class="text-muted mb-2">
        You administer the platform, so you are not on a tenant plan yourself.
      </p>
      <p class="text-muted mb-0">
        Usage for every tenant is listed below, and you can change any tenant's
        plan from there.
      </p>`;

    document.getElementById('usage-meters').innerHTML =
      '<p class="text-muted mb-0">Select a tenant below to see their consumption against their plan.</p>';

    document.getElementById('usage-history-chart').parentElement.innerHTML =
      '<p class="text-muted mb-0">Per-tenant history is available from each tenant\'s own dashboard.</p>';

    renderCatalogue(null);

    const hint = document.querySelector('#plan-catalogue')?.parentElement?.querySelector('p.text-muted');
    if (hint) {
      hint.textContent = 'Change a tenant\'s plan from the usage table below.';
    }
  }

  function setupBillingSection() {
    const user = window.currentUser;
    if (!user || (user.role !== 'superadmin' && user.role !== 'company_admin')) {
      return;
    }
    if (!document.getElementById('billing-section')) {
      return;
    }

    document.getElementById('save-plan-btn')?.addEventListener('click', savePlan);
    loadBilling();
  }

  window.setupBillingSection = setupBillingSection;
})();
