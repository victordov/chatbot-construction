/**
 * Markdown Support for Task Descriptions
 * 
 * We use the marked.js library to render Markdown in task descriptions.
 * This allows users to format their task descriptions with:
 * - Headers (# Header)
 * - Bold text (**bold**)
 * - Italic text (*italic*)
 * - Lists (- item)
 * - Links ([text](url))
 * - And other Markdown features
 * 
 * Security is ensured by enabling the sanitize option to prevent XSS attacks.
 */
// Configure marked.js for Markdown rendering
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true, // GitHub Flavored Markdown
    breaks: true, // Convert line breaks to <br>
    sanitize: true, // Sanitize HTML to prevent XSS attacks
    smartLists: true, // Use smarter list behavior
    smartypants: false // Don't use "smart" typographic punctuation
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

  document.getElementById('edit-task-btn').addEventListener('click', function() {
    const taskId = document.getElementById('task-detail-container').dataset.taskId;
    editTaskFromDetails(taskId);
  });

  // Check URL parameters for task ID
  const params = getUrlParams();
  if (params.section === 'tasks' && params.taskId) {
    // Small delay to ensure the section is loaded
    setTimeout(() => {
      loadTaskDetails(params.taskId);
    }, 100);
  }

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

// Task utility functions moved from admin-operators.js
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
    const assigneeDisplay = task.assigneeName || task.assignee?.username || 'Unassigned';

    // Format due date
    const dueDate = new Date(task.dueDate);
    const formattedDate = dueDate.toLocaleDateString();

    // Check if task is overdue
    const now = new Date();
    if (dueDate < now && task.status !== 'completed') {
      row.classList.add('overdue-task');
      row.style.color = '#dc3545'; // Bootstrap danger color
    }

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

    // Add follow-up indicator if task has follow-ups
    if (task.hasFollowUps) {
      const followUpIndicator = document.createElement('span');
      followUpIndicator.className = 'badge bg-info ms-2';
      followUpIndicator.innerHTML = '<i data-feather="git-branch"></i>';
      followUpIndicator.title = 'Has follow-up tasks';
      followUpIndicator.style.cursor = 'pointer';
      followUpIndicator.addEventListener('click', function(e) {
        e.stopPropagation();
        loadTaskDetails(task._id);
      });
      actionsCell.appendChild(followUpIndicator);
    }

    // Add parent task indicator if this is a follow-up task
    if (task.parentTaskId) {
      const parentTaskIndicator = document.createElement('span');
      parentTaskIndicator.className = 'badge bg-secondary ms-2';
      parentTaskIndicator.innerHTML = '<i data-feather="corner-right-up"></i>';
      parentTaskIndicator.title = 'Follow-up task';
      parentTaskIndicator.style.cursor = 'pointer';
      actionsCell.appendChild(parentTaskIndicator);
    }

    // Process description for the task list
    // In the list view, we show a plain text preview of the description
    // We don't render Markdown here since it's just a truncated preview
    // and rendering HTML in a truncated string could lead to broken tags
    let processedDescription = task.description;
    if (processedDescription.length > 50) {
      processedDescription = processedDescription.substring(0, 50) + '...';
    }

    // Add cells to row
    row.innerHTML = `
      <td>${task.title}</td>
      <td class="description-cell">${processedDescription}</td>
      <td>${formattedDate}</td>
      <td></td>
      <td>${assigneeDisplay}</td>
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
  // Update URL with task ID
  updateUrlWithParams({ section: 'tasks', taskId: taskId });

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
      loadTaskActivities(taskId);
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

  // Show parent task info if this is a follow-up task
  const parentTaskInfo = document.getElementById('parent-task-info');
  if (task.parentTaskId) {
    parentTaskInfo.style.display = 'block';
    document.getElementById('parent-task-title').textContent = task.parentTaskId.title || 'Parent Task';
    document.getElementById('parent-task-link').onclick = function() {
      loadTaskDetails(task.parentTaskId._id);
      return false;
    };
  } else {
    parentTaskInfo.style.display = 'none';
  }

  // Load follow-up tasks if any
  loadFollowUpTasks(task._id);

  const assigneeDisplay = task.assigneeName || task.assignee?.username || 'Unassigned';

  // Set task details
  document.getElementById('task-title').textContent = task.title;

  // Render task description with Markdown
  // This converts Markdown syntax to HTML for display
  // The sanitize option is enabled to prevent XSS attacks
  const descriptionElement = document.getElementById('task-description');
  descriptionElement.innerHTML = marked.parse(task.description, { sanitize: true });

  // Format due date
  const dueDate = new Date(task.dueDate);
  document.getElementById('task-due-date').textContent = dueDate.toLocaleDateString();

  // Check if task is overdue
  const now = new Date();
  if (dueDate < now && task.status !== 'completed') {
    document.getElementById('task-due-date').classList.add('text-danger');
    document.getElementById('task-due-date').innerHTML += ' <span class="badge bg-danger">OVERDUE</span>';
  }

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
  document.getElementById('task-assignee').textContent = assigneeDisplay;

  // Set status dropdown
  document.getElementById('task-status-update').value = task.status;

  // Add Create Follow-up button
  const createFollowUpBtn = document.getElementById('create-follow-up-btn');
  createFollowUpBtn.onclick = function() {
    openFollowUpTaskModal(task._id);
  };

  // Set conversation link if available
  const conversationLink = document.getElementById('task-conversation-link');
  if (task.conversationId) {
    const sessionId = task.conversationId.sessionId || task.conversationId;
    conversationLink.href = `#active-chats-section?session=${sessionId}`;
    conversationLink.style.display = 'inline-block';
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

function loadTaskActivities(taskId) {
  fetch(`/api/tasks/${taskId}/activities`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load task activities');
      }
      return response.json();
    })
    .then(data => {
      displayTaskActivities(data.activities);
    })
    .catch(error => {
      logger.error('Error loading task activities:', error);
      // Don't show error notification for activities as it's not critical
      // Just display empty state
      displayTaskActivities([]);
    });
}

// Display task activities
function displayTaskActivities(activities) {
  const activityList = document.getElementById('task-activity-list');
  
  // Clear existing activities
  activityList.innerHTML = '';

  if (activities.length === 0) {
    activityList.innerHTML = '<li class="list-group-item text-center text-muted">No activity yet</li>';
    return;
  }

  activities.forEach(activity => {
    const activityItem = document.createElement('li');
    activityItem.className = 'list-group-item';

    // Format timestamp
    const timestamp = new Date(activity.createdAt);
    const formattedTime = timestamp.toLocaleString();

    // Get activity icon based on type
    const icon = getActivityIcon(activity.type);

    // Create activity content
    activityItem.innerHTML = `
      <div class="d-flex align-items-start">
        <div class="me-2">
          <i data-feather="${icon}" class="text-muted" style="width: 16px; height: 16px;"></i>
        </div>
        <div class="flex-grow-1">
          <div class="fw-bold">${activity.userName}</div>
          <div class="text-muted small">${activity.description}</div>
          <div class="text-muted small">${formattedTime}</div>
        </div>
      </div>
    `;

    activityList.appendChild(activityItem);
  });

  // Initialize Feather icons for the new activity items
  feather.replace();
}

// Get appropriate icon for activity type
function getActivityIcon(activityType) {
  const iconMap = {
    'task_created': 'plus',
    'task_updated': 'edit',
    'task_assigned': 'user',
    'task_unassigned': 'user-x',
    'status_changed': 'check-circle',
    'priority_changed': 'flag',
    'due_date_changed': 'calendar',
    'comment_added': 'message-circle',
    'comment_updated': 'edit',
    'comment_deleted': 'trash-2',
    'follow_up_created': 'git-branch',
    'task_completed': 'check',
    'task_deleted': 'trash-2'
  };

  return iconMap[activityType] || 'activity';
}

function loadFollowUpTasks(taskId) {
  fetch(`/api/tasks/${taskId}/follow-ups`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load follow-up tasks');
      }
      return response.json();
    })
    .then(data => {
      displayFollowUpTasks(data.tasks);
    })
    .catch(error => {
      logger.error('Error loading follow-up tasks:', error);
      showNotification('Error', 'Failed to load follow-up tasks', 'error');
    });
}

function displayFollowUpTasks(tasks) {
  const followUpsList = document.getElementById('follow-ups-list');
  const followUpsSection = document.getElementById('follow-ups-section');

  // Clear existing follow-up tasks
  followUpsList.innerHTML = '';

  if (tasks.length === 0) {
    followUpsSection.style.display = 'none';
    return;
  }

  followUpsSection.style.display = 'block';

  tasks.forEach(task => {
    const taskItem = document.createElement('div');
    taskItem.className = 'card mb-2';

    // Format due date
    const dueDate = new Date(task.dueDate);
    const formattedDate = dueDate.toLocaleDateString();

    // Check if task is overdue
    const now = new Date();
    let overdueClass = '';
    let overdueLabel = '';

    if (dueDate < now && task.status !== 'completed') {
      overdueClass = 'text-danger';
      overdueLabel = ' <span class="badge bg-danger">OVERDUE</span>';
    }

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

    taskItem.innerHTML = `
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="mb-0"><a href="#" class="follow-up-link">${task.title}</a></h6>
          <div>
            ${statusBadge.outerHTML}
          </div>
        </div>
        <div class="d-flex justify-content-between align-items-center">
          <small class="text-muted">Assigned to: ${task.assigneeName || task.assignee?.username || 'Unassigned'}</small>
          <small class="${overdueClass}">Due: ${formattedDate}${overdueLabel}</small>
        </div>
      </div>
    `;

    // Add click event to the follow-up link
    taskItem.querySelector('.follow-up-link').addEventListener('click', function(e) {
      e.preventDefault();
      loadTaskDetails(task._id);
    });

    followUpsList.appendChild(taskItem);
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

  comments.forEach(comment => {
    const commentDiv = document.createElement('div');
    commentDiv.className = 'card mb-2';

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
  document.getElementById('task-detail-container').style.display = 'none';
  document.querySelector('.row.mb-3').style.display = 'block';
}

function openTaskModal(conversationId = null, task = null) {
  document.getElementById('task-form').reset();

  loadOperators(localStorage.getItem('chatbot-auth-token'))
    .then(() => {
      const taskModal = new bootstrap.Modal(document.getElementById('taskModal'));
      taskModal.show();
    });

  // Hide parent task info by default
  document.getElementById('parent-task-info-modal').style.display = 'none';

  if (conversationId) {
    document.getElementById('conversation-id').value = conversationId;

    if (window.currentConversation && window.currentConversation.sessionId === conversationId) {
      const metadata = window.currentConversation.metadata;
      if (metadata) {
        if (metadata instanceof Map) {
          document.getElementById('contact-name-input').value = metadata.get('name') || '';
          document.getElementById('contact-email-input').value = metadata.get('email') || '';
          document.getElementById('contact-phone-input').value = metadata.get('phone') || '';

          document.getElementById('name-missing').style.display = !metadata.get('name') ? 'block' : 'none';
          document.getElementById('email-missing').style.display = !metadata.get('email') ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = !metadata.get('phone') ? 'block' : 'none';
        } else {
          document.getElementById('contact-name-input').value = metadata.name || '';
          document.getElementById('contact-email-input').value = metadata.email || '';
          document.getElementById('contact-phone-input').value = metadata.phone || '';

          document.getElementById('name-missing').style.display = !metadata.name ? 'block' : 'none';
          document.getElementById('email-missing').style.display = !metadata.email ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = !metadata.phone ? 'block' : 'none';
        }
      }
    } else {
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

          document.getElementById('name-missing').style.display = metadata && !metadata.get('name') ? 'block' : 'none';
          document.getElementById('email-missing').style.display = metadata && !metadata.get('email') ? 'block' : 'none';
          document.getElementById('phone-missing').style.display = metadata && !metadata.get('phone') ? 'block' : 'none';
        })
        .catch(error => {
          logger.error('Error loading conversation:', error);
        });
    }
  }

  if (task) {
    document.getElementById('taskModalLabel').textContent = 'Edit Task';
    document.getElementById('save-task-btn').textContent = 'Update Task';

    document.getElementById('conversation-id').value = task.conversationId || '';
    document.getElementById('task-title-input').value = task.title;
    document.getElementById('task-description-input').value = task.description;

    const dueDate = new Date(task.dueDate);
    const formattedDate = dueDate.toISOString().split('T')[0];
    document.getElementById('task-due-date-input').value = formattedDate;

    document.getElementById('task-priority-input').value = task.priority;
    document.getElementById('task-assignee-input').value = task.assignee;

    // Show parent task info if this is a follow-up task
    if (task.parentTaskId) {
      document.getElementById('parent-task-info-modal').style.display = 'block';
      document.getElementById('parent-task-title-modal').textContent = 
        task.parentTaskId.title || 'Parent Task';
      document.getElementById('parent-task-id').value = task.parentTaskId._id || task.parentTaskId;
    }

    if (task.contactInfo) {
      document.getElementById('contact-name-input').value = task.contactInfo.name || '';
      document.getElementById('contact-email-input').value = task.contactInfo.email || '';
      document.getElementById('contact-phone-input').value = task.contactInfo.phone || '';

      document.getElementById('name-missing').style.display = !task.contactInfo.name ? 'block' : 'none';
      document.getElementById('email-missing').style.display = !task.contactInfo.email ? 'block' : 'none';
      document.getElementById('phone-missing').style.display = !task.contactInfo.phone ? 'block' : 'none';
    }

    document.getElementById('task-form').dataset.taskId = task._id;
  } else {
    document.getElementById('taskModalLabel').textContent = 'Create New Task';
    document.getElementById('save-task-btn').textContent = 'Create Task';

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const formattedDate = tomorrow.toISOString().split('T')[0];
    document.getElementById('task-due-date-input').value = formattedDate;

    delete document.getElementById('task-form').dataset.taskId;
  }
}

function saveTask(token) {
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

  const contactInfo = {
    name: document.getElementById('contact-name-input').value,
    email: document.getElementById('contact-email-input').value,
    phone: document.getElementById('contact-phone-input').value
  };

  let isValid = true;

  titleInput.classList.remove('is-invalid');
  descriptionInput.classList.remove('is-invalid');
  dueDateInput.classList.remove('is-invalid');
  assigneeInput.classList.remove('is-invalid');

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

  // Assignee is optional, no validation needed

  if (!isValid) {
    return;
  }

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

  // Handle parent task ID for follow-up tasks
  const parentTaskId = document.getElementById('parent-task-id').value;
  if (parentTaskId) {
    taskData.parentTaskId = parentTaskId;
  }

  const method = taskId ? 'PUT' : 'POST';
  const url = taskId ? `/api/tasks/${taskId}` : '/api/tasks';

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
      data => {
        bootstrap.Modal.getInstance(document.getElementById('taskModal')).hide();

        showNotification('Success', taskId ? 'Task updated successfully' : 'Task created successfully', 'success');

        // If we're viewing a task and it was updated, reload the activities
        const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
        if (taskId && currentTaskId === taskId) {
          loadTaskActivities(taskId);
        }

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
      data => {
        showNotification('Success', 'Task status updated successfully', 'success');
        // Reload activities to show the status change
        loadTaskActivities(taskId);
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
      data => {
        document.getElementById('comment-input').value = '';
        loadTaskComments(taskId);
        // Reload activities to show the new comment
        loadTaskActivities(taskId);
      })
    .catch(error => {
      logger.error('Error adding comment:', error);
      showNotification('Error', 'Failed to add comment', 'error');
    });
}

function openFollowUpTaskModal(parentTaskId) {
  document.getElementById('task-form').reset();

  // Get the parent task details
  fetch(`/api/tasks/${parentTaskId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': localStorage.getItem('chatbot-auth-token')
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load parent task details');
      }
      return response.json();
    })
    .then(data => {
      const parentTask = data.task;

      // Set parent task info
      document.getElementById('parent-task-info-modal').style.display = 'block';
      document.getElementById('parent-task-title-modal').textContent = parentTask.title;

      // Set default due date (7 days after parent task due date)
      const parentDueDate = new Date(parentTask.dueDate);
      const followUpDueDate = new Date(parentDueDate);
      followUpDueDate.setDate(followUpDueDate.getDate() + 7);
      const formattedDate = followUpDueDate.toISOString().split('T')[0];
      document.getElementById('task-due-date-input').value = formattedDate;

      // Set parent task ID
      document.getElementById('parent-task-id').value = parentTaskId;

      // Set conversation ID if available
      if (parentTask.conversationId) {
        document.getElementById('conversation-id').value = 
          parentTask.conversationId._id || parentTask.conversationId;
      }

      // Set contact info if available
      if (parentTask.contactInfo) {
        document.getElementById('contact-name-input').value = parentTask.contactInfo.name || '';
        document.getElementById('contact-email-input').value = parentTask.contactInfo.email || '';
        document.getElementById('contact-phone-input').value = parentTask.contactInfo.phone || '';

        document.getElementById('name-missing').style.display = !parentTask.contactInfo.name ? 'block' : 'none';
        document.getElementById('email-missing').style.display = !parentTask.contactInfo.email ? 'block' : 'none';
        document.getElementById('phone-missing').style.display = !parentTask.contactInfo.phone ? 'block' : 'none';
      }

      // Update modal title and button text
      document.getElementById('taskModalLabel').textContent = 'Create Follow-up Task';
      document.getElementById('save-task-btn').textContent = 'Create Follow-up Task';

      // Load operators and show modal
      loadOperators(localStorage.getItem('chatbot-auth-token'))
        .then(() => {
          const taskModal = new bootstrap.Modal(document.getElementById('taskModal'));
          taskModal.show();
        });
    })
    .catch(error => {
      logger.error('Error loading parent task details:', error);
      showNotification('Error', 'Failed to load parent task details', 'error');
    });
}

function editTaskFromDetails(taskId) {
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
      openTaskModal(null, data.task);
    })
    .catch(error => {
      logger.error('Error loading task for editing:', error);
      showNotification('Error', 'Failed to load task for editing', 'error');
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
      data => {
        showNotification('Success', 'Task deleted successfully', 'success');

        const currentTaskId = document.querySelector('#task-detail-container')?.dataset.taskId;
        if (currentTaskId === taskId) {
          showTaskList();
        }

        loadTasks();
      })
    .catch(error => {
      logger.error('Error deleting task:', error);
      showNotification('Error', 'Failed to delete task', 'error');
    });
}
