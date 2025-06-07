(() => {
  // Check if widget script has already been loaded
  if (window.chatbotWidgetLoaded) {
    return;
  }
  window.chatbotWidgetLoaded = true;

  // Get configuration if available
  const config = window.chatbotConfig || {};

  // Default configuration
  const defaultConfig = {
    primaryColor: '#4CAF50',
    title: 'Chat Support',
    welcomeMessage: 'Hello! How can I help you with your property search today?',
    position: 'right', // 'right' or 'left'
    allowFileUpload: true,
    allowAttachments: true,
    serverUrl: window.location.origin // Default to current origin
  };

  // Merge configs
  const finalConfig = { ...defaultConfig, ...config };

  // Create widget elements
  function createWidgetElements() {
    // Create and add stylesheet
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = `${finalConfig.serverUrl}/css/chatbot-widget.css`;
    document.head.appendChild(styleLink);

    // Create CSS variable for primary color
    document.documentElement.style.setProperty('--chatbot-primary-color', finalConfig.primaryColor);

    // Create widget container
    const container = document.createElement('div');
    container.className = 'chatbot-widget-container';

    // Create chat button
    const button = document.createElement('div');
    button.className = 'chatbot-widget-button';
    button.innerHTML = '<span class="chatbot-widget-button-icon">💬</span>';

    // Create chat window
    const chatWindow = document.createElement('div');
    chatWindow.className = 'chatbot-widget-window chatbot-widget-hidden';

    // Create window elements
    chatWindow.innerHTML = `
      <div class="chatbot-widget-header">
        <h3 class="chatbot-widget-title">${finalConfig.title}</h3>
        <button class="chatbot-widget-close">×</button>
      </div>
      <div class="chatbot-widget-messages"></div>
      <div class="chatbot-widget-input-area">
        <input type="text" class="chatbot-widget-input" placeholder="Type your message...">
        ${finalConfig.allowFileUpload ? '<button class="chatbot-widget-upload">📎</button>' : ''}
        <button class="chatbot-widget-send">➤</button>
        <input type="file" class="chatbot-widget-file-upload" accept="application/pdf">
      </div>
    `;

    // Add elements to DOM
    container.appendChild(button);
    container.appendChild(chatWindow);
    document.body.appendChild(container);

    return {
      container,
      button,
      chatWindow,
      messagesContainer: chatWindow.querySelector('.chatbot-widget-messages'),
      input: chatWindow.querySelector('.chatbot-widget-input'),
      sendButton: chatWindow.querySelector('.chatbot-widget-send'),
      closeButton: chatWindow.querySelector('.chatbot-widget-close'),
      uploadButton: chatWindow.querySelector('.chatbot-widget-upload'),
      fileInput: chatWindow.querySelector('.chatbot-widget-file-upload')
    };
  }

  // Initialize the socket connection
  function initializeSocket(sessionId) {
    const socket = io(finalConfig.serverUrl);

    socket.on('connect', () => {
      console.log('Socket connected');
      if (sessionId) {
        socket.emit('join', sessionId);
      }
    });

    return socket;
  }

  // Initialize the widget
  async function initializeWidget() {
    // Create DOM elements
    const elements = createWidgetElements();

    // State variables
    let sessionId = localStorage.getItem('chatbotSessionId');
    let socket = null;
    let isOpen = false;

    // Get or create session
    async function getSession() {
      try {
        const response = await fetch(`${finalConfig.serverUrl}/api/session`);
        const data = await response.json();
        sessionId = data.sessionId;
        localStorage.setItem('chatbotSessionId', sessionId);
        return data;
      } catch (error) {
        console.error('Error getting session:', error);
      }
    }

    // Initialize session and socket
    const sessionData = await getSession();
    socket = initializeSocket(sessionId);

    // Load chat history
    async function loadChatHistory() {
      try {
        const response = await fetch(`${finalConfig.serverUrl}/api/chat/history`);
        const data = await response.json();

        // Display messages
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(message => {
            addMessageToChat(message.content, message.sender);
          });
        } else {
          // Show welcome message if no history
          addMessageToChat(finalConfig.welcomeMessage, 'bot');
        }
      } catch (error) {
        console.error('Error loading chat history:', error);
        addMessageToChat(finalConfig.welcomeMessage, 'bot');
      }
    }

    // Add message to chat
    function addMessageToChat(content, sender, attachment = null) {
      const messageEl = document.createElement('div');
      messageEl.className = `chatbot-widget-message chatbot-widget-message-${sender}`;
      messageEl.textContent = content;

      // Add attachment if any
      if (attachment) {
        const attachmentEl = document.createElement('div');
        attachmentEl.className = 'chatbot-widget-attachment';
        attachmentEl.innerHTML = `
          <span class="chatbot-widget-attachment-icon">📄</span>
          <span class="chatbot-widget-attachment-name">${attachment.filename}</span>
          <a href="${attachment.url}" class="chatbot-widget-attachment-download" target="_blank">Download</a>
        `;
        messageEl.appendChild(attachmentEl);
      }

      elements.messagesContainer.appendChild(messageEl);
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }

    // Show typing indicator
    function showTypingIndicator() {
      const typingEl = document.createElement('div');
      typingEl.className = 'chatbot-widget-typing';
      typingEl.innerHTML = '<div class="chatbot-widget-dot"></div><div class="chatbot-widget-dot"></div><div class="chatbot-widget-dot"></div>';
      typingEl.id = 'chatbot-typing-indicator';
      elements.messagesContainer.appendChild(typingEl);
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }

    // Hide typing indicator
    function hideTypingIndicator() {
      const typingEl = document.getElementById('chatbot-typing-indicator');
      if (typingEl) {
        typingEl.remove();
      }
    }

    // Send message function
    async function sendMessage(content) {
      if (!content.trim()) {
        return;
      }

      // Add user message to chat
      addMessageToChat(content, 'user');

      // Clear input
      elements.input.value = '';

      // Show typing indicator
      showTypingIndicator();

      // Send message via websocket
      socket.emit('message', {
        sessionId,
        message: content,
        sender: 'user'
      });

      // Also send via REST API as fallback
      try {
        await fetch(`${finalConfig.serverUrl}/api/chat/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ message: content })
        });
      } catch (error) {
        console.error('Error sending message via REST:', error);
      }
    }

    // Upload file function
    async function uploadFile(file) {
      if (!file || file.type !== 'application/pdf') {
        addMessageToChat('Only PDF files are supported.', 'bot');
        return;
      }

      const formData = new FormData();
      formData.append('pdf', file);

      try {
        const response = await fetch(`${finalConfig.serverUrl}/api/upload`, {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (data.error) {
          addMessageToChat(`Error uploading file: ${data.error}`, 'bot');
        } else {
          addMessageToChat('I\'ve uploaded a file for you:', 'user', {
            filename: file.name,
            url: data.url
          });

          // Send message about file via websocket
          socket.emit('message', {
            sessionId,
            message: `Uploaded a file: ${file.name}`,
            sender: 'user',
            attachment: {
              filename: file.name,
              url: data.url
            }
          });
        }
      } catch (error) {
        console.error('Error uploading file:', error);
        addMessageToChat('Failed to upload file. Please try again.', 'bot');
      }
    }

    // Socket event handlers
    socket.on('bot-message', (data) => {
      hideTypingIndicator();
      addMessageToChat(data.text || data.content, 'bot', data.attachment);
    });

    socket.on('message', (data) => {
      hideTypingIndicator();
      addMessageToChat(data.content, data.sender, data.attachment);
    });

    socket.on('typing', (data) => {
      if (data.isTyping) {
        showTypingIndicator();
      } else {
        hideTypingIndicator();
      }
    });

    // UI Event Handlers
    elements.button.addEventListener('click', () => {
      if (!isOpen) {
        elements.chatWindow.classList.remove('chatbot-widget-hidden');
        setTimeout(() => {
          elements.chatWindow.classList.remove('chatbot-widget-minimized');
        }, 10);

        // Load chat history if first open
        if (elements.messagesContainer.children.length === 0) {
          loadChatHistory();
        }
      } else {
        elements.chatWindow.classList.add('chatbot-widget-minimized');
        setTimeout(() => {
          elements.chatWindow.classList.add('chatbot-widget-hidden');
        }, 300);
      }
      isOpen = !isOpen;
    });

    elements.closeButton.addEventListener('click', () => {
      elements.chatWindow.classList.add('chatbot-widget-minimized');
      setTimeout(() => {
        elements.chatWindow.classList.add('chatbot-widget-hidden');
      }, 300);
      isOpen = false;
    });

    elements.sendButton.addEventListener('click', () => {
      sendMessage(elements.input.value);
    });

    elements.input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage(elements.input.value);
      }

      // Send typing indicator
      socket.emit('typing', {
        sessionId,
        isTyping: true,
        user: 'user'
      });
    });

    // File upload handling
    if (finalConfig.allowFileUpload && elements.uploadButton && elements.fileInput) {
      elements.uploadButton.addEventListener('click', () => {
        elements.fileInput.click();
      });

      elements.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          uploadFile(e.target.files[0]);
        }
      });
    }
  }

  // Initialize when DOM is fully loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
  } else {
    initializeWidget();
  }
})();
