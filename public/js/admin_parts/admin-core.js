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
      localStorage.setItem('chatbot-user', JSON.stringify(data.user));
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

  // Hide navigation the user cannot act on. Showing an operator a "Companies"
  // tab that always 403s is worse than not showing it at all.
  applyRoleVisibility(user);

  const companyBadge = document.getElementById('company-badge');
  if (companyBadge && user.company) {
    companyBadge.textContent = user.company.name;
  }

  // Populate sidebar profile
  const nameEl = document.getElementById('profile-name');
  const emailEl = document.getElementById('profile-email');
  if (nameEl) {
    nameEl.textContent = user.displayName || user.username;
  }
  if (emailEl) {
    emailEl.textContent = user.email;
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('chatbot-auth-token');
      localStorage.removeItem('chatbot-user');
      window.location.href = '/admin/login.html';
    });
  }

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

  // Notification bell and widget install panel.
  if (typeof setupNotifications === 'function') {
    setupNotifications(socket);
  }
  if (typeof setupWidgetSection === 'function') {
    setupWidgetSection();
  }
  if (typeof setupBillingSection === 'function') {
    setupBillingSection();
  }
  if (typeof setupAnalytics === 'function') {
    setupAnalytics();
  }
  if (typeof setupAssistantSection === 'function') {
    setupAssistantSection();
  }
  if (typeof setupOperatorTools === 'function') {
    setupOperatorTools(socket);
  }
  setupExport();

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

/**
 * Re-measure any charts inside a section that has just become visible.
 *
 * Chart.js sizes a canvas when the chart is constructed. Sections other than
 * the one open at page load are `display: none`, so their canvases measure
 * zero and the chart draws nothing - the axes and labels appear, but the
 * datasets are invisible. Chart.js does not re-measure on its own when the
 * element later becomes visible, so we ask it to.
 */
function resizeChartsIn(sectionId) {
  if (typeof Chart === 'undefined') {
    return;
  }

  const section = document.getElementById(sectionId);
  if (!section) {
    return;
  }

  // Two frames: one for the browser to apply the display change and lay the
  // section out, one for the canvas to have its final size.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    section.querySelectorAll('canvas').forEach(canvas => {
      const chart = Chart.getChart ? Chart.getChart(canvas) : null;
      if (!chart) {
        return;
      }

      // Chart.js wrote `width: 0px; height: 0px` inline from its initial
      // measurement of a hidden canvas. resize() re-reads those styles, so
      // without clearing them it measures zero again - the chart stays blank
      // permanently. Clearing lets it size from the container.
      canvas.style.width = '';
      canvas.style.height = '';
      chart.resize();
    });
  }));
}

/**
 * Show only the navigation entries this role can use.
 */
function applyRoleVisibility(user) {
  document.querySelectorAll('#sidebar [data-roles]').forEach(link => {
    const allowed = link.getAttribute('data-roles').split(',').map(r => r.trim());
    if (!allowed.includes(user.role)) {
      link.closest('.nav-item')?.remove();
    }
  });

  // The superadmin-only "New Company" control is meaningless to anyone else.
  if (user.role !== 'superadmin') {
    document.getElementById('superadmin-only-btn')?.remove();
    document.querySelectorAll('.superadmin-only').forEach(el => el.remove());
  }
}

/**
 * Download the conversation history as CSV. The Export button in the header
 * previously had no handler at all.
 */
function setupExport() {
  const button = document.getElementById('export-btn');
  if (!button) {
    return;
  }

  button.addEventListener('click', async () => {
    setLoading(button, true);
    try {
      const response = await fetch('/api/admin/export?type=conversations', {
        headers: { 'x-auth-token': localStorage.getItem('chatbot-auth-token') }
      });

      if (!response.ok) {
        throw new Error(`Export failed (${response.status})`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `conversations-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      showToast('Export downloaded', 'success');
    } catch (error) {
      logger.error('Export failed:', error);
      showToast('Could not export conversations', 'danger');
    } finally {
      setLoading(button, false);
    }
  });
}

// Helper function to update URL with query parameters
window.updateUrlWithParams = function(params) {
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
};

// Helper function to get query parameters from URL and fragment
window.getUrlParams = function() {
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
};

// Navigation setup
function setupNavigation() {
  // Only grab sidebar navigation links that switch top-level sections
  const navLinks = document.querySelectorAll('#sidebar .nav-link[data-section]');
  const sections = document.querySelectorAll('.content-section');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');

  // Add event listener for hash changes
  window.addEventListener('hashchange', function() {
    const params = getUrlParams();

    // If the hash contains a section parameter, switch to that section
    if (params.section) {
      // Find the link with the matching data-section attribute
      const link = document.querySelector(`#sidebar .nav-link[data-section="${params.section}"]`);
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
      const activeChatsLink = document.querySelector('#sidebar .nav-link[data-section="active-chats"]');
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

      const pageTitle = document.getElementById('page-title');
      if (pageTitle) {
        pageTitle.textContent = this.textContent.trim();
      }

      // The Analytics charts are built on first view: see
      // initializeAnalyticsCharts for why they cannot be built up front.
      if (sectionId === 'analytics' && typeof initializeAnalyticsCharts === 'function') {
        initializeAnalyticsCharts();
      }

      resizeChartsIn(sectionId + '-section');

      // If tasks section is clicked, load operators and show task list
      if (sectionId === 'tasks') {
        loadOperators(localStorage.getItem('chatbot-auth-token'));
        // Make sure we show the task list view instead of task detail view
        if (typeof showTaskList === 'function') {
          showTaskList();
        }
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
    const link = document.querySelector(`#sidebar .nav-link[data-section="${params.section}"]`);
    if (link) {
      // Simulate a click on the link
      link.click();
    }

    // If tasks section is loaded directly, load operators and show task list
    if (params.section === 'tasks') {
      loadOperators(localStorage.getItem('chatbot-auth-token'));

      // If there's no taskId parameter, make sure we show the task list view
      if (!params.taskId && typeof showTaskList === 'function') {
        showTaskList();
      }
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
    const activeChatsLink = document.querySelector('#sidebar .nav-link[data-section="active-chats"]');
    if (activeChatsLink) {
      activeChatsLink.click();

      // Small delay to ensure the section is loaded
      setTimeout(() => {
        viewChatHistory(params.session);
      }, 100);
    }
  }
}
