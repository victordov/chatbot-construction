/**
 * Chatbot Widget JavaScript
 * Embeddable JavaScript widget for the chatbot application.
 *
 * Everything the widget draws lives inside a Shadow DOM root attached to a
 * single host element, so the host page's stylesheet cannot restyle the chat
 * window and the widget's stylesheet cannot leak into the host page. The only
 * things that touch the document are the host element itself and, when the
 * page has not already loaded it, the socket.io client script.
 */

(function() {
  // Configuration with defaults
  const config = {
    serverUrl: '',
    // Identifies the tenant this widget belongs to. The server uses it to
    // attribute conversations to a company; without it, chats only reach the
    // right dashboard if the page's origin happens to be registered.
    widgetKey: null,
    // Content-hashed URLs for the widget's own dependencies, supplied by the
    // loader from /api/widget/config so they can be cached immutably.
    assets: {},
    // Whether the company is open and an operator could pick up. Null means
    // unknown, which is treated as available.
    availability: null,
    // The tenant's own id for this visitor, plus the HMAC proving the tenant
    // vouched for it. Unsigned ids are ignored by the server.
    externalId: null,
    userHash: null,
    chatbotName: 'Assistant',
    primaryColor: '#2196f3',
    initialMessage: 'Hello! How can I assist you today?',
    position: 'right', // 'right' or 'left'
    // Which details the pre-chat form insists on. Name and email are the
    // minimum an operator needs to follow up; a phone number is more than
    // most visitors want to hand over just to ask a question.
    requireName: true,
    requireEmail: true,
    requirePhone: false,
    // Linked from the pre-chat form. Defaults to the server's own policy page.
    privacyPolicyUrl: null
  };

  // Every localStorage key the widget writes, in one place.
  const STORAGE_KEYS = {
    sessionId: 'chatbotSessionId',
    sessionToken: 'chatbotSessionToken',
    userName: 'chatbotUserName',
    userEmail: 'chatbotUserEmail',
    userPhone: 'chatbotUserPhone',
    // When the visitor's details were saved, so they can be forgotten again.
    userSavedAt: 'chatbotUserSavedAt'
  };

  // Personal details are kept for a month and then dropped: long enough that
  // a returning visitor is not asked twice in a week, short enough that a
  // shared computer does not carry somebody's email address for a year.
  const PII_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Mirrors the server's upload limit. Checked here so a 40 MB video gets an
  // immediate answer rather than a slow upload followed by an error.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // Socket.io instance
  let socket;

  // Session management. The token is issued by the server on the first
  // resume and proves this browser owns the session id, so a visitor cannot
  // read somebody else's transcript by guessing an id.
  let sessionId = readStorage(STORAGE_KEYS.sessionId) || generateSessionId();
  let sessionToken = readStorage(STORAGE_KEYS.sessionToken) || null;

  // Broadcast channel for cross-window/tab communication
  let broadcastChannel;

  // Shadow DOM host and root. Every element lookup goes through `root`.
  let host;
  let root;

  // User details form
  let userDetailsForm;

  // DOM elements
  let container;
  let chatWindow;
  let chatMessages;
  let chatInput;
  let chatIconButton;
  let sendButton;
  let fileUploadButton;
  let typingIndicator;
  let fileUploadInput;
  let fileIndicator;
  let chatMessagesContainer;
  let connectionStatus;

  // Heartbeat interval for keeping the socket connection alive
  let heartbeatInterval;

  // Ids of every message already on screen. A duplicate delivery - a
  // reconnect that replays, a second tab, a retried emit - renders nothing.
  const renderedMessageIds = new Set();

  // Set once the server has said what this session already contains, so the
  // greeting is only shown to somebody starting fresh.
  let historyReceived = false;
  let greetingShown = false;
  let closedNoticeShown = false;
  let everConnected = false;
  let uploading = false;

  // Logger utility to avoid direct console usage
  const logger = {
    log: function() {
      if (window.debugMode) {
        // eslint-disable-next-line no-console
        console.log(...arguments);
      }
    },
    error: function() {
      // eslint-disable-next-line no-console
      console.error(...arguments);
    },
    warn: function() {
      // eslint-disable-next-line no-console
      console.warn(...arguments);
    }
  };

  // ------------------------------------------------------------ storage

  /** localStorage can throw (private mode, blocked storage); never let it. */
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Nothing to do: the session simply will not survive a reload.
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Ignore.
    }
  }

  /**
   * Drop the visitor's saved details once they are older than the TTL.
   * Called before every read, so expiry needs no timer.
   */
  function expireStoredUserDetails() {
    const savedAt = Number(readStorage(STORAGE_KEYS.userSavedAt));
    const hasDetails = readStorage(STORAGE_KEYS.userName) !== null ||
      readStorage(STORAGE_KEYS.userEmail) !== null ||
      readStorage(STORAGE_KEYS.userPhone) !== null;

    if (!hasDetails) {
      return;
    }

    // Details saved before the timestamp existed have no date: treat them as
    // expired rather than keeping them forever.
    if (!savedAt || Date.now() - savedAt > PII_TTL_MS) {
      clearStoredUserDetails();
    }
  }

  function clearStoredUserDetails() {
    removeStorage(STORAGE_KEYS.userName);
    removeStorage(STORAGE_KEYS.userEmail);
    removeStorage(STORAGE_KEYS.userPhone);
    removeStorage(STORAGE_KEYS.userSavedAt);
  }

  function storedUserDetails() {
    expireStoredUserDetails();
    return {
      name: readStorage(STORAGE_KEYS.userName) || '',
      email: readStorage(STORAGE_KEYS.userEmail) || '',
      phone: readStorage(STORAGE_KEYS.userPhone) || ''
    };
  }

  // --------------------------------------------------------------- init

  // Initialize the widget
  function init(customConfig = {}) {
    // Merge custom configuration with defaults
    Object.assign(config, customConfig);

    if (!config.serverUrl) {
      logger.error('Chatbot widget: Server URL is required');
      return;
    }

    // Only one widget per page. A second init (a script tag included twice)
    // would otherwise open a second socket for the same session.
    if (document.getElementById('chatbot-widget-host')) {
      logger.warn('Chatbot widget: already initialised on this page');
      return;
    }

    // Save session ID to localStorage
    writeStorage(STORAGE_KEYS.sessionId, sessionId);

    // Initialize broadcast channel for cross-window/tab communication
    initBroadcastChannel();

    // Create widget elements
    createWidgetElements();

    // Initialize socket connection
    initSocketConnection();

    // Add event listeners
    addEventListeners();

    // Apply custom color
    applyCustomStyles();

    // Start heartbeat to keep connection alive
    startHeartbeat();

    // Restart the heartbeat when the page comes back into view. Registered
    // once here rather than inside startHeartbeat, which used to add a fresh
    // listener on every call.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !heartbeatInterval) {
        startHeartbeat();
      }
    });
  }

  // Start heartbeat to keep socket connection alive
  function startHeartbeat() {
    // Clear any existing interval
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    // Send a heartbeat every 30 seconds
    heartbeatInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', { sessionId });
        logger.log('Heartbeat sent');
      }
    }, 30000);
  }

  // Initialize broadcast channel for cross-window/tab communication
  function initBroadcastChannel() {
    try {
      // Check if BroadcastChannel API is available
      if (typeof BroadcastChannel !== 'undefined') {
        broadcastChannel = new BroadcastChannel('chatbot_widget_channel');

        // Listen for messages from other tabs/windows
        broadcastChannel.onmessage = (event) => {
          const { type, data } = event.data || {};

          switch (type) {
          case 'new-message':
            // Add message to the UI without sending to server again. Each tab
            // has its own socket and hears the server directly, so this is
            // only a fallback; the id check keeps it from doubling up.
            if (data.id && renderedMessageIds.has(data.id)) {
              break;
            }
            if (data.sender === 'user') {
              addUserMessage(data.message, false, data.id);
            } else if (data.sender === 'bot') {
              // Use the sender name if provided, otherwise default to "AI Assistant"
              const senderName = data.senderName || 'AI Assistant';
              addBotMessage(data.message, false, senderName, data.id);
            }
            break;

          case 'chat-opened':
            // Sync chat window state across tabs
            setChatWindowOpen(Boolean(data.isOpen), false);
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
      logger.warn('BroadcastChannel not supported or error initializing:', error);
    }
  }

  // ---------------------------------------------------------- rendering

  /** Which pre-chat fields to show, and whether each one is mandatory. */
  function preChatFields() {
    return [
      { key: 'name', id: 'chatbot-user-name', label: 'Name', type: 'text',
        autocomplete: 'name', required: config.requireName !== false },
      { key: 'email', id: 'chatbot-user-email', label: 'Email', type: 'email',
        autocomplete: 'email', required: config.requireEmail !== false },
      { key: 'phone', id: 'chatbot-user-phone', label: 'Phone', type: 'tel',
        autocomplete: 'tel', required: config.requirePhone === true }
    ];
  }

  /** The form is only worth showing when at least one field is required. */
  function preChatFormNeeded() {
    return preChatFields().some(field => field.required);
  }

  function privacyPolicyHref() {
    const configured = config.privacyPolicyUrl && safeUrl(config.privacyPolicyUrl);
    if (configured && configured !== '#') {
      return configured;
    }
    return `${config.serverUrl.replace(/\/+$/, '')}/privacy-policy.html`;
  }

  // Create the user details form
  function createUserDetailsForm() {
    userDetailsForm = document.createElement('div');
    userDetailsForm.className = 'user-details-form';
    userDetailsForm.style.display = 'none'; // Hidden by default

    const fields = preChatFields().map(field => `
      <div class="user-details-field">
        <label for="${field.id}">${escapeHtml(field.label)}${field.required ? '' : ' <span class="optional">(optional)</span>'}</label>
        <input type="${field.type}" id="${field.id}" name="${field.key}"
               autocomplete="${field.autocomplete}"
               ${field.required ? 'required aria-required="true"' : ''}>
      </div>`).join('');

    userDetailsForm.innerHTML = `
      <h3 id="chatbot-user-details-title">Please provide your details</h3>
      <form id="chatbot-user-details-form" aria-labelledby="chatbot-user-details-title" novalidate>
        ${fields}
        <p class="user-details-privacy">
          By starting a chat you agree to our
          <a href="${escapeHtml(privacyPolicyHref())}" target="_blank" rel="noopener noreferrer">privacy policy</a>.
        </p>
        <div class="user-details-error" role="alert" aria-live="assertive"></div>
        <button type="submit">Start Chat</button>
      </form>
    `;

    return userDetailsForm;
  }

  // Create the widget DOM elements
  function createWidgetElements() {
    // The host is the only element the page sees. Positioning lives on it
    // (inline, so the host page's stylesheet cannot move it by accident) and
    // everything else is inside its shadow root.
    host = document.createElement('div');
    host.id = 'chatbot-widget-host';
    host.setAttribute('data-chatbot-widget', '');
    host.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      config.position === 'left' ? 'left: 20px' : 'right: 20px',
      // Above anything a normal page uses, without being the maximum, so a
      // cookie banner that deliberately goes higher still can.
      'z-index: 2147483000',
      'width: auto',
      'height: auto',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'background: transparent',
      'line-height: normal'
    ].join('; ');

    root = host.attachShadow({ mode: 'open' });

    // The stylesheet goes inside the shadow root, where it applies to the
    // widget and to nothing else.
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = config.serverUrl +
      (config.assets['widget/css/widget.css'] || '/widget/css/widget.css');
    root.appendChild(cssLink);

    // Create container
    container = document.createElement('div');
    container.className = 'chatbot-widget-container';
    if (config.position === 'left') {
      container.classList.add('position-left');
    }

    // Launcher. A real button, so it is focusable and announced properly.
    chatIconButton = document.createElement('button');
    chatIconButton.type = 'button';
    chatIconButton.className = 'chat-icon-button';
    chatIconButton.setAttribute('aria-label', `Open chat with ${config.chatbotName}`);
    chatIconButton.setAttribute('aria-expanded', 'false');
    chatIconButton.setAttribute('aria-haspopup', 'dialog');
    chatIconButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
      </svg>
    `;

    // Create chat window
    chatWindow = document.createElement('div');
    chatWindow.className = 'chat-window';
    chatWindow.setAttribute('role', 'dialog');
    chatWindow.setAttribute('aria-label', `Chat with ${config.chatbotName}`);
    chatWindow.setAttribute('aria-hidden', 'true');

    // Create chat header
    const chatHeader = document.createElement('div');
    chatHeader.className = 'chat-header';
    chatHeader.innerHTML = `
      <h3>${escapeHtml(config.chatbotName)}</h3>
      <div class="chat-header-actions">
        <button class="human-button" type="button"
                title="Talk to a person">Talk to a person</button>
        <button class="close-button" type="button" aria-label="Close chat">&times;</button>
      </div>
    `;

    // Connection state. Empty while everything is fine; says "Reconnecting…"
    // or "Offline" when it is not, so a visitor knows why Send is greyed out.
    connectionStatus = document.createElement('div');
    connectionStatus.className = 'connection-status';
    connectionStatus.setAttribute('role', 'status');
    connectionStatus.setAttribute('aria-live', 'polite');

    // Create chat messages container
    chatMessagesContainer = document.createElement('div');
    chatMessagesContainer.className = 'chat-messages';

    // Create chat messages list. `polite` so a screen reader announces new
    // replies without interrupting what the visitor is doing.
    chatMessages = document.createElement('div');
    chatMessages.className = 'chat-messages-list';
    chatMessages.setAttribute('role', 'log');
    chatMessages.setAttribute('aria-live', 'polite');
    chatMessages.setAttribute('aria-relevant', 'additions');

    // Create typing indicator
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing-indicator';
    typingIndicator.setAttribute('aria-label', 'Typing');
    typingIndicator.innerHTML = `
      <span></span>
      <span></span>
      <span></span>
    `;

    // Create chat input area
    const chatInputArea = document.createElement('div');
    chatInputArea.className = 'chat-input-area';

    // Create file upload button and hidden input
    fileUploadButton = document.createElement('button');
    fileUploadButton.type = 'button';
    fileUploadButton.className = 'file-upload-button';
    fileUploadButton.setAttribute('aria-label', 'Attach a file');
    fileUploadButton.title = 'Attach a file';
    fileUploadButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
      </svg>
    `;

    fileUploadInput = document.createElement('input');
    fileUploadInput.type = 'file';
    fileUploadInput.id = 'chatbot-file-input';
    fileUploadInput.setAttribute('aria-label', 'Choose a file to send');
    fileUploadInput.style.display = 'none';
    // Everything the server's MIME allowlist accepts (`routes/upload.js`).
    // This said `.pdf` while the server had accepted images, text, Word and
    // Excel for some time, so a customer trying to send a screenshot of the
    // problem - the single most useful thing they can send - could not.
    fileUploadInput.accept =
      '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx';

    // Create file indicator
    fileIndicator = document.createElement('div');
    fileIndicator.className = 'file-indicator';
    fileIndicator.setAttribute('role', 'status');
    fileIndicator.setAttribute('aria-live', 'polite');

    // Create chat input, with a label a screen reader can find.
    const inputLabel = document.createElement('label');
    inputLabel.className = 'visually-hidden';
    inputLabel.setAttribute('for', 'chatbot-message-input');
    inputLabel.textContent = 'Your message';

    chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.id = 'chatbot-message-input';
    chatInput.placeholder = 'Type your message...';
    chatInput.autocomplete = 'off';
    chatInput.setAttribute('enterkeyhint', 'send');

    // Create send button
    sendButton = document.createElement('button');
    sendButton.className = 'send-button';
    sendButton.type = 'button';
    sendButton.textContent = 'Send';

    // Assemble the widget
    chatInputArea.appendChild(fileUploadButton);
    chatInputArea.appendChild(fileUploadInput);
    chatInputArea.appendChild(inputLabel);
    chatInputArea.appendChild(chatInput);
    chatInputArea.appendChild(sendButton);

    chatMessagesContainer.appendChild(chatMessages);
    chatMessagesContainer.appendChild(typingIndicator);

    // Create user details form
    const userDetailsFormElement = createUserDetailsForm();

    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(connectionStatus);
    chatWindow.appendChild(userDetailsFormElement);
    chatWindow.appendChild(chatMessagesContainer);
    chatWindow.appendChild(fileIndicator);
    chatWindow.appendChild(chatInputArea);

    container.appendChild(chatIconButton);
    container.appendChild(chatWindow);

    root.appendChild(container);

    // Append to document body
    document.body.appendChild(host);
  }

  // Apply custom styles based on configuration
  function applyCustomStyles() {
    // Custom properties inherit across the shadow boundary, so setting them
    // on the host is enough for every rule inside the root to see them - and
    // it leaves the page's own `:root` alone.
    if (config.primaryColor) {
      host.style.setProperty('--primary-color', config.primaryColor);
    }
  }

  // ------------------------------------------------------------- socket

  /**
   * Hand the socket.io client to `callback`, loading it from the server only
   * when the page has not already got one. Overwriting a `window.io` the host
   * page relies on would break their own realtime features.
   */
  function withSocketIo(callback) {
    if (typeof window.io === 'function') {
      callback(window.io);
      return;
    }

    const script = document.createElement('script');
    script.src = `${config.serverUrl}/socket.io/socket.io.js`;
    script.async = true;
    script.onload = () => {
      if (typeof window.io !== 'function') {
        logger.error('Chatbot widget: socket.io client did not load');
        setConnectionState('offline');
        return;
      }
      callback(window.io);
    };
    script.onerror = () => {
      logger.error('Chatbot widget: could not load the socket.io client');
      setConnectionState('offline');
    };
    document.head.appendChild(script);
  }

  /** What the widget sends to (re)claim its session. */
  function resumeSession() {
    const details = storedUserDetails();
    const payload = {
      sessionId,
      sessionToken,
      widgetKey: config.widgetKey,
      pageUrl: window.location.origin
    };

    if (details.name) {
      payload.userName = details.name;
    }
    if (details.email) {
      payload.userEmail = details.email;
    }
    if (details.phone) {
      payload.userPhone = details.phone;
    }

    socket.emit('resume-session', payload);
  }

  /** Read the text of a message whichever field the server used. */
  function messageText(message) {
    if (typeof message.text === 'string') {
      return message.text;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    return '';
  }

  /**
   * Render a live message from the server, once.
   *
   * @returns {boolean} whether it was new
   */
  function renderIncoming(message, sender, kind) {
    const id = message.id || message.messageId || null;
    if (id && renderedMessageIds.has(id)) {
      return false;
    }

    const text = messageText(message);

    if (kind === 'user') {
      addUserMessage(text, false, id);
      if (message.fileUrl) {
        addUserMessage(`I've uploaded a file: ${message.fileName}`, false);
      }
      return true;
    }

    addBotMessage(text, true, sender, id);

    // Products or appointment times, rendered properly rather than
    // described in a sentence. This is what knowing the shape buys.
    if (message.cards && Array.isArray(message.cards.items) && message.cards.items.length) {
      addCards(message.cards);
    }

    // Quick replies, when the workflow offered a set of choices.
    if (Array.isArray(message.choices) && message.choices.length > 0) {
      addQuickReplies(message.choices);
    }

    // Handle file responses if present
    if (message.fileUrl) {
      addFileResponse(message.fileUrl, message.fileName, sender);
    }

    return true;
  }

  function sendReadReceipt(message) {
    socket.emit('message-read', {
      sessionId,
      messageId: message.id || 'latest',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * The transcript the server already holds for this session, drawn once.
   * Nothing here is new, so no read receipts, no cross-tab broadcast, and no
   * typing indicator changes.
   */
  function renderHistory(messages) {
    (messages || []).forEach(message => {
      const id = message.id || message._id || null;
      if (id && renderedMessageIds.has(id)) {
        return;
      }

      const text = messageText(message);
      const timestamp = message.timestamp ? new Date(message.timestamp) : null;

      const fromOperator = message.sender === 'operator' || message.isOperator === true;
      const operatorName = message.operatorName || message.senderName || 'Operator';

      if (message.sender === 'user') {
        addUserMessage(text, false, id, timestamp);
        if (message.fileUrl && message.fileName) {
          addUserMessage(`I've uploaded a file: ${message.fileName}`, false, null, timestamp);
        }
      } else if (fromOperator) {
        addBotMessage(text, false, operatorName, id, timestamp);
      } else {
        addBotMessage(text, false, 'AI Assistant', id, timestamp);
      }

      if (message.fileUrl && message.sender !== 'user') {
        addFileResponse(message.fileUrl, message.fileName, fromOperator ? operatorName : 'AI Assistant');
      }
    });
  }

  /**
   * The greeting, for a fresh session only. Somebody returning to a
   * conversation does not need to be welcomed to it again.
   */
  function showGreetingIfFresh() {
    if (greetingShown) {
      return;
    }
    greetingShown = true;

    if (renderedMessageIds.size === 0 && !chatMessages.querySelector('.message') && config.initialMessage) {
      addBotMessage(config.initialMessage, false);
    }

    showClosedNotice();
  }

  /**
   * Say so up front when nobody can answer. Letting a visitor type into a
   * widget that implies a human is coming, at 3am, is the wrong promise.
   */
  function showClosedNotice() {
    if (closedNoticeShown) {
      return;
    }
    closedNoticeShown = true;

    if (config.availability && config.availability.open === false) {
      const closedMessage = config.availability.offlineMessage ||
        'We are closed at the moment.';
      const returnHint = config.availability.opensAt
        ? ` We reopen ${config.availability.opensAt}.`
        : '';
      addBotMessage(closedMessage + returnHint, false);
    }
  }

  // The server has said it cannot take a conversation right now. The
  // transcript stays readable; only sending is switched off.
  let chatUnavailable = false;

  function setChatUnavailable(unavailable) {
    if (chatUnavailable === unavailable) {
      return;
    }
    chatUnavailable = unavailable;

    if (unavailable) {
      historyReceived = true;
      greetingShown = true;
      addSystemNotice('Chat is unavailable at the moment. Please try again later.');
    }
    setConnectionState(socket && socket.connected ? 'online' : 'reconnecting');
  }

  /**
   * Reflect the connection in the UI.
   *
   * Nothing is queued while offline: a message typed into a dead socket and
   * quietly replayed later reads as sent when it was not. Disabling Send
   * says the truth.
   */
  function setConnectionState(state) {
    const online = state === 'online';
    const canSend = online && !chatUnavailable;

    connectionStatus.textContent = state === 'online'
      ? (chatUnavailable ? 'Chat unavailable' : '')
      : (state === 'reconnecting' ? 'Reconnecting…' : 'Offline');
    connectionStatus.classList.toggle('active', !canSend);

    sendButton.disabled = !canSend;
    fileUploadButton.disabled = !canSend || uploading;
    chatInput.disabled = !canSend;
    chatInput.placeholder = canSend
      ? 'Type your message...'
      : (online ? 'Chat is unavailable right now' : 'Waiting for connection...');
  }

  // Initialize socket.io connection
  function initSocketConnection() {
    setConnectionState('reconnecting');

    withSocketIo(io => {
      // Connect to server with reconnection options
      socket = io(config.serverUrl, {
        // The key travels in the handshake so the server can resolve the
        // tenant before the first message is stored, and the signed identity
        // travels with it so the very first message is attributed correctly.
        auth: {
          widgetKey: config.widgetKey,
          externalId: config.externalId,
          userHash: config.userHash
        },
        query: { sessionId, widgetKey: config.widgetKey || '' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      });

      // -- session protocol --------------------------------------------

      // Sent on every verified resume, echoing the token. A token of null
      // means the server would not create a conversation - the tenant's
      // quota is spent - and the bot's explanation follows as a message.
      socket.on('session-ready', (data = {}) => {
        if (data.sessionId && data.sessionId !== sessionId) {
          sessionId = data.sessionId;
          writeStorage(STORAGE_KEYS.sessionId, sessionId);
        }
        if (data.sessionToken) {
          sessionToken = data.sessionToken;
          writeStorage(STORAGE_KEYS.sessionToken, sessionToken);
          setChatUnavailable(false);
        } else if (Object.prototype.hasOwnProperty.call(data, 'sessionToken') && data.sessionToken === null) {
          setChatUnavailable(true);
        }

        // If the server has no history to send, the greeting still needs to
        // appear; give the history event a moment to arrive first.
        setTimeout(() => {
          if (!historyReceived) {
            showGreetingIfFresh();
          }
        }, 1500);
      });

      // The id we hold is not ours to resume - a token mismatch, or a session
      // that has been deleted. Start again with a clean one rather than
      // arguing.
      socket.on('session-rejected', () => {
        removeStorage(STORAGE_KEYS.sessionId);
        removeStorage(STORAGE_KEYS.sessionToken);
        sessionToken = null;
        sessionId = generateSessionId();
        writeStorage(STORAGE_KEYS.sessionId, sessionId);
        resumeSession();
      });

      socket.on('session-history', (data = {}) => {
        historyReceived = true;
        renderHistory(data.messages);
        showGreetingIfFresh();
      });

      // Something the server could not do with what we sent. A small line in
      // the transcript, where the visitor is looking, rather than a console
      // entry nobody sees.
      socket.on('error', (data = {}) => {
        const message = typeof data === 'string' ? data : data.message;
        addSystemNotice(message || 'Something went wrong. Please try again.');
        setTypingIndicator(false);
      });

      // -- messages -----------------------------------------------------

      // Listen for bot messages
      socket.on('bot-message', (message = {}) => {
        setTypingIndicator(false);

        // For bot messages, the sender is always AI Assistant
        const sender = 'AI Assistant';

        if (!renderIncoming(message, sender, 'bot')) {
          return;
        }

        sendReadReceipt(message);

        // Broadcast to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'new-message',
            data: {
              id: message.id || null,
              sender: 'bot',
              senderName: sender,
              message: messageText(message)
            }
          });
        }
      });

      // Listen for operator messages
      socket.on('operator-message', (message = {}) => {
        setTypingIndicator(false);

        // Get operator name from message
        const sender = message.senderName || 'Operator';

        if (!renderIncoming(message, sender, 'operator')) {
          return;
        }

        sendReadReceipt(message);

        // Broadcast to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'new-message',
            data: {
              id: message.id || null,
              sender: 'bot',
              senderName: sender,
              message: messageText(message)
            }
          });
        }
      });

      // Listen for user messages sent from another tab or device on the
      // same session. Our own messages are drawn when they are sent, so the
      // echo is dropped by id.
      socket.on('user-message', (message = {}) => {
        if (!renderIncoming(message, null, 'user')) {
          return;
        }

        sendReadReceipt(message);
      });

      // Listen for typing indicator. The server says when it starts and when
      // it stops; an event without a flag is the older "started" form.
      socket.on('bot-typing', (data) => {
        const typing = data && typeof data.typing === 'boolean' ? data.typing : true;
        setTypingIndicator(typing);
      });

      // Listen for operator typing indicator
      socket.on('operator-typing', (data = {}) => {
        setTypingIndicator(Boolean(data.isTyping));
      });

      /**
       * The operator has closed the conversation.
       *
       * Before this the widget was never told, so a visitor sat waiting for a
       * reply to a chat that had already been closed.
       */
      socket.on('chat-ended', (data = {}) => {
        addSystemNotice(data.message || 'This conversation has been closed.');

        if (data.requestRating) {
          showRatingPrompt();
        }
      });

      /**
       * The answer to "talk to a person".
       *
       * Says plainly whether somebody is coming. A silent queue is what makes
       * people repeat themselves and then leave.
       */
      socket.on('operator-requested', (data = {}) => {
        const humanButton = chatWindow.querySelector('.human-button');

        if (data.connected) {
          addSystemNotice(data.operatorName
            ? `${data.operatorName} has joined the conversation.`
            : 'You are connected to a member of the team.');
          if (humanButton) {
            humanButton.style.display = 'none';
          }
          return;
        }

        addSystemNotice(
          'Nobody is free right now. Your conversation is in the queue and ' +
          'someone will reply here as soon as they can.'
        );

        if (humanButton) {
          // Re-enabled: they may want to ask again later, and a button that
          // stays dead reads as broken.
          humanButton.disabled = false;
        }
      });

      // Listen for read receipts
      socket.on('message-read', (data = {}) => {
        // Update read status in the UI
        updateMessageReadStatus(data.messageId);
      });

      // Show user details form when requested by operator
      socket.on('request-user-details', () => {
        if (!chatWindow.classList.contains('open')) {
          setChatWindowOpen(true);
        }
        showUserDetailsForm();
      });

      // -- connection ---------------------------------------------------

      // Load chat history when socket is connected. The same resume runs on
      // every connect, including reconnects, so the dead `reconnect` handler
      // that used to duplicate it is gone. Anything already on screen stays
      // on screen: history is deduplicated by id.
      socket.on('connect', () => {
        logger.log('Socket connected');
        everConnected = true;
        setConnectionState('online');
        resumeSession();
      });

      socket.on('disconnect', (reason) => {
        logger.log('Socket disconnected:', reason);
        setTypingIndicator(false);
        setConnectionState('reconnecting');
      });

      // socket.io retries on its own with backoff; calling connect() by hand
      // here used to stack a second reconnect loop on top of it.
      socket.on('connect_error', (error) => {
        logger.error('Connection error:', error);
        setConnectionState(everConnected ? 'reconnecting' : 'offline');
      });
    });
  }

  // ------------------------------------------------------------- events

  // Add event listeners to widget elements
  function addEventListeners() {
    // Toggle chat window on icon click
    chatIconButton.addEventListener('click', toggleChatWindow);

    // Close chat window on close button click
    const closeButton = chatWindow.querySelector('.close-button');
    closeButton.addEventListener('click', closeChatWindow);

    // Escape closes the window, as any dialog does.
    chatWindow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chatWindow.classList.contains('open')) {
        closeChatWindow();
        chatIconButton.focus();
      }
    });

    // Add event listener to user details form
    const userDetailsFormElement = userDetailsForm.querySelector('form');
    if (userDetailsFormElement) {
      userDetailsFormElement.addEventListener('submit', handleUserDetailsSubmit);
    }

    /**
     * Asking for a person.
     *
     * A button rather than a guess at the message text. Inferring "this one
     * wants a human" gets it wrong in both directions: it escalates people
     * being polite, and misses the ones quietly giving up.
     */
    const humanButton = chatWindow.querySelector('.human-button');
    humanButton.addEventListener('click', () => {
      if (!socket || !socket.connected) {
        return;
      }
      humanButton.disabled = true;
      socket.emit('request-operator');
    });

    // Send message on button click.
    sendButton.addEventListener('click', sendMessage);

    // Send message on Enter key press
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Track user typing
    let typingTimeout;
    chatInput.addEventListener('input', () => {
      if (socket && socket.connected) {
        // Clear existing timeout
        clearTimeout(typingTimeout);

        // Send typing indicator to server
        socket.emit('user-typing', {
          sessionId,
          isTyping: true
        });

        // Set timeout to stop typing indicator after 2 seconds of inactivity
        typingTimeout = setTimeout(() => {
          if (socket && socket.connected) {
            socket.emit('user-typing', {
              sessionId,
              isTyping: false
            });
          }
        }, 2000);
      }
    });

    // File upload button click
    fileUploadButton.addEventListener('click', () => {
      if (!uploading) {
        fileUploadInput.click();
      }
    });

    // File upload change
    fileUploadInput.addEventListener('change', handleFileUpload);

    // Handle visibility change to manage active state
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // When tab becomes visible, check socket connection and reconnect if needed
        if (socket && !socket.connected && !socket.active) {
          logger.log('Reconnecting socket on visibility change');
          socket.connect();
        }

        // Mark all messages as read
        if (socket && socket.connected) {
          socket.emit('mark-all-read', {
            sessionId,
            timestamp: new Date().toISOString()
          });
        }
      }
    });
  }

  // Check if user details exist in localStorage
  function userDetailsExist() {
    const details = storedUserDetails();
    return preChatFields().every(field => !field.required || details[field.key]);
  }

  function showUserDetailsForm() {
    const details = storedUserDetails();

    userDetailsForm.style.display = 'block';
    chatMessagesContainer.style.display = 'none';
    fileIndicator.style.display = 'none';

    preChatFields().forEach(field => {
      const input = root.getElementById(field.id);
      if (input) {
        input.value = details[field.key] || '';
      }
    });

    const firstInput = userDetailsForm.querySelector('input');
    if (firstInput) {
      firstInput.focus();
    }
  }

  function showChatInterface() {
    userDetailsForm.style.display = 'none';
    chatMessagesContainer.style.display = 'block';
    fileIndicator.style.display = 'block';
    scrollToBottom();
  }

  // Handle user details form submission
  function handleUserDetailsSubmit(e) {
    e.preventDefault();

    const form = e.target;
    const errorBox = userDetailsForm.querySelector('.user-details-error');
    const values = {};

    // Validate by hand so the message shows inside the widget: native
    // validation bubbles render outside the shadow root and are easy to miss.
    for (const field of preChatFields()) {
      const input = root.getElementById(field.id);
      const value = input ? input.value.trim() : '';
      values[field.key] = value;

      if (field.required && !value) {
        errorBox.textContent = `Please enter your ${field.label.toLowerCase()}.`;
        input.focus();
        return;
      }
      if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errorBox.textContent = 'Please enter a valid email address.';
        input.focus();
        return;
      }
    }
    errorBox.textContent = '';

    // Save to localStorage, dated so it can be forgotten again.
    writeStorage(STORAGE_KEYS.userName, values.name);
    writeStorage(STORAGE_KEYS.userEmail, values.email);
    writeStorage(STORAGE_KEYS.userPhone, values.phone);
    writeStorage(STORAGE_KEYS.userSavedAt, String(Date.now()));

    // Send user details to server
    if (socket && socket.connected) {
      socket.emit('user-details', {
        sessionId,
        sessionToken,
        // Carry the tenant hints: this event usually creates the conversation
        // document, so it must be able to attribute it to a company.
        widgetKey: config.widgetKey,
        pageUrl: window.location.origin,
        externalId: config.externalId,
        userHash: config.userHash,
        name: values.name,
        email: values.email,
        phone: values.phone
      });
    }

    // Hide form and show chat interface
    showChatInterface();
    form.reset();

    // Focus on chat input
    chatInput.focus();
  }

  /**
   * Open or close the window, keeping the launcher's state and the other tabs
   * in step.
   */
  function setChatWindowOpen(open, broadcast = true) {
    chatWindow.classList.toggle('open', open);
    chatWindow.setAttribute('aria-hidden', open ? 'false' : 'true');
    chatIconButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    chatIconButton.setAttribute('aria-label',
      `${open ? 'Close' : 'Open'} chat with ${config.chatbotName}`);

    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'chat-opened',
        data: { isOpen: open }
      });
    }
  }

  // Toggle chat window visibility
  function toggleChatWindow() {
    const opening = !chatWindow.classList.contains('open');
    setChatWindowOpen(opening);

    if (opening) {
      // Check if user details exist
      if (!preChatFormNeeded() || userDetailsExist()) {
        // Show chat interface
        showChatInterface();
        chatInput.focus();
      } else {
        // Show user details form
        showUserDetailsForm();
      }

      // Emit event to the server that chat was opened
      if (socket && socket.connected) {
        socket.emit('chat-opened', {
          sessionId,
          widgetKey: config.widgetKey,
          pageUrl: window.location.origin
        });
      }
    }
  }

  // Close chat window
  function closeChatWindow() {
    setChatWindowOpen(false);
  }

  // Send a message to the server
  function sendMessage() {
    const message = chatInput.value.trim();

    if (!message) {
      return;
    }

    // Nothing is queued while disconnected: see setConnectionState.
    if (!socket || !socket.connected) {
      addSystemNotice('You are offline. Your message was not sent.');
      return;
    }
    if (chatUnavailable) {
      addSystemNotice('Chat is unavailable at the moment. Your message was not sent.');
      return;
    }

    // Generate a local message ID for tracking read status
    const messageId = generateMessageId();
    const timestamp = new Date().toISOString();

    // Add message to UI
    addUserMessage(message, true, messageId);

    // Clear input
    chatInput.value = '';

    // Inform the server that the user is no longer typing
    socket.emit('user-typing', {
      sessionId,
      isTyping: false
    });

    // Prepare message data
    const messageData = {
      sessionId,
      sessionToken,
      messageId,
      timestamp,
      message
    };

    // Add user name if available
    const details = storedUserDetails();
    if (details.name) {
      messageData.userName = details.name;
    }

    // Send the message to the server
    socket.emit('user-message', messageData);
  }

  function setUploading(state) {
    uploading = state;
    fileUploadButton.disabled = state || chatUnavailable || !(socket && socket.connected);
    fileUploadButton.classList.toggle('uploading', state);
    fileUploadButton.setAttribute('aria-busy', state ? 'true' : 'false');
  }

  // Handle file upload
  function handleFileUpload(event) {
    const file = event.target.files[0];

    if (!file) {
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      fileUploadInput.value = '';
      fileIndicator.textContent = 'That file is too large. The limit is 10 MB.';
      fileIndicator.classList.add('active', 'error');
      setTimeout(() => fileIndicator.classList.remove('active', 'error'), 5000);
      return;
    }

    if (!socket || !socket.connected) {
      fileUploadInput.value = '';
      addSystemNotice('You are offline. The file was not sent.');
      return;
    }

    // Show file indicator
    fileIndicator.textContent = `Uploading ${file.name}…`;
    fileIndicator.classList.remove('error');
    fileIndicator.classList.add('active');
    setUploading(true);

    // Broadcast file selection to other tabs/windows
    if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'file-uploaded',
        data: {
          fileName: file.name
        }
      });
    }

    // Create FormData. The token proves this browser owns the session the
    // file is being attached to.
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', sessionId);
    formData.append('sessionToken', sessionToken || '');

    const clearIndicator = () => {
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
    };

    const fail = (reason) => {
      logger.error('File upload failed:', reason);
      fileIndicator.textContent = reason || 'Sorry, there was a problem uploading your file. Please try again.';
      fileIndicator.classList.add('error');
      setTimeout(() => {
        fileIndicator.classList.remove('error');
        clearIndicator();
      }, 5000);
    };

    // Upload file
    fetch(`${config.serverUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include'
    })
      .then(response => response.json().catch(() => ({})).then(data => ({ ok: response.ok, status: response.status, data })))
      .then(({ ok, status, data }) => {
        if (!ok || !data.success) {
          const reason = status === 413
            ? 'That file is too large. The limit is 10 MB.'
            : (data.error || 'Sorry, there was a problem uploading your file. Please try again.');
          fail(reason);
          return;
        }

        // Add message about file upload
        addUserMessage(`I've uploaded a file: ${file.name}`, true);

        fileIndicator.textContent = `Sent ${file.name}`;
        setTimeout(clearIndicator, 3000);

        // Notify server about uploaded file
        if (socket && socket.connected) {
          socket.emit('file-uploaded', {
            sessionId,
            sessionToken,
            fileId: data.fileId,
            fileName: file.name,
            timestamp: new Date().toISOString()
          });
        }
      })
      .catch(error => {
        fail(error && error.message ? null : null);
      })
      .finally(() => {
        fileUploadInput.value = '';
        setUploading(false);
      });
  }

  // ----------------------------------------------------------- messages

  /** Remember that a message is on screen. */
  function trackRendered(id) {
    if (id) {
      renderedMessageIds.add(id);
    }
  }

  // Add a user message to the chat
  function addUserMessage(message, broadcast = true, id = null, when = null) {
    const messageId = id || generateMessageId();
    const timestamp = when || new Date();

    trackRendered(messageId);

    // Get user name from localStorage, default to "You" if not available
    const userName = storedUserDetails().name || 'You';

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
      <svg class="status-icon sent" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
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
          id: messageId,
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
  function addBotMessage(message, broadcast = true, sender = 'AI Assistant', id = null, when = null) {
    trackRendered(id);

    const messageElement = document.createElement('div');
    messageElement.className = 'message bot';
    if (id) {
      messageElement.dataset.messageId = id;
    }

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = sender;
    messageElement.appendChild(senderElement);

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';

    contentElement.innerHTML = formatMessage(message);
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestamp = when || new Date();
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
          id: id || null,
          sender: 'bot',
          senderName: sender,
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
    const intro = document.createElement('p');
    intro.textContent = 'Here\'s the file you requested:';
    contentElement.appendChild(intro);

    // Built as nodes rather than as a template string: the name comes from
    // whoever uploaded the file and the URL is only ever ours, so neither
    // belongs in innerHTML. `safeUrl` also stops a `javascript:` href, which
    // escaping alone would happily preserve.
    const link = document.createElement('a');
    link.href = safeUrl(fileUrl);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = String(fileName || 'file');
    link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
      'viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> ';
    link.appendChild(document.createTextNode(String(fileName || 'file')));
    contentElement.appendChild(link);
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestamp = new Date();
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();
  }

  /**
   * Products and appointment times, shown rather than described.
   *
   * A product with its picture and price answers "do you have waterproof
   * panniers?" in a way no paragraph does, and a time on a button is something
   * somebody taps rather than retypes. Both are only possible because the
   * connector contract fixes the shape.
   */
  function addCards(cards) {
    const cardsContainer = document.createElement('div');
    cardsContainer.className = `chat-cards chat-cards-${cards.type === 'Slot' ? 'slots' : 'products'}`;

    cards.items.slice(0, 8).forEach(item => {
      const card = document.createElement(cards.type === 'Slot' ? 'button' : 'div');
      card.className = 'chat-card';

      if (cards.type === 'Slot') {
        card.type = 'button';
        card.textContent = item.label || formatSlot(item.startsAt);
        if (item.staff) {
          const staff = document.createElement('span');
          staff.className = 'chat-card-staff';
          staff.textContent = item.staff;
          card.appendChild(staff);
        }
        // Tapping sends the id, which is what the booking step needs; the
        // transcript shows the readable time so it still reads as a
        // conversation.
        card.addEventListener('click', () => {
          cardsContainer.remove();
          chatInput.value = item.label || formatSlot(item.startsAt);
          sendMessage();
        });
      } else {
        // The image and link come from the tenant's API rather than from us,
        // so they go through the same URL check as everything else.
        const imageUrl = item.image ? safeUrl(item.image) : '#';
        if (imageUrl !== '#') {
          const image = document.createElement('img');
          image.className = 'chat-card-image';
          image.src = imageUrl;
          image.alt = '';
          // A broken image should leave a card that still works, not a
          // browser's broken-image icon in somebody's chat.
          image.addEventListener('error', () => image.remove());
          card.appendChild(image);
        }

        const title = document.createElement('div');
        title.className = 'chat-card-title';
        title.textContent = item.title;
        card.appendChild(title);

        if (item.price) {
          const price = document.createElement('div');
          price.className = 'chat-card-price';
          price.textContent = item.price;
          card.appendChild(price);
        }

        const linkUrl = item.url ? safeUrl(item.url) : '#';
        if (linkUrl !== '#') {
          const link = document.createElement('a');
          link.className = 'chat-card-link';
          link.href = linkUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'View';
          card.appendChild(link);
        }
      }

      cardsContainer.appendChild(card);
    });

    chatMessages.appendChild(cardsContainer);
    scrollToBottom();
  }

  /** A time as somebody would say it, not as a machine stores it. */
  function formatSlot(value) {
    const date = new Date(value);

    if (isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    });
  }

  /**
   * Buttons for a question with a known set of answers.
   *
   * Tapping one sends its label as an ordinary message, so nothing downstream
   * needs a special case: the transcript reads naturally, an operator joining
   * later sees what was chosen, and a visitor who prefers to type still can.
   *
   * The buttons are removed once used. Leaving them behind invites answering
   * a question that has already moved on, which is how a flow gets out of step
   * with the person in it.
   */
  function addQuickReplies(choices) {
    const existing = chatMessages.querySelector('.quick-replies');
    if (existing) {
      existing.remove();
    }

    const group = document.createElement('div');
    group.className = 'quick-replies';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Suggested replies');

    choices.slice(0, 8).forEach(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-reply';
      button.textContent = choice.label;
      button.addEventListener('click', () => {
        group.remove();
        chatInput.value = choice.label;
        sendMessage();
      });
      group.appendChild(button);
    });

    chatMessages.appendChild(group);
    scrollToBottom();
  }

  /** A neutral, non-attributed line: not the bot speaking, but a state change. */
  function addSystemNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'chat-system-notice';
    notice.textContent = text;
    chatMessages.appendChild(notice);
    scrollToBottom();
  }

  /**
   * Ask how it went.
   *
   * Asked at the end because that is the only moment the customer is both
   * finished and still here. One tap is the whole requirement — the comment
   * box only appears after a score, so nobody is asked to write an essay
   * before they have rated.
   */
  function showRatingPrompt() {
    if (chatMessages.querySelector('.chat-rating')) {
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'chat-rating';
    panel.innerHTML = `
      <div class="chat-rating-question">How did we do?</div>
      <div class="chat-rating-scores" role="group" aria-label="Rate this conversation">
        ${[1, 2, 3, 4, 5].map(score => `
          <button type="button" class="chat-rating-score" data-score="${score}"
                  aria-label="${score} out of 5">${score}</button>`).join('')}
      </div>
      <div class="chat-rating-scale" aria-hidden="true">
        <span>Not helpful</span><span>Very helpful</span>
      </div>
      <button type="button" class="chat-rating-dismiss">No thanks</button>`;

    chatMessages.appendChild(panel);
    scrollToBottom();

    panel.querySelectorAll('.chat-rating-score').forEach(button => {
      button.addEventListener('click', () => {
        const score = Number(button.dataset.score);
        panel.querySelectorAll('.chat-rating-score').forEach(other => {
          other.classList.toggle('selected', Number(other.dataset.score) === score);
          other.disabled = true;
        });
        submitRating(score, panel);
      });
    });

    panel.querySelector('.chat-rating-dismiss').addEventListener('click', () => {
      if (socket && socket.connected) {
        socket.emit('decline-rating');
      }
      panel.remove();
    });
  }

  /**
   * Send the score straight away, then offer the comment box.
   *
   * The score is what gets measured, so it is recorded the moment it is tapped
   * rather than waiting for a comment that most people will not write.
   */
  function submitRating(score, panel) {
    if (socket && socket.connected) {
      socket.emit('submit-rating', { score });
    }

    panel.querySelector('.chat-rating-question').textContent = 'Thank you.';
    panel.querySelector('.chat-rating-dismiss').remove();

    const follow = document.createElement('div');
    follow.className = 'chat-rating-comment';
    follow.innerHTML = `
      <label for="chatbot-rating-comment">Anything you would like to add?</label>
      <textarea id="chatbot-rating-comment" rows="2" maxlength="1000"
                placeholder="Optional"></textarea>
      <button type="button" class="chat-rating-send">Send</button>`;

    panel.appendChild(follow);
    scrollToBottom();

    follow.querySelector('.chat-rating-send').addEventListener('click', () => {
      const comment = follow.querySelector('textarea').value.trim();

      if (comment && socket && socket.connected) {
        // Re-sent with the score: the server records a conversation once, and
        // the first submission has already been stored, so this second one is
        // only useful if the visitor was quick enough that it has not landed.
        socket.emit('submit-rating', { score, comment });
      }

      follow.innerHTML = '<div class="chat-rating-done">Thanks for the feedback.</div>';
      scrollToBottom();
    });
  }

  // Set typing indicator visibility
  function setTypingIndicator(isTyping, broadcast = true) {
    typingIndicator.classList.toggle('active', Boolean(isTyping));
    scrollToBottom();

    // Broadcast typing indicator state to other tabs/windows
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'typing-indicator',
        data: {
          isTyping: Boolean(isTyping)
        }
      });
    }
  }

  // Update read status of a message
  function updateMessageReadStatus(messageId) {
    if (!messageId) {
      return;
    }

    // The id comes from the server, so it is escaped before it goes into a
    // selector rather than trusted to be selector-safe.
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(String(messageId))
      : String(messageId).replace(/["\\]/g, '\\$&');
    const message = chatMessages.querySelector(`.message[data-message-id="${escaped}"]`);

    if (message) {
      const statusIcon = message.querySelector('.message-status');

      if (statusIcon) {
        statusIcon.innerHTML = `
          <svg class="status-icon read" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/>
          </svg>
        `;
      }
    }
  }

  // ------------------------------------------------------------ helpers

  // Format time for messages
  function formatTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (isNaN(value.getTime())) {
      return '';
    }
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Make a string safe to put inside HTML.
   *
   * This widget runs on the tenant's own website, in their page, next to their
   * customers' sessions. Anything that reaches innerHTML unescaped is therefore
   * not our bug to shrug at - it is script execution on somebody else's site.
   * Message text is the obvious carrier, but so is a chatbot name typed into
   * the appearance form and a filename chosen by whoever uploaded it.
   */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A URL we are willing to put in an href.
   *
   * Only http(s) and same-origin relative paths. Anything else - `javascript:`
   * most of all - becomes an inert anchor rather than a link that runs code.
   */
  function safeUrl(value) {
    const raw = String(value || '').trim();

    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) {
      return raw;
    }
    return '#';
  }

  /**
   * The small amount of formatting a reply is allowed to carry.
   *
   * Escaping happens first and the markup is added afterwards, so the only tags
   * that can reach the page are the three this function puts there. Doing it the
   * other way round - transforming and then trusting the result - is what let
   * `<img src=x onerror=...>` in a bot reply run in the visitor's browser.
   */
  function formatMessage(message) {
    return escapeHtml(message)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  // Generate a unique message ID
  function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Scroll chat messages to bottom
  function scrollToBottom() {
    if (chatMessagesContainer) {
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    }
  }

  /**
   * A session id nobody can guess.
   *
   * `Math.random` is not designed to be unpredictable, and a predictable
   * session id is a transcript somebody else can read.
   */
  function generateSessionId() {
    const cryptoObject = window.crypto || window.msCrypto;

    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return cryptoObject.randomUUID();
    }

    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObject.getRandomValues(bytes);
      // RFC 4122 version and variant bits.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // No crypto at all: an ancient browser. Better a weak id than no chat.
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
