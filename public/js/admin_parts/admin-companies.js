// Company Management JavaScript

// Load all companies
function loadAllCompanies() {
  const token = localStorage.getItem('chatbot-auth-token');
  const currentUser = JSON.parse(localStorage.getItem('chatbot-user'));

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

  fetch('/api/companies', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const tableBody = document.getElementById('companies-table-body');
      if (!tableBody) return;

      tableBody.innerHTML = '';

      data.companies.forEach(company => {
        const row = document.createElement('tr');

        // Format date
        const createdDate = new Date(company.createdAt).toLocaleDateString();

        row.innerHTML = `
          <td>${company.name}</td>
          <td>${company.description || '-'}</td>
          <td>${company.website || '-'}</td>
          <td>
            <span class="badge ${company.isActive ? 'bg-success' : 'bg-danger'}">
              ${company.isActive ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>${createdDate}</td>
          <td>
            <div class="btn-group">
              <button class="btn btn-sm btn-primary view-company" 
                      data-id="${company._id}">
                View
              </button>
              <button class="btn btn-sm btn-secondary edit-company" 
                      data-id="${company._id}">
                Edit
              </button>
              <button class="btn btn-sm ${company.isActive ? 'btn-warning' : 'btn-success'} toggle-company-status" 
                      data-id="${company._id}" 
                      data-status="${company.isActive}">
                ${company.isActive ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </td>
        `;

        tableBody.appendChild(row);
      });

      // Add event listeners to buttons
      document.querySelectorAll('.view-company').forEach(button => {
        button.addEventListener('click', viewCompany);
      });

      document.querySelectorAll('.edit-company').forEach(button => {
        button.addEventListener('click', openEditCompanyModal);
      });

      document.querySelectorAll('.toggle-company-status').forEach(button => {
        button.addEventListener('click', toggleCompanyStatus);
      });
    })
    .catch(error => {
      console.error('Error loading companies:', error);
      showToast('Failed to load companies', 'danger');
    });
}

// Load a specific company
function loadCompany(companyId) {
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/companies/${companyId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const tableBody = document.getElementById('companies-table-body');
      if (!tableBody) return;

      tableBody.innerHTML = '';

      const company = data.company;
      const row = document.createElement('tr');

      // Format date
      const createdDate = new Date(company.createdAt).toLocaleDateString();

      row.innerHTML = `
        <td>${company.name}</td>
        <td>${company.description || '-'}</td>
        <td>${company.website || '-'}</td>
        <td>
          <span class="badge ${company.isActive ? 'bg-success' : 'bg-danger'}">
            ${company.isActive ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td>${createdDate}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary view-company" 
                    data-id="${company._id}">
              View
            </button>
            <button class="btn btn-sm btn-secondary edit-company" 
                    data-id="${company._id}">
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
      showToast('Failed to load company', 'danger');
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
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/companies/${companyId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
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
      showToast('Failed to load company details', 'danger');
    });
}

// Load company users
function loadCompanyUsers(companyId) {
  const token = localStorage.getItem('chatbot-auth-token');
  const currentUser = JSON.parse(localStorage.getItem('chatbot-user'));

  // Check if user is superadmin to show/hide the create user button
  const createCompanyUserBtn = document.getElementById('create-company-user-btn');
  if (createCompanyUserBtn) {
    createCompanyUserBtn.style.display = currentUser.role === 'superadmin' ? 'block' : 'none';
  }

  fetch(`/api/companies/${companyId}/users`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const tableBody = document.getElementById('company-users-table-body');
      if (!tableBody) return;

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
          <td>${user.username}</td>
          <td>${user.displayName || '-'}</td>
          <td>${user.email}</td>
          <td>${user.role === 'company_admin' ? 'Admin' : 'Operator'}</td>
          <td>
            <span class="badge ${user.isActive ? 'bg-success' : 'bg-danger'}">
              ${user.isActive ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td>${createdDate}</td>
          <td>${lastLogin}</td>
          <td>
            ${canEdit ? `
              <div class="btn-group">
                <button class="btn btn-sm btn-primary edit-company-user" 
                        data-id="${user._id}" 
                        data-company-id="${companyId}">
                  Edit
                </button>
                <button class="btn btn-sm ${user.isActive ? 'btn-warning' : 'btn-success'} toggle-company-user-status" 
                        data-id="${user._id}" 
                        data-company-id="${companyId}" 
                        data-status="${user.isActive}">
                  ${user.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button class="btn btn-sm btn-danger reset-company-user-password" 
                        data-id="${user._id}" 
                        data-company-id="${companyId}">
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
      showToast('Failed to load company users', 'danger');
    });
}

// Back to companies list
function backToCompaniesList() {
  document.getElementById('companies-list-section').style.display = 'block';
  document.getElementById('company-detail-section').style.display = 'none';
}

// Create new company
function createCompany() {
  const name = document.getElementById('company-name').value;
  const description = document.getElementById('company-description').value;
  const website = document.getElementById('company-website').value;
  const token = localStorage.getItem('chatbot-auth-token');

  if (!name) {
    showToast('Company name is required', 'warning');
    return;
  }

  fetch('/api/companies', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ name, description, website })
  })
    .then(response => response.json())
    .then(data => {
      if (data.company) {
        showToast('Company created successfully', 'success');

        // Clear form and close modal
        document.getElementById('create-company-form').reset();
        bootstrap.Modal.getInstance(document.getElementById('createCompanyModal')).hide();

        // Reload companies list
        loadAllCompanies();
      } else {
        showToast(data.error || 'Failed to create company', 'danger');
      }
    })
    .catch(error => {
      console.error('Error creating company:', error);
      showToast('Failed to create company', 'danger');
    });
}

// Toggle company active status
function toggleCompanyStatus(event) {
  const button = event.currentTarget;
  const companyId = button.dataset.id;
  const currentStatus = button.dataset.status === 'true';
  const newStatus = !currentStatus;
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/companies/${companyId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ isActive: newStatus })
  })
    .then(response => response.json())
    .then(data => {
      if (data.company) {
        showToast(`Company ${newStatus ? 'activated' : 'deactivated'} successfully`, 'success');
        loadAllCompanies(); // Reload the companies list
      } else {
        showToast(data.error || 'Failed to update company status', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating company status:', error);
      showToast('Failed to update company status', 'danger');
    });
}

// Open edit company modal
function openEditCompanyModal(event) {
  const companyId = event.currentTarget.dataset.id;
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/companies/${companyId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
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
      showToast('Failed to fetch company details', 'danger');
    });
}

// Save edited company details
function editCompany() {
  const companyId = document.getElementById('edit-company-id').value;
  const name = document.getElementById('edit-company-name').value;
  const description = document.getElementById('edit-company-description').value;
  const website = document.getElementById('edit-company-website').value;
  const token = localStorage.getItem('chatbot-auth-token');

  if (!name) {
    showToast('Company name is required', 'warning');
    return;
  }

  fetch(`/api/companies/${companyId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ name, description, website })
  })
    .then(response => response.json())
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
      showToast('Failed to update company details', 'danger');
    });
}

// Open edit company user modal
function openEditCompanyUserModal(event) {
  const userId = event.currentTarget.dataset.id;
  const companyId = event.currentTarget.dataset.companyId;
  const token = localStorage.getItem('chatbot-auth-token');

  // Set the modal title to "Edit User"
  document.getElementById('companyUserModalLabel').textContent = 'Edit User';

  // Hide password fields for editing
  document.getElementById('password-fields').style.display = 'none';

  // Set company ID in the form
  document.getElementById('company-user-company-id').value = companyId;

  // Fetch user details
  fetch(`/api/companies/${companyId}/users/${userId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
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
      showToast('Failed to fetch user details', 'danger');
    });
}

// Toggle company user status
function toggleCompanyUserStatus(event) {
  const button = event.currentTarget;
  const userId = button.dataset.id;
  const companyId = button.dataset.companyId;
  const currentStatus = button.dataset.status === 'true';
  const newStatus = !currentStatus;
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/companies/${companyId}/users/${userId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ isActive: newStatus })
  })
    .then(response => response.json())
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
      showToast('Failed to update user status', 'danger');
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
  const token = localStorage.getItem('chatbot-auth-token');

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

  fetch(`/api/companies/${companyId}/users/${userId}/reset-password`, {
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
    .then(response => response.json())
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
      showToast('Failed to reset password', 'danger');
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
  const token = localStorage.getItem('chatbot-auth-token');

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
    ? `/api/companies/${companyId}/users` 
    : `/api/companies/${companyId}/users/${userId}`;

  fetch(url, {
    method: isCreating ? 'POST' : 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify(userData)
  })
    .then(response => response.json())
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
      showToast(`Failed to ${isCreating ? 'create' : 'update'} user`, 'danger');
    });
}

// Initialize company management
document.addEventListener('DOMContentLoaded', function() {
  // Check if companies section exists
  const companiesSection = document.getElementById('companies-section');
  if (!companiesSection) return;

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

  // Load companies when the section is shown
  const navLinks = document.querySelectorAll('#sidebar .nav-link');
  navLinks.forEach(link => {
    if (link.getAttribute('data-section') === 'companies') {
      link.addEventListener('click', function() {
        loadAllCompanies();
      });
    }
  });

  // Check if companies section is active on page load
  if (companiesSection.classList.contains('active')) {
    loadAllCompanies();
  }
});
