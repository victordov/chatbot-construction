/**
 * Chatbot Widget JavaScript
 * Embeddable JavaScript widget for the chatbot application
 */

(function() {
  // Configuration with defaults
  const config = {
    serverUrl: '',
    chatbotName: 'Assistant',
    primaryColor: '#2196f3',
    initialMessage: 'Hello! How can I assist you today?',
    position: 'right' // 'right' or 'left'
  };
  // Socket.io instance
  let socket;

  // Session management
  const sessionId = localStorage.getItem('chatbotSessionId') || generateSessionId();

  // Broadcast channel for cross-window/tab communication
  let broadcastChannel;

  // Encryption utility
  let encryptionUtil;

  // DOM elements
  let chatWindow;
  let chatMessages;
  let chatInput;
  let chatIconButton;
  let typingIndicator;
  let fileUploadInput;
  let fileIndicator;
  // Initialize the widget
  function init(customConfig = {}) {
    // Merge custom configuration with defaults
    Object.assign(config, customConfig);

    if (!config.serverUrl) {
      console.error('Chatbot widget: Server URL is required');
      return;
    }

    // Save session ID to localStorage
    localStorage.setItem('chatbotSessionId', sessionId);

    // Initialize broadcast channel for cross-window/tab communication
    initBroadcastChannel();

    // Load encryption utility
    loadEncryptionUtil();

    // Create widget elements
    createWidgetElements();

    // Initialize socket connection
    initSocketConnection();

    // Add event listeners
    addEventListeners();

    // Apply custom color
    applyCustomStyles();

    // Display initial message
    if (config.initialMessage) {
      addBotMessage(config.initialMessage);
    }
  }

  // Load the encryption utility script
  function loadEncryptionUtil() {
    const script = document.createElement('script');
    script.src = `${config.serverUrl}/widget/js/encryption.js`;
    script.onload = () => {
      encryptionUtil = new EncryptionUtil();
      encryptionUtil.init()
        .then(success => {
          if (!success) {
            console.error('Failed to initialize encryption utility');
          }
        });
    };
    document.body.appendChild(script);
  }

  // Initialize broadcast channel for cross-window/tab communication
  function initBroadcastChannel() {
    try {
      // Check if BroadcastChannel API is available
      if (typeof BroadcastChannel !== 'undefined') {
        broadcastChannel = new BroadcastChannel('chatbot_widget_channel');

        // Listen for messages from other tabs/windows
        broadcastChannel.onmessage = (event) => {
          const { type, data } = event.data;

          switch (type) {
          case 'new-message':
            // Add message to the UI without sending to server again
            if (data.sender === 'user') {
              // We don't need to pass the user name as it will be retrieved from localStorage
              addUserMessage(data.message, false);
            } else if (data.sender === 'bot') {
              // Use the sender name if provided, otherwise default to "AI Assistant"
              const senderName = data.senderName || 'AI Assistant';
              addBotMessage(data.message, false, senderName);
            }
            break;

          case 'chat-opened':
            // Sync chat window state across tabs
            if (data.isOpen && !chatWindow.classList.contains('open')) {
              chatWindow.classList.add('open');
            } else if (!data.isOpen && chatWindow.classList.contains('open')) {
              chatWindow.classList.remove('open');
            }
            break;

          case 'typing-indicator':
            // Sync typing indicator across tabs
            setTypingIndicator(data.isTyping, false);
            break;

          case 'file-uploaded':
            // Update file indicator across tabs
            if (data.fileName) {
              fileIndicator.textContent = `File selected: ${data.fileName}`;
              fileIndicator.classList.add('active');
            } else {
              fileIndicator.classList.remove('active');
            }
            break;

          case 'ping':
            // Respond to ping to indicate this tab is active
            broadcastChannel.postMessage({
              type: 'pong',
              data: {
                timestamp: Date.now()
              }
            });
            break;
          }
        };

        // Send a ping to check for other active instances
        broadcastChannel.postMessage({
          type: 'ping',
          data: {
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      console.warn('BroadcastChannel not supported or error initializing:', error);
    }
  }

  // Create the widget DOM elements
  function createWidgetElements() {
    // Create container
    const container = document.createElement('div');
    container.className = 'chatbot-widget-container';

    // Create chat icon button with SVG
    chatIconButton = document.createElement('div');
    chatIconButton.className = 'chat-icon-button';
    chatIconButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
      </svg>
    `;

    // Create chat window
    chatWindow = document.createElement('div');
    chatWindow.className = 'chat-window';

    // Create chat header
    const chatHeader = document.createElement('div');
    chatHeader.className = 'chat-header';
    chatHeader.innerHTML = `
      <h3>${config.chatbotName}</h3>
      <button class="close-button">&times;</button>
    `;

    // Create chat messages container
    const chatMessagesContainer = document.createElement('div');
    chatMessagesContainer.className = 'chat-messages';

    // Create chat messages list
    chatMessages = document.createElement('div');
    chatMessages.className = 'chat-messages-list';

    // Create typing indicator
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing-indicator';
    typingIndicator.innerHTML = `
      <span></span>
      <span></span>
      <span></span>
    `;

    // Create chat input area
    const chatInputArea = document.createElement('div');
    chatInputArea.className = 'chat-input-area';

    // Create file upload button and hidden input
    const fileUploadButton = document.createElement('button');
    fileUploadButton.className = 'file-upload-button';
    fileUploadButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
        <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
      </svg>
    `;

    fileUploadInput = document.createElement('input');
    fileUploadInput.type = 'file';
    fileUploadInput.style.display = 'none';
    fileUploadInput.accept = '.pdf'; // Only accept PDF files for now

    // Create file indicator
    fileIndicator = document.createElement('div');
    fileIndicator.className = 'file-indicator';

    // Create chat input
    chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.placeholder = 'Type your message...';

    // Create send button
    const sendButton = document.createElement('button');
    sendButton.textContent = 'Send';

    // Assemble the widget
    chatInputArea.appendChild(fileUploadButton);
    chatInputArea.appendChild(fileUploadInput);
    chatInputArea.appendChild(chatInput);
    chatInputArea.appendChild(sendButton);

    chatMessagesContainer.appendChild(chatMessages);
    chatMessagesContainer.appendChild(typingIndicator);

    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(chatMessagesContainer);
    chatWindow.appendChild(fileIndicator);
    chatWindow.appendChild(chatInputArea);

    container.appendChild(chatIconButton);
    container.appendChild(chatWindow);

    // Append to document body
    document.body.appendChild(container);

    // Add the CSS file
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = `${config.serverUrl}/widget/css/widget.css`;
    document.head.appendChild(cssLink);

    // Add custom styles for sender names
    const customStyles = document.createElement('style');
    customStyles.textContent = `
      .message-sender {
        font-weight: bold;
        margin-bottom: 4px;
        font-size: 0.9em;
      }

      .message.user .message-sender {
        text-align: right;
        color: #2196f3;
      }

      .message.bot .message-sender {
        text-align: left;
        color: #4caf50;
      }

      .message-content {
        word-wrap: break-word;
      }
    `;
    document.head.appendChild(customStyles);
  }
  // Initialize socket.io connection
  function initSocketConnection() {
    // Load Socket.io from the server
    const script = document.createElement('script');
    script.src = `${config.serverUrl}/socket.io/socket.io.js`;
    script.onload = () => {
      // Connect to server
      socket = io(config.serverUrl, {
        query: { sessionId }
      });

      // Handle encryption key exchange
      socket.on('encryption-init', async (data) => {
        if (encryptionUtil && data.serverPublicKey) {
          try {
            // Set server's public key (now awaiting the async method)
            await encryptionUtil.setServerPublicKey(data.serverPublicKey);

            // Send client's public key to server
            const publicKey = await encryptionUtil.getPublicKey();
            socket.emit('client-public-key', {
              sessionId,
              publicKey
            });
          } catch (error) {
            console.error('Error during encryption setup:', error);
          }
        }
      });

      // Handle encryption ready status
      socket.on('encryption-ready', (data) => {
        if (!data.success) {
          console.error('Encryption setup failed:', data.error);
        } else {
          console.log('End-to-end encryption enabled');
        }
      });

      // Listen for bot messages
      socket.on('bot-message', (message) => {
        setTypingIndicator(false);

        // Decrypt message if it's encrypted
        let messageText = message.text;
        if (message.encrypted && encryptionUtil && encryptionUtil.isEncryptionReady()) {
          const decrypted = encryptionUtil.decryptMessage(message.encryptedMessage, message.nonce);
          if (decrypted) {
            messageText = decrypted;
          } else {
            console.error('Failed to decrypt message');
            messageText = 'Error: Could not decrypt message';
          }
        }

        // Determine sender type (AI Assistant or operator)
        let sender = 'AI Assistant';
        if (message.senderType === 'operator' && message.senderName) {
          sender = message.senderName;
        }

        addBotMessage(messageText, true, sender);

        // Handle file responses if present
        if (message.fileUrl) {
          addFileResponse(message.fileUrl, message.fileName, sender);
        }

        // Send read receipt to server
        socket.emit('message-read', {
          sessionId,
          messageId: message.id || 'latest',
          timestamp: new Date().toISOString()
        });

        // Broadcast to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'new-message',
            data: {
              sender: 'bot',
              senderName: sender,
              message: messageText
            }
          });
        }
      });

      // Listen for typing indicator
      socket.on('bot-typing', () => {
        setTypingIndicator(true);

        // Broadcast typing indicator to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'typing-indicator',
            data: {
              isTyping: true
            }
          });
        }
      });

      // Listen for read receipts
      socket.on('message-read', (data) => {
        // Update read status in the UI
        updateMessageReadStatus(data.messageId);
      });

      // Handle reconnection
      socket.on('reconnect', async () => {
        // Re-establish session
        const publicKey = encryptionUtil ? await encryptionUtil.getPublicKey() : null;
        socket.emit('resume-session', {
          sessionId,
          publicKey
        });
      });
    };

    document.body.appendChild(script);
  }
  // Add event listeners to widget elements
  function addEventListeners() {
    // Toggle chat window on icon click
    chatIconButton.addEventListener('click', toggleChatWindow);

    // Close chat window on close button click
    const closeButton = chatWindow.querySelector('.close-button');
    closeButton.addEventListener('click', closeChatWindow);

    // Send message on button click
    const sendButton = chatWindow.querySelector('button:last-child');
    sendButton.addEventListener('click', sendMessage);

    // Send message on Enter key press
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      }
    });

    // Track user typing
    let typingTimeout;
    chatInput.addEventListener('input', () => {
      if (socket) {
        // Clear existing timeout
        clearTimeout(typingTimeout);

        // Send typing indicator to server
        socket.emit('user-typing', {
          sessionId,
          isTyping: true
        });

        // Set timeout to stop typing indicator after 2 seconds of inactivity
        typingTimeout = setTimeout(() => {
          socket.emit('user-typing', {
            sessionId,
            isTyping: false
          });
        }, 2000);
      }
    });

    // File upload button click
    const fileUploadButton = chatWindow.querySelector('.file-upload-button');
    fileUploadButton.addEventListener('click', () => {
      fileUploadInput.click();
    });

    // File upload change
    fileUploadInput.addEventListener('change', handleFileUpload);

    // Handle visibility change to manage active state
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // When tab becomes visible, mark all messages as read
        socket.emit('mark-all-read', {
          sessionId,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  // Apply custom styles based on configuration
  function applyCustomStyles() {
    const root = document.documentElement;

    if (config.primaryColor) {
      root.style.setProperty('--primary-color', config.primaryColor);
    }

    // Adjust position if needed
    if (config.position === 'left') {
      const container = document.querySelector('.chatbot-widget-container');
      container.style.right = 'auto';
      container.style.left = '20px';

      const chatWindow = document.querySelector('.chat-window');
      chatWindow.style.right = 'auto';
      chatWindow.style.left = '0';
    }
  }
  // Toggle chat window visibility
  function toggleChatWindow() {
    chatWindow.classList.toggle('open');

    if (chatWindow.classList.contains('open')) {
      chatInput.focus();

      // Emit event to the server that chat was opened
      if (socket) {
        socket.emit('chat-opened', { sessionId });
      }

      // Broadcast chat window state to other tabs/windows
      if (broadcastChannel) {
        broadcastChannel.postMessage({
          type: 'chat-opened',
          data: {
            isOpen: true
          }
        });
      }
    } else {
      // Broadcast chat window state to other tabs/windows
      if (broadcastChannel) {
        broadcastChannel.postMessage({
          type: 'chat-opened',
          data: {
            isOpen: false
          }
        });
      }
    }
  }

  // Close chat window
  function closeChatWindow() {
    chatWindow.classList.remove('open');

    // Broadcast chat window state to other tabs/windows
    if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'chat-opened',
        data: {
          isOpen: false
        }
      });
    }
  }
  // Send a message to the server
  function sendMessage() {
    const message = chatInput.value.trim();

    if (message) {
      // Add message to UI
      addUserMessage(message, true);

      // Clear input
      chatInput.value = '';

      // Show typing indicator
      setTypingIndicator(true);

      // Inform the server that the user is no longer typing
      if (socket) {
        socket.emit('user-typing', {
          sessionId,
          isTyping: false
        });
      }

      // Send to server
      if (socket) {
        // Generate a local message ID for tracking read status
        const messageId = generateMessageId();
        const timestamp = new Date().toISOString();

        // Prepare message data
        const messageData = {
          sessionId,
          messageId,
          timestamp
        };

        // Check if encryption is available and ready
        if (encryptionUtil && encryptionUtil.isEncryptionReady()) {
          // Encrypt the message
          const encrypted = encryptionUtil.encryptMessage(message);

          if (encrypted) {
            // Send encrypted message
            messageData.encrypted = true;
            messageData.encryptedMessage = encrypted.encryptedMessage;
            messageData.nonce = encrypted.nonce;
          } else {
            // Fallback to plaintext if encryption fails
            messageData.message = message;
            console.warn('Encryption failed, sending in plaintext');
          }
        } else {
          // Send plaintext message
          messageData.message = message;
        }

        // Send the message to the server
        socket.emit('user-message', messageData);
      }
    }
  }
  // Handle file upload
  function handleFileUpload(event) {
    const file = event.target.files[0];

    if (file) {
      // Show file indicator
      fileIndicator.textContent = `File selected: ${file.name}`;
      fileIndicator.classList.add('active');

      // Broadcast file selection to other tabs/windows
      if (broadcastChannel) {
        broadcastChannel.postMessage({
          type: 'file-uploaded',
          data: {
            fileName: file.name
          }
        });
      }

      // Create FormData
      const formData = new FormData();
      formData.append('file', file);
      formData.append('sessionId', sessionId);

      // Upload file
      fetch(`${config.serverUrl}/api/upload`, {
        method: 'POST',
        body: formData
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
          // Add message about file upload
            addUserMessage(`I've uploaded a file: ${file.name}`, true);

            // Show typing indicator
            setTypingIndicator(true);

            // Clear file input and indicator
            fileUploadInput.value = '';
            setTimeout(() => {
              fileIndicator.classList.remove('active');

              // Broadcast file indicator clearing to other tabs/windows
              if (broadcastChannel) {
                broadcastChannel.postMessage({
                  type: 'file-uploaded',
                  data: {
                    fileName: null
                  }
                });
              }
            }, 3000);

            // Notify server about uploaded file
            if (socket) {
              socket.emit('file-uploaded', {
                sessionId,
                fileId: data.fileId,
                fileName: file.name,
                timestamp: new Date().toISOString()
              });
            }
          } else {
            console.error('File upload failed:', data.error);
            // Show error message
            addBotMessage('Sorry, there was a problem uploading your file. Please try again.');
          }
        })
        .catch(error => {
          console.error('File upload error:', error);
          addBotMessage('Sorry, there was a problem uploading your file. Please try again.');
        });
    }
  }

  // Add a user message to the chat
  function addUserMessage(message, broadcast = true) {
    const messageId = generateMessageId();
    const timestamp = new Date();

    // Get user name from localStorage, default to "You" if not available
    const userName = localStorage.getItem('chatbotUserName') || 'You';

    const messageElement = document.createElement('div');
    messageElement.className = 'message user';
    messageElement.dataset.messageId = messageId;

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = userName;

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';
    contentElement.textContent = message;

    // Append sender and content to message element
    messageElement.appendChild(senderElement);
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    // Add read status indicator
    const readStatusElement = document.createElement('div');
    readStatusElement.className = 'message-status';
    readStatusElement.innerHTML = `
      <svg class="status-icon sent" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
      </svg>
    `;
    messageElement.appendChild(readStatusElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'new-message',
        data: {
          sender: 'user',
          senderName: userName,
          message,
          messageId,
          timestamp: timestamp.toISOString()
        }
      });
    }

    return messageId;
  }

  // Add a bot message to the chat
  function addBotMessage(message, broadcast = true, sender = 'AI Assistant') {
    const messageElement = document.createElement('div');
    messageElement.className = 'message bot';

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = sender;
    messageElement.appendChild(senderElement);

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';

    // Handle markdown-like formatting
    const formattedMessage = message
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');

    contentElement.innerHTML = formattedMessage;
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestamp = new Date();
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'new-message',
        data: {
          sender: 'bot',
          message,
          timestamp: timestamp.toISOString()
        }
      });
    }
  }
  // Add file response message
  function addFileResponse(fileUrl, fileName, sender = 'AI Assistant') {
    const messageElement = document.createElement('div');
    messageElement.className = 'message bot';

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = sender;
    messageElement.appendChild(senderElement);

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';
    contentElement.innerHTML = `
      <p>Here's the file you requested:</p>
      <a href="${fileUrl}" target="_blank" download="${fileName}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
        ${fileName}
      </a>
    `;
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestamp = new Date();
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows
    if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'new-message',
        data: {
          sender: 'bot',
          message: `File shared: ${fileName}`,
          timestamp: timestamp.toISOString(),
          fileUrl,
          fileName
        }
      });
    }
  }

  // Set typing indicator visibility
  function setTypingIndicator(isTyping, broadcast = true) {
    if (isTyping) {
      typingIndicator.classList.add('active');
    } else {
      typingIndicator.classList.remove('active');
    }
    scrollToBottom();

    // Broadcast typing indicator state to other tabs/windows
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'typing-indicator',
        data: {
          isTyping
        }
      });
    }
  }

  // Update read status of a message
  function updateMessageReadStatus(messageId) {
    const message = document.querySelector(`.message[data-message-id="${messageId}"]`);

    if (message) {
      const statusIcon = message.querySelector('.message-status');

      if (statusIcon) {
        statusIcon.innerHTML = `
          <svg class="status-icon read" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
            <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/>
          </svg>
        `;
      }
    }
  }

  // Format time for messages
  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Generate a unique message ID
  function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // Scroll chat messages to bottom
  function scrollToBottom() {
    const messagesContainer = chatWindow.querySelector('.chat-messages');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Generate a unique session ID
  function generateSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Expose public API
  window.ChatbotWidget = {
    init
  };
})();
