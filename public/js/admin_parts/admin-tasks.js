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
