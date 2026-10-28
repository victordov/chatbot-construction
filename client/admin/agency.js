/**
 * Clients: an agency's view of the businesses it runs support for.
 *
 * One row per client with what an agency checks first - is it paying, is
 * the widget on their site, is anybody talking to it, is the bot resolving
 * anything - and the three things it does from here: add a client (which
 * invites the client's first admin), open a client's dashboard to work in
 * it, and remove a client (which detaches it; nothing of theirs is deleted).
 *
 * Below the list, the agency's brand: what its clients see instead of ours.
 */

import * as bootstrap from 'bootstrap';
import { enterClientDashboard } from './core.js';
import { registerSection } from './nav.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, setLoading, showToast
} from './utils.js';

const PLAN_NAMES = { trial: 'Trial', basic: 'Basic', professional: 'Professional', agency: 'Agency', enterprise: 'Enterprise' };

const STATUS_STYLE = {
  active: ['success', 'Active'],
  trialing: ['info text-dark', 'Trial'],
  trial_expired: ['danger', 'Trial ended'],
  past_due: ['warning text-dark', 'Payment overdue'],
  cancelled: ['secondary', 'Cancelled'],
  suspended: ['danger', 'Suspended']
};

let overview = null;

const money = amount => `$${Number(amount || 0).toFixed(2).replace(/\.00$/, '')}`;

function renderTerms() {
  const terms = document.getElementById('agency-terms');
  if (!overview) {
    terms.textContent = '';
    return;
  }
  const extra = overview.extraClients
    ? ` ${overview.extraClients} more at ${money(overview.perClientPrice)} each: ${money(overview.extraClientsCost)} a month.`
    : '';
  terms.textContent = `${overview.clients} of ${overview.clientLimit} clients. ` +
    `${overview.clientsIncluded} are included in your plan.${extra}`;
}

function clientRow(client) {
  const [tone, words] = STATUS_STYLE[client.status] || ['secondary', client.status];
  const installed = client.installed
    ? `<span class="badge bg-success">Seen ${escapeHtml(formatRelativeTime(client.widgetSeenAt))}</span>`
    : '<span class="badge bg-light text-dark">Not installed</span>';
  const rate = client.resolutionRate === null ? '<span class="text-muted">—</span>' : `${client.resolutionRate}%`;

  return `
    <tr class="${client.isActive ? '' : 'text-muted'}">
      <td>
        <div class="fw-semibold">${escapeHtml(client.name)}</div>
        <div class="small text-muted">${escapeHtml(client.website)}</div>
      </td>
      <td>
        <span class="badge bg-light text-dark">${escapeHtml(PLAN_NAMES[client.planId] || client.planId)}</span>
        ${client.isActive ? `<span class="badge bg-${tone}">${escapeHtml(words)}</span>` : '<span class="badge bg-danger">Switched off</span>'}
        ${client.managedByAgency ? '<div class="small text-muted">Paid by you</div>' : ''}
      </td>
      <td>${installed}</td>
      <td class="text-end">${Number(client.conversationsThisMonth).toLocaleString()}</td>
      <td class="text-end">${rate}</td>
      <td class="small">${client.lastActivity ? escapeHtml(formatRelativeTime(client.lastActivity)) : '<span class="text-muted">Nothing yet</span>'}</td>
      <td class="text-end text-nowrap">
        <button type="button" class="btn btn-sm btn-primary agency-open-client" data-id="${escapeHtml(client.id)}"
                ${client.isActive ? '' : 'disabled'}>Open dashboard</button>
        <button type="button" class="btn btn-sm btn-outline-danger agency-remove-client"
                data-id="${escapeHtml(client.id)}" data-name="${escapeHtml(client.name)}">Remove</button>
      </td>
    </tr>`;
}

async function loadClients() {
  const body = document.getElementById('agency-clients-body');
  try {
    const { clients } = await api('/api/agency/clients');
    body.innerHTML = clients.length
      ? clients.map(clientRow).join('')
      : '<tr><td colspan="7" class="text-center text-muted py-4">No clients yet. Add the first one: they get an invitation under your brand.</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="text-danger">${escapeHtml(errorMessage(error, 'Could not load your clients'))}</td></tr>`;
  }
}

function renderBrand() {
  const brand = overview.branding;
  document.getElementById('agency-brand-name').value = brand.productName;
  document.getElementById('agency-brand-email').value = brand.supportEmail;
  document.getElementById('agency-brand-logo').value = brand.logoUrl;
  document.getElementById('agency-brand-color').value = brand.primaryColor || '#2563eb';

  const form = document.getElementById('agency-brand-form');
  form.querySelectorAll('input, button').forEach(element => {
    element.disabled = !overview.brandingAllowed;
  });
  if (!overview.brandingAllowed) {
    document.getElementById('agency-brand-note').innerHTML =
      'Your own brand comes with the Agency plan. <a href="?section=billing" data-section-link="billing">See plans</a>.';
  }
}

async function load() {
  const unavailable = document.getElementById('agency-unavailable');
  const content = document.getElementById('agency-content');
  try {
    overview = await api('/api/agency/me');
    unavailable.classList.add('d-none');
    content.classList.remove('d-none');
  } catch (error) {
    overview = null;
    unavailable.classList.toggle('d-none', error.status !== 403);
    content.classList.toggle('d-none', error.status === 403);
    if (error.status !== 403) {
      showToast(errorMessage(error, 'Could not load your agency'), 'danger');
    }
    return;
  }
  renderTerms();
  renderBrand();
  loadClients();
}

// ------------------------------------------------------------------ actions

function openAddClient() {
  if (!overview) {
    return;
  }
  const select = document.getElementById('client-plan');
  const clientPlan = PLAN_NAMES[overview.clientPlan] || overview.clientPlan;
  select.innerHTML = `
    <option value="trial">Trial - they choose and pay for a plan themselves</option>
    <option value="${escapeHtml(overview.clientPlan)}">${escapeHtml(clientPlan)} - paid by you, as part of your plan</option>`;
  document.getElementById('client-plan-help').textContent = overview.clients >= overview.clientsIncluded
    ? `You have used the ${overview.clientsIncluded} clients your plan includes; this one adds ${money(overview.perClientPrice)} a month.`
    : `${overview.clientsIncluded - overview.clients} more clients are included in your plan.`;
  document.getElementById('add-client-form').reset();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('addClientModal')).show();
}

async function addClient() {
  const name = document.getElementById('client-name').value.trim();
  const adminEmail = document.getElementById('client-admin-email').value.trim();

  if (!name) {
    showToast('Enter the client\'s company name', 'warning');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    showToast('Enter the email address of the client\'s first admin', 'warning');
    return;
  }

  const button = document.getElementById('add-client-submit');
  setLoading(button, true);
  try {
    const result = await api('/api/agency/clients', {
      method: 'POST',
      body: {
        name,
        adminEmail,
        website: document.getElementById('client-website').value.trim() || undefined,
        adminName: document.getElementById('client-admin-name').value.trim() || undefined,
        plan: document.getElementById('client-plan').value
      }
    });

    showToast(result.message, result.inviteSent ? 'success' : 'warning', 8000);
    document.getElementById('agency-invite-link').innerHTML = result.inviteLink ? `
      <div class="alert alert-warning alert-dismissible">
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Hide"></button>
        <div class="fw-semibold mb-1">Send this invitation link to ${escapeHtml(adminEmail)} yourself.</div>
        <code class="d-block p-2 bg-light text-dark rounded user-select-all text-break">${escapeHtml(result.inviteLink)}</code>
      </div>` : '';

    bootstrap.Modal.getInstance(document.getElementById('addClientModal')).hide();
    load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not add the client'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function openClient(button) {
  setLoading(button, true);
  try {
    const { token } = await api(`/api/agency/clients/${encodeURIComponent(button.dataset.id)}/open`, { method: 'POST' });
    enterClientDashboard(token);
  } catch (error) {
    setLoading(button, false);
    showToast(errorMessage(error, 'Could not open the client\'s dashboard'), 'danger');
  }
}

async function removeClient(button) {
  const name = button.dataset.name || 'this client';
  const ok = await confirmDialog({
    title: `Remove ${name}?`,
    message: 'They stop being your client: you can no longer open their dashboard, and they stop seeing your brand. ' +
      'Nothing of theirs is deleted - their team, settings and conversations stay with them. ' +
      'If you were paying for their plan, they move to a trial to choose their own.',
    confirmLabel: 'Remove client',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    const result = await api(`/api/agency/clients/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
    showToast(result.message, 'success');
    load();
  } catch (error) {
    showToast(errorMessage(error, 'Could not remove the client'), 'danger');
  }
}

async function saveBrand(event) {
  event.preventDefault();
  const button = document.getElementById('agency-brand-save');
  setLoading(button, true);
  try {
    const { branding } = await api('/api/agency/branding', {
      method: 'PUT',
      body: {
        productName: document.getElementById('agency-brand-name').value,
        supportEmail: document.getElementById('agency-brand-email').value,
        logoUrl: document.getElementById('agency-brand-logo').value,
        primaryColor: document.getElementById('agency-brand-color').value
      }
    });
    overview.branding = branding;
    showToast('Saved. Your clients see it the next time they load their dashboard.', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not save your brand'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

function setup() {
  document.getElementById('agency-add-client-btn').addEventListener('click', openAddClient);
  document.getElementById('add-client-submit').addEventListener('click', addClient);
  document.getElementById('agency-brand-form').addEventListener('submit', saveBrand);
  document.getElementById('agency-clients-body').addEventListener('click', event => {
    const open = event.target.closest('.agency-open-client');
    const remove = event.target.closest('.agency-remove-client');
    if (open) {
      openClient(open);
    } else if (remove) {
      removeClient(remove);
    }
  });
}

registerSection('agency', { setup, show: load });
