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
