/**
 * Team: the people who answer conversations.
 */

import * as bootstrap from 'bootstrap';
import { registerSection } from './nav.js';
import { authToken, errorMessage, escapeHtml, getStoredUser, logger, parseJsonResponse, showNotification, showToast } from './utils.js';

export function loadOperators(token) {
  return fetch('/api/admin/operators', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load operators');
      }
      return response.json();
    })
    .then(data => {
      // Populate assignee dropdowns
      const assigneeSelect = document.getElementById('task-assignee-input');
      const assigneeFilter = document.getElementById('task-assignee-filter');

      // Clear existing options (except the first one)
      while (assigneeSelect.options.length > 1) {
        assigneeSelect.remove(1);
      }

      while (assigneeFilter.options.length > 1) {
        assigneeFilter.remove(1);
      }

      // Add operators to dropdowns
      data.operators.forEach(operator => {
        const option1 = document.createElement('option');
        option1.value = operator._id;
        option1.textContent = operator.username;
        assigneeSelect.appendChild(option1);

        const option2 = document.createElement('option');
        option2.value = operator._id;
        option2.textContent = operator.username;
        assigneeFilter.appendChild(option2);
      });

      return data.operators;
    })
    .catch(error => {
      logger.error('Error loading operators:', error);
      showNotification('Error', errorMessage(error, 'Failed to load operators'), 'error');
      return [];
    });
}

// Load all operators (including inactive)
function loadAllOperators() {
  const token = authToken();

  fetch('/api/admin/all-operators', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const tableBody = document.getElementById('operators-table-body');
      tableBody.innerHTML = '';

      data.operators.forEach(operator => {
        const row = document.createElement('tr');

        // Format date
        const createdDate = new Date(operator.createdAt).toLocaleDateString();
        const lastLogin = operator.lastLogin
          ? new Date(operator.lastLogin).toLocaleDateString()
          : 'Never';

        // Every one of these is typed by somebody: escaped, or it is script
        // running in whoever opens the operators tab.
        row.innerHTML = `
          <td>${escapeHtml(operator.username)}</td>
          <td>${escapeHtml(operator.displayName || '-')}</td>
          <td>${escapeHtml(operator.name || '-')}</td>
          <td>${escapeHtml(operator.email)}</td>
          <td>
            <span class="badge ${operator.isActive ? 'bg-success' : 'bg-danger'}">
              ${operator.isActive ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>${createdDate}</td>
          <td>${lastLogin}</td>
          <td>
            <div class="btn-group">
              <button class="btn btn-sm btn-primary edit-operator"
                      data-id="${escapeHtml(operator._id)}">
                Edit
              </button>
              <button class="btn btn-sm ${operator.isActive ? 'btn-warning' : 'btn-success'} toggle-status"
                      data-id="${escapeHtml(operator._id)}" 
                      data-status="${operator.isActive}">
                ${operator.isActive ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </td>
        `;

        tableBody.appendChild(row);
      });

      // Add event listeners to status toggle buttons
      document.querySelectorAll('.toggle-status').forEach(button => {
        button.addEventListener('click', toggleOperatorStatus);
      });

      // Add event listeners to edit buttons
      document.querySelectorAll('.edit-operator').forEach(button => {
        button.addEventListener('click', openEditOperatorModal);
      });
    })
    .catch(error => {
      console.error('Error loading operators:', error);
      showToast(errorMessage(error, 'Failed to load operators'), 'danger');
    });
}

// Toggle operator active status
function toggleOperatorStatus(event) {
  const button = event.currentTarget;
  const operatorId = button.dataset.id;
  const currentStatus = button.dataset.status === 'true';
  const newStatus = !currentStatus;
  const token = authToken();

  fetch(`/api/admin/operators/${operatorId}`, {
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
        showToast(`Operator ${newStatus ? 'activated' : 'deactivated'} successfully`, 'success');
        loadAllOperators(); // Reload the operators list
      } else {
        showToast(data.error || 'Failed to update operator status', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating operator status:', error);
      showToast(errorMessage(error, 'Failed to update operator status'), 'danger');
    });
}

// Load companies for dropdowns
function loadCompaniesForDropdown(selectElement, selectedCompanyId = null) {
  const token = authToken();
  const currentUser = getStoredUser() || {};

  // Clear existing options (except the first one)
  while (selectElement.options.length > 1) {
    selectElement.remove(1);
  }

  // If user is a company admin, they can only assign to their own company
  if (currentUser.role === 'company_admin' && currentUser.company) {
    const option = document.createElement('option');
    option.value = currentUser.company.id;
    option.textContent = currentUser.company.name;
    option.selected = true;
    selectElement.appendChild(option);

    // Disable the select element since there's only one option
    selectElement.disabled = true;
    return;
  }

  // For superadmins, load all companies
  fetch('/api/companies', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      data.companies.forEach(company => {
        const option = document.createElement('option');
        option.value = company._id;
        option.textContent = company.name;

        // Select the company if it matches the selectedCompanyId
        if (selectedCompanyId && company._id === selectedCompanyId) {
          option.selected = true;
        }

        selectElement.appendChild(option);
      });
    })
    .catch(error => {
      console.error('Error loading companies:', error);
      showToast(errorMessage(error, 'Failed to load companies'), 'danger');
    });
}

// Handle role selection changes
function handleRoleChange(roleSelect, companySelect, companyContainer) {
  const currentUser = getStoredUser() || {};

  // Hide superadmin option for non-superadmins
  const superadminOption = roleSelect.querySelector('option[value="superadmin"]');
  if (superadminOption) {
    superadminOption.style.display = currentUser.role === 'superadmin' ? 'block' : 'none';
  }

  // Show/hide company selection based on role
  roleSelect.addEventListener('change', function() {
    const selectedRole = this.value;

    if (selectedRole === 'superadmin') {
      companyContainer.style.display = 'none';
      companySelect.required = false;
    } else {
      companyContainer.style.display = 'block';
      companySelect.required = true;
    }
  });

  // Initial setup based on current role
  const selectedRole = roleSelect.value;
  if (selectedRole === 'superadmin') {
    companyContainer.style.display = 'none';
    companySelect.required = false;
  } else {
    companyContainer.style.display = 'block';
    companySelect.required = true;
  }

  // Company admins can only create operators
  if (currentUser.role === 'company_admin') {
    // Hide company_admin and superadmin options
    Array.from(roleSelect.options).forEach(option => {
      if (option.value !== 'operator') {
        option.style.display = 'none';
      }
    });

    // Set to operator and disable
    roleSelect.value = 'operator';
    roleSelect.disabled = true;
  }
}

// Create new operator
function setupOperatorForms() {
  const createOperatorBtn = document.getElementById('create-operator-btn');
  if (createOperatorBtn) {
    createOperatorBtn.addEventListener('click', createOperator);
  }

  // Setup role and company selection for create operator form
  const roleSelect = document.getElementById('operator-role');
  const companySelect = document.getElementById('operator-company');
  const companyContainer = document.getElementById('company-selection-container');

  if (roleSelect && companySelect && companyContainer) {
    // Load companies for dropdown
    loadCompaniesForDropdown(companySelect);

    // Setup role change handler
    handleRoleChange(roleSelect, companySelect, companyContainer);
  }

  // Setup role and company selection for edit operator form
  const editRoleSelect = document.getElementById('edit-operator-role');
  const editCompanySelect = document.getElementById('edit-operator-company');
  const editCompanyContainer = document.getElementById('edit-company-selection-container');

  if (editRoleSelect && editCompanySelect && editCompanyContainer) {
    // Setup role change handler
    handleRoleChange(editRoleSelect, editCompanySelect, editCompanyContainer);
  }

  const saveOperatorBtn = document.getElementById('save-operator-btn');
  if (saveOperatorBtn) {
    saveOperatorBtn.addEventListener('click', editOperator);
  }

  const confirmResetPasswordBtn = document.getElementById('confirm-reset-password-btn');
  if (confirmResetPasswordBtn) {
    confirmResetPasswordBtn.addEventListener('click', resetPassword);
  }
}

function createOperator() {
  const username = document.getElementById('operator-username').value;
  const displayName = document.getElementById('operator-display-name').value;
  const name = document.getElementById('operator-name').value;
  const email = document.getElementById('operator-email').value;
  const role = document.getElementById('operator-role').value;
  const companyId = document.getElementById('operator-company').value;
  const password = document.getElementById('operator-password').value;
  const confirmPassword = document.getElementById('operator-confirm-password').value;
  const token = authToken();

  if (!username || !email || !password || !confirmPassword) {
    showToast('Please fill in all required fields', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'warning');
    return;
  }

  // Validate company selection for non-superadmin roles
  if (role !== 'superadmin' && !companyId) {
    showToast('Please select a company', 'warning');
    return;
  }

  fetch('/api/admin/operators', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({
      username,
      displayName,
      name,
      email,
      role,
      companyId: role !== 'superadmin' ? companyId : null,
      password,
      confirmPassword
    })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        showToast('Operator created successfully', 'success');

        // Clear form and close modal
        document.getElementById('create-operator-form').reset();
        bootstrap.Modal.getInstance(document.getElementById('createOperatorModal')).hide();

        // Reload operators list
        loadAllOperators();
      } else {
        showToast(data.error || 'Failed to create operator', 'danger');
      }
    })
    .catch(error => {
      console.error('Error creating operator:', error);
      showToast(errorMessage(error, 'Failed to create operator'), 'danger');
    });
}

// Open edit operator modal
function openEditOperatorModal(event) {
  const operatorId = event.currentTarget.dataset.id;
  const token = authToken();

  // Fetch operator details
  fetch('/api/admin/all-operators', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(parseJsonResponse)
    .then(data => {
      const operator = data.operators.find(op => op._id === operatorId);

      if (!operator) {
        showToast('Operator not found', 'danger');
        return;
      }

      // Fill the form with operator details
      document.getElementById('edit-operator-id').value = operator._id;
      document.getElementById('edit-operator-username').value = operator.username;
      document.getElementById('edit-operator-display-name').value = operator.displayName || '';
      document.getElementById('edit-operator-name').value = operator.name || '';
      document.getElementById('edit-operator-email').value = operator.email;

      // Set role if available
      const roleSelect = document.getElementById('edit-operator-role');
      if (roleSelect && operator.role) {
        roleSelect.value = operator.role;

        // Trigger change event to update company field visibility
        const event = new Event('change');
        roleSelect.dispatchEvent(event);
      }

      // Load companies and set selected company if available
      const companySelect = document.getElementById('edit-operator-company');
      if (companySelect && operator.company) {
        loadCompaniesForDropdown(companySelect, operator.company.id);
      } else if (companySelect) {
        loadCompaniesForDropdown(companySelect);
      }

      // Store operator ID for reset password
      document.getElementById('reset-password-operator-id').value = operator._id;

      // Show the modal
      const editModal = new bootstrap.Modal(document.getElementById('editOperatorModal'));
      editModal.show();
    })
    .catch(error => {
      console.error('Error fetching operator details:', error);
      showToast(errorMessage(error, 'Failed to fetch operator details'), 'danger');
    });
}

function editOperator() {
  const operatorId = document.getElementById('edit-operator-id').value;
  const username = document.getElementById('edit-operator-username').value;
  const displayName = document.getElementById('edit-operator-display-name').value;
  const name = document.getElementById('edit-operator-name').value;
  const email = document.getElementById('edit-operator-email').value;
  const role = document.getElementById('edit-operator-role').value;
  const companyId = document.getElementById('edit-operator-company').value;
  const token = authToken();
  const currentUser = getStoredUser() || {};

  if (!username || !email) {
    showToast('Username and email are required', 'warning');
    return;
  }

  // Validate company selection for non-superadmin roles
  if (role !== 'superadmin' && !companyId) {
    showToast('Please select a company', 'warning');
    return;
  }

  // Company admins can only create operators
  if (currentUser.role === 'company_admin' && role !== 'operator') {
    showToast('Company admins can only create operators', 'warning');
    return;
  }

  fetch(`/api/admin/operators/${operatorId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({
      username,
      displayName,
      name,
      email,
      role,
      companyId: role !== 'superadmin' ? companyId : null
    })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        showToast('Operator details updated successfully', 'success');

        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('editOperatorModal')).hide();

        // Reload operators list
        loadAllOperators();
      } else {
        showToast(data.error || 'Failed to update operator details', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating operator details:', error);
      showToast(errorMessage(error, 'Failed to update operator details'), 'danger');
    });
}

function resetPassword() {
  const operatorId = document.getElementById('reset-password-operator-id').value;
  const password = document.getElementById('reset-password-new').value;
  const confirmPassword = document.getElementById('reset-password-confirm').value;
  const token = authToken();

  if (!password || !confirmPassword) {
    showToast('Password and confirm password are required', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'warning');
    return;
  }

  fetch(`/api/admin/operators/${operatorId}/reset-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ password, confirmPassword })
  })
    .then(parseJsonResponse)
    .then(data => {
      if (data.success) {
        showToast('Password reset successfully', 'success');

        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('resetPasswordModal')).hide();

        // Also close the edit modal if it's open
        const editModal = bootstrap.Modal.getInstance(document.getElementById('editOperatorModal'));
        if (editModal) {
          editModal.hide();
        }

        // Clear the form
        document.getElementById('reset-password-form').reset();
      } else {
        showToast(data.error || 'Failed to reset password', 'danger');
      }
    })
    .catch(error => {
      console.error('Error resetting password:', error);
      showToast(errorMessage(error, 'Failed to reset password'), 'danger');
    });
}

registerSection('operators', {
  setup: setupOperatorForms,
  show: loadAllOperators
});
