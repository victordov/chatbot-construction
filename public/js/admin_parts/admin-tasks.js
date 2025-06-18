    const joinChatBtn = document.getElementById('join-chat-btn');
    const selectedChatId = joinChatBtn.getAttribute('data-session-id');

    if (selectedChatId === sessionId) {
      const toggle = document.getElementById('suggestions-toggle');
      if (toggle) {
        toggle.checked = enabled;
      }
    }
  });
}

// Task Management Functions
function setupTaskManagement(token) {
  // Set up event listeners for task-related buttons
  document.getElementById('create-task-btn').addEventListener('click', function() {
    const selectedChatId = document.querySelector('#active-chat-list .active')?.dataset.sessionId;
    if (selectedChatId) {
      openTaskModal(selectedChatId);
    }
  });

  document.getElementById('view-tasks-btn').addEventListener('click', function() {
    const selectedChatId = document.querySelector('#active-chat-list .active')?.dataset.sessionId;
    if (selectedChatId) {
      // Navigate to tasks section
      const tasksLink = document.querySelector('.nav-link[data-section="tasks"]');
      if (tasksLink) {
        tasksLink.click();

        // Small delay to ensure the section is loaded
        setTimeout(() => {
          // Get the conversation object from MongoDB
          const conversation = window.currentConversation;
          if (conversation && conversation._id) {
            // Set the conversation ID filter
            document.getElementById('task-search').value = `Conversation: ${selectedChatId.substring(0, 8)}...`;

            // Load tasks for this conversation
            loadTasksForConversation(conversation._id);
          } else {
            // If we don't have the conversation object with _id, we need to fetch it
            fetch(`/api/admin/chat/${selectedChatId}`, {
              headers: {
                'x-auth-token': localStorage.getItem('chatbot-auth-token')
              }
            })
              .then(response => response.json())
              .then(data => {
                if (data && data._id) {
                  // Set the conversation ID filter
                  document.getElementById('task-search').value = `Conversation: ${selectedChatId.substring(0, 8)}...`;

                  // Load tasks for this conversation
                  loadTasksForConversation(data._id);
                } else {
                  showNotification('Error', 'Failed to load conversation details', 'error');
                }
              })
              .catch(error => {
                logger.error('Error fetching conversation details:', error);
                showNotification('Error', 'Failed to load conversation details', 'error');
              });
          }
        }, 100);
      }
    }
  });

  document.getElementById('new-task-btn').addEventListener('click', function() {
    openTaskModal();
  });

  document.getElementById('save-task-btn').addEventListener('click', function() {
    saveTask(token);
  });

  document.getElementById('back-to-tasks-btn').addEventListener('click', function() {
    showTaskList();
  });

  // Set up event listeners for task filters
  document.getElementById('task-status-filter').addEventListener('change', function() {
    loadTasks(token);
  });

  document.getElementById('task-priority-filter').addEventListener('change', function() {
    loadTasks(token);
  });

  document.getElementById('task-assignee-filter').addEventListener('change', function() {
    loadTasks(token);
  });

  document.getElementById('task-search-btn').addEventListener('click', function() {
    loadTasks(token);
  });

  document.getElementById('task-search').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      loadTasks(token);
    }
  });

  document.getElementById('task-status-update').addEventListener('change', function() {
    updateTaskStatus(token, this.value);
  });

  document.getElementById('add-comment-btn').addEventListener('click', function() {
    addComment(token);
  });

  document.getElementById('comment-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      addComment(token);
    }
  });

  // Add event listeners to remove validation styling when user interacts with fields
  const requiredFields = [
    'task-title-input',
    'task-description-input',
    'task-due-date-input',
    'task-assignee-input'
  ];

  requiredFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    field.addEventListener('input', function() {
      this.classList.remove('is-invalid');
    });
    field.addEventListener('change', function() {
      this.classList.remove('is-invalid');
    });
  });

  // Load operators for assignee dropdown
  loadOperators(token);

  // Load initial tasks
  loadTasks(token);

  // Set up WebSocket listeners for task events
  setupTaskSocketListeners();
}

function setupTaskSocketListeners() {
  const socket = window.adminSocket;

  socket.on('task-created', function(data) {
    // Reload tasks if we're on the tasks page
    if (document.querySelector('#tasks-section').classList.contains('active')) {
      loadTasks();
    }

    // Show notification
    showNotification('New task created', `Task "${data.task.title}" has been created`);
  });

  socket.on('task-updated', function(data) {
    // If we're viewing this task, update the details
    const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
    if (currentTaskId === data.task._id) {
      loadTaskDetails(currentTaskId);
    }

    // Reload tasks if we're on the tasks page
    if (document.querySelector('#tasks-section').classList.contains('active')) {
      loadTasks();
    }
  });

  socket.on('task-assigned', function(data) {
    // If the task is assigned to current user, show notification
    if (data.task.assignee === window.currentUser._id) {
      showNotification('Task assigned to you', `Task "${data.task.title}" has been assigned to you`);
    }

    // Reload tasks if we're on the tasks page
    if (document.querySelector('#tasks-section').classList.contains('active')) {
      loadTasks();
    }
  });

  socket.on('task-deleted', function(data) {
    // If we're viewing this task, go back to task list
    const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
    if (currentTaskId === data.taskId) {
      showTaskList();
    }

    // Reload tasks if we're on the tasks page
    if (document.querySelector('#tasks-section').classList.contains('active')) {
      loadTasks();
    }
  });

  socket.on('comment-created', function(data) {
    // If we're viewing this task, update the comments
    const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
    if (currentTaskId === data.taskId) {
      loadTaskComments(currentTaskId);
    }
  });

  socket.on('comment-updated', function(data) {
    // If we're viewing this task, update the comments
    const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
    if (currentTaskId === data.taskId) {
      loadTaskComments(currentTaskId);
    }
  });

  socket.on('comment-deleted', function(data) {
    // If we're viewing this task, update the comments
    const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
    if (currentTaskId === data.taskId) {
      loadTaskComments(currentTaskId);
    }
  });
}

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
