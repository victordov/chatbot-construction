/**
 * Team: the people who answer conversations.
 *
 * People join by invitation: an email with a link where they choose their own
 * password, so nobody sends one over chat. Setting a password for somebody is
 * still possible, as the second way. Deactivating someone signs them out
 * everywhere and hands their open chats back to the queue; removing someone
 * keeps the history they are part of and takes their name off it.
 */

import * as bootstrap from 'bootstrap';
import { registerSection } from './nav.js';
import { state } from './state.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, getStoredUser, logger,
  showNotification, showToast
} from './utils.js';

const ROLE_WORDS = { operator: 'Operator', company_admin: 'Admin', superadmin: 'Superadmin' };

let team = [];
let companies = null;

function currentUser() {
  return state.currentUser || getStoredUser() || {};
}

function isSuperadmin() {
  return currentUser().role === 'superadmin';
}

/**
 * Operators for task assignment, in the task form and filter. Used by the
 * Tasks screen, which every operator can open.
 */
export function loadOperators() {
  return api('/api/admin/operators')
    .then(data => {
      const assigneeSelect = document.getElementById('task-assignee-input');
      const assigneeFilter = document.getElementById('task-assignee-filter');

      [assigneeSelect, assigneeFilter].forEach(select => {
        if (!select) {
          return;
        }
        // Clear existing options (except the first one)
        while (select.options.length > 1) {
          select.remove(1);
        }
        data.operators.forEach(operator => {
          const option = document.createElement('option');
          option.value = operator._id;
          option.textContent = operator.displayName || operator.username;
          select.appendChild(option);
        });
      });

      return data.operators;
    })
    .catch(error => {
      logger.error('Error loading operators:', error);
      showNotification('Error', errorMessage(error, 'Failed to load operators'), 'error');
      return [];
    });
}

// ------------------------------------------------------------------ list

function statusBadge(person) {
  if (person.invitePending) {
    return person.inviteExpired
      ? '<span class="badge bg-warning text-dark">Invitation expired</span>'
      : `<span class="badge bg-info text-dark" title="Sent; the link works until ${escapeHtml(new Date(person.inviteExpires).toLocaleDateString())}">Invited</span>`;
  }
  return person.isActive
    ? '<span class="badge bg-success">Active</span>'
    : '<span class="badge bg-secondary">Deactivated</span>';
}

/**
 * What an admin may do to this row. A company admin manages operators; their
 * fellow admins are peers, apart from an invitation nobody has accepted yet.
 */
function actionsFor(person) {
  if (person.isSelf) {
    return '<span class="small text-muted">You</span>';
  }
  const canManage = isSuperadmin() || person.role === 'operator';
  const id = escapeHtml(person._id);

  if (person.invitePending) {
    return `
      <div class="btn-group btn-group-sm">
        <button type="button" class="btn btn-outline-primary" data-action="resend" data-id="${id}">Resend</button>
        <button type="button" class="btn btn-outline-danger" data-action="revoke" data-id="${id}">Withdraw</button>
      </div>`;
  }

  if (!canManage) {
    return '<span class="small text-muted">Admin</span>';
  }

  return `
    <div class="btn-group btn-group-sm">
      <button type="button" class="btn btn-outline-primary" data-action="edit" data-id="${id}">Edit</button>
      <button type="button" class="btn btn-outline-secondary" data-action="toggle" data-id="${id}">
        ${person.isActive ? 'Deactivate' : 'Reactivate'}
      </button>
      <button type="button" class="btn btn-outline-danger" data-action="remove" data-id="${id}">Remove</button>
    </div>`;
}

function renderTeam() {
  const body = document.getElementById('operators-table-body');
  const superadmin = isSuperadmin();

  document.querySelectorAll('.operators-company-col').forEach(cell => cell.classList.toggle('d-none', !superadmin));

  if (!team.length) {
    body.innerHTML = `
      <tr><td colspan="8" class="text-center py-5">
        <div class="fw-semibold mb-1">Nobody else is here yet</div>
        <div class="text-muted small mb-3">Invite the people who will answer conversations. They choose their own password.</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="invite">Invite teammate</button>
      </td></tr>`;
    return;
  }

  body.innerHTML = team.map(person => `
    <tr class="${person.isActive || person.invitePending ? '' : 'text-muted'}">
      <td>
        <div class="team-name">${escapeHtml(person.displayName || person.name || person.email)}</div>
        <div class="team-sub">${escapeHtml(person.username)}</div>
      </td>
      <td>${escapeHtml(person.email)}</td>
      <td>${escapeHtml(ROLE_WORDS[person.role] || person.role)}</td>
      ${superadmin ? `<td>${escapeHtml(person.company ? person.company.name : '—')}</td>` : ''}
      <td>${statusBadge(person)}</td>
      <td>${person.role === 'operator' ? escapeHtml(person.maxConcurrentChats ?? 'Team setting') : '<span class="text-muted">—</span>'}</td>
      <td class="small">${person.lastLogin ? escapeHtml(formatRelativeTime(person.lastLogin)) : '<span class="text-muted">Never</span>'}</td>
      <td class="text-end">${actionsFor(person)}</td>
    </tr>`).join('');
}

async function loadTeam() {
  try {
    const { operators } = await api('/api/admin/all-operators');
    team = operators;
    renderTeam();
  } catch (error) {
    logger.error('Error loading the team:', error);
    document.getElementById('operators-table-body').innerHTML =
      `<tr><td colspan="8" class="text-danger text-center py-4">${escapeHtml(errorMessage(error, 'Could not load your team'))}</td></tr>`;
  }
}

const findPerson = id => team.find(person => String(person._id) === String(id));

// ------------------------------------------------------------- companies

/**
 * Fill a company menu. A company admin has one company and the menu is
 * fixed to it; a superadmin picks.
 */
async function fillCompanies(select, selectedId = null) {
  const user = currentUser();
  while (select.options.length > 1) {
    select.remove(1);
  }

  if (user.role !== 'superadmin') {
    if (user.company) {
      const option = document.createElement('option');
      option.value = user.company.id;
      option.textContent = user.company.name;
      option.selected = true;
      select.appendChild(option);
    }
    select.disabled = true;
    return;
  }

  try {
    if (!companies) {
      companies = (await api('/api/companies')).companies;
    }
    companies.forEach(company => {
      const option = document.createElement('option');
      option.value = company._id;
      option.textContent = company.name;
      option.selected = Boolean(selectedId && String(company._id) === String(selectedId));
      select.appendChild(option);
    });
  } catch (error) {
    showToast(errorMessage(error, 'Failed to load companies'), 'danger');
  }
}

/** Where the company menu shows: for a superadmin, who has to choose. */
function showCompanyChoice(container) {
  if (container) {
    container.classList.toggle('d-none', !isSuperadmin());
  }
}

// -------------------------------------------------------------- invite

/**
 * An invitation that could not be emailed: show the link, once, to copy and
 * send by hand.
 */
function showInviteLink(email, link) {
  const panel = document.getElementById('invite-link-panel');
  if (!link) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = `
    <div class="alert alert-warning alert-dismissible">
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Hide"></button>
      <div class="fw-semibold mb-1">The invitation email could not be sent to ${escapeHtml(email)}.</div>
      <div class="small mb-2">Send them this link yourself. It works once, for seven days.</div>
      <code class="d-block p-2 bg-light text-dark rounded user-select-all text-break">${escapeHtml(link)}</code>
    </div>`;
}

async function openInvite() {
  document.getElementById('invite-operator-form').reset();
  showCompanyChoice(document.getElementById('invite-operator-company-group'));
  if (isSuperadmin()) {
    await fillCompanies(document.getElementById('invite-operator-company'));
  }
  bootstrap.Modal.getOrCreateInstance(document.getElementById('inviteOperatorModal')).show();
  setTimeout(() => document.getElementById('invite-operator-email').focus(), 300);
}

async function sendInvite() {
  const button = document.getElementById('invite-operator-btn');
  const email = document.getElementById('invite-operator-email').value.trim();
  const name = document.getElementById('invite-operator-name').value.trim();
  const role = document.getElementById('invite-operator-role').value;
  const companyId = isSuperadmin() ? document.getElementById('invite-operator-company').value : undefined;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter a valid email address', 'warning');
    return;
  }
  if (isSuperadmin() && !companyId) {
    showToast('Choose the company to invite them to', 'warning');
    return;
  }

  button.disabled = true;
  try {
    const result = await api('/api/admin/operators/invite', {
      method: 'POST',
      body: { email, name: name || undefined, role, companyId }
    });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('inviteOperatorModal')).hide();
    showToast(result.inviteSent ? `Invitation sent to ${email}` : `${email} is on the team; send them the link below`, 'success');
    showInviteLink(email, result.inviteLink);
    loadTeam();
  } catch (error) {
    if (error.status === 402) {
      showToast(`${errorMessage(error, 'No seats left on your plan')} Upgrade under Plan & billing, or invite them as an admin.`, 'warning', 10000);
    } else {
      showToast(errorMessage(error, 'Could not send the invitation'), 'danger');
    }
  } finally {
    button.disabled = false;
  }
}

async function resendInvite(person) {
  try {
    const result = await api(`/api/admin/operators/${encodeURIComponent(person._id)}/resend-invite`, { method: 'POST' });
    showToast(result.inviteSent ? `A new invitation is on its way to ${person.email}` : 'The email could not be sent; copy the link below', result.inviteSent ? 'success' : 'warning');
    showInviteLink(person.email, result.inviteLink);
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not resend the invitation'), 'danger');
  }
}

async function revokeInvite(person) {
  const ok = await confirmDialog({
    title: 'Withdraw this invitation?',
    message: `The link sent to ${person.email} stops working. You can invite them again later.`,
    confirmLabel: 'Withdraw',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/admin/operators/${encodeURIComponent(person._id)}/invite`, { method: 'DELETE' });
    showToast('Invitation withdrawn', 'success');
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not withdraw the invitation'), 'danger');
  }
}

// ---------------------------------------------------- set a password

async function openCreate() {
  document.getElementById('create-operator-form').reset();
  const role = document.getElementById('operator-role');
  role.value = 'operator';
  showCompanyChoice(document.getElementById('company-selection-container'));
  await fillCompanies(document.getElementById('operator-company'));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('createOperatorModal')).show();
}

async function createOperator() {
  const name = document.getElementById('operator-name').value.trim();
  const email = document.getElementById('operator-email').value.trim();
  const role = document.getElementById('operator-role').value;
  const companyId = document.getElementById('operator-company').value;
  const password = document.getElementById('operator-password').value;
  const confirmPassword = document.getElementById('operator-confirm-password').value;

  if (!email || !password || !confirmPassword) {
    showToast('Fill in the email and both password fields', 'warning');
    return;
  }
  if (password.length < 8) {
    showToast('Use at least 8 characters for the password', 'warning');
    return;
  }
  if (password !== confirmPassword) {
    showToast('The two passwords do not match', 'warning');
    return;
  }
  if (!companyId) {
    showToast('Choose a company', 'warning');
    return;
  }

  try {
    await api('/api/admin/operators', {
      method: 'POST',
      body: { displayName: name || undefined, email, role, companyId, password, confirmPassword }
    });
    showToast(`${name || email} can now sign in with that password`, 'success');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('createOperatorModal')).hide();
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not add them'), error.status === 402 ? 'warning' : 'danger');
  }
}

// ------------------------------------------------------------------ edit

async function openEdit(person) {
  document.getElementById('edit-operator-id').value = person._id;
  document.getElementById('edit-operator-display-name').value = person.displayName || person.name || '';
  document.getElementById('edit-operator-email').value = person.email;
  document.getElementById('edit-operator-role').value = person.role === 'company_admin' ? 'company_admin' : 'operator';
  document.getElementById('edit-operator-limit').value = person.maxConcurrentChats ?? '';
  document.getElementById('reset-password-operator-id').value = person._id;

  showCompanyChoice(document.getElementById('edit-company-selection-container'));
  await fillCompanies(document.getElementById('edit-operator-company'), person.company && person.company.id);

  bootstrap.Modal.getOrCreateInstance(document.getElementById('editOperatorModal')).show();
}

async function saveEdit() {
  const id = document.getElementById('edit-operator-id').value;
  const person = findPerson(id);
  const displayName = document.getElementById('edit-operator-display-name').value.trim();
  const email = document.getElementById('edit-operator-email').value.trim();
  const role = document.getElementById('edit-operator-role').value;
  const limit = document.getElementById('edit-operator-limit').value.trim();
  const companyId = document.getElementById('edit-operator-company').value;

  if (!email) {
    showToast('An email address is required', 'warning');
    return;
  }

  if (person && person.role === 'operator' && role === 'company_admin') {
    const ok = await confirmDialog({
      title: `Make ${displayName || email} an admin?`,
      message: 'Admins can change the bot, the team, the plan and every setting - including removing other operators.',
      confirmLabel: 'Make admin'
    });
    if (!ok) {
      return;
    }
  }

  try {
    await api(`/api/admin/operators/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        displayName,
        email,
        role,
        maxConcurrentChats: limit === '' ? null : Number(limit),
        ...(isSuperadmin() && companyId ? { companyId } : {})
      }
    });
    showToast('Saved', 'success');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('editOperatorModal')).hide();
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not save the changes'), 'danger');
  }
}

async function resetPassword() {
  const operatorId = document.getElementById('reset-password-operator-id').value;
  const password = document.getElementById('reset-password-new').value;
  const confirmPassword = document.getElementById('reset-password-confirm').value;

  if (!password || !confirmPassword) {
    showToast('Password and confirm password are required', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'warning');
    return;
  }

  try {
    await api(`/api/admin/operators/${encodeURIComponent(operatorId)}/reset-password`, {
      method: 'POST',
      body: { password, confirmPassword }
    });
    showToast('Password set. They have been signed out everywhere.', 'success');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('resetPasswordModal')).hide();
    const editModal = bootstrap.Modal.getInstance(document.getElementById('editOperatorModal'));
    if (editModal) {
      editModal.hide();
    }
    document.getElementById('reset-password-form').reset();
  } catch (error) {
    showToast(errorMessage(error, 'Failed to reset password'), 'danger');
  }
}

// ---------------------------------------------- deactivate and remove

async function toggleActive(person) {
  const name = person.displayName || person.email;

  if (person.isActive) {
    const ok = await confirmDialog({
      title: `Deactivate ${name}?`,
      message: 'They are signed out everywhere straight away, and any conversations they hold go back to the queue. You can reactivate them later.',
      confirmLabel: 'Deactivate',
      danger: true
    });
    if (!ok) {
      return;
    }
  }

  try {
    const result = await api(`/api/admin/operators/${encodeURIComponent(person._id)}`, {
      method: 'PATCH',
      body: { isActive: !person.isActive }
    });
    showToast(person.isActive
      ? `${name} is deactivated${result.chatsReturnedToQueue ? `; ${result.chatsReturnedToQueue} conversation${result.chatsReturnedToQueue === 1 ? '' : 's'} went back to the queue` : ''}.`
      : `${name} can sign in again.`, 'success');
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not change their status'), error.status === 402 ? 'warning' : 'danger');
  }
}

async function removePerson(person) {
  const name = person.displayName || person.email;
  const ok = await confirmDialog({
    title: `Remove ${name} from the team?`,
    message: 'They are signed out and cannot sign in again. Conversations and notes they wrote stay, under "Removed user". This cannot be undone; to bring them back, invite them again.',
    confirmLabel: 'Remove',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    await api(`/api/admin/operators/${encodeURIComponent(person._id)}`, { method: 'DELETE' });
    showToast(`${name} has been removed`, 'success');
    loadTeam();
  } catch (error) {
    showToast(errorMessage(error, 'Could not remove them'), 'danger');
  }
}

// ----------------------------------------------------------------- wiring

function setupOperators() {
  // Only roles the server will actually create: an operator or another admin.
  ['operator-role', 'edit-operator-role', 'invite-operator-role'].forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      [...select.options].filter(option => !['operator', 'company_admin'].includes(option.value))
        .forEach(option => option.remove());
    }
  });

  document.getElementById('open-invite-operator').addEventListener('click', openInvite);
  document.getElementById('open-create-operator').addEventListener('click', openCreate);
  document.getElementById('invite-operator-btn').addEventListener('click', sendInvite);
  document.getElementById('create-operator-btn').addEventListener('click', createOperator);
  document.getElementById('save-operator-btn').addEventListener('click', saveEdit);
  document.getElementById('confirm-reset-password-btn').addEventListener('click', resetPassword);

  document.getElementById('operators-table-body').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) {
      return;
    }
    if (button.dataset.action === 'invite') {
      openInvite();
      return;
    }
    const person = findPerson(button.dataset.id);
    if (!person) {
      return;
    }
    const handlers = {
      edit: openEdit,
      toggle: toggleActive,
      remove: removePerson,
      resend: resendInvite,
      revoke: revokeInvite
    };
    if (handlers[button.dataset.action]) {
      handlers[button.dataset.action](person);
    }
  });
}

registerSection('operators', {
  setup: setupOperators,
  show: loadTeam
});
