/**
 * Companies: the tenants, for whoever runs the platform.
 *
 * The list says what somebody running the platform needs at a glance: the
 * plan and its state, whether the company signed itself up, whether its
 * widget has ever been seen on a real website, and when anything last
 * happened there.
 */

import * as bootstrap from 'bootstrap';
import { registerSection } from './nav.js';
import {
  api, authToken, confirmDialog, debounce, errorMessage, escapeHtml, formatRelativeTime, getStoredUser,
  parseJsonResponse, showToast
} from './utils.js';

const STATUS_STYLE = {
  active: ['success', 'Active'],
  trialing: ['info text-dark', 'Trial'],
  trial_expired: ['danger', 'Trial ended'],
  past_due: ['warning text-dark', 'Payment overdue'],
  cancelled: ['secondary', 'Cancelled'],
  suspended: ['danger', 'Suspended']
};

let searchTerm = '';

/**
 * Which companies are agencies, and whose client each client is
 * (routes/agency.js). An empty map when it cannot be read: the list is still
 * worth showing without it.
 */
async function loadAgencyMap() {
  try {
    const { agencies, clients } = await api('/api/agency/companies');
    return {
      agencies: new Map(agencies.map(row => [String(row.id), row])),
      clients: new Map(clients.map(row => [String(row.id), row]))
    };
  } catch (error) {
    return { agencies: new Map(), clients: new Map() };
  }
}

function agencyBadge(company, agencyMap) {
  const agency = agencyMap.agencies.get(String(company._id));
  if (agency) {
    return `<div><span class="badge bg-primary">Agency</span> <span class="small text-muted">${agency.clients} of ${agency.clientLimit} clients</span></div>`;
  }
  const client = agencyMap.clients.get(String(company._id));
  return client
    ? `<div class="small text-muted">Client of ${escapeHtml(client.agencyName || 'an agency')}</div>`
    : '';
}

function companyRow(company, agencyMap = { agencies: new Map(), clients: new Map() }) {
  const [tone, words] = STATUS_STYLE[company.status] || ['secondary', company.status];
  const isAgency = agencyMap.agencies.has(String(company._id));
  const isClient = agencyMap.clients.has(String(company._id));
  const createdDate = new Date(company.createdAt).toLocaleDateString();
  const installed = company.installed
    ? `<span class="badge bg-success" title="${escapeHtml(company.widgetOrigin || '')}">Seen ${escapeHtml(formatRelativeTime(company.widgetSeenAt))}</span>`
    : '<span class="badge bg-light text-dark">Never</span>';

  return `
    <tr class="${company.isActive ? '' : 'text-muted'}">
      <td>
        <div class="fw-semibold">${escapeHtml(company.name)}</div>
        <div class="small text-muted">${escapeHtml(company.website || '')}</div>
        ${agencyBadge(company, agencyMap)}
      </td>
      <td><span class="badge bg-light text-dark">${escapeHtml(company.planId)}</span></td>
      <td>
        ${company.isActive
    ? `<span class="badge bg-${tone}">${escapeHtml(words)}</span>`
    : '<span class="badge bg-danger">Deactivated</span>'}
      </td>
      <td class="small">${company.createdVia === 'signup' ? 'Signed up' : 'Created here'}</td>
      <td>${installed}</td>
      <td class="small">${company.lastActivity ? escapeHtml(formatRelativeTime(company.lastActivity)) : '<span class="text-muted">Nothing yet</span>'}</td>
      <td class="small">${escapeHtml(createdDate)}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary view-company" data-id="${escapeHtml(company._id)}">View</button>
          <button class="btn btn-outline-secondary edit-company" data-id="${escapeHtml(company._id)}">Edit</button>
          <button class="btn ${company.isActive ? 'btn-outline-danger' : 'btn-outline-success'} toggle-company-status"
                  data-id="${escapeHtml(company._id)}"
                  data-name="${escapeHtml(company.name)}"
                  data-status="${company.isActive}">
            ${company.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          ${isClient ? '' : `
          <button class="btn btn-outline-secondary toggle-company-agency" data-id="${escapeHtml(company._id)}"
                  data-name="${escapeHtml(company.name)}" data-agency="${isAgency}">
            ${isAgency ? 'Stop agency' : 'Make agency'}
          </button>`}
        </div>
      </td>
    </tr>`;
}

// Load all companies
async function loadAllCompanies() {
  const currentUser = getStoredUser() || {};

  // Only superadmins can see all companies
  if (currentUser.role !== 'superadmin') {
    if (currentUser.company) {
      // Company admins can only see their own company
      loadCompany(currentUser.company.id);
    } else {
      showToast('You do not have access to any company', 'warning');
    }
    return;
  }

  const tableBody = document.getElementById('companies-table-body');
  if (!tableBody) {
    return;
  }

  try {
    const query = searchTerm ? `?q=${encodeURIComponent(searchTerm)}` : '';
    const [{ companies }, agencyMap] = await Promise.all([api(`/api/companies${query}`), loadAgencyMap()]);

    if (!companies.length) {
      tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">${searchTerm
        ? 'No company matches that search.'
        : 'No companies yet. Create one, or turn on self-serve sign-up.'}</td></tr>`;
      return;
    }

    tableBody.innerHTML = companies.map(company => companyRow(company, agencyMap)).join('');

    tableBody.querySelectorAll('.view-company').forEach(button => {
      button.addEventListener('click', viewCompany);
    });
    tableBody.querySelectorAll('.edit-company').forEach(button => {
      button.addEventListener('click', openEditCompanyModal);
    });
    tableBody.querySelectorAll('.toggle-company-status').forEach(button => {
      button.addEventListener('click', toggleCompanyStatus);
    });
    tableBody.querySelectorAll('.toggle-company-agency').forEach(button => {
      button.addEventListener('click', toggleCompanyAgency);
    });
  } catch (error) {
    console.error('Error loading companies:', error);
    showToast(errorMessage(error, 'Failed to load companies'), 'danger');
  }
}

// Load a specific company
function loadCompany(companyId) {
  const token = authToken();

  fetch(`/api/companies/${escapeHtml(companyId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const tableBody = document.getElementById('companies-table-body');
      if (!tableBody) {
        return;
      }

      tableBody.innerHTML = '';

      const company = data.company;
      const row = document.createElement('tr');

      // Format date
      const createdDate = new Date(company.createdAt).toLocaleDateString();

      row.innerHTML = `
        <td>${escapeHtml(company.name)}</td>
        <td>${escapeHtml(company.description) || '-'}</td>
        <td>${escapeHtml(company.website) || '-'}</td>
        <td>
          <span class="badge ${company.isActive ? 'bg-success' : 'bg-danger'}">
            ${company.isActive ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td>${createdDate}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary view-company" 
                    data-id="${escapeHtml(company._id)}">
              View
            </button>
            <button class="btn btn-sm btn-secondary edit-company" 
                    data-id="${escapeHtml(company._id)}">
              Edit
            </button>
          </div>
        </td>
      `;

      tableBody.appendChild(row);

      // Add event listeners to buttons
      document.querySelectorAll('.view-company').forEach(button => {
        button.addEventListener('click', viewCompany);
      });

      document.querySelectorAll('.edit-company').forEach(button => {
        button.addEventListener('click', openEditCompanyModal);
      });
    })
    .catch(error => {
      console.error('Error loading company:', error);
      showToast(errorMessage(error, 'Failed to load company'), 'danger');
    });
}

// View company details and users
function viewCompany(event) {
  const companyId = event.currentTarget.dataset.id;
  loadCompanyUsers(companyId);

  // Show company details section
  document.getElementById('companies-list-section').style.display = 'none';
  document.getElementById('company-detail-section').style.display = 'block';

  // Set company ID for back button
  document.getElementById('company-detail-id').value = companyId;

  // Load company details
  const token = authToken();

  fetch(`/api/companies/${escapeHtml(companyId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const company = data.company;

      // Update company details
      document.getElementById('company-detail-name').textContent = company.name;
      document.getElementById('company-detail-description').textContent = company.description || 'No description';
      document.getElementById('company-detail-website').textContent = company.website || 'No website';
      document.getElementById('company-detail-status').textContent = company.isActive ? 'Active' : 'Inactive';
      document.getElementById('company-detail-status').className = company.isActive ? 'text-success' : 'text-danger';
      document.getElementById('company-detail-created').textContent = new Date(company.createdAt).toLocaleString();
    })
    .catch(error => {
      console.error('Error loading company details:', error);
      showToast(errorMessage(error, 'Failed to load company details'), 'danger');
    });
}

// Load company users
function loadCompanyUsers(companyId) {
  const token = authToken();
  const currentUser = getStoredUser() || {};

  // Check if user is superadmin to show/hide the create user button
  const createCompanyUserBtn = document.getElementById('create-company-user-btn');
  if (createCompanyUserBtn) {
    createCompanyUserBtn.style.display = currentUser.role === 'superadmin' ? 'block' : 'none';
  }

  fetch(`/api/companies/${escapeHtml(companyId)}/users`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const tableBody = document.getElementById('company-users-table-body');
      if (!tableBody) {
        return;
      }

      tableBody.innerHTML = '';

      if (data.users.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="8" class="text-center">No users found for this company</td>';
        tableBody.appendChild(row);
        return;
      }

      data.users.forEach(user => {
        const row = document.createElement('tr');

        // Format dates
        const createdDate = new Date(user.createdAt).toLocaleDateString();
        const lastLogin = user.lastLogin
          ? new Date(user.lastLogin).toLocaleDateString()
          : 'Never';

        // Only superadmins can edit/delete users
        const canEdit = currentUser.role === 'superadmin';

        row.innerHTML = `
          <td>${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.displayName) || '-'}</td>
          <td>${escapeHtml(user.email)}</td>
          <td>${user.role === 'company_admin' ? 'Admin' : 'Operator'}</td>
          <td>
            ${user.invitePending
    ? '<span class="badge bg-info text-dark">Invited</span>'
    : `<span class="badge ${user.isActive ? 'bg-success' : 'bg-danger'}">${user.isActive ? 'Active' : 'Inactive'}</span>`}
          </td>
          <td>${createdDate}</td>
          <td>${lastLogin}</td>
          <td>
            ${canEdit ? `
              <div class="btn-group">
                <button class="btn btn-sm btn-primary edit-company-user" 
                        data-id="${escapeHtml(user._id)}" 
                        data-company-id="${escapeHtml(companyId)}">
                  Edit
                </button>
                <button class="btn btn-sm ${user.isActive ? 'btn-warning' : 'btn-success'} toggle-company-user-status" 
                        data-id="${escapeHtml(user._id)}" 
                        data-company-id="${escapeHtml(companyId)}" 
                        data-status="${user.isActive}">
                  ${user.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button class="btn btn-sm btn-danger reset-company-user-password" 
                        data-id="${escapeHtml(user._id)}" 
                        data-company-id="${escapeHtml(companyId)}">
                  Reset Password
                </button>
              </div>
            ` : '-'}
          </td>
        `;

        tableBody.appendChild(row);
      });

      // Add event listeners to buttons
      document.querySelectorAll('.edit-company-user').forEach(button => {
        button.addEventListener('click', openEditCompanyUserModal);
      });

      document.querySelectorAll('.toggle-company-user-status').forEach(button => {
        button.addEventListener('click', toggleCompanyUserStatus);
      });

      document.querySelectorAll('.reset-company-user-password').forEach(button => {
        button.addEventListener('click', openResetCompanyUserPasswordModal);
      });
    })
    .catch(error => {
      console.error('Error loading company users:', error);
      showToast(errorMessage(error, 'Failed to load company users'), 'danger');
    });
}

// Back to companies list
function backToCompaniesList() {
  document.getElementById('companies-list-section').style.display = 'block';
  document.getElementById('company-detail-section').style.display = 'none';
}

/**
 * Create a company and invite its first admin.
 *
 * Their address is required: there is no made-up admin@<name>.com any more,
 * and no generated password to copy out of a toast. The admin gets an
 * invitation and chooses their own.
 */
async function createCompany() {
  const name = document.getElementById('company-name').value.trim();
  const description = document.getElementById('company-description').value;
  const website = document.getElementById('company-website').value.trim();
  const adminEmail = document.getElementById('company-admin-email').value.trim();
  const adminName = document.getElementById('company-admin-name').value.trim();

  if (!name) {
    showToast('Company name is required', 'warning');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    showToast('Enter the email address of the company\'s first admin', 'warning');
    return;
  }

  const button = document.getElementById('create-company-btn');
  button.disabled = true;

  try {
    const data = await api('/api/companies', {
      method: 'POST',
      body: { name, description, website, adminEmail, adminName: adminName || undefined }
    });

    showToast(data.message || 'Company created', data.inviteSent ? 'success' : 'warning', 8000);

    const panel = document.getElementById('company-invite-link');
    panel.innerHTML = data.inviteLink ? `
      <div class="alert alert-warning alert-dismissible">
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Hide"></button>
        <div class="fw-semibold mb-1">Send this invitation link to ${escapeHtml(adminEmail)} yourself.</div>
        <code class="d-block p-2 bg-light text-dark rounded user-select-all text-break">${escapeHtml(data.inviteLink)}</code>
      </div>` : '';

    document.getElementById('create-company-form').reset();
    bootstrap.Modal.getInstance(document.getElementById('createCompanyModal')).hide();
    loadAllCompanies();
  } catch (error) {
    console.error('Error creating company:', error);
    showToast(errorMessage(error, 'Failed to create company'), 'danger');
  } finally {
    button.disabled = false;
  }
}

/**
 * Make a company an agency, or stop it being one. An agency's admins get a
 * Clients screen, can add client companies and work in their dashboards,
 * and on the Agency plan put their own brand on them. Stopping keeps the
 * links to its clients, so switching it back restores them.
 */
async function toggleCompanyAgency(event) {
  const button = event.currentTarget;
  const makeAgency = button.dataset.agency !== 'true';
  const name = button.dataset.name || 'this company';

  const ok = await confirmDialog(makeAgency
    ? {
      title: `Make ${name} an agency?`,
      message: 'Its admins can add client companies, open their dashboards and, on the Agency plan, put their own brand on them.',
      confirmLabel: 'Make agency'
    }
    : {
      title: `Stop ${name} being an agency?`,
      message: 'Its admins lose the Clients screen and can no longer open their clients\' dashboards; the clients go back to our brand. The clients stay linked, so making it an agency again restores everything.',
      confirmLabel: 'Stop agency',
      danger: true
    });
  if (!ok) {
    return;
  }

  try {
    await api(`/api/agency/companies/${encodeURIComponent(button.dataset.id)}`, {
      method: 'PATCH',
      body: { isAgency: makeAgency }
    });
    showToast(makeAgency ? `${name} is now an agency.` : `${name} is no longer an agency.`, 'success');
    loadAllCompanies();
  } catch (error) {
    showToast(errorMessage(error, 'Could not change the agency'), 'danger');
  }
}

/**
 * Switch a company off or on. Off means everyone in it is signed out and
 * refused at sign-in, and the widget stops answering, so it is confirmed.
 */
async function toggleCompanyStatus(event) {
  const button = event.currentTarget;
  const companyId = button.dataset.id;
  const name = button.dataset.name || 'this company';
  const newStatus = button.dataset.status !== 'true';

  if (!newStatus) {
    const ok = await confirmDialog({
      title: `Deactivate ${name}?`,
      message: 'Everyone in it is signed out straight away and cannot sign in again until it is reactivated. Their data is kept.',
      confirmLabel: 'Deactivate company',
      danger: true
    });
    if (!ok) {
      return;
    }
  }

  try {
    await api(`/api/companies/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      body: { isActive: newStatus }
    });
    showToast(`${name} ${newStatus ? 'reactivated' : 'deactivated'}`, 'success');
    loadAllCompanies();
  } catch (error) {
    console.error('Error updating company status:', error);
    showToast(errorMessage(error, 'Failed to update company status'), 'danger');
  }
}
// Open edit company modal
function openEditCompanyModal(event) {
  const companyId = event.currentTarget.dataset.id;
  const token = authToken();

  fetch(`/api/companies/${escapeHtml(companyId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const company = data.company;

      if (!company) {
        showToast('Company not found', 'danger');
        return;
      }

      // Fill the form with company details
      document.getElementById('edit-company-id').value = company._id;
      document.getElementById('edit-company-name').value = company.name;
      document.getElementById('edit-company-description').value = company.description || '';
      document.getElementById('edit-company-website').value = company.website || '';

      // Show the modal
      const editModal = new bootstrap.Modal(document.getElementById('editCompanyModal'));
      editModal.show();
    })
    .catch(error => {
      console.error('Error fetching company details:', error);
      showToast(errorMessage(error, 'Failed to fetch company details'), 'danger');
    });
}

// Save edited company details
function editCompany() {
  const companyId = document.getElementById('edit-company-id').value;
  const name = document.getElementById('edit-company-name').value;
  const description = document.getElementById('edit-company-description').value;
  const website = document.getElementById('edit-company-website').value;
  const token = authToken();

  if (!name) {
    showToast('Company name is required', 'warning');
    return;
  }

  fetch(`/api/companies/${escapeHtml(companyId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ name, description, website })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.company) {
        showToast('Company details updated successfully', 'success');

        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('editCompanyModal')).hide();

        // Reload companies list or company details
        const detailSection = document.getElementById('company-detail-section');
        if (detailSection && detailSection.style.display !== 'none') {
          viewCompany({ currentTarget: { dataset: { id: companyId } } });
        } else {
          loadAllCompanies();
        }
      } else {
        showToast(data.error || 'Failed to update company details', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating company details:', error);
      showToast(errorMessage(error, 'Failed to update company details'), 'danger');
    });
}

// Open edit company user modal
function openEditCompanyUserModal(event) {
  const userId = event.currentTarget.dataset.id;
  const companyId = event.currentTarget.dataset.companyId;
  const token = authToken();

  // Set the modal title to "Edit User"
  document.getElementById('companyUserModalLabel').textContent = 'Edit User';

  // Hide password fields for editing
  document.getElementById('password-fields').style.display = 'none';

  // Set company ID in the form
  document.getElementById('company-user-company-id').value = companyId;

  // Fetch user details
  fetch(`/api/companies/${escapeHtml(companyId)}/users/${userId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const user = data.user;

      if (!user) {
        showToast('User not found', 'danger');
        return;
      }

      // Fill the form with user details
      document.getElementById('company-user-id').value = user.id;
      document.getElementById('company-user-username').value = user.username;
      document.getElementById('company-user-display-name').value = user.displayName || '';
      document.getElementById('company-user-name').value = user.name || '';
      document.getElementById('company-user-email').value = user.email;
      document.getElementById('company-user-role').value = user.role;

      // Show the modal
      const modal = new bootstrap.Modal(document.getElementById('companyUserModal'));
      modal.show();
    })
    .catch(error => {
      console.error('Error fetching user details:', error);
      showToast(errorMessage(error, 'Failed to fetch user details'), 'danger');
    });
}

// Toggle company user status. Deactivating signs the person out everywhere
// and returns their chats to the queue, so it is confirmed first.
async function toggleCompanyUserStatus(event) {
  const button = event.currentTarget;
  const userId = button.dataset.id;
  const companyId = button.dataset.companyId;
  const currentStatus = button.dataset.status === 'true';
  const newStatus = !currentStatus;
  const token = authToken();

  if (!newStatus) {
    const ok = await confirmDialog({
      title: 'Deactivate this person?',
      message: 'They are signed out everywhere straight away, and conversations they hold go back to the queue.',
      confirmLabel: 'Deactivate',
      danger: true
    });
    if (!ok) {
      return;
    }
  }

  fetch(`/api/companies/${escapeHtml(companyId)}/users/${userId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ isActive: newStatus })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        showToast(`User ${newStatus ? 'activated' : 'deactivated'} successfully`, 'success');
        loadCompanyUsers(companyId); // Reload the company users list
      } else {
        showToast(data.error || 'Failed to update user status', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating user status:', error);
      showToast(errorMessage(error, 'Failed to update user status'), 'danger');
    });
}

// Open reset company user password modal
function openResetCompanyUserPasswordModal(event) {
  const userId = event.currentTarget.dataset.id;
  const companyId = event.currentTarget.dataset.companyId;

  // Set user ID and company ID in the form
  document.getElementById('reset-company-user-id').value = userId;
  document.getElementById('reset-company-id').value = companyId;

  // Clear password fields
  document.getElementById('reset-company-user-password').value = '';
  document.getElementById('reset-company-user-confirm-password').value = '';
  document.getElementById('generate-random-password').checked = false;

  // Show the modal
  const modal = new bootstrap.Modal(document.getElementById('resetCompanyUserPasswordModal'));
  modal.show();
}

// Reset company user password
function resetCompanyUserPassword() {
  const userId = document.getElementById('reset-company-user-id').value;
  const companyId = document.getElementById('reset-company-id').value;
  const generateRandom = document.getElementById('generate-random-password').checked;
  const password = document.getElementById('reset-company-user-password').value;
  const confirmPassword = document.getElementById('reset-company-user-confirm-password').value;
  const token = authToken();

  // Validate input if not generating random password
  if (!generateRandom) {
    if (!password || !confirmPassword) {
      showToast('Password and confirm password are required', 'warning');
      return;
    }

    if (password !== confirmPassword) {
      showToast('Passwords do not match', 'warning');
      return;
    }
  }

  fetch(`/api/companies/${escapeHtml(companyId)}/users/${userId}/reset-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({
      password: generateRandom ? null : password,
      generateRandom
    })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('resetCompanyUserPasswordModal')).hide();

        if (data.password) {
          // If a random password was generated, show it to the user
          showToast(`Password reset successfully. New password: ${data.password}`, 'success');
        } else {
          showToast('Password reset successfully', 'success');
        }
      } else {
        showToast(data.error || 'Failed to reset password', 'danger');
      }
    })
    .catch(error => {
      console.error('Error resetting password:', error);
      showToast(errorMessage(error, 'Failed to reset password'), 'danger');
    });
}

// Open create company user modal
function openCreateCompanyUserModal() {
  // Get company ID from the hidden input
  const companyId = document.getElementById('company-detail-id').value;

  // Set the modal title to "Create New User"
  document.getElementById('companyUserModalLabel').textContent = 'Create New User';

  // Show password fields for creating
  document.getElementById('password-fields').style.display = 'block';

  // Clear the form
  document.getElementById('company-user-form').reset();

  // Set company ID in the form
  document.getElementById('company-user-company-id').value = companyId;
  document.getElementById('company-user-id').value = '';

  // Show the modal
  const modal = new bootstrap.Modal(document.getElementById('companyUserModal'));
  modal.show();
}

// Save company user (create or edit)
function saveCompanyUser() {
  const userId = document.getElementById('company-user-id').value;
  const companyId = document.getElementById('company-user-company-id').value;
  const username = document.getElementById('company-user-username').value;
  const displayName = document.getElementById('company-user-display-name').value;
  const name = document.getElementById('company-user-name').value;
  const email = document.getElementById('company-user-email').value;
  const role = document.getElementById('company-user-role').value;
  const token = authToken();

  // Validate input
  if (!username || !email) {
    showToast('Username and email are required', 'warning');
    return;
  }

  // Check if creating or editing
  const isCreating = !userId;

  // If creating, validate password
  if (isCreating) {
    const password = document.getElementById('company-user-password').value;
    const confirmPassword = document.getElementById('company-user-confirm-password').value;

    if (!password || !confirmPassword) {
      showToast('Password and confirm password are required', 'warning');
      return;
    }

    if (password !== confirmPassword) {
      showToast('Passwords do not match', 'warning');
      return;
    }
  }

  // Prepare request data
  const userData = {
    username,
    displayName,
    name,
    email,
    role
  };

  // Add password if creating
  if (isCreating) {
    userData.password = document.getElementById('company-user-password').value;
  }

  // Send request
  const url = isCreating
    ? `/api/companies/${escapeHtml(companyId)}/users`
    : `/api/companies/${escapeHtml(companyId)}/users/${userId}`;

  fetch(url, {
    method: isCreating ? 'POST' : 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify(userData)
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        showToast(`User ${isCreating ? 'created' : 'updated'} successfully`, 'success');

        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('companyUserModal')).hide();

        // Reload company users
        loadCompanyUsers(companyId);
      } else {
        showToast(data.error || `Failed to ${isCreating ? 'create' : 'update'} user`, 'danger');
      }
    })
    .catch(error => {
      console.error(`Error ${isCreating ? 'creating' : 'updating'} user:`, error);
      showToast(errorMessage(error, `Failed to ${isCreating ? 'create' : 'update'} user`), 'danger');
    });
}

// Initialize company management
function setupCompanies() {
  // Search as you type, without a query per keystroke.
  document.getElementById('companies-search')?.addEventListener('input', debounce(event => {
    searchTerm = event.target.value.trim();
    loadAllCompanies();
  }, 300));

  // Set up event listeners
  const createCompanyBtn = document.getElementById('create-company-btn');
  if (createCompanyBtn) {
    createCompanyBtn.addEventListener('click', createCompany);
  }

  const saveCompanyBtn = document.getElementById('save-company-btn');
  if (saveCompanyBtn) {
    saveCompanyBtn.addEventListener('click', editCompany);
  }

  const backToCompaniesBtn = document.getElementById('back-to-companies-btn');
  if (backToCompaniesBtn) {
    backToCompaniesBtn.addEventListener('click', backToCompaniesList);
  }

  // Set up event listener for create company user button
  const createCompanyUserBtn = document.getElementById('create-company-user-btn');
  if (createCompanyUserBtn) {
    createCompanyUserBtn.addEventListener('click', openCreateCompanyUserModal);
  }

  // Set up event listener for save company user button
  const saveCompanyUserBtn = document.getElementById('save-company-user-btn');
  if (saveCompanyUserBtn) {
    saveCompanyUserBtn.addEventListener('click', saveCompanyUser);
  }

  // Set up event listener for reset company user password button
  const confirmResetCompanyUserPasswordBtn = document.getElementById('confirm-reset-company-user-password-btn');
  if (confirmResetCompanyUserPasswordBtn) {
    confirmResetCompanyUserPasswordBtn.addEventListener('click', resetCompanyUserPassword);
  }

  // Set up event listener for generate random password checkbox
  const generateRandomPasswordCheckbox = document.getElementById('generate-random-password');
  if (generateRandomPasswordCheckbox) {
    generateRandomPasswordCheckbox.addEventListener('change', function() {
      const passwordField = document.getElementById('reset-company-user-password');
      const confirmPasswordField = document.getElementById('reset-company-user-confirm-password');

      if (this.checked) {
        passwordField.disabled = true;
        confirmPasswordField.disabled = true;
      } else {
        passwordField.disabled = false;
        confirmPasswordField.disabled = false;
      }
    });
  }

  // Hide company detail section initially
  const companyDetailSection = document.getElementById('company-detail-section');
  if (companyDetailSection) {
    companyDetailSection.style.display = 'none';
  }
}

registerSection('companies', {
  setup: setupCompanies,
  show: loadAllCompanies
});
