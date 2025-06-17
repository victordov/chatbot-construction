// Admin Dashboard JavaScript
// Add CSS for unread message indicators and operator status

// Client-side logger
const logger = {
  info: function(message, data) {
    if (data) {
      console.info(message, data);
    } else {
      console.info(message);
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
    // Use console.info instead of console.debug to avoid ESLint warnings
    if (data) {
      console.info('[DEBUG]', message, data);
    } else {
      console.info('[DEBUG]', message);
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

  .user-disconnected {
    position: relative;
    opacity: 0.8;
  }

  .user-disconnected::after {
    content: "Disconnected";
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.8em;
    color: #dc3545;
    font-style: italic;
  }

  .message.system {
    text-align: center;
    margin: 10px 0;
  }

  .message.system .message-content {
    display: inline-block;
    padding: 5px 10px;
    background-color: #f8f9fa;
    border-radius: 10px;
    font-style: italic;
    color: #6c757d;
  }

  .typing-indicator {
    margin-bottom: 10px;
  }

  .message.typing {
    opacity: 0.7;
  }

  .message.typing .message-content {
    display: flex;
    align-items: center;
    padding: 5px 10px;
  }

  .message.typing .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: #777;
    margin-right: 4px;
    animation: typing-animation 1.4s infinite ease-in-out both;
  }

  .message.typing .dot:nth-child(1) {
    animation-delay: 0s;
  }

  .message.typing .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .message.typing .dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typing-animation {
    0%, 80%, 100% { transform: scale(0.7); }
    40% { transform: scale(1); }
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

  // Track joined chats
  // Load joined chats from localStorage if available
  window.joinedChats = new Set();
  const savedJoinedChats = localStorage.getItem('joined-chats');
  if (savedJoinedChats) {
    try {
      const chatIds = JSON.parse(savedJoinedChats);
      chatIds.forEach(id => window.joinedChats.add(id));
      logger.info('Restored joined chats from localStorage:', chatIds);
    } catch (error) {
      logger.error('Error parsing joined chats from localStorage:', error);
    }
  }

  // Store current user
  window.currentUser = user;

  // Helper function to save joined chats to localStorage
  window.saveJoinedChats = function() {
    try {
      const chatIds = Array.from(window.joinedChats);
      localStorage.setItem('joined-chats', JSON.stringify(chatIds));
      logger.info('Saved joined chats to localStorage:', chatIds);
    } catch (error) {
      logger.error('Error saving joined chats to localStorage:', error);
    }
  };

  // Initialize Socket.IO connection with reconnection options
  // Store socket in window object to make it globally available
  window.adminSocket = io({
    auth: {
      token: token
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  // For backward compatibility
  const socket = window.adminSocket;

  // Set up event handlers
  setupEventHandlers(socket);

  // Set up connection event handlers
  setupConnectionHandlers(socket);

  // Set up task management
  setupTaskManagement(token);

  // Set up contact information management
  setupContactInfoManagement(token);

  // Start heartbeat to keep connection alive
  startHeartbeat(socket);

  // Initialize charts
  initializeCharts();

  // Load initial data
  loadDashboardData(token);
  loadActiveChats(socket, token);
  loadChatHistory(token);

  // Set up navigation (after data is loaded)
  setupNavigation();

  // Check URL parameters for chat selection
  const params = getUrlParams();
  if (params.chat) {
    // If a specific chat is in the URL, view it
    setTimeout(() => {
      viewChatHistory(params.chat);
    }, 500); // Small delay to ensure data is loaded
  } else if (params.session) {
    // If a specific session is in the URL, view it
    setTimeout(() => {
      viewChatHistory(params.session);
    }, 500); // Small delay to ensure data is loaded
  }
}

// Helper function to update URL with query parameters
function updateUrlWithParams(params) {
  const url = new URL(window.location.href);

  // Clear existing parameters
  url.search = '';

  // Add new parameters
  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.set(key, params[key]);
    }
  });

  // Update URL without reloading the page
  window.history.pushState({}, '', url);
}

// Helper function to get query parameters from URL and fragment
function getUrlParams() {
  const params = {};

  // Parse query parameters
  const searchParams = new URLSearchParams(window.location.search);
  for (const [key, value] of searchParams.entries()) {
    params[key] = value;
  }

  // Parse fragment parameters if present
  const hashParts = window.location.hash.split('?');
  if (hashParts.length > 1) {
    const fragmentParams = new URLSearchParams(hashParts[1]);
    for (const [key, value] of fragmentParams.entries()) {
      params[key] = value;
    }
  }

  return params;
}

// Navigation setup
function setupNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');

  // Add event listener for hash changes
  window.addEventListener('hashchange', function() {
    const params = getUrlParams();

    // If the hash contains a section parameter, switch to that section
    if (params.section) {
      // Find the link with the matching data-section attribute
      const link = document.querySelector(`.nav-link[data-section="${params.section}"]`);
      if (link) {
        // Simulate a click on the link
        link.click();

        // If active-chats section is loaded with a session parameter, view that chat
        if (params.section === 'active-chats' && params.session) {
          // Small delay to ensure the section is loaded
          setTimeout(() => {
            viewChatHistory(params.session);
          }, 100);
        }
      }
    } else if (params.session) { // If no section parameter but session parameter exists, navigate to active-chats
      // Navigate to active-chats section and view the chat
      const activeChatsLink = document.querySelector('.nav-link[data-section="active-chats"]');
      if (activeChatsLink) {
        activeChatsLink.click();

        // Small delay to ensure the section is loaded
        setTimeout(() => {
          viewChatHistory(params.session);
        }, 100);
      }
    }
  });

  // Setup sidebar toggle for small screens
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', function() {
      sidebar.classList.toggle('show');
    });

    // Close sidebar when a link is clicked on small screens
    navLinks.forEach(link => {
      link.addEventListener('click', function() {
        if (window.innerWidth < 768) {
          sidebar.classList.remove('show');
        }
      });
    });

    // Close sidebar when clicking outside of it on small screens
    document.addEventListener('click', function(event) {
      if (window.innerWidth < 768 &&
          !sidebar.contains(event.target) &&
          event.target !== sidebarToggle &&
          !sidebarToggle.contains(event.target)) {
        sidebar.classList.remove('show');
      }
    });
  }

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

      // If tasks section is clicked, load operators
      if (sectionId === 'tasks') {
        loadOperators(localStorage.getItem('chatbot-auth-token'));
      }

      // If operators section is clicked, load all operators
      if (sectionId === 'operators') {
        loadAllOperators();
      }

      // Update URL with section parameter
      updateUrlWithParams({ section: sectionId, chat: null });
    });
  });

  // Check URL parameters on page load
  const params = getUrlParams();
  if (params.section) {
    // Find the link with the matching data-section attribute
    const link = document.querySelector(`.nav-link[data-section="${params.section}"]`);
    if (link) {
      // Simulate a click on the link
      link.click();
    }

    // If tasks section is loaded directly, load operators
    if (params.section === 'tasks') {
      loadOperators(localStorage.getItem('chatbot-auth-token'));
    }

    // If operators section is loaded directly, load all operators
    if (params.section === 'operators') {
      loadAllOperators();
    }

    // If active-chats section is loaded with a session parameter, view that chat
    if (params.section === 'active-chats' && params.session) {
      // Small delay to ensure the section is loaded
      setTimeout(() => {
        viewChatHistory(params.session);
      }, 100);
    }
  }

  // Check for session parameter in URL fragment even if no section parameter
  if (!params.section && params.session) {
    // Navigate to active-chats section and view the chat
    const activeChatsLink = document.querySelector('.nav-link[data-section="active-chats"]');
    if (activeChatsLink) {
      activeChatsLink.click();

      // Small delay to ensure the section is loaded
      setTimeout(() => {
        viewChatHistory(params.session);
      }, 100);
    }
  }
}

// Event handlers
function setupEventHandlers(socket) {
  // Set up suggestion event handlers
  setupSuggestionEventHandlers(socket);

  // Function to update suggestion buttons based on operator join status
  function updateSuggestionButtons(isJoined) {
    // Get all user messages
    const userMessages = document.querySelectorAll('.message.user');

    userMessages.forEach(messageDiv => {
      // Check if message already has actions
      let actionDiv = messageDiv.querySelector('.message-actions');

      if (isJoined) {
        // If operator has joined, add suggestion button if not already present
        if (!actionDiv) {
          actionDiv = document.createElement('div');
          actionDiv.className = 'message-actions';
          actionDiv.style.marginTop = '5px';

          const getSuggestionBtn = document.createElement('button');
          getSuggestionBtn.className = 'btn btn-sm btn-outline-primary get-suggestion-btn';
          getSuggestionBtn.textContent = 'Get Suggestion';
          getSuggestionBtn.addEventListener('click', function() {
            // Get the session ID
            const sessionId = document.getElementById('join-chat-btn').getAttribute('data-session-id');

            // Get the message ID if available
            const messageId = messageDiv.dataset.messageId;

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
      } else {
        // If operator has left, remove suggestion button
        if (actionDiv) {
          actionDiv.remove();
        }
      }
    });
  }

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
    // Save joined chats to localStorage
    window.saveJoinedChats();

    // Update suggestion buttons
    updateSuggestionButtons(true);
  });

  // End chat button
  const endChatBtn = document.getElementById('end-chat-btn');
  endChatBtn.addEventListener('click', function() {
    const sessionId = this.getAttribute('data-session-id');
    if (confirm('Are you sure you want to end this chat?')) {
      socket.emit('end-chat', { sessionId });

      // Remove this chat from the joined chats set
      window.joinedChats.delete(sessionId);
      // Save joined chats to localStorage
      window.saveJoinedChats();

      // Update suggestion buttons before resetting the view
      updateSuggestionButtons(false);

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

  // Track operator typing
  let typingTimeout;
  messageInput.addEventListener('input', function() {
    const joinChatBtn = document.getElementById('join-chat-btn');
    const sessionId = joinChatBtn.getAttribute('data-session-id');

    // Clear existing timeout
    clearTimeout(typingTimeout);

    // Send typing indicator to server
    socket.emit('operator-typing', {
      sessionId,
      isTyping: true
    });

    // Set timeout to stop typing indicator after 2 seconds of inactivity
    typingTimeout = setTimeout(() => {
      socket.emit('operator-typing', {
        sessionId,
        isTyping: false
      });
    }, 2000);
  });

  // Settings form
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', function(e) {
    e.preventDefault();
    saveSettings();
  });

  // Chat history search
  const chatHistorySearch = document.getElementById('chat-history-search');
  const chatHistorySearchBtn = document.getElementById('chat-history-search-btn');

  // Search button click event
  chatHistorySearchBtn.addEventListener('click', function() {
    const searchTerm = chatHistorySearch.value.trim();
    loadChatHistory(localStorage.getItem('chatbot-auth-token'), searchTerm);
  });

  // Search input enter key event
  chatHistorySearch.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      const searchTerm = chatHistorySearch.value.trim();
      loadChatHistory(localStorage.getItem('chatbot-auth-token'), searchTerm);
    }
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

  // Listen for chat reactivation events
  socket.on('chat-reactivated', function(data) {
    // Fetch the reactivated chat details
    fetch(`/api/admin/chat/${data.sessionId}`, {
      headers: {
        'x-auth-token': localStorage.getItem('chatbot-auth-token')
      }
    })
      .then(response => response.json())
      .then(chat => {
        if (chat) {
          // Add to active chat list
          addChatToList(chat);

          // Update active chats count
          updateActiveChatCount(1);

          // Notify operator
          notifyNewChat({
            sessionId: chat.sessionId,
            domain: chat.domain,
            reactivated: true
          });
        }
      })
      .catch(error => {
        logger.error('Error fetching reactivated chat:', error);
      });
  });

  // Store timeouts for disconnected chats
  const disconnectedChatTimeouts = {};

  // Listen for chat activity events (opened/closed)
  socket.on('chat-activity', function(data) {
    const { type, sessionId } = data;

    if (type === 'opened') {
      // User opened the chat in their browser
      // Fetch the chat details if it's not already in the list
      const existingChat = document.querySelector(`#active-chat-list a[data-session-id="${sessionId}"]`);

      if (existingChat) {
        // If there's an existing timeout for this chat, clear it
        if (disconnectedChatTimeouts[sessionId]) {
          clearTimeout(disconnectedChatTimeouts[sessionId]);
          delete disconnectedChatTimeouts[sessionId];

          // Remove the disconnected status if it exists
          const chatItem = document.querySelector(`#active-chat-list a[data-session-id="${sessionId}"]`);
          if (chatItem) {
            chatItem.classList.remove('user-disconnected');
          }

          // Add a message that the user has reconnected
          const joinChatBtn = document.getElementById('join-chat-btn');
          if (joinChatBtn.getAttribute('data-session-id') === sessionId) {
            addMessageToChat({
              content: 'User has reconnected',
              sender: 'system',
              timestamp: new Date()
            });
          }
        }
      } else {
        fetch(`/api/admin/chat/${sessionId}`, {
          headers: {
            'x-auth-token': localStorage.getItem('chatbot-auth-token')
          }
        })
          .then(response => response.json())
          .then(chat => {
            if (chat) {
              // Add to active chat list
              addChatToList(chat);

              // Update active chats count
              updateActiveChatCount(1);
            }
          })
          .catch(error => {
            logger.error('Error fetching opened chat:', error);
          });
      }
    } else if (type === 'closed') {
      // User closed the chat in their browser

      // Add a message that the user has disconnected if this is the currently selected chat
      const joinChatBtn = document.getElementById('join-chat-btn');
      if (joinChatBtn.getAttribute('data-session-id') === sessionId) {
        addMessageToChat({
          content: 'User has disconnected. This chat will remain open for 3 minutes.',
          sender: 'system',
          timestamp: new Date()
        });
      }

      // Mark the chat as disconnected
      const chatItem = document.querySelector(`#active-chat-list a[data-session-id="${sessionId}"]`);
      if (chatItem) {
        chatItem.classList.add('user-disconnected');
      }

      // Set a timeout to remove the chat after 3 minutes
      disconnectedChatTimeouts[sessionId] = setTimeout(() => {
        // Remove from active chat list
        removeChatFromList(sessionId);

        // Update active chats count
        updateActiveChatCount(-1);

        // Remove from the timeouts object
        delete disconnectedChatTimeouts[sessionId];
      }, 3 * 60 * 1000); // 3 minutes
    }
  });

  // Listen for user typing events
  socket.on('user-typing', function(data) {
    const { sessionId, isTyping } = data;

    // Only show typing indicator for the currently selected chat
    const selectedChatId = document.getElementById('join-chat-btn').getAttribute('data-session-id');
    if (selectedChatId === sessionId) {
      const chatMessages = document.getElementById('chat-messages');

      // Check if typing indicator already exists
      let typingIndicator = chatMessages.querySelector('.typing-indicator');

      if (isTyping) {
        // Create typing indicator if it doesn't exist
        if (!typingIndicator) {
          typingIndicator = document.createElement('div');
          typingIndicator.className = 'typing-indicator';
          typingIndicator.innerHTML = `
            <div class="message bot typing">
              <div class="message-content">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
              </div>
              <div class="message-time">User is typing...</div>
            </div>
          `;
          chatMessages.appendChild(typingIndicator);

          // Scroll to bottom
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }
      } else {
        // Remove typing indicator if it exists
        if (typingIndicator) {
          typingIndicator.remove();
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
function initializeCharts() {
  // Chat Activity Chart
  const activityCtx = document.getElementById('chat-activity-chart').getContext('2d');
  // eslint-disable-next-line no-unused-vars
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
  // eslint-disable-next-line no-unused-vars
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
  // eslint-disable-next-line no-unused-vars
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
        alert('Chat not found');
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

      // Update URL with chat parameter
      updateUrlWithParams({
        section: 'active-chats',
        chat: chat.sessionId
      });
    })
    .catch(error => {
      logger.error('Error viewing chat history:', error);
      alert('An error occurred while loading the chat');
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
          alert('Failed to delete chat history');
        }
      })
      .catch(error => {
        logger.error('Error deleting chat history:', error);
        alert('An error occurred while deleting chat history');
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
  // Use showAlert for notifications
  showAlert(`${title}: ${message}`, type);
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
      showAlert('Failed to load operators', 'danger');
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
        showAlert(`Operator ${newStatus ? 'activated' : 'deactivated'} successfully`, 'success');
        loadAllOperators(); // Reload the operators list
      } else {
        showAlert(data.error || 'Failed to update operator status', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating operator status:', error);
      showAlert('Failed to update operator status', 'danger');
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
    showAlert('Please fill in all required fields', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showAlert('Passwords do not match', 'warning');
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
        showAlert('Operator created successfully', 'success');

        // Clear form and close modal
        document.getElementById('create-operator-form').reset();
        bootstrap.Modal.getInstance(document.getElementById('createOperatorModal')).hide();

        // Reload operators list
        loadAllOperators();
      } else {
        showAlert(data.error || 'Failed to create operator', 'danger');
      }
    })
    .catch(error => {
      console.error('Error creating operator:', error);
      showAlert('Failed to create operator', 'danger');
    });
}

// Helper function to show alerts
function showAlert(message, type = 'info') {
  const alertContainer = document.createElement('div');
  alertContainer.className = `alert alert-${type} alert-dismissible fade show`;
  alertContainer.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
  `;

  document.querySelector('.content-section:not([style*="display: none"])').prepend(alertContainer);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    const alert = bootstrap.Alert.getInstance(alertContainer);
    if (alert) {
      alert.close();
    } else {
      alertContainer.remove();
    }
  }, 5000);
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
        showAlert('Operator not found', 'danger');
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
      showAlert('Failed to fetch operator details', 'danger');
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
    showAlert('Username and email are required', 'warning');
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
        showAlert('Operator details updated successfully', 'success');

        // Close the modal
        bootstrap.Modal.getInstance(document.getElementById('editOperatorModal')).hide();

        // Reload operators list
        loadAllOperators();
      } else {
        showAlert(data.error || 'Failed to update operator details', 'danger');
      }
    })
    .catch(error => {
      console.error('Error updating operator details:', error);
      showAlert('Failed to update operator details', 'danger');
    });
}

function resetPassword() {
  const operatorId = document.getElementById('reset-password-operator-id').value;
  const password = document.getElementById('reset-password-new').value;
  const confirmPassword = document.getElementById('reset-password-confirm').value;
  const token = localStorage.getItem('chatbot-auth-token');

  if (!password || !confirmPassword) {
    showAlert('Password and confirm password are required', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showAlert('Passwords do not match', 'warning');
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
        showAlert('Password reset successfully', 'success');

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
        showAlert(data.error || 'Failed to reset password', 'danger');
      }
    })
    .catch(error => {
      console.error('Error resetting password:', error);
      showAlert('Failed to reset password', 'danger');
    });
}

// Start Google OAuth flow
function connectGoogleAccount() {
  const token = localStorage.getItem('chatbot-auth-token');
  fetch('/api/google/auth/url', { headers: { 'x-auth-token': token } })
    .then(res => res.json())
    .then(data => {
      window.open(data.url, '_blank');
    })
    .catch(() => showAlert('Failed to initiate Google OAuth', 'danger'));
}

// Load spreadsheet data and display in table
function loadSpreadsheet() {
  const token = localStorage.getItem('chatbot-auth-token');
  const spreadsheetId = document.getElementById('spreadsheet-id').value;
  const exclude = document.getElementById('exclude-columns').value;

  fetch(`/api/google/sheets/${spreadsheetId}?exclude=${encodeURIComponent(exclude)}`, {
    headers: { 'x-auth-token': token }
  })
    .then(res => res.json())
    .then(data => {
      const table = document.getElementById('spreadsheet-table');
      table.innerHTML = '';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      data.header.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      data.rows.forEach(r => {
        const row = document.createElement('tr');
        r.forEach(c => {
          const td = document.createElement('td');
          td.textContent = c;
          row.appendChild(td);
        });
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
    })
    .catch(() => showAlert('Failed to load spreadsheet', 'danger'));
}

document.addEventListener('DOMContentLoaded', function() {
  const loadBtn = document.getElementById('load-spreadsheet');
  if (loadBtn) {
    loadBtn.addEventListener('click', loadSpreadsheet);
  }
  const connectBtn = document.getElementById('connect-google');
  if (connectBtn) {
    connectBtn.addEventListener('click', connectGoogleAccount);
  }
});
