
function loadOperators(token) {
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
      showNotification('Error', 'Failed to load operators', 'error');
      return [];
    });
}


// Set up contact information management
function setupContactInfoManagement(token) {
  // Set up event listener for edit button
  document.getElementById('edit-contact-info-btn').addEventListener('click', function() {
    openContactInfoModal();
  });

  // Request user to provide details
  const requestBtn = document.getElementById('request-user-info-btn');
  if (requestBtn) {
    requestBtn.addEventListener('click', function() {
      requestUserInfo();
    });
  }

  // Set up event listener for save button
  document.getElementById('save-contact-info-btn').addEventListener('click', function() {
    saveContactInfo(token);
  });
}

// Open contact info modal
function openContactInfoModal() {
  // Get current conversation
  const conversation = window.currentConversation;
  if (!conversation) {
    return;
  }

  // Set session ID
  document.getElementById('contact-info-session-id').value = conversation.sessionId;

  // Fill form with existing data if available
  if (conversation.metadata) {
    // Check if metadata is a Map or a plain object
    if (conversation.metadata instanceof Map) {
      document.getElementById('edit-name-input').value = conversation.metadata.get('name') || '';
      document.getElementById('edit-email-input').value = conversation.metadata.get('email') || '';
      document.getElementById('edit-phone-input').value = conversation.metadata.get('phone') || '';
    } else {
      document.getElementById('edit-name-input').value = conversation.metadata.name || '';
      document.getElementById('edit-email-input').value = conversation.metadata.email || '';
      document.getElementById('edit-phone-input').value = conversation.metadata.phone || '';
    }
  } else {
    // Clear form
    document.getElementById('edit-name-input').value = '';
    document.getElementById('edit-email-input').value = '';
    document.getElementById('edit-phone-input').value = '';
  }

  // Show the modal
  const contactInfoModal = new bootstrap.Modal(document.getElementById('contactInfoModal'));
  contactInfoModal.show();
}

// Save contact info
function saveContactInfo(token) {
  // Get form data
  const sessionId = document.getElementById('contact-info-session-id').value;
  const name = document.getElementById('edit-name-input').value;
  const email = document.getElementById('edit-email-input').value;
  const phone = document.getElementById('edit-phone-input').value;

  // Create data object
  const contactInfo = {
    name,
    email,
    phone
  };

  // Send request to save contact info
  fetch(`/api/admin/chat/${sessionId}/contact-info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token || localStorage.getItem('chatbot-auth-token')
    },
    body: JSON.stringify(contactInfo)
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to save contact information');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
        // Hide the modal
        bootstrap.Modal.getInstance(document.getElementById('contactInfoModal')).hide();

        // Update the conversation data
        if (window.currentConversation) {
          if (!window.currentConversation.metadata) {
            window.currentConversation.metadata = {};
          }

          // Check if metadata is a Map or a plain object
          if (window.currentConversation.metadata instanceof Map) {
            window.currentConversation.metadata.set('name', name);
            window.currentConversation.metadata.set('email', email);
            window.currentConversation.metadata.set('phone', phone);
          } else {
            window.currentConversation.metadata.name = name;
            window.currentConversation.metadata.email = email;
            window.currentConversation.metadata.phone = phone;
          }

          // Update the display
          displayUserContactInfo(window.currentConversation);

          // Reload messages to update user names
          loadChatMessages(sessionId);
        }

        // Show success notification
        showNotification('Success', 'Contact information saved successfully', 'success');
      })
    .catch(error => {
      logger.error('Error saving contact information:', error);
      showNotification('Error', 'Failed to save contact information', 'error');
    });
}

// Request user to provide contact information via widget
function requestUserInfo() {
  const conversation = window.currentConversation;
  if (!conversation) return;
  const socket = window.adminSocket;
  if (socket) {
    socket.emit('request-user-details', { sessionId: conversation.sessionId });
    showNotification('Info Request', 'User has been asked to provide contact info', 'info');
  }
}

function showNotification(title, message, type = 'info') {
  showToast(`${title}: ${message}`, type);
}

// Load all operators (including inactive)
function loadAllOperators() {
  const token = localStorage.getItem('chatbot-auth-token');

  fetch('/api/admin/all-operators', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
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

        row.innerHTML = `
          <td>${operator.username}</td>
          <td>${operator.displayName || '-'}</td>
          <td>${operator.name || '-'}</td>
          <td>${operator.email}</td>
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
                      data-id="${operator._id}">
                Edit
              </button>
              <button class="btn btn-sm ${operator.isActive ? 'btn-warning' : 'btn-success'} toggle-status" 
                      data-id="${operator._id}" 
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
      showToast('Failed to load operators', 'danger');
    });
}

// Toggle operator active status
function toggleOperatorStatus(event) {
  const button = event.currentTarget;
  const operatorId = button.dataset.id;
  const currentStatus = button.dataset.status === 'true';
  const newStatus = !currentStatus;
  const token = localStorage.getItem('chatbot-auth-token');

  fetch(`/api/admin/operators/${operatorId}`, {
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
        showToast(`Operator ${newStatus ? 'activated' : 'deactivated'} successfully`, 'success');
        loadAllOperators(); // Reload the operators list
      } else {
        showToast(data.error || 'Failed to update operator status', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating operator status:', error);
      showToast('Failed to update operator status', 'danger');
    });
}

// Load companies for dropdowns
function loadCompaniesForDropdown(selectElement, selectedCompanyId = null) {
  const token = localStorage.getItem('chatbot-auth-token');
  const currentUser = JSON.parse(localStorage.getItem('chatbot-user'));

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
    .then(response => response.json())
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
      showToast('Failed to load companies', 'danger');
    });
}

// Handle role selection changes
function handleRoleChange(roleSelect, companySelect, companyContainer) {
  const currentUser = JSON.parse(localStorage.getItem('chatbot-user'));

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
document.addEventListener('DOMContentLoaded', function() {
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
});

function createOperator() {
  const username = document.getElementById('operator-username').value;
  const displayName = document.getElementById('operator-display-name').value;
  const name = document.getElementById('operator-name').value;
  const email = document.getElementById('operator-email').value;
  const role = document.getElementById('operator-role').value;
  const companyId = document.getElementById('operator-company').value;
  const password = document.getElementById('operator-password').value;
  const confirmPassword = document.getElementById('operator-confirm-password').value;
  const token = localStorage.getItem('chatbot-auth-token');

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
    .then(response => response.json())
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
      showToast('Failed to create operator', 'danger');
    });
}

// Helper function to show toast notifications
function showToast(message, type = 'info') {
  const container = document.querySelector('.toast-container');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.className = `toast align-items-center text-bg-${type} border-0`;
  wrapper.role = 'alert';
  wrapper.setAttribute('aria-live', 'assertive');
  wrapper.setAttribute('aria-atomic', 'true');
  wrapper.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(wrapper);
  const toast = new bootstrap.Toast(wrapper, { delay: 5000 });
  toast.show();
  toast._element.addEventListener('hidden.bs.toast', () => wrapper.remove());
}

// Toggle loading state for buttons
function setLoading(button, isLoading) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
  } else {
    if (button.dataset.originalContent) {
      button.innerHTML = button.dataset.originalContent;
      delete button.dataset.originalContent;
    }
    button.disabled = false;
  }
}

// Open edit operator modal
function openEditOperatorModal(event) {
  const operatorId = event.currentTarget.dataset.id;
  const token = localStorage.getItem('chatbot-auth-token');

  // Fetch operator details
  fetch('/api/admin/all-operators', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => response.json())
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
      showToast('Failed to fetch operator details', 'danger');
    });
}

// Save edited operator details
document.addEventListener('DOMContentLoaded', function() {
  const saveOperatorBtn = document.getElementById('save-operator-btn');
  if (saveOperatorBtn) {
    saveOperatorBtn.addEventListener('click', editOperator);
  }

  const confirmResetPasswordBtn = document.getElementById('confirm-reset-password-btn');
  if (confirmResetPasswordBtn) {
    confirmResetPasswordBtn.addEventListener('click', resetPassword);
  }
});

function editOperator() {
  const operatorId = document.getElementById('edit-operator-id').value;
  const username = document.getElementById('edit-operator-username').value;
  const displayName = document.getElementById('edit-operator-display-name').value;
  const name = document.getElementById('edit-operator-name').value;
  const email = document.getElementById('edit-operator-email').value;
  const role = document.getElementById('edit-operator-role').value;
  const companyId = document.getElementById('edit-operator-company').value;
  const token = localStorage.getItem('chatbot-auth-token');
  const currentUser = JSON.parse(localStorage.getItem('chatbot-user'));

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
    .then(response => response.json())
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
      showToast('Failed to update operator details', 'danger');
    });
}

function resetPassword() {
  const operatorId = document.getElementById('reset-password-operator-id').value;
  const password = document.getElementById('reset-password-new').value;
  const confirmPassword = document.getElementById('reset-password-confirm').value;
  const token = localStorage.getItem('chatbot-auth-token');

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
    .then(response => response.json())
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
      showToast('Failed to reset password', 'danger');
    });
}

// Start Google OAuth flow
function connectGoogleAccount(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  fetch('/api/google/auth/url', { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const w = window.open(data.url, '_blank');
      const poll = setInterval(() => {
        if (w.closed) {
          clearInterval(poll);
          checkGoogleStatus();
        }
      }, 1000);
    })
    .catch(() => showToast('Failed to initiate Google OAuth', 'danger'))
    .finally(() => setLoading(btn, false));
}

function checkGoogleStatus() {
  const token = localStorage.getItem('chatbot-auth-token');
  fetch('/api/google/status', { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const btn = document.getElementById('connect-google');
      if (btn) {
        btn.textContent = data.authorized ? 'Reauthorize Google Account' : 'Connect Google Account';
      }
      const span = document.getElementById('google-account');
      if (span) span.textContent = data.email || '';
      showStep(data.authorized ? 'kb-step-search' : 'kb-step-connect');
    });
}

// Load spreadsheet data and display in table
let currentDocId = null;

function loadSpreadsheet(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  const spreadsheetId = document.getElementById('spreadsheet-id').value;
  const defaultSheet = document.getElementById('default-sheet').checked;
  const sheet = defaultSheet ? 'Sheet1' : document.getElementById('sheet-select').value;
  const excludeInput = document.getElementById('exclude-columns');
  const exclude = excludeInput
    ? excludeInput.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  fetch('/api/google/knowledge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ spreadsheetId, sheet, exclude })
  })
    .then(res => res.json())
    .then(data => {
      if (document.getElementById('knowledge-list')) {
        refreshKnowledge();
      }
      currentDocId = data.doc._id;
      expandKnowledge(data.doc._id);
    })
    .catch(() => showToast('Failed to load spreadsheet', 'danger'))
    .finally(() => setLoading(btn, false));
}

// Search Google Drive for spreadsheets
function searchDrive(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  const query = document.getElementById('drive-query').value;
  fetch(`/api/google/drive/search?q=${encodeURIComponent(query)}`, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const list = document.getElementById('drive-results');
      list.innerHTML = '';
      data.files.forEach(f => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';
        li.textContent = f.name;
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary';
        btn.textContent = 'Select';
        btn.addEventListener('click', () => openLoadModal(f.id, f.name));
        li.appendChild(btn);
        list.appendChild(li);
      });
    })
    .catch(() => showToast('Drive search failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function openLoadModal(id, name) {
  document.getElementById('spreadsheet-id').value = id;
  if (name) {
    const span = document.getElementById('selected-spreadsheet-name');
    if (span) span.textContent = name;
  }
  fetchSheetNames(id).then(() => {
    showStep('kb-step-sheet');
  });
}

function importSpreadsheet(id) {
  document.getElementById('spreadsheet-id').value = id;
  fetchSheetNames(id);
}

function fetchSheetNames(id) {
  const token = localStorage.getItem('chatbot-auth-token');
  return fetch(`/api/google/sheets/${id}/names`, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const select = document.getElementById('sheet-select');
      select.innerHTML = '';
      data.names.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        select.appendChild(opt);
      });
    })
    .catch(() => showToast('Failed to fetch sheet names', 'danger'));
}

function fetchModalSheetNames(id) {
  const token = localStorage.getItem('chatbot-auth-token');
  return fetch(`/api/google/sheets/${id}/names`, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const select = document.getElementById('modal-sheet-select');
      select.innerHTML = '';
      data.names.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        select.appendChild(opt);
      });
    })
    .catch(() => showToast('Failed to fetch sheet names', 'danger'));
}

function loadFromModal(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  const spreadsheetId = document.getElementById('modal-spreadsheet-id').value;
  const defaultSheet = document.getElementById('modal-default-sheet').checked;
  const sheet = defaultSheet ? 'Sheet1' : document.getElementById('modal-sheet-select').value;
  const excludeInput = document.getElementById('exclude-columns');
  const exclude = excludeInput
    ? excludeInput.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  fetch('/api/google/knowledge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ spreadsheetId, sheet, exclude })
  })
    .then(res => res.json())
    .then(data => {
      bootstrap.Modal.getInstance(document.getElementById('loadSheetModal')).hide();
      if (document.getElementById('knowledge-list')) {
        refreshKnowledge();
      }
      currentDocId = data.doc._id;
      expandKnowledge(data.doc._id);
    })
    .catch(() => showToast('Failed to load spreadsheet', 'danger'))
    .finally(() => setLoading(btn, false));
}

function refreshKnowledge(query = '', event) {
  const btn = event?.currentTarget;
  if (btn) setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  const url = '/api/google/knowledge' + (query ? `?q=${encodeURIComponent(query)}` : '');
  fetch(url, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const list = document.getElementById('knowledge-list');
      list.innerHTML = '';
      data.docs.forEach(doc => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';
        li.textContent = (doc.title || doc.spreadsheetId) + ' - ' + (doc.sheet || 'Sheet1');
        const div = document.createElement('div');
        const expand = document.createElement('button');
        expand.className = 'btn btn-sm btn-outline-primary me-1';
        expand.textContent = 'View';
        expand.addEventListener('click', () => expandKnowledge(doc._id));
        const refBtn = document.createElement('button');
        refBtn.className = 'btn btn-sm btn-outline-secondary me-1';
        refBtn.textContent = 'Refresh';
        refBtn.addEventListener('click', event => refreshDocument(doc._id, event));
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-outline-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', event => deleteKnowledge(doc._id, event));
        div.appendChild(expand);
        div.appendChild(refBtn);
        div.appendChild(delBtn);
        li.appendChild(div);
        list.appendChild(li);
      });
    })
    .catch(() => showToast('Failed to load knowledge list', 'danger'))
    .finally(() => {
      if (btn) setLoading(btn, false);
    });
}

function refreshDocument(id, event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${id}/refresh`, { method: 'POST', headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(() => refreshKnowledge())
    .catch(() => showToast('Refresh failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function expandKnowledge(id) {
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${id}`, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      currentDocId = data.doc._id;
      const table = document.getElementById('spreadsheet-table');
      table.innerHTML = '';
      const headerRow = document.createElement('tr');
      data.doc.columns.forEach((col, idx) => {
        const th = document.createElement('th');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !col.exclude;
        cb.addEventListener('change', () => updateColumns(id));
        th.appendChild(cb);
        th.appendChild(document.createTextNode(' ' + col.name));
        if (col.exclude) th.classList.add('text-muted');
        headerRow.appendChild(th);
      });
      const thead = document.createElement('thead');
      thead.appendChild(headerRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      data.doc.rows.forEach(r => {
        const tr = document.createElement('tr');
        r.forEach((c, cellIdx) => {
          const td = document.createElement('td');
          td.textContent = c;
          if (data.doc.columns[cellIdx] && data.doc.columns[cellIdx].exclude) {
            td.classList.add('text-muted');
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      applyStickySpreadsheetRows();

      document.getElementById('spreadsheet-id').value = data.doc.spreadsheetId;
      fetchSheetNames(data.doc.spreadsheetId);
      if (document.getElementById('default-sheet')) {
        const cb = document.getElementById('default-sheet');
        const select = document.getElementById('sheet-select');
        if (select) {
          if (cb && !cb.checked && data.doc.sheet) {
            select.value = data.doc.sheet;
          }
        }
      }
      showStep('kb-step-columns');
    })
    .catch(() => showToast('Failed to load document', 'danger'));
}

function updateColumns(id) {
  const table = document.getElementById('spreadsheet-table');
  const excluded = [];
  table.querySelectorAll('thead th').forEach(th => {
    const cb = th.querySelector('input[type="checkbox"]');
    const name = th.textContent.trim();
    if (cb && !cb.checked) {
      excluded.push(name);
      th.classList.add('text-muted');
    } else {
      th.classList.remove('text-muted');
    }
  });
  const headerCells = table.querySelectorAll('thead th');
  table.querySelectorAll('tbody tr').forEach(row => {
    row.querySelectorAll('td').forEach((td, idx) => {
      const headerCell = headerCells[idx];
      if (headerCell && excluded.includes(headerCell.textContent.trim())) {
        td.classList.add('text-muted');
      } else {
        td.classList.remove('text-muted');
      }
    });
  });
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${id}/columns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ excluded })
  });
}

// Make each spreadsheet row sticky so short cells stay in view while long cells scroll
// and adjust z-index on scroll so the active row isn't hidden by others
function applyStickySpreadsheetRows() {
  const table = document.getElementById('spreadsheet-table');
  if (!table) return;

  const header = table.querySelector('thead tr');
  if (header) {
    header.classList.add('sticky-header');
    header.style.top = '0';
  }

  const headerHeight = header ? header.offsetHeight : 0;

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  rows.forEach(tr => {
    tr.classList.add('sticky-row');
    tr.style.top = `${headerHeight}px`;
    tr.style.zIndex = 1;
  });

  const container = table.closest('.spreadsheet-table-container');
  if (container) {
    const updateZIndex = () => {
      let activeRow = null;
      rows.forEach(tr => {
        const { top } = tr.getBoundingClientRect();
        const { top: cTop } = container.getBoundingClientRect();
        if (top - cTop <= headerHeight) {
          if (!activeRow || top > activeRow.top) {
            activeRow = { tr, top };
          }
        }
      });
      rows.forEach(tr => (tr.style.zIndex = 1));
      if (activeRow) activeRow.tr.style.zIndex = 2;
    };
    container.addEventListener('scroll', updateZIndex);
    updateZIndex();
  }

  enableSpreadsheetColumnResizing(table);
}

function enableSpreadsheetColumnResizing(table) {
  if (!table) return;
  const headerCells = table.querySelectorAll('thead th');
  headerCells.forEach((th, index) => {
    const handle = document.createElement('div');
    handle.className = 'col-resizer';
    th.style.position = 'relative';
    th.appendChild(handle);
    let startX = 0;
    let startWidth = 0;
    function onMouseMove(e) {
      const newWidth = Math.max(startWidth + (e.clientX - startX), 30);
      th.style.width = `${newWidth}px`;
      table.querySelectorAll(`tbody td:nth-child(${index + 1})`).forEach(td => {
        td.style.width = `${newWidth}px`;
      });
      const totalWidth = Array.from(headerCells).reduce((sum, cell) => sum + cell.offsetWidth, 0);
      table.style.width = `${totalWidth}px`;
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startWidth = th.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
  const initialWidth = Array.from(headerCells).reduce((sum, cell) => sum + cell.offsetWidth, 0);
  table.style.width = `${initialWidth}px`;
}

function saveKnowledgeConfig(event) {
  if (!currentDocId) return;
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const table = document.getElementById('spreadsheet-table');
  const excluded = [];
  table.querySelectorAll('thead th').forEach(th => {
    const cb = th.querySelector('input[type="checkbox"]');
    const name = th.textContent.trim();
    if (cb && !cb.checked) excluded.push(name);
  });
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${currentDocId}/columns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ excluded })
  })
    .then(() => showSummary(currentDocId))
    .catch(() => showToast('Failed to save configuration', 'danger'))
    .finally(() => setLoading(btn, false));
}

function showSummary(id) {
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${id}`, { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      const ul = document.getElementById('kb-summary-details');
      if (!ul) return;
      ul.innerHTML = '';
      const email = document.getElementById('google-account')?.textContent || '';
      const items = [
        `Spreadsheet: ${data.doc.title || data.doc.spreadsheetId}`,
        `Sheet: ${data.doc.sheet || 'Sheet1'}`,
        `Authorized Account: ${email}`,
        `Active Columns: ${data.doc.columns.filter(c => !c.exclude).map(c => c.name).join(', ')}`
      ];
      items.forEach(text => {
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      });
      showStep('kb-summary');
    })
    .catch(() => showToast('Failed to load configuration', 'danger'));
}

function deleteKnowledge(id, event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/knowledge/${id}`, { method: 'DELETE', headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(() => {
      if (currentDocId === id) {
        currentDocId = null;
        showStep('kb-step-connect');
      }
      refreshKnowledge();
    })
    .catch(() => showToast('Delete failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function showStep(id) {
  document.querySelectorAll('.kb-step').forEach(el => el.classList.add('d-none'));
  const step = document.getElementById(id);
  if (step) step.classList.remove('d-none');
}

document.addEventListener('DOMContentLoaded', function() {
  const loadBtn = document.getElementById('load-sheet');
  if (loadBtn) {
    loadBtn.addEventListener('click', loadSpreadsheet);
  }
  const connectBtn = document.getElementById('connect-google');
  if (connectBtn) {
    connectBtn.addEventListener('click', connectGoogleAccount);
    checkGoogleStatus();
  }
  const searchBtn = document.getElementById('search-drive');
  if (searchBtn) {
    searchBtn.addEventListener('click', searchDrive);
  }
  const searchKnowledgeBtn = document.getElementById('search-knowledge');
  if (searchKnowledgeBtn) {
    searchKnowledgeBtn.addEventListener('click', function(event) {
      const q = document.getElementById('knowledge-query').value;
      refreshKnowledge(q, event);
    });
  }
  const refreshBtn = document.getElementById('refresh-knowledge');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', event => refreshKnowledge('', event));
    refreshKnowledge();
  }
  const defaultCb = document.getElementById('default-sheet');
  const sheetSelect = document.getElementById('sheet-select');
  if (defaultCb && sheetSelect) {
    defaultCb.addEventListener('change', function() {
      sheetSelect.disabled = this.checked;
      if (loadBtn) loadBtn.disabled = !this.checked && !sheetSelect.value;
    });
    sheetSelect.disabled = defaultCb.checked;
    if (loadBtn) loadBtn.disabled = !defaultCb.checked && !sheetSelect.value;
    sheetSelect.addEventListener('change', function() {
      if (loadBtn) loadBtn.disabled = !defaultCb.checked && !this.value;
    });
  }
  const idInput = document.getElementById('spreadsheet-id');
  if (idInput) {
    idInput.addEventListener('change', function() {
      if (this.value) fetchSheetNames(this.value);
    });
  }
  const modalLoadBtn = document.getElementById('modal-load-btn');
  if (modalLoadBtn) {
    modalLoadBtn.addEventListener('click', loadFromModal);
  }
  const modalDefaultCb = document.getElementById('modal-default-sheet');
  const modalSheetSelect = document.getElementById('modal-sheet-select');
  if (modalDefaultCb && modalSheetSelect) {
    modalDefaultCb.addEventListener('change', function() {
      modalSheetSelect.disabled = this.checked;
    });
    modalSheetSelect.disabled = modalDefaultCb.checked;
  }

  const changeSpreadsheetBtn = document.getElementById('kb-change-spreadsheet');
  if (changeSpreadsheetBtn) {
    changeSpreadsheetBtn.addEventListener('click', () => showStep('kb-step-search'));
  }
  const changeGoogleBtn = document.getElementById('change-google');
  if (changeGoogleBtn) {
    changeGoogleBtn.addEventListener('click', () => showStep('kb-step-connect'));
  }

  const finishBtn = document.getElementById('finish-kb-setup');
  if (finishBtn) {
    finishBtn.addEventListener('click', saveKnowledgeConfig);
  }

  const refreshKbBtn = document.getElementById('kb-refresh');
  if (refreshKbBtn) {
    refreshKbBtn.addEventListener('click', event => {
      refreshDocument(currentDocId, event);
      if (currentDocId) showSummary(currentDocId);
    });
  }

  const editKbBtn = document.getElementById('kb-edit');
  if (editKbBtn) {
    editKbBtn.addEventListener('click', () => currentDocId && showStep('kb-step-columns'));
  }

  const disconnectKbBtn = document.getElementById('kb-disconnect');
  if (disconnectKbBtn) {
    disconnectKbBtn.addEventListener('click', event => deleteKnowledge(currentDocId, event));
  }
});
