
// Send operator message
function sendOperatorMessage(socket, messageInput) {
  const message = messageInput.value.trim();
  if (message) {
    const joinChatBtn = document.getElementById('join-chat-btn');
    const sessionId = joinChatBtn.getAttribute('data-session-id');

    // Clear typing indicator when sending a message
    socket.emit('operator-typing', {
      sessionId,
      isTyping: false
    });

    socket.emit('operator-message', {
      sessionId,
      message
    });

    // Also display the message in the operator's own chat window immediately
    addMessageToChat({
      content: message,
      sender: 'operator',
      timestamp: new Date()
    });

    // Clear input
    messageInput.value = '';
  }
}

// Initialize charts
let chatActivityChart;
let chatVolumeChart;
let responseTimeChart;

function initializeCharts() {
  // Chat Activity Chart
  const activityCtx = document.getElementById('chat-activity-chart').getContext('2d');
  chatActivityChart = new Chart(activityCtx, {
    type: 'line',
    data: {
      labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'],
      datasets: [{
        label: 'Number of Chats',
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: '#007bff',
        tension: 0.1,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      height: 300
    }
  });

  // Topics Chart
  const topicsCtx = document.getElementById('topics-chart').getContext('2d');
  // eslint-disable-next-line no-unused-vars
  const topicsChart = new Chart(topicsCtx, {
    type: 'doughnut',
    data: {
      labels: ['Properties', 'Mortgages', 'Payments', 'Other'],
      datasets: [{
        data: [0, 0, 0, 0],
        backgroundColor: ['#007bff', '#28a745', '#ffc107', '#dc3545']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      height: 300
    }
  });

  // Chat Volume Chart
  const volumeCtx = document.getElementById('chat-volume-chart').getContext('2d');
  chatVolumeChart = new Chart(volumeCtx, {
    type: 'bar',
    data: {
      labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
      datasets: [{
        label: 'Number of Chats',
        data: [0, 0, 0, 0],
        backgroundColor: '#007bff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      height: 300
    }
  });

  // Response Time Chart
  const responseCtx = document.getElementById('response-time-chart').getContext('2d');
  responseTimeChart = new Chart(responseCtx, {
    type: 'line',
    data: {
      labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
      datasets: [{
        label: 'Response Time (seconds)',
        data: [0, 0, 0, 0],
        borderColor: '#28a745',
        tension: 0.1,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      height: 300
    }
  });

  // Helper will update this chart once data is loaded
}

// Update the Response Time chart using analytics data
function updateResponseTimeChart(rtData) {
  if (!responseTimeChart) return;

  const labels = [];
  const dataPoints = [];

  if (Array.isArray(rtData)) {
    rtData.forEach(record => {
      const date = new Date(record._id.year, record._id.month - 1);
      const label = date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric'
      });
      labels.push(label);
      dataPoints.push(record.avg);
    });
  }

  responseTimeChart.data.labels = labels;
  responseTimeChart.data.datasets[0].data = dataPoints;
  responseTimeChart.update();
}

// Update the Chat Activity chart using analytics data
function updateChatActivityChart(volumeData) {
  if (!chatActivityChart) return;

  const labels = [];
  const dataPoints = [];
  const today = new Date();

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);

    const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    labels.push(label);

    const record = volumeData.find(v =>
      v._id.year === date.getFullYear() &&
      v._id.month === date.getMonth() + 1 &&
      v._id.day === date.getDate()
    );

    dataPoints.push(record ? record.count : 0);
  }

  chatActivityChart.data.labels = labels;
  chatActivityChart.data.datasets[0].data = dataPoints;
  chatActivityChart.update();
}

// Update the Chat Volume chart using analytics data
function updateChatVolumeChart(volumeData) {
  if (!chatVolumeChart) return;

  const labels = [];
  const dataPoints = [];

  if (Array.isArray(volumeData)) {
    volumeData.forEach(record => {
      const date = new Date(record._id.year, record._id.month - 1);
      const label = date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      labels.push(label);
      dataPoints.push(record.count);
    });
  }

  chatVolumeChart.data.labels = labels;
  chatVolumeChart.data.datasets[0].data = dataPoints;
  chatVolumeChart.update();
}

// Update conversation metrics table
function updateConversationMetrics(metrics) {
  if (!metrics) return;

  const total = metrics.totalConversations || {};
  document.getElementById('conv-total-today').textContent = total.today || 0;
  document.getElementById('conv-total-week').textContent = total.thisWeek || 0;
  document.getElementById('conv-total-month').textContent = total.thisMonth || 0;
  document.getElementById('conv-total-change').textContent =
    (total.change ?? 0) + '%';

  const dur = metrics.averageDuration || {};
  document.getElementById('conv-duration-today').textContent =
    (dur.today || 0) + ' min';
  document.getElementById('conv-duration-week').textContent =
    (dur.thisWeek || 0) + ' min';
  document.getElementById('conv-duration-month').textContent =
    (dur.thisMonth || 0) + ' min';
  document.getElementById('conv-duration-change').textContent =
    (dur.change ?? 0) + '%';

  const msgs = metrics.messagesPerConversation || {};
  document.getElementById('conv-msgs-today').textContent =
    Math.round(msgs.today || 0);
  document.getElementById('conv-msgs-week').textContent =
    Math.round(msgs.thisWeek || 0);
  document.getElementById('conv-msgs-month').textContent =
    Math.round(msgs.thisMonth || 0);
  document.getElementById('conv-msgs-change').textContent =
    (msgs.change ?? 0) + '%';
}

// Load dashboard data
function loadDashboardData(token) {
  // In a real app, this would fetch data from the server
  fetch('/api/admin/analytics', {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      document.getElementById('active-chats-count').textContent = data.activeChats || '0';
      document.getElementById('total-chats-today').textContent = data.totalChatsToday || '0';
      document.getElementById('avg-response-time').textContent = data.avgResponseTime ? `${data.avgResponseTime}s` : '0s';
      if (data.chatVolumePerDay) {
        updateChatActivityChart(data.chatVolumePerDay);
      }
      if (data.chatVolumeOverTime) {
        updateChatVolumeChart(data.chatVolumeOverTime);
      }
      if (data.responseTimeOverTime) {
        updateResponseTimeChart(data.responseTimeOverTime);
      }
      if (data.conversationMetrics) {
        updateConversationMetrics(data.conversationMetrics);
      }
    })
    .catch(error => {
      logger.error('Error loading dashboard data:', error);
    });
}

// Load active chats
function loadActiveChats(socket, token) {
  // In a real app, this would fetch data from the server
  fetch('/api/admin/active-chats', {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const chatList = document.getElementById('active-chat-list');

      // Clear the "no chats" message if there are chats
      if (data.chats && data.chats.length > 0) {
        chatList.innerHTML = '';

        // Add each chat to the list
        data.chats.forEach(chat => {
          addChatToList(chat);

          // If this chat was previously joined, automatically rejoin it
          if (window.joinedChats.has(chat.sessionId)) {
            logger.info('Automatically rejoining chat:', chat.sessionId);
            socket.emit('operator-takeover', {
              sessionId: chat.sessionId,
              operatorName: window.currentUser ? window.currentUser.username : 'Admin'
            });
          }
        });

        // Update active chats count
        document.getElementById('active-chats-count').textContent = data.chats.length;
      }
    })
    .catch(error => {
      logger.error('Error loading active chats:', error);
    });
}

// Load chat history
function loadChatHistory(token, search = '') {
  // In a real app, this would fetch data from the server
  const url = search
    ? `/api/admin/chat-history?search=${encodeURIComponent(search)}`
    : '/api/admin/chat-history';

  fetch(url, {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const historyTable = document.getElementById('chat-history-table');

      // Clear the "no history" message if there are records
      if (data.history && data.history.length > 0) {
        historyTable.innerHTML = '';

        // Add each record to the table
        data.history.forEach(record => {
          const row = document.createElement('tr');

          row.innerHTML = `
            <td>${record.sessionId.substring(0, 8)}...</td>
            <td>${new Date(record.startedAt).toLocaleString()}</td>
            <td>${calculateDuration(record.startedAt, record.endedAt)}</td>
            <td>${record.messages ? record.messages.length : (record['messages.length'] || 0)}</td>
            <td><span class="badge bg-${record.status === 'ended' ? 'secondary' : 'success'}">${record.status}</span></td>
            <td>
              <button class="btn btn-sm btn-primary view-chat-btn" data-session-id="${record.sessionId}">View</button>
              <button class="btn btn-sm btn-danger delete-chat-btn" data-session-id="${record.sessionId}">Delete</button>
            </td>
          `;

          historyTable.appendChild(row);
        });

        // Add event listeners to the buttons
        document.querySelectorAll('.view-chat-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            viewChatHistory(this.getAttribute('data-session-id'));
          });
        });

        document.querySelectorAll('.delete-chat-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            deleteChatHistory(this.getAttribute('data-session-id'));
          });
        });
      }
    })
    .catch(error => {
      logger.error('Error loading chat history:', error);
    });
}

// Add chat to list
function addChatToList(chat) {
  const chatList = document.getElementById('active-chat-list');

  // Remove empty state if present
  const emptyState = chatList.querySelector('.empty-state');
  if (emptyState) {
    chatList.removeChild(emptyState);
  }

  const chatItem = document.createElement('a');
  chatItem.href = '#';
  chatItem.className = 'list-group-item list-group-item-action';
  chatItem.setAttribute('data-session-id', chat.sessionId);

  const startTime = new Date(chat.startedAt || Date.now()).toLocaleTimeString();

  // Determine if the chat has an operator
  const hasOperator = chat.hasOperator || window.joinedChats.has(chat.sessionId);
  const statusClass = hasOperator ? 'has-operator' : 'no-operator';

  chatItem.innerHTML = `
    <div class="d-flex w-100 justify-content-between">
      <h6 class="mb-1">
        <span class="status-indicator ${statusClass}"></span>
        Session ${chat.sessionId.substring(0, 8)}...
      </h6>
      <small>${startTime}</small>
    </div>
    <p class="mb-1">Messages: ${chat.messages ? chat.messages.length : (chat['messages.length'] || 0)}</p>
    <small>From: ${chat.domain || 'Unknown'}</small>
  `;

  chatList.appendChild(chatItem);

  // Add event listener
  chatItem.addEventListener('click', function() {
    // Deselect all chats
    document.querySelectorAll('#active-chat-list a').forEach(a => {
      a.classList.remove('active');
    });

    // Select this chat
    this.classList.add('active');

    // Clear unread message indicators
    this.classList.remove('has-new-message');
    const badge = this.querySelector('.unread-badge');
    if (badge) {
      badge.remove();
    }

    // Load chat messages
    loadChatMessages(chat.sessionId);

    // Update selected chat title
    document.getElementById('selected-chat-title').textContent = `Session ${chat.sessionId.substring(0, 8)}...`;

    // Update the join and end buttons
    const joinBtn = document.getElementById('join-chat-btn');
    joinBtn.disabled = false;
    joinBtn.setAttribute('data-session-id', chat.sessionId);

    // Check if this chat has already been joined by the current operator
    const isJoined = window.joinedChats.has(chat.sessionId);
    if (isJoined) {
      joinBtn.textContent = 'Joined';
      joinBtn.classList.remove('btn-primary');
      joinBtn.classList.add('btn-success');
      joinBtn.setAttribute('data-joined', 'true');

      // Show the operator input
      document.getElementById('operator-input').style.display = 'block';
    } else {
      joinBtn.textContent = 'Join Chat';
      joinBtn.classList.remove('btn-success');
      joinBtn.classList.add('btn-primary');
      joinBtn.removeAttribute('data-joined');

      // Hide the operator input if not joined
      document.getElementById('operator-input').style.display = 'none';
    }

    // Update suggestion buttons based on join status
    // We need to wait a bit for the messages to load
    setTimeout(() => {
      // Find all suggestion buttons and update their state
      const suggestionButtons = document.querySelectorAll('.get-suggestion-btn');
      suggestionButtons.forEach(btn => {
        btn.disabled = !isJoined;
      });
    }, 500);

    const endBtn = document.getElementById('end-chat-btn');
    endBtn.disabled = false;
    endBtn.setAttribute('data-session-id', chat.sessionId);

    const leaveBtn = document.getElementById('leave-chat-btn');
    leaveBtn.disabled = !isJoined;
    leaveBtn.setAttribute('data-session-id', chat.sessionId);

    // Enable the Create Task and View Tasks buttons
    const createTaskBtn = document.getElementById('create-task-btn');
    createTaskBtn.disabled = false;

    const viewTasksBtn = document.getElementById('view-tasks-btn');
    viewTasksBtn.disabled = false;

    // Update URL with chat parameter
    updateUrlWithParams({
      section: 'active-chats',
      chat: chat.sessionId
    });
  });
}

// Load chat messages
function loadChatMessages(sessionId) {
  const token = localStorage.getItem('chatbot-auth-token');
  // In a real app, this would fetch data from the server
  fetch(`/api/admin/chat/${sessionId}`, {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(data => {
      const chatMessages = document.getElementById('chat-messages');
      chatMessages.innerHTML = '';

      // Store the conversation data globally for access in other functions
      window.currentConversation = data;

      // Display user contact information if available
      displayUserContactInfo(data);

      if (data.messages && data.messages.length > 0) {
        data.messages.forEach(msg => {
          // Get user name from metadata if available
          let userName = 'user';
          if (data.metadata && data.metadata.name) {
            userName = data.metadata.name;
          }

          addMessageToChat({
            _id: msg._id,
            content: msg.content,
            sender: msg.sender,
            timestamp: msg.timestamp,
            userName: userName
          });
        });
      } else {
        chatMessages.innerHTML = '<div class="empty-state"><p>No messages yet</p></div>';
      }

      // Scroll to bottom
      chatMessages.scrollTop = chatMessages.scrollHeight;
    })
    .catch(error => {
      logger.error('Error loading chat messages:', error);
    });
}

// Display user contact information
function displayUserContactInfo(conversation) {
  const contactInfoDiv = document.getElementById('user-contact-info');
  const nameSpan = document.getElementById('user-name');
  const emailSpan = document.getElementById('user-email');
  const phoneSpan = document.getElementById('user-phone');

  // Check if metadata exists and contains contact information
  if (conversation.metadata) {
    // Show the contact info section
    contactInfoDiv.style.display = 'block';

    // Check if metadata is a Map or a plain object
    if (conversation.metadata instanceof Map) {
      // Update the contact info fields
      nameSpan.textContent = conversation.metadata.get('name') || 'Not provided';
      emailSpan.textContent = conversation.metadata.get('email') || 'Not provided';
      phoneSpan.textContent = conversation.metadata.get('phone') || 'Not provided';

      // Apply styling for missing information
      nameSpan.className = conversation.metadata.get('name') ? '' : 'text-danger';
      emailSpan.className = conversation.metadata.get('email') ? '' : 'text-danger';
      phoneSpan.className = conversation.metadata.get('phone') ? '' : 'text-danger';
    } else {
      // Update the contact info fields
      nameSpan.textContent = conversation.metadata.name || 'Not provided';
      emailSpan.textContent = conversation.metadata.email || 'Not provided';
      phoneSpan.textContent = conversation.metadata.phone || 'Not provided';

      // Apply styling for missing information
      nameSpan.className = conversation.metadata.name ? '' : 'text-danger';
      emailSpan.className = conversation.metadata.email ? '' : 'text-danger';
      phoneSpan.className = conversation.metadata.phone ? '' : 'text-danger';
    }
  } else {
    // Show the contact info section with default values
    contactInfoDiv.style.display = 'block';
    nameSpan.textContent = 'Not provided';
    emailSpan.textContent = 'Not provided';
    phoneSpan.textContent = 'Not provided';
    nameSpan.className = 'text-danger';
    emailSpan.className = 'text-danger';
    phoneSpan.className = 'text-danger';
  }
}

// Add message to chat
function addMessageToChat(data) {
  const chatMessages = document.getElementById('chat-messages');

  // Remove empty state if present
  const emptyState = chatMessages.querySelector('.empty-state');
  if (emptyState) {
    chatMessages.removeChild(emptyState);
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${data.sender}`;

  // Store message ID if available
  if (data._id) {
    messageDiv.dataset.messageId = data._id;
  }

  const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

  // Create message content
  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = data.content;
  messageDiv.appendChild(contentDiv);

  // Handle system messages differently
  if (data.sender === 'system') {
    // For system messages, we don't need to show the sender name
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = timestamp;
    messageDiv.appendChild(timeDiv);
  } else {
    // Create message time with sender for non-system messages
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';

    // Use user's name if available for user messages
    if (data.sender === 'user' && data.userName && data.userName !== 'user') {
      timeDiv.textContent = `${data.userName} • ${timestamp}`;
    } else {
      timeDiv.textContent = `${data.sender} • ${timestamp}`;
    }

    messageDiv.appendChild(timeDiv);

    // Add "Get Suggestion" button for user messages if operator has joined
    if (data.sender === 'user') {
      const joinChatBtn = document.getElementById('join-chat-btn');
      const isJoined = joinChatBtn.getAttribute('data-joined') === 'true';

      if (isJoined) {
        const actionDiv = document.createElement('div');
        actionDiv.className = 'message-actions';
        actionDiv.style.marginTop = '5px';

        const getSuggestionBtn = document.createElement('button');
        getSuggestionBtn.className = 'btn btn-sm btn-outline-primary get-suggestion-btn';
        getSuggestionBtn.textContent = 'Get Suggestion';
        getSuggestionBtn.addEventListener('click', function() {
          // Get the session ID
          const sessionId = joinChatBtn.getAttribute('data-session-id');

          // Get the message ID if available
          const messageId = data._id;

          // Request suggestion
          const socket = window.adminSocket;
          socket.emit('request-suggestions', {
            sessionId,
            messageId
          });

          // Show loading state
          getSuggestionBtn.disabled = true;
          getSuggestionBtn.textContent = 'Generating...';

          // Reset button after a timeout
          setTimeout(() => {
            getSuggestionBtn.disabled = false;
            getSuggestionBtn.textContent = 'Get Suggestion';
          }, 5000);
        });

        actionDiv.appendChild(getSuggestionBtn);
        messageDiv.appendChild(actionDiv);
      }
    }
  }

  chatMessages.appendChild(messageDiv);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Remove chat from list
function removeChatFromList(sessionId) {
  const chatItem = document.querySelector(`#active-chat-list a[data-session-id="${sessionId}"]`);
  if (chatItem) {
    chatItem.remove();

    // If this was the selected chat, reset the view
    const joinBtn = document.getElementById('join-chat-btn');
    if (joinBtn.getAttribute('data-session-id') === sessionId) {
      resetChatView();
    }

    // If no more chats, show empty state
    const chatList = document.getElementById('active-chat-list');
    if (chatList.children.length === 0) {
      chatList.innerHTML = '<a href="#" class="list-group-item list-group-item-action empty-state">No active conversations</a>';
    }
  }
}

// Reset chat view
function resetChatView() {
  document.getElementById('selected-chat-title').textContent = 'Select a conversation';
  document.getElementById('chat-messages').innerHTML = '<div class="empty-state"><p>Select a conversation to view messages</p></div>';
  document.getElementById('operator-input').style.display = 'none';
  document.getElementById('join-chat-btn').disabled = true;
  document.getElementById('end-chat-btn').disabled = true;
  document.getElementById('leave-chat-btn').disabled = true;
}

// Update active chat count
function updateActiveChatCount(change) {
  const countElement = document.getElementById('active-chats-count');
  let count = parseInt(countElement.textContent);
  count += change;
  countElement.textContent = count.toString();
}

// Notify new chat
function notifyNewChat(chat) {
  // Check if sound notifications are enabled
  const soundEnabled = localStorage.getItem('sound-notifications') === 'true';

  // Check notification setting
  const notificationSetting = localStorage.getItem('notification-setting') || 'all';

  if (notificationSetting !== 'none') {
    // Show browser notification if supported
    if ('Notification' in window && Notification.permission === 'granted') {
      // Different notification based on whether this is a new or reactivated chat
      const title = chat.reactivated ? 'Chat Reactivated' : 'New Chat';
      const body = chat.reactivated
        ? `Chat session from ${chat.domain || 'Unknown'} has been reactivated`
        : `New chat session started from ${chat.domain || 'Unknown'}`;

      new Notification(title, { body });
    }

    // Play sound if enabled
    if (soundEnabled) {
      // In a real app, this would play a notification sound
      logger.info('Playing notification sound');
    }
  }
}

// Load column configuration
function loadColumnConfig() {
  const token = localStorage.getItem('chatbot-auth-token');

  fetch('/api/admin/column-config/apartment_info', {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(config => {
      // Clear existing column items
      const columnContainer = document.getElementById('column-config-container');
      columnContainer.innerHTML = '';

      // Sort columns by order
      const columns = config.columns.sort((a, b) => a.order - b.order);

      // Add column items to the container
      columns.forEach(column => {
        const item = document.createElement('div');
        item.className = 'list-group-item';
        item.setAttribute('data-key', column.key);
        item.setAttribute('data-order', column.order);

        item.innerHTML = `
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <input type="checkbox" class="form-check-input me-2" id="col-${column.key}" ${column.enabled ? 'checked' : ''}>
              <label class="form-check-label" for="col-${column.key}">${column.label}</label>
            </div>
            <div>
              <button class="btn btn-sm btn-outline-secondary move-up">↑</button>
              <button class="btn btn-sm btn-outline-secondary move-down">↓</button>
            </div>
          </div>
        `;

        columnContainer.appendChild(item);
      });

      // Add event listeners for move up/down buttons
      document.querySelectorAll('.move-up').forEach(btn => {
        btn.addEventListener('click', function() {
          const item = this.closest('.list-group-item');
          const prev = item.previousElementSibling;
          if (prev) {
            columnContainer.insertBefore(item, prev);
          }
        });
      });

      document.querySelectorAll('.move-down').forEach(btn => {
        btn.addEventListener('click', function() {
          const item = this.closest('.list-group-item');
          const next = item.nextElementSibling;
          if (next) {
            columnContainer.insertBefore(next, item);
          }
        });
      });
    })
    .catch(error => {
      logger.error('Error loading column configuration:', error);
    });
}

// Save settings
function saveSettings() {
  const notificationSetting = document.getElementById('notification-setting').value;
  const soundNotifications = document.getElementById('sound-notifications').checked;
  const autoRefresh = document.getElementById('auto-refresh').value;
  const enablePdf = document.getElementById('enable-pdf').checked;

  // Save settings to localStorage
  localStorage.setItem('notification-setting', notificationSetting);
  localStorage.setItem('sound-notifications', soundNotifications);
  localStorage.setItem('auto-refresh', autoRefresh);
  localStorage.setItem('enable-pdf', enablePdf);

  // Request notification permission if needed
  if (notificationSetting !== 'none' && 'Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }

  // Save column configuration
  saveColumnConfig();

  showToast('Settings saved successfully', 'success');
}

// Save column configuration
function saveColumnConfig() {
  const token = localStorage.getItem('chatbot-auth-token');
  const columnContainer = document.getElementById('column-config-container');
  const columnItems = columnContainer.querySelectorAll('.list-group-item');

  // Build columns array from UI
  const columns = Array.from(columnItems).map((item, index) => {
    const key = item.getAttribute('data-key');
    const checkbox = item.querySelector(`input[id="col-${key}"]`);
    const label = item.querySelector(`label[for="col-${key}"]`).textContent;

    return {
      key,
      label,
      enabled: checkbox.checked,
      order: index
    };
  });

  // Save to server
  fetch('/api/admin/column-config/apartment_info', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    },
    body: JSON.stringify({ columns })
  })
    .then(response => response.json())
    .then(data => {
      if (!data.success) {
        logger.error('Error saving column configuration:', data.error);
      }
    })
    .catch(error => {
      logger.error('Error saving column configuration:', error);
    });
}

// Set up connection event handlers
function setupConnectionHandlers(socket) {
  socket.on('connect', () => {
    logger.info('Socket connected');
    // Join operator room when connected
    socket.emit('join-operator-room');

    // Update UI to show connected status
    updateConnectionStatus(true);
  });

  socket.on('disconnect', (reason) => {
    logger.info('Socket disconnected:', reason);
    // Update UI to show disconnected status
    updateConnectionStatus(false);
  });

  socket.on('connect_error', (error) => {
    logger.error('Connection error:', error);
    // Update UI to show error status
    updateConnectionStatus(false, error.message);
  });

  socket.on('reconnect', (attemptNumber) => {
    logger.info(`Socket reconnected after ${attemptNumber} attempts`);
    // Join operator room when reconnected
    socket.emit('join-operator-room');

    // Update UI to show connected status
    updateConnectionStatus(true);

    // Reload active chats to ensure we have the latest data
    const token = localStorage.getItem('chatbot-auth-token');
    loadActiveChats(socket, token);
  });
}

// Start heartbeat to keep socket connection alive
function startHeartbeat(socket) {
  // Send a heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('heartbeat', { timestamp: new Date().toISOString() });
      logger.info('Heartbeat sent');
    }
  }, 30000);

  // Handle page visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // When page becomes visible, check socket connection and reconnect if needed
      if (socket && !socket.connected) {
        logger.info('Reconnecting socket on visibility change');
        socket.connect();
      }
    }
  });

  // Clean up interval when window is closed
  window.addEventListener('beforeunload', () => {
    clearInterval(heartbeatInterval);
  });
}

// Update connection status in UI
function updateConnectionStatus(isConnected, errorMessage = null) {
  const statusElement = document.getElementById('connection-status');
  if (!statusElement) {
    // Create status element if it doesn't exist
    const navbarNav = document.querySelector('.navbar-nav');
    if (navbarNav) {
      const statusItem = document.createElement('li');
      statusItem.className = 'nav-item ms-3';
      statusItem.innerHTML = `<span id="connection-status" class="badge ${isConnected ? 'bg-success' : 'bg-danger'}">${isConnected ? 'Connected' : 'Disconnected'}</span>`;
      navbarNav.appendChild(statusItem);
    }
  } else {
    // Update existing status element
    statusElement.className = `badge ${isConnected ? 'bg-success' : 'bg-danger'}`;
    statusElement.textContent = isConnected ? 'Connected' : 'Disconnected';

    if (!isConnected && errorMessage) {
      statusElement.title = errorMessage;
    } else {
      statusElement.title = '';
    }
  }
}

// Calculate duration between two timestamps
function calculateDuration(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();

  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);

  return durationMinutes + ' min';
}

// Update chat operator status
function updateChatOperatorStatus(sessionId, hasOperator) {
  // Find the chat item
  const chatItem = document.querySelector(`#active-chat-list a[data-session-id="${sessionId}"]`);
  if (!chatItem) {
    return;
  }

  // Find the status indicator
  const statusIndicator = chatItem.querySelector('.status-indicator');
  if (!statusIndicator) {
    return;
  }

  // Update the status class
  statusIndicator.classList.remove('has-operator', 'no-operator');
  statusIndicator.classList.add(hasOperator ? 'has-operator' : 'no-operator');

  // If this operator joined the chat, add it to the joined chats set
  if (hasOperator) {
    window.joinedChats.add(sessionId);
    // Save joined chats to localStorage
    window.saveJoinedChats();
  }
}

// View chat history
function viewChatHistory(sessionId) {
  const token = localStorage.getItem('chatbot-auth-token');

  // Fetch the chat details
  fetch(`/api/admin/chat/${sessionId}`, {
    headers: {
      'x-auth-token': token
    }
  })
    .then(response => response.json())
    .then(chat => {
      if (!chat) {
        showToast('Chat not found', 'danger');
        return;
      }

      // Switch to the active chats section
      document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
      });
      document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
      });

      const activeChatsLink = document.querySelector('.nav-link[data-section="active-chats"]');
      if (activeChatsLink) {
        activeChatsLink.classList.add('active');
      }

      const activeChatsSection = document.getElementById('active-chats-section');
      if (activeChatsSection) {
        activeChatsSection.classList.add('active');
      }

      // Update selected chat title
      document.getElementById('selected-chat-title').textContent = `Session ${chat.sessionId.substring(0, 8)}...`;

      // Load chat messages
      const chatMessages = document.getElementById('chat-messages');
      chatMessages.innerHTML = '';

      if (chat.messages && chat.messages.length > 0) {
        chat.messages.forEach(msg => {
          addMessageToChat({
            _id: msg._id,
            content: msg.content,
            sender: msg.sender,
            timestamp: msg.timestamp
          });
        });
      } else {
        chatMessages.innerHTML = '<div class="empty-state"><p>No messages yet</p></div>';
      }

      // Scroll to bottom
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // Set up join and end buttons
      const joinBtn = document.getElementById('join-chat-btn');
      joinBtn.disabled = false;
      joinBtn.setAttribute('data-session-id', chat.sessionId);

      // Check if this chat is active and not already joined
      if (chat.status === 'active') {
        if (window.joinedChats.has(chat.sessionId)) {
          joinBtn.textContent = 'Joined';
          joinBtn.classList.remove('btn-primary');
          joinBtn.classList.add('btn-success');
          joinBtn.setAttribute('data-joined', 'true');

          // Show the operator input
          document.getElementById('operator-input').style.display = 'block';
        } else {
          joinBtn.textContent = 'Join Chat';
          joinBtn.classList.remove('btn-success');
          joinBtn.classList.add('btn-primary');
          joinBtn.removeAttribute('data-joined');

          // Hide the operator input
          document.getElementById('operator-input').style.display = 'none';
        }
      } else {
        // Chat is not active, disable join button
        joinBtn.disabled = true;
        joinBtn.textContent = 'Chat Ended';
        joinBtn.classList.remove('btn-primary', 'btn-success');
        joinBtn.classList.add('btn-secondary');

        // Hide the operator input
        document.getElementById('operator-input').style.display = 'none';
      }

      const endBtn = document.getElementById('end-chat-btn');
      endBtn.disabled = chat.status !== 'active';
      endBtn.setAttribute('data-session-id', chat.sessionId);

      const leaveBtn = document.getElementById('leave-chat-btn');
      leaveBtn.disabled = !window.joinedChats.has(chat.sessionId);
      leaveBtn.setAttribute('data-session-id', chat.sessionId);

      // Update URL with chat parameter
      updateUrlWithParams({
        section: 'active-chats',
        chat: chat.sessionId
      });
    })
    .catch(error => {
      logger.error('Error viewing chat history:', error);
      showToast('An error occurred while loading the chat', 'danger');
    });
}

// Delete chat history
function deleteChatHistory(sessionId) {
  const token = localStorage.getItem('chatbot-auth-token');
  if (confirm('Are you sure you want to delete this chat history? This action cannot be undone.')) {
    fetch(`/api/admin/chat/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'x-auth-token': token
      }
    })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          // Remove from table
          const row = document.querySelector(`#chat-history-table tr button[data-session-id="${sessionId}"]`).closest('tr');
          row.remove();

          // If no more history, show empty state
          const historyTable = document.getElementById('chat-history-table');
          if (historyTable.children.length === 0) {
            historyTable.innerHTML = '<tr><td colspan="6" class="text-center">No chat history available</td></tr>';
          }
        } else {
          showToast('Failed to delete chat history', 'danger');
        }
      })
      .catch(error => {
        logger.error('Error deleting chat history:', error);
        showToast('An error occurred while deleting chat history', 'danger');
      });
  }
}

// Add styles for suggestions
const suggestionStyles = document.createElement('style');
suggestionStyles.textContent = `
  /* Suggestion styles */
  .suggestions-container {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    margin: 10px 0;
    padding: 10px;
    max-height: 300px;
    overflow-y: auto;
  }

  .suggestions-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    border-bottom: 1px solid #dee2e6;
    padding-bottom: 5px;
  }

  .suggestions-title {
    font-weight: bold;
    margin: 0;
  }

  .suggestions-controls {
    display: flex;
    align-items: center;
  }

  .suggestion-item {
    background-color: white;
    border-left: 4px solid #007bff;
    margin-bottom: 8px;
    padding: 10px;
    border-radius: 0 4px 4px 0;
    transition: all 0.2s ease;
  }

  .suggestion-item.used {
    opacity: 0.6;
  }

  .suggestion-content {
    margin-bottom: 8px;
    white-space: pre-wrap;
  }

  .suggestion-actions {
    display: flex;
    gap: 5px;
  }

  .suggestion-edit-container {
    margin-top: 10px;
  }

  .suggestion-edit-textarea {
    width: 100%;
    min-height: 100px;
    margin-bottom: 8px;
    padding: 5px;
  }

  .suggestion-edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 5px;
  }

  .user-query {
    font-style: italic;
    color: #6c757d;
    margin-bottom: 10px;
    padding: 5px;
    background-color: #f1f1f1;
    border-radius: 4px;
  }
`;
document.head.appendChild(suggestionStyles);

// Function to display suggestions to operators
function displaySuggestion(data) {
  // eslint-disable-next-line no-unused-vars
  const { sessionId, userMessageId, userMessage, suggestion, suggestionId } = data;

  // Check if this is the currently selected chat
  const joinChatBtn = document.getElementById('join-chat-btn');
  const selectedChatId = joinChatBtn.getAttribute('data-session-id');

  if (selectedChatId !== sessionId) {
    // Not the current chat, don't display
    return;
  }

  // Check if suggestions container exists, create if not
  let suggestionsContainer = document.querySelector('.suggestions-container');
  if (!suggestionsContainer) {
    suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'suggestions-container';

    // Create header
    const header = document.createElement('div');
    header.className = 'suggestions-header';
    header.innerHTML = `
      <h5 class="suggestions-title">AI Suggestions</h5>
      <div class="suggestions-controls">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="suggestions-toggle" checked>
          <label class="form-check-label" for="suggestions-toggle">Enable Suggestions</label>
        </div>
      </div>
    `;
    suggestionsContainer.appendChild(header);

    // Add event listener for toggle switch
    const toggle = header.querySelector('#suggestions-toggle');
    toggle.addEventListener('change', function() {
      const enabled = this.checked;
      const sessionId = joinChatBtn.getAttribute('data-session-id');

      // Emit event to toggle suggestions
      const socket = window.adminSocket;
      socket.emit('toggle-suggestions', {
        sessionId,
        enabled
      });
    });

    // Insert after chat messages and before operator input
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.parentNode.insertBefore(suggestionsContainer, document.getElementById('operator-input'));
  }

  // Create suggestion item
  const suggestionItem = document.createElement('div');
  suggestionItem.className = 'suggestion-item';
  suggestionItem.dataset.suggestionId = suggestionId;

  // Add user query
  const userQueryEl = document.createElement('div');
  userQueryEl.className = 'user-query';
  userQueryEl.textContent = `User: ${userMessage}`;
  suggestionItem.appendChild(userQueryEl);

  // Add suggestion content
  const contentEl = document.createElement('div');
  contentEl.className = 'suggestion-content';
  contentEl.textContent = suggestion;
  suggestionItem.appendChild(contentEl);

  // Add action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'suggestion-actions';
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary use-suggestion-btn">Use</button>
    <button class="btn btn-sm btn-secondary edit-suggestion-btn">Edit</button>
    <button class="btn btn-sm btn-outline-danger dismiss-suggestion-btn">Dismiss</button>
  `;
  suggestionItem.appendChild(actionsEl);

  // Add to container
  suggestionsContainer.appendChild(suggestionItem);

  // Add event listeners
  const useBtn = suggestionItem.querySelector('.use-suggestion-btn');
  useBtn.addEventListener('click', function() {
    useSuggestion(suggestionId);
  });

  const editBtn = suggestionItem.querySelector('.edit-suggestion-btn');
  editBtn.addEventListener('click', function() {
    editSuggestion(suggestionItem, suggestion, suggestionId);
  });

  const dismissBtn = suggestionItem.querySelector('.dismiss-suggestion-btn');
  dismissBtn.addEventListener('click', function() {
    suggestionItem.remove();
  });
}

// Function to use a suggestion
function useSuggestion(suggestionId) {
  // Use the global socket connection with authentication
  const socket = window.adminSocket;
  const sessionId = document.getElementById('join-chat-btn').getAttribute('data-session-id');

  // Mark suggestion as used
  const suggestionItem = document.querySelector(`.suggestion-item[data-suggestion-id="${suggestionId}"]`);
  if (suggestionItem) {
    const suggestionText = suggestionItem.querySelector('.suggestion-content').textContent;

    // Add message to chat window to show it's being sent
    addMessageToChat({
      content: suggestionText,
      sender: 'operator',
      timestamp: new Date()
    });

    // Emit the event to use the suggestion
    socket.emit('use-suggestion', {
      sessionId: sessionId,
      suggestionId
    });

    suggestionItem.classList.add('used');

    // Disable buttons
    const buttons = suggestionItem.querySelectorAll('button');
    buttons.forEach(btn => btn.disabled = true);
  }
}

// Function to edit a suggestion
function editSuggestion(suggestionItem, suggestion, suggestionId) {
  // Create edit container
  const editContainer = document.createElement('div');
  editContainer.className = 'suggestion-edit-container';

  // Create textarea with suggestion content
  const textarea = document.createElement('textarea');
  textarea.className = 'suggestion-edit-textarea form-control';
  textarea.value = suggestion;
  editContainer.appendChild(textarea);

  // Create action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'suggestion-edit-actions';
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary save-edit-btn">Save & Use</button>
    <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
  `;
  editContainer.appendChild(actionsEl);

  // Hide the original content and actions
  const contentEl = suggestionItem.querySelector('.suggestion-content');
  const originalActionsEl = suggestionItem.querySelector('.suggestion-actions');
  contentEl.style.display = 'none';
  originalActionsEl.style.display = 'none';

  // Add edit container
  suggestionItem.appendChild(editContainer);

  // Focus textarea
  textarea.focus();

  // Add event listeners
  const saveBtn = editContainer.querySelector('.save-edit-btn');
  saveBtn.addEventListener('click', function() {
    const editedText = textarea.value;
    const sessionId = document.getElementById('join-chat-btn').getAttribute('data-session-id');

    // Add message to chat window to show it's being sent
    addMessageToChat({
      content: editedText,
      sender: 'operator',
      timestamp: new Date()
    });

    // Use the edited suggestion
    const socket = window.adminSocket;
    socket.emit('use-suggestion', {
      sessionId: sessionId,
      suggestionId,
      edited: editedText
    });

    // Update UI
    contentEl.textContent = editedText;
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();

    // Mark as used
    suggestionItem.classList.add('used');

    // Disable buttons
    const buttons = suggestionItem.querySelectorAll('.suggestion-actions button');
    buttons.forEach(btn => btn.disabled = true);
  });

  const cancelBtn = editContainer.querySelector('.cancel-edit-btn');
  cancelBtn.addEventListener('click', function() {
    // Restore original content and actions
    contentEl.style.display = 'block';
    originalActionsEl.style.display = 'flex';
    editContainer.remove();
  });
}

// Add socket event listeners for suggestions
function setupSuggestionEventHandlers(socket) {
  // Listen for operator suggestions
  socket.on('operator-suggestion', function(data) {
    displaySuggestion(data);
  });

  // Listen for suggestion used events
  socket.on('suggestion-used', function(data) {
    const { suggestionId, operatorName } = data;

    // Mark suggestion as used if it exists
    const suggestionItem = document.querySelector(`.suggestion-item[data-suggestion-id="${suggestionId}"]`);
    if (suggestionItem) {
      suggestionItem.classList.add('used');

      // Add a note about who used it
      const noteEl = document.createElement('div');
      noteEl.className = 'text-muted small mt-2';
      noteEl.textContent = `Used by ${operatorName}`;
      suggestionItem.appendChild(noteEl);

      // Disable buttons
      const buttons = suggestionItem.querySelectorAll('button');
      buttons.forEach(btn => btn.disabled = true);
    }
  });

  // Listen for suggestions status changed
  socket.on('suggestions-status-changed', function(data) {
    const { sessionId, enabled } = data;

    // Update toggle if this is the current chat
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

