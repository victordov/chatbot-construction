
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

function loadTasksForConversation(conversationId) {
  // Reset filters
  document.getElementById('task-status-filter').value = '';
  document.getElementById('task-priority-filter').value = '';
  document.getElementById('task-assignee-filter').value = '';

  // Build query string with conversationId
  const queryString = `?conversationId=${conversationId}`;

  // Fetch tasks
  fetch(`/api/tasks${queryString}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load tasks');
      }
      return response.json();
    })
    .then(data => {
      displayTasks(data.tasks);

      // Update UI to show we're viewing tasks for a specific conversation
      const taskListHeader = document.querySelector('#tasks-section .card-header h5');
      if (taskListHeader) {
        taskListHeader.innerHTML = 'Tasks for Conversation <span class="badge bg-info">Filtered</span>';
      }
    })
    .catch(error => {
      logger.error('Error loading tasks for conversation:', error);
      showNotification('Error', 'Failed to load tasks for conversation', 'error');
    });
}

function loadTasks(token) {
  // Get filter values
  const status = document.getElementById('task-status-filter').value;
  const priority = document.getElementById('task-priority-filter').value;
  const assignee = document.getElementById('task-assignee-filter').value;
  const search = document.getElementById('task-search').value;

  // Build query string
  const queryParams = [];
  if (status) {
    queryParams.push(`status=${status}`);
  }
  if (priority) {
    queryParams.push(`priority=${priority}`);
  }
  if (assignee) {
    queryParams.push(`assignee=${assignee}`);
  }
  if (search) {
    queryParams.push(`search=${encodeURIComponent(search)}`);
  }

  const queryString = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

  // Fetch tasks
  fetch(`/api/tasks${queryString}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token || localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load tasks');
      }
      return response.json();
    })
    .then(data => {
      displayTasks(data.tasks);
    })
    .catch(error => {
      logger.error('Error loading tasks:', error);
      showNotification('Error', 'Failed to load tasks', 'error');
    });
}

function displayTasks(tasks) {
  const taskList = document.getElementById('task-list');

  // Clear existing tasks
  taskList.innerHTML = '';

  if (tasks.length === 0) {
    taskList.innerHTML = '<tr><td colspan="7" class="text-center">No tasks available</td></tr>';
    return;
  }

  // Add tasks to the list
  tasks.forEach(task => {
    const row = document.createElement('tr');

    // Format due date
    const dueDate = new Date(task.dueDate);
    const formattedDate = dueDate.toLocaleDateString();

    // Create priority badge
    const priorityBadge = document.createElement('span');
    priorityBadge.className = 'badge';

    switch (task.priority) {
    case 'low':
      priorityBadge.className += ' bg-secondary';
      break;
    case 'medium':
      priorityBadge.className += ' bg-primary';
      break;
    case 'high':
      priorityBadge.className += ' bg-warning';
      break;
    case 'urgent':
      priorityBadge.className += ' bg-danger';
      break;
    }

    priorityBadge.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);

    // Create status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge';

    switch (task.status) {
    case 'open':
      statusBadge.className += ' bg-secondary';
      break;
    case 'in_progress':
      statusBadge.className += ' bg-primary';
      break;
    case 'completed':
      statusBadge.className += ' bg-success';
      break;
    }

    const statusText = task.status === 'in_progress' ? 'In Progress' :
      task.status.charAt(0).toUpperCase() + task.status.slice(1);
    statusBadge.textContent = statusText;

    // Create action buttons
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-sm btn-outline-primary me-1';
    viewBtn.innerHTML = '<i data-feather="eye"></i>';
    viewBtn.title = 'View Task';
    viewBtn.addEventListener('click', function() {
      loadTaskDetails(task._id);
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
    editBtn.innerHTML = '<i data-feather="edit"></i>';
    editBtn.title = 'Edit Task';
    editBtn.addEventListener('click', function() {
      openTaskModal(null, task);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-outline-danger';
    deleteBtn.innerHTML = '<i data-feather="trash-2"></i>';
    deleteBtn.title = 'Delete Task';
    deleteBtn.addEventListener('click', function() {
      if (confirm('Are you sure you want to delete this task?')) {
        deleteTask(task._id);
      }
    });

    const actionsCell = document.createElement('td');
    actionsCell.appendChild(viewBtn);
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(deleteBtn);

    // Add cells to row
    row.innerHTML = `
      <td>${task.title}</td>
      <td>${task.description.length > 50 ? task.description.substring(0, 50) + '...' : task.description}</td>
      <td>${formattedDate}</td>
      <td></td>
      <td>${task.assigneeName || 'Unassigned'}</td>
      <td></td>
    `;

    // Add priority badge
    row.cells[3].appendChild(priorityBadge);

    // Add status badge
    row.cells[5].appendChild(statusBadge);

    // Add actions
    row.appendChild(actionsCell);

    taskList.appendChild(row);
  });

  // Initialize Feather icons for the new buttons
  feather.replace();
}

function loadTaskDetails(taskId) {
  fetch(`/api/tasks/${taskId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load task details');
      }
      return response.json();
    })
    .then(data => {
      displayTaskDetails(data.task);
      loadTaskComments(taskId);
    })
    .catch(error => {
      logger.error('Error loading task details:', error);
      showNotification('Error', 'Failed to load task details', 'error');
    });
}

function displayTaskDetails(task) {
  // Hide task list and show task details
  document.getElementById('task-detail-container').style.display = 'block';
  document.getElementById('task-detail-container').dataset.taskId = task._id;
  document.querySelector('.row.mb-3').style.display = 'none';

  // Set task details
  document.getElementById('task-title').textContent = task.title;
  document.getElementById('task-description').textContent = task.description;

  // Format due date
  const dueDate = new Date(task.dueDate);
  document.getElementById('task-due-date').textContent = dueDate.toLocaleDateString();

  // Set priority with appropriate styling
  const prioritySpan = document.getElementById('task-priority');
  prioritySpan.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  prioritySpan.className = '';

  switch (task.priority) {
  case 'low':
    prioritySpan.className = 'text-secondary';
    break;
  case 'medium':
    prioritySpan.className = 'text-primary';
    break;
  case 'high':
    prioritySpan.className = 'text-warning';
    break;
  case 'urgent':
    prioritySpan.className = 'text-danger';
    break;
  }

  // Set assignee
  document.getElementById('task-assignee').textContent = task.assigneeName || 'Unassigned';

  // Set status dropdown
  document.getElementById('task-status-update').value = task.status;

  // Set conversation link if available
  const conversationLink = document.getElementById('task-conversation-link');
  if (task.conversationId) {
    // Check if conversationId is an object with sessionId property (populated)
    const sessionId = task.conversationId.sessionId || task.conversationId;
    conversationLink.href = `#active-chats-section?session=${sessionId}`;
    conversationLink.style.display = 'inline-block';

    // Add click event listener to explicitly call viewChatHistory
    conversationLink.onclick = function(e) {
      e.preventDefault();
      viewChatHistory(sessionId);
      return false;
    };
  } else {
    conversationLink.style.display = 'none';
  }

  // Set contact information
  document.getElementById('contact-name').textContent = task.contactInfo?.name || 'Not provided';
  document.getElementById('contact-email').textContent = task.contactInfo?.email || 'Not provided';
  document.getElementById('contact-phone').textContent = task.contactInfo?.phone || 'Not provided';

  // Apply styling for missing contact info
  if (!task.contactInfo?.name) {
    document.getElementById('contact-name').className = 'text-danger';
  } else {
    document.getElementById('contact-name').className = '';
  }

  if (!task.contactInfo?.email) {
    document.getElementById('contact-email').className = 'text-danger';
  } else {
    document.getElementById('contact-email').className = '';
  }

  if (!task.contactInfo?.phone) {
    document.getElementById('contact-phone').className = 'text-danger';
  } else {
    document.getElementById('contact-phone').className = '';
  }
}

function loadTaskComments(taskId) {
  fetch(`/api/tasks/${taskId}/comments`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load comments');
      }
      return response.json();
    })
    .then(data => {
      displayComments(data.comments);
    })
    .catch(error => {
      logger.error('Error loading comments:', error);
      showNotification('Error', 'Failed to load comments', 'error');
    });
}

function displayComments(comments) {
  const commentsList = document.getElementById('comments-list');

  // Clear existing comments
  commentsList.innerHTML = '';

  if (comments.length === 0) {
    commentsList.innerHTML = '<div class="text-center text-muted">No comments yet</div>';
    return;
  }

  // Add comments to the list
  comments.forEach(comment => {
    const commentDiv = document.createElement('div');
    commentDiv.className = 'card mb-2';

    // Format date
    const commentDate = new Date(comment.createdAt);
    const formattedDate = commentDate.toLocaleString();

    commentDiv.innerHTML = `
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <strong>${comment.authorName}</strong>
          <small class="text-muted">${formattedDate}</small>
        </div>
        <p class="mb-0">${comment.content}</p>
      </div>
    `;

    commentsList.appendChild(commentDiv);
  });
}

function showTaskList() {
  // Hide task details and show task list
  document.getElementById('task-detail-container').style.display = 'none';
  document.querySelector('.row.mb-3').style.display = 'block';
}

function openTaskModal(conversationId = null, task = null) {
  // Clear previous form data
  document.getElementById('task-form').reset();

  // Load operators for assignee dropdown and wait for it to complete
  loadOperators(localStorage.getItem('chatbot-auth-token'))
    .then(() => {
      // Show the modal after operators are loaded
      const taskModal = new bootstrap.Modal(document.getElementById('taskModal'));
      taskModal.show();
    });

  // Set conversation ID if provided
  if (conversationId) {
    document.getElementById('conversation-id').value = conversationId;

    // Check if we already have the conversation data in memory
    if (window.currentConversation && window.currentConversation.sessionId === conversationId) {
      // Use the current conversation data
      const metadata = window.currentConversation.metadata;
      if (metadata) {
        // Populate contact information fields
        // Check if metadata is a Map or a plain object
        if (metadata instanceof Map) {
          document.getElementById('contact-name-input').value = metadata.get('name') || '';
          document.getElementById('contact-email-input').value = metadata.get('email') || '';
          document.getElementById('contact-phone-input').value = metadata.get('phone') || '';

          // Show indicators for missing information
          document.getElementById('name-missing').style.display = !metadata.get('name') ? 'block' : 'none';
          document.getElementById('email-missing').style.display = !metadata.get('email') ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = !metadata.get('phone') ? 'block' : 'none';
        } else {
          document.getElementById('contact-name-input').value = metadata.name || '';
          document.getElementById('contact-email-input').value = metadata.email || '';
          document.getElementById('contact-phone-input').value = metadata.phone || '';

          // Show indicators for missing information
          document.getElementById('name-missing').style.display = !metadata.name ? 'block' : 'none';
          document.getElementById('email-missing').style.display = !metadata.email ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = !metadata.phone ? 'block' : 'none';
        }
      }
    } else {
      // Try to pre-fill contact information from the conversation
      fetch(`/api/chat/session/${conversationId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': localStorage.getItem('chatbot-auth-token')
        }
      })
        .then(response => {
          if (!response.ok) {
            throw new Error('Failed to load conversation');
          }
          return response.json();
        })
        .then(data => {
          // Check if metadata contains contact information
          const metadata = data.conversation.metadata;
          if (metadata) {
            if (metadata.get('name')) {
              document.getElementById('contact-name-input').value = metadata.get('name');
            }
            if (metadata.get('email')) {
              document.getElementById('contact-email-input').value = metadata.get('email');
            }
            if (metadata.get('phone')) {
              document.getElementById('contact-phone-input').value = metadata.get('phone');
            }
          }

          // Show indicators for missing information
          document.getElementById('name-missing').style.display = metadata && !metadata.get('name') ? 'block' : 'none';
          document.getElementById('email-missing').style.display = metadata && !metadata.get('email') ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = metadata && !metadata.get('phone') ? 'block' : 'none';
        })
        .catch(error => {
          logger.error('Error loading conversation:', error);
        });
    }
  }

  // If editing an existing task
  if (task) {
    document.getElementById('taskModalLabel').textContent = 'Edit Task';
    document.getElementById('save-task-btn').textContent = 'Update Task';

    // Fill form with task data
    document.getElementById('conversation-id').value = task.conversationId || '';
    document.getElementById('task-title-input').value = task.title;
    document.getElementById('task-description-input').value = task.description;

    // Format date for input
    const dueDate = new Date(task.dueDate);
    const formattedDate = dueDate.toISOString().split('T')[0];
    document.getElementById('task-due-date-input').value = formattedDate;

    document.getElementById('task-priority-input').value = task.priority;
    document.getElementById('task-assignee-input').value = task.assignee;

    // Fill contact information if available
    if (task.contactInfo) {
      document.getElementById('contact-name-input').value = task.contactInfo.name || '';
      document.getElementById('contact-email-input').value = task.contactInfo.email || '';
      document.getElementById('contact-phone-input').value = task.contactInfo.phone || '';

      // Show indicators for missing information
      document.getElementById('name-missing').style.display = !task.contactInfo.name ? 'block' : 'none';
      document.getElementById('email-missing').style.display = !task.contactInfo.email ? 'block' : 'none';
      document.getElementById('phone-missing').style.display = !task.contactInfo.phone ? 'block' : 'none';
    }

    // Store task ID for update
    document.getElementById('task-form').dataset.taskId = task._id;
  } else {
    document.getElementById('taskModalLabel').textContent = 'Create New Task';
    document.getElementById('save-task-btn').textContent = 'Create Task';

    // Set default due date to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const formattedDate = tomorrow.toISOString().split('T')[0];
    document.getElementById('task-due-date-input').value = formattedDate;

    // Remove task ID if present
    delete document.getElementById('task-form').dataset.taskId;
  }
}

function saveTask(token) {
  // Get form data
  const taskId = document.getElementById('task-form').dataset.taskId;
  const conversationId = document.getElementById('conversation-id').value;
  const titleInput = document.getElementById('task-title-input');
  const descriptionInput = document.getElementById('task-description-input');
  const dueDateInput = document.getElementById('task-due-date-input');
  const priorityInput = document.getElementById('task-priority-input');
  const assigneeInput = document.getElementById('task-assignee-input');

  const title = titleInput.value;
  const description = descriptionInput.value;
  const dueDate = dueDateInput.value;
  const priority = priorityInput.value;
  const assignee = assigneeInput.value;

  // Get contact information
  const contactInfo = {
    name: document.getElementById('contact-name-input').value,
    email: document.getElementById('contact-email-input').value,
    phone: document.getElementById('contact-phone-input').value
  };

  // Validate required fields
  let isValid = true;

  // Reset validation state
  titleInput.classList.remove('is-invalid');
  descriptionInput.classList.remove('is-invalid');
  dueDateInput.classList.remove('is-invalid');
  assigneeInput.classList.remove('is-invalid');

  // Check each required field and mark invalid ones
  if (!title) {
    titleInput.classList.add('is-invalid');
    isValid = false;
  }

  if (!description) {
    descriptionInput.classList.add('is-invalid');
    isValid = false;
  }

  if (!dueDate) {
    dueDateInput.classList.add('is-invalid');
    isValid = false;
  }

  if (!assignee) {
    assigneeInput.classList.add('is-invalid');
    isValid = false;
  }

  if (!isValid) {
    return;
  }

  // Create task data object
  const taskData = {
    title,
    description,
    dueDate,
    priority,
    assignee,
    contactInfo
  };

  if (conversationId) {
    taskData.conversationId = conversationId;
  }

  // Determine if creating or updating
  const method = taskId ? 'PUT' : 'POST';
  const url = taskId ? `/api/tasks/${taskId}` : '/api/tasks';

  // Send request
  fetch(url, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token || localStorage.getItem('chatbot-auth-token')
    },
    body: JSON.stringify(taskData)
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to save task');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
      // Hide the modal
        bootstrap.Modal.getInstance(document.getElementById('taskModal')).hide();

        // Show success notification
        showNotification('Success', taskId ? 'Task updated successfully' : 'Task created successfully', 'success');

        // Reload tasks
        loadTasks();
      })
    .catch(error => {
      logger.error('Error saving task:', error);
      showNotification('Error', 'Failed to save task', 'error');
    });
}

function updateTaskStatus(token, status) {
  const taskId = document.getElementById('task-detail-container').dataset.taskId;

  fetch(`/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token || localStorage.getItem('chatbot-auth-token')
    },
    body: JSON.stringify({ status })
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to update task status');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
        showNotification('Success', 'Task status updated successfully', 'success');
      })
    .catch(error => {
      logger.error('Error updating task status:', error);
      showNotification('Error', 'Failed to update task status', 'error');
    });
}

function addComment(token) {
  const taskId = document.getElementById('task-detail-container').dataset.taskId;
  const content = document.getElementById('comment-input').value.trim();

  if (!content) {
    return;
  }

  fetch(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token || localStorage.getItem('chatbot-auth-token')
    },
    body: JSON.stringify({ content })
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to add comment');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
      // Clear comment input
        document.getElementById('comment-input').value = '';

        // Reload comments
        loadTaskComments(taskId);
      })
    .catch(error => {
      logger.error('Error adding comment:', error);
      showNotification('Error', 'Failed to add comment', 'error');
    });
}

function deleteTask(taskId) {
  fetch(`/api/tasks/${taskId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to delete task');
      }
      return response.json();
    })
    .then(
      // eslint-disable-next-line no-unused-vars
      data => {
        showNotification('Success', 'Task deleted successfully', 'success');

        // If viewing this task, go back to task list
        const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
        if (currentTaskId === taskId) {
          showTaskList();
        }

        // Reload tasks
        loadTasks();
      })
    .catch(error => {
      logger.error('Error deleting task:', error);
      showNotification('Error', 'Failed to delete task', 'error');
    });
}

// Set up contact information management
function setupContactInfoManagement(token) {
  // Set up event listener for edit button
  document.getElementById('edit-contact-info-btn').addEventListener('click', function() {
    openContactInfoModal();
  });

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

// Create new operator
document.addEventListener('DOMContentLoaded', function() {
  const createOperatorBtn = document.getElementById('create-operator-btn');
  if (createOperatorBtn) {
    createOperatorBtn.addEventListener('click', createOperator);
  }
});

function createOperator() {
  const username = document.getElementById('operator-username').value;
  const name = document.getElementById('operator-name').value;
  const email = document.getElementById('operator-email').value;
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

  fetch('/api/admin/operators', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ username, name, email, password, confirmPassword })
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
      document.getElementById('edit-operator-name').value = operator.name || '';
      document.getElementById('edit-operator-email').value = operator.email;

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
  const name = document.getElementById('edit-operator-name').value;
  const email = document.getElementById('edit-operator-email').value;
  const token = localStorage.getItem('chatbot-auth-token');

  if (!username || !email) {
    showToast('Username and email are required', 'warning');
    return;
  }

  fetch(`/api/admin/operators/${operatorId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ username, name, email })
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
      window.open(data.url, '_blank');
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
    });
}

// Load spreadsheet data and display in table
function loadSpreadsheet(event) {
  const btn = event?.currentTarget;
  setLoading(btn, true);
  const token = localStorage.getItem('chatbot-auth-token');
  const spreadsheetId = document.getElementById('spreadsheet-id').value;
  const defaultSheet = document.getElementById('default-sheet').checked;
  const sheet = defaultSheet ? 'Sheet1' : document.getElementById('sheet-select').value;
  const exclude = document.getElementById('exclude-columns').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  fetch('/api/google/knowledge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ spreadsheetId, sheet, exclude })
  })
    .then(res => res.json())
    .then(data => {
      refreshKnowledge();
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
        btn.textContent = 'Load';
        btn.addEventListener('click', () => openLoadModal(f.id));
        li.appendChild(btn);
        list.appendChild(li);
      });
    })
    .catch(() => showToast('Drive search failed', 'danger'))
    .finally(() => setLoading(btn, false));
}

function openLoadModal(id) {
  document.getElementById('modal-spreadsheet-id').value = id;
  fetchModalSheetNames(id).then(() => {
    const modal = new bootstrap.Modal(document.getElementById('loadSheetModal'));
    modal.show();
  });
}

function importSpreadsheet(id) {
  document.getElementById('spreadsheet-id').value = id;
  fetchSheetNames(id);
}

function fetchSheetNames(id) {
  const token = localStorage.getItem('chatbot-auth-token');
  fetch(`/api/google/sheets/${id}/names`, { headers: { 'x-auth-token': token } })
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
  const exclude = document.getElementById('exclude-columns').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  fetch('/api/google/knowledge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ spreadsheetId, sheet, exclude })
  })
    .then(res => res.json())
    .then(data => {
      bootstrap.Modal.getInstance(document.getElementById('loadSheetModal')).hide();
      refreshKnowledge();
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
        expand.textContent = 'Expand';
        expand.addEventListener('click', () => expandKnowledge(doc._id));
        const refBtn = document.createElement('button');
        refBtn.className = 'btn btn-sm btn-outline-secondary';
        refBtn.textContent = 'Refresh';
        refBtn.addEventListener('click', event => refreshDocument(doc._id, event));
        div.appendChild(expand);
        div.appendChild(refBtn);
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
  table.querySelectorAll('tbody tr').forEach(row => {
    row.querySelectorAll('td').forEach((td, idx) => {
      if (excluded.includes(table.querySelectorAll('thead th')[idx].textContent.trim())) {
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

document.addEventListener('DOMContentLoaded', function() {
  const loadBtn = document.getElementById('load-spreadsheet');
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
    });
    sheetSelect.disabled = defaultCb.checked;
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
});
