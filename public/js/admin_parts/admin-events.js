
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
    const operatorName = window.currentUser ? (window.currentUser.displayName || window.currentUser.username) : 'Admin';
    // The server names the operator from the socket's own identity; sending
    // a name here would be ignored.
    socket.emit('operator-takeover', { sessionId });

    // Immediately reflect in the active chat list
    updateChatOperatorStatus(sessionId, true, operatorName);

    // Add this chat to the joined chats set
    window.joinedChats.add(sessionId);
    // Save joined chats to localStorage
    window.saveJoinedChats();

    // Update suggestion buttons
    updateSuggestionButtons(true);

    // Enable leave button
    const leaveBtn = document.getElementById('leave-chat-btn');
    leaveBtn.disabled = false;

    // The queue's "mine" count just changed.
    if (typeof applyChatFilter === 'function') {
      applyChatFilter();
    }
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

  // Leave chat button
  const leaveChatBtn = document.getElementById('leave-chat-btn');
  leaveChatBtn.addEventListener('click', function() {
    const sessionId = this.getAttribute('data-session-id');
    const passToBot = confirm(
      'Pass this conversation to the chatbot?\nPress OK to hand off to the bot or Cancel to leave it for another operator.'
    );
    socket.emit('operator-leave', { sessionId, passToBot });

    window.joinedChats.delete(sessionId);
    window.saveJoinedChats();

    updateSuggestionButtons(false);
    resetChatView();

    if (typeof applyChatFilter === 'function') {
      applyChatFilter();
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

  const runHistorySearch = () => {
    // Always restart at page 1: staying on page 7 of the previous result set
    // usually lands on an empty page.
    loadChatHistory(authToken(), chatHistorySearch.value.trim(), 1);
  };

  chatHistorySearchBtn.addEventListener('click', runHistorySearch);

  // Search as you type, debounced so each keystroke is not a database query.
  chatHistorySearch.addEventListener('input', debounce(runHistorySearch, 350));

  chatHistorySearch.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      runHistorySearch();
    }
  });

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

  /**
   * A customer has just rated a conversation.
   *
   * Shown live rather than only in a report: a 1 arriving while the operator is
   * still at their desk is something they can act on.
   */
  socket.on('conversation-rated', function(data) {
    if (window.currentConversation && window.currentConversation.sessionId === data.sessionId) {
      window.currentConversation.rating = Object.assign(
        {}, window.currentConversation.rating, data
      );
      if (typeof displayRating === 'function') {
        displayRating(window.currentConversation.rating);
      }
    }

    if (typeof showToast === 'function' && data.score <= 2) {
      // Only the bad ones interrupt. A stream of "someone gave you a 5" toasts
      // trains people to dismiss the notification that mattered.
      showToast(`A customer rated a conversation ${data.score}/5`, 'warning');
    }
  });

  // Listen for operator join/leave events
  socket.on('operator-joined', function(data) {
    updateChatOperatorStatus(data.sessionId, true, data.operatorName);
  });

  socket.on('operator-left', function(data) {
    // A dropped connection can hand the chat straight to somebody else; show
    // the new owner rather than a chat that looks unattended.
    if (data.reassignedTo) {
      const name = typeof data.reassignedTo === 'object'
        ? (data.reassignedTo.name || data.reassignedTo.displayName || 'another operator')
        : String(data.reassignedTo);
      updateChatOperatorStatus(data.sessionId, true, name);
    } else {
      updateChatOperatorStatus(data.sessionId, false, data.operatorName);
    }

    if (data.reason === 'disconnected' && typeof showToast === 'function') {
      const who = data.operatorName || 'An operator';
      showToast(data.reassignedTo
        ? `${who} lost their connection; the chat was passed on.`
        : `${who} lost their connection; their chat is waiting for somebody.`, 'warning');
    }
  });

  /**
   * Somebody else took this chat from us.
   *
   * Nothing we type would reach the visitor any more, so the chat leaves our
   * list and, if it was open, the view resets rather than looking joined.
   */
  socket.on('chat-taken-from-you', function(data) {
    const sessionId = data && data.sessionId;
    if (!sessionId) {
      return;
    }

    window.joinedChats.delete(sessionId);
    window.saveJoinedChats();

    const takenBy = data.takenBy && typeof data.takenBy === 'object'
      ? (data.takenBy.name || data.takenBy.displayName || 'another operator')
      : (data.takenBy || 'another operator');

    if (joinChatBtn.getAttribute('data-session-id') === sessionId) {
      updateSuggestionButtons(false);
      resetChatView();
    }

    removeChatFromList(sessionId);
    updateActiveChatCount(-1);

    if (typeof showToast === 'function') {
      showToast(`${takenBy} took over a chat you were in.`, 'warning');
    }
    if (typeof applyChatFilter === 'function') {
      applyChatFilter();
    }
  });

  /**
   * The server refused something. Most often: the chat we tried to join is
   * already held by another operator, in which case an admin may take it
   * anyway.
   */
  socket.on('error', function(data) {
    const payload = typeof data === 'string' ? { message: data } : (data || {});
    const message = payload.message || 'The server refused that request.';

    if (payload.heldBy && payload.sessionId) {
      const holder = payload.heldBy.name || 'another operator';
      const role = window.currentUser && window.currentUser.role;
      const mayForce = role === 'company_admin' || role === 'superadmin';

      // Whatever the join button did optimistically is undone: we are not in.
      if (joinChatBtn.getAttribute('data-session-id') === payload.sessionId) {
        window.joinedChats.delete(payload.sessionId);
        window.saveJoinedChats();
        updateSuggestionButtons(false);
        resetChatView();
        updateChatOperatorStatus(payload.sessionId, true, holder);
      }

      if (mayForce && confirm(`${holder} is already in this chat. Take over anyway?`)) {
        socket.emit('operator-takeover', { sessionId: payload.sessionId, force: true });
        return;
      }

      if (typeof showToast === 'function') {
        showToast(`${holder} is already handling this chat.`, 'warning');
      }
      return;
    }

    if (typeof showToast === 'function') {
      showToast(message, 'danger');
    }
  });

  // Update user name when details change
  socket.on('user-details-updated', function(data) {
    updateChatUserName(data.sessionId, data.name);
    if (window.currentConversation && window.currentConversation.sessionId === data.sessionId) {
      if (!window.currentConversation.metadata) {
        window.currentConversation.metadata = {};
      }
      window.currentConversation.metadata.name = data.name;
      window.currentConversation.metadata.email = data.email;
      window.currentConversation.metadata.phone = data.phone;
      displayUserContactInfo(window.currentConversation);
    }
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
        'x-auth-token': authToken()
      }
    })
      .then(parseJsonResponse)
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
        showToast(errorMessage(error, 'Could not load the reactivated chat'), 'danger');
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
            'x-auth-token': authToken()
          }
        })
          .then(parseJsonResponse)
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
            showToast(errorMessage(error, 'Could not load the opened chat'), 'danger');
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
