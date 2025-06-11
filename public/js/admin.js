// Admin Dashboard JavaScript
// Add CSS for unread message indicators and operator status

// Client-side logger
const logger = {
  info: function(message, data) {
    if (data) {
      console.log(message, data);
    } else {
      console.log(message);
    }
  },
  error: function(message, error) {
    if (error) {
      console.error(message, error);
    } else {
      console.error(message);
    }
  },
  warn: function(message, data) {
    if (data) {
      console.warn(message, data);
    } else {
      console.warn(message);
    }
  },
  debug: function(message, data) {
    if (data) {
      console.debug(message, data);
    } else {
      console.debug(message);
    }
  }
};
const style = document.createElement('style');
style.textContent = `
  .has-new-message {
    background-color: #f8f9fa;
    font-weight: bold;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0% { background-color: #f8f9fa; }
    50% { background-color: #e2f0ff; }
    100% { background-color: #f8f9fa; }
  }

  .unread-badge {
    margin-left: 5px;
    padding: 3px 6px;
    border-radius: 10px;
    font-size: 0.7em;
  }

  .status-indicator {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 5px;
  }

  .status-indicator.no-operator {
    background-color: #ffc107; /* Amber color */
  }

  .status-indicator.has-operator {
    background-color: #28a745; /* Green color */
  }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', function() {
  // Check if user is logged in
  const token = localStorage.getItem('chatbot-auth-token');
  if (!token) {
    // Redirect to login page
    window.location.href = '/admin/login.html';
    return;
  }

  // Verify token
  fetch('/api/auth/verify', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token
    }
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Token invalid');
      }
      return response.json();
    })
    .then(data => {
    // Initialize dashboard
      initializeDashboard(token, data.user);
    })
    .catch(error => {
      logger.error('Auth error:', error);
      localStorage.removeItem('chatbot-auth-token');
      window.location.href = '/admin/login.html';
    });
});

function initializeDashboard(token, user) {
  // Initialize Feather icons
  feather.replace();

  // Set up navigation
  setupNavigation();

  // Track joined chats
  window.joinedChats = new Set();

  // Initialize Socket.IO connection with reconnection options
  const socket = io({
    auth: {
      token: token
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  // Set up event handlers
  setupEventHandlers(socket);

  // Set up connection event handlers
  setupConnectionHandlers(socket);

  // Start heartbeat to keep connection alive
  startHeartbeat(socket);

  // Initialize charts
  initializeCharts();

  // Load initial data
  loadDashboardData(token);
  loadActiveChats(socket, token);
  loadChatHistory(token);
}

// Navigation setup
function setupNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');

  navLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();

      // Remove active class from all links and sections
      navLinks.forEach(l => l.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));

      // Add active class to clicked link
      this.classList.add('active');

      // Show corresponding section
      const sectionId = this.getAttribute('data-section');
      document.getElementById(sectionId + '-section').classList.add('active');
    });
  });
}

// Event handlers
function setupEventHandlers(socket) {
  // Join chat button
  const joinChatBtn = document.getElementById('join-chat-btn');
  joinChatBtn.addEventListener('click', function() {
    const operatorInput = document.getElementById('operator-input');
    operatorInput.style.display = 'block';

    // Change button text to "Joined" instead of disabling
    this.textContent = 'Joined';
    this.classList.remove('btn-primary');
    this.classList.add('btn-success');

    // Store the joined status in a data attribute
    this.setAttribute('data-joined', 'true');

    // Notify that operator has joined
    const sessionId = this.getAttribute('data-session-id');
    const operatorName = 'Admin'; // Use actual operator name if available
    socket.emit('operator-takeover', { sessionId, operatorName });

    // Add this chat to the joined chats set
    window.joinedChats.add(sessionId);
  });

  // End chat button
  const endChatBtn = document.getElementById('end-chat-btn');
  endChatBtn.addEventListener('click', function() {
    const sessionId = this.getAttribute('data-session-id');
    if (confirm('Are you sure you want to end this chat?')) {
      socket.emit('end-chat', { sessionId });

      // Remove this chat from the joined chats set
      window.joinedChats.delete(sessionId);

      resetChatView();
    }
  });

  // Send message
  const sendBtn = document.getElementById('send-operator-message');
  const messageInput = document.getElementById('operator-message');

  sendBtn.addEventListener('click', function() {
    sendOperatorMessage(socket, messageInput);
  });

  messageInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      sendOperatorMessage(socket, messageInput);
    }
  });

  // Settings form
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', function(e) {
    e.preventDefault();
    saveSettings();
  });

  // Load column configuration
  loadColumnConfig();

  // Socket events
  socket.on('new-chat', function(data) {
    // Update active chats count
    updateActiveChatCount(1);

    // Add to active chat list
    addChatToList(data);

    // Notify operator
    notifyNewChat(data);
  });

  socket.on('chat-ended', function(data) {
    // Update active chats count
    updateActiveChatCount(-1);

    // Remove from active chat list
    removeChatFromList(data.sessionId);
  });

  // Listen for operator join/leave events
  socket.on('operator-joined', function(data) {
    updateChatOperatorStatus(data.sessionId, true);
  });

  socket.on('operator-left', function(data) {
    updateChatOperatorStatus(data.sessionId, false);
  });

  socket.on('new-message', function(data) {
    // Add message to chat if it's currently selected
    const selectedChatId = joinChatBtn.getAttribute('data-session-id');
    if (selectedChatId === data.sessionId) {
      addMessageToChat({
        content: data.message,
        sender: data.sender,
        timestamp: data.timestamp
      });
    } else {
      // If the chat is not selected, update the chat item to indicate a new message
      const chatItem = document.querySelector(`#active-chat-list a[data-session-id="${data.sessionId}"]`);
      if (chatItem) {
        // Add a visual indicator for new messages
        chatItem.classList.add('has-new-message');

        // Add or update the unread count badge
        let badge = chatItem.querySelector('.unread-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'unread-badge badge bg-danger';

          // Position the badge in the top-right of the chat item
          const headerDiv = chatItem.querySelector('.d-flex');
          if (headerDiv) {
            // Add the badge to the header div which has a flex layout
            headerDiv.appendChild(badge);
          } else {
            // Fallback to appending to the chat item with float right
            badge.style.float = 'right';
            chatItem.appendChild(badge);
          }
        }

        // Increment the unread count
        const count = badge.textContent ? parseInt(badge.textContent) + 1 : 1;
        badge.textContent = count;

        // Play a notification sound if enabled
        const soundEnabled = localStorage.getItem('sound-notifications') === 'true';
        if (soundEnabled) {
          // Create a simple beep sound
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();

          oscillator.type = 'sine';
          oscillator.frequency.value = 800;
          gainNode.gain.value = 0.1;

          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);

          oscillator.start();
          setTimeout(() => oscillator.stop(), 200);
        }
      }
    }
  });
}

// Send operator message
function sendOperatorMessage(socket, messageInput) {
  const message = messageInput.value.trim();
  if (message) {
    const joinChatBtn = document.getElementById('join-chat-btn');
    const sessionId = joinChatBtn.getAttribute('data-session-id');

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
function initializeCharts() {
  // Chat Activity Chart
  const activityCtx = document.getElementById('chat-activity-chart').getContext('2d');
  const activityChart = new Chart(activityCtx, {
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
  const volumeChart = new Chart(volumeCtx, {
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
  const responseChart = new Chart(responseCtx, {
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
function loadChatHistory(token) {
  // In a real app, this would fetch data from the server
  fetch('/api/admin/chat-history', {
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
            <td>${record.messages.length}</td>
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
    <p class="mb-1">Messages: ${chat.messages ? chat.messages.length : 0}</p>
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

      // Hide the operator input if not joined
      document.getElementById('operator-input').style.display = 'none';
    }

    const endBtn = document.getElementById('end-chat-btn');
    endBtn.disabled = false;
    endBtn.setAttribute('data-session-id', chat.sessionId);
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

      if (data.messages && data.messages.length > 0) {
        data.messages.forEach(msg => {
          addMessageToChat({
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
    })
    .catch(error => {
      logger.error('Error loading chat messages:', error);
    });
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

  const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

  messageDiv.innerHTML = `
    <div class="message-content">${data.content}</div>
    <div class="message-time">${data.sender} • ${timestamp}</div>
  `;

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
      new Notification('New Chat', {
        body: `New chat session started from ${chat.domain || 'Unknown'}`
      });
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

  // Save settings to localStorage
  localStorage.setItem('notification-setting', notificationSetting);
  localStorage.setItem('sound-notifications', soundNotifications);
  localStorage.setItem('auto-refresh', autoRefresh);

  // Request notification permission if needed
  if (notificationSetting !== 'none' && 'Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }

  // Save column configuration
  saveColumnConfig();

  alert('Settings saved successfully');
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
  }
}

// View chat history
function viewChatHistory(sessionId) {
  // In a real app, this would open a modal with the chat history
  alert(`View chat history for session ${sessionId}`);
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
          alert('Failed to delete chat history');
        }
      })
      .catch(error => {
        logger.error('Error deleting chat history:', error);
        alert('An error occurred while deleting chat history');
      });
  }
}
