const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('./models/conversation');
const User = require('./models/user');
const AIService = require('./services/ai');
const EncryptionService = require('./services/encryption');
const tenantService = require('./services/tenant');
const usageService = require('./services/usage');
const contactService = require('./services/contacts');
const emailChannel = require('./services/email-channel');
const { operatorRoom, GLOBAL_OPERATOR_ROOM } = require('./socketManager');
const { logger } = require('./services/logging');

function setupWebSockets(server) {
  // Initialize encryption service
  const encryptionService = new EncryptionService();

  const io = socketIO(server, {
    cors: {
      origin: function (origin, callback) {
        // No Origin means a non-browser client; tenant domains are resolved
        // from the database so onboarding a customer does not require an env
        // change and redeploy.
        if (!origin) {
          return callback(null, true);
        }

        // The admin dashboard connects from the server's own origin.
        const selfOrigins = [
          `http://localhost:${process.env.PORT || 3000}`,
          `http://127.0.0.1:${process.env.PORT || 3000}`,
          process.env.PUBLIC_URL
        ].filter(Boolean);
        if (selfOrigins.includes(origin)) {
          return callback(null, true);
        }

        tenantService.isOriginAllowed(origin)
          .then(allowed => callback(allowed ? null : new Error('Not allowed by CORS'), allowed))
          .catch(error => callback(error));
      },
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Middleware for authenticating operators
  io.use(async (socket, next) => {
    try {
      // Get token from socket handshake auth
      const token = socket.handshake.auth.token;

      // If no token, client is a regular user (not an operator)
      if (!token) {
        socket.user = { role: 'user' };
        return next();
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');

      // Check if user still exists and is active
      const user = await User.findById(decoded.id).select('username displayName role company isActive');
      if (!user || !user.isActive) {
        return next(new Error('Authentication failed'));
      }

      // Add user info to socket. `company` is required so operator events can
      // be scoped to a single tenant instead of a global broadcast room.
      socket.user = {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        companyId: user.company ? user.company.toString() : null
      };

      next();
    } catch (error) {
      if (error.name === 'JsonWebTokenError') {
        socket.user = { role: 'user' }; // Treat as regular user if token is invalid
        return next();
      }
      next(new Error('Authentication failed'));
    }
  });  // Handle socket connections
  io.on('connection', (socket) => {
    logger.info('New client connected');

    // Track client's session and role
    let clientSessionId = null;
    let encryptionEnabled = false;
    // Every staff role counts as an operator here. The old check looked for a
    // role named 'admin', which does not exist in the User schema, so
    // superadmins and company admins were silently treated as visitors.
    const STAFF_ROLES = ['operator', 'company_admin', 'superadmin'];
    const isOperator = Boolean(socket.user && STAFF_ROLES.includes(socket.user.role));
    const isSuperadmin = Boolean(socket.user && socket.user.role === 'superadmin');
    const operatorCompanyId = socket.user ? socket.user.companyId : null;
    const operatorDisplayName = socket.user
      ? (socket.user.displayName || socket.user.username)
      : 'Operator';

    // Company of the visitor on the other end of this socket, resolved from the
    // widget key / origin so their events reach only their tenant's operators.
    let clientCompanyId = null;

    /**
     * Where this socket connected from, captured once at connection time.
     *
     * Operators use this to see which site a conversation came from, and it
     * drives the traffic-source chart. Different transports populate different
     * headers, so try each in turn rather than relying on `origin` alone.
     */
    const connectionOrigin = (() => {
      const headers = socket.handshake.headers || {};
      const candidate = headers.origin || headers.referer;

      if (candidate) {
        try {
          return new URL(candidate).origin;
        } catch {
          return candidate;
        }
      }

      // Last resort: the Host header tells us the server the client reached,
      // which for a first-party install is also the site they are on.
      if (headers.host) {
        return `${socket.handshake.secure ? 'https' : 'http'}://${headers.host}`;
      }

      return null;
    })();

    /**
     * Emit to the operators of one tenant (plus superadmins), excluding this
     * socket. Replaces the previous global 'operators' room, which delivered
     * every tenant's messages to every tenant's operators.
     */
    const toOperators = (companyId, event, payload) => {
      socket.to(operatorRoom(companyId)).emit(event, payload);
      socket.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
    };

    /** Same, but including this socket (used for operator-originated events). */
    const allOperators = (companyId, event, payload) => {
      io.to(operatorRoom(companyId)).emit(event, payload);
      io.to(GLOBAL_OPERATOR_ROOM).emit(event, payload);
    };

    /**
     * Guard for operator actions on a specific conversation. Without this an
     * operator could join, read, answer or end any session id they can guess,
     * including conversations belonging to another company.
     */
    const canOperateOn = async (sessionId) => {
      if (!isOperator || !sessionId) {
        return false;
      }
      if (isSuperadmin) {
        return true;
      }
      const conversation = await Conversation.findOne({ sessionId }).select('company').lean();
      if (!conversation) {
        return false;
      }
      const convCompany = conversation.company ? conversation.company.toString() : null;
      return Boolean(convCompany && operatorCompanyId && convCompany === operatorCompanyId);
    };

    /**
     * Resolve and remember the tenant for the visitor's session, so later
     * events on this socket can be routed without another database lookup.
     */
    const resolveClientCompany = async (sessionId, hints = {}) => {
      if (clientCompanyId) {
        return clientCompanyId;
      }

      const existing = sessionId
        ? await Conversation.findOne({ sessionId }).select('company').lean()
        : null;

      if (existing && existing.company) {
        clientCompanyId = existing.company.toString();
        return clientCompanyId;
      }

      const companyId = await tenantService.resolveCompanyId({
        widgetKey: hints.widgetKey || socket.handshake.auth?.widgetKey || socket.handshake.query?.widgetKey,
        origin: socket.handshake.headers.origin || socket.handshake.headers.referer
      });

      clientCompanyId = companyId ? companyId.toString() : null;
      return clientCompanyId;
    };

    /**
     * Find or create the conversation for a session, always stamping the
     * resolved company so multi-tenant filtering works downstream.
     */
    const getOrCreateConversation = async (sessionId, hints = {}) => {
      // Where the visitor is chatting from. Operators use this to know which
      // site a conversation came from, and it drives the traffic-source chart.
      const origin = hints.pageUrl || connectionOrigin;

      let conversation = await Conversation.findOne({ sessionId });

      if (!conversation) {
        const companyId = await resolveClientCompany(sessionId, hints);
        conversation = new Conversation({
          sessionId,
          company: companyId || undefined,
          domain: origin,
          messages: []
        });

        // Metered once, at creation, so a long conversation counts as one.
        usageService.record(companyId, { conversations: 1 });
      } else {
        // Backfill on conversations created before the tenant or origin was
        // known - for example by a `join` that arrived before `user-details`.
        if (!conversation.company) {
          const companyId = await resolveClientCompany(sessionId, hints);
          if (companyId) {
            conversation.company = companyId;
          }
        }
        if (!conversation.domain && origin) {
          conversation.domain = origin;
        }
      }

      if (conversation.company) {
        clientCompanyId = conversation.company.toString();
      }

      // Attach the person behind the session. Identity claims are only trusted
      // when the tenant signed them; see services/contacts.js.
      if (clientCompanyId && !conversation.contact) {
        const contact = await contactService.resolve({
          companyId: clientCompanyId,
          sessionId,
          externalId: hints.externalId || socket.handshake.auth?.externalId,
          userHash: hints.userHash || socket.handshake.auth?.userHash,
          email: hints.email,
          name: hints.name,
          phone: hints.phone
        });

        if (contact) {
          await contactService.linkConversation(contact, conversation);
        }
      }

      return conversation;
    };

    // Staff get a personal room so notifications can be delivered to one user
    // rather than broadcast to every connected client.
    if (isOperator && socket.user.id) {
      socket.join(`user:${socket.user.id}`);
    }

    // Send server's public key to client for encryption setup
    const serverPublicKey = encryptionService.getServerPublicKey();
    socket.emit('encryption-init', {
      serverPublicKey: serverPublicKey
    });

    // Handle client's public key for end-to-end encryption
    socket.on('client-public-key', (data) => {
      const { sessionId, publicKey } = data;
      clientSessionId = sessionId;

      // Register client's public key
      const success = encryptionService.registerClientPublicKey(sessionId, publicKey);

      if (success) {
        encryptionEnabled = true;
        socket.emit('encryption-ready', { success: true });
        logger.info(`End-to-end encryption enabled for session: ${sessionId}`);
      } else {
        socket.emit('encryption-ready', {
          success: false,
          error: 'Failed to set up encryption'
        });
      }
    });
    // Join a chat session room
    socket.on('join', async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) {
        return socket.emit('joined-room', { success: false, error: 'Invalid session' });
      }

      // Operators must prove they own the tenant before eavesdropping on a room.
      if (isOperator && !(await canOperateOn(sessionId))) {
        logger.warn('Operator denied join for out-of-tenant session', {
          sessionId,
          operator: socket.user.username
        });
        return socket.emit('joined-room', { success: false, error: 'Access denied' });
      }

      clientSessionId = sessionId;
      socket.join(sessionId);
      logger.info(`Client joined room: ${sessionId}`);
      socket.emit('joined-room', {
        success: true,
        room: sessionId
      });
    });// Handle new session from widget
    socket.on('resume-session', async (data) => {
      const { sessionId, publicKey } = data;
      clientSessionId = sessionId;
      socket.join(sessionId);

      // If client provides a public key, set up encryption
      if (publicKey) {
        const success = encryptionService.registerClientPublicKey(sessionId, publicKey);
        encryptionEnabled = success;

        socket.emit('encryption-ready', {
          success,
          error: success ? null : 'Failed to set up encryption'
        });
      }

      // Find existing conversation
      const conversation = await Conversation.findOne({ sessionId });
      if (conversation && conversation.company) {
        clientCompanyId = conversation.company.toString();
      } else {
        await resolveClientCompany(sessionId, data);
      }

      // If there's an existing conversation, send the last few messages
      if (conversation && conversation.messages.length > 0) {
        // Send last 10 messages (or fewer if there aren't that many)
        const lastMessages = conversation.messages.slice(-10);

        // Send each message individually in correct order
        lastMessages.forEach(message => {
          // Prepare message data
          const messageData = {
            id: message._id.toString(),
            timestamp: message.timestamp || new Date(),
            isOperator: message.sender === 'operator',
            operatorName: message.operatorName
          };

          // Add file information if present
          if (message.fileId) {
            messageData.fileId = message.fileId;
            messageData.fileName = message.fileName;
            messageData.fileUrl = `/api/upload/${message.fileId}`;
          }

          // Encrypt message content if encryption is enabled
          if (encryptionEnabled && message.content && encryptionService.hasClientPublicKey(sessionId)) {
            const encrypted = encryptionService.encryptForClient(sessionId, message.content);
            if (encrypted) {
              messageData.encrypted = true;
              messageData.encryptedMessage = encrypted.encryptedMessage;
              messageData.nonce = encrypted.nonce;
            } else {
              messageData.text = message.content;
            }
          } else {
            messageData.text = message.content;
          }

          if (message.sender === 'user') {
            socket.emit('user-message', messageData);
          } else if (message.sender === 'operator') {
            socket.emit('operator-message', messageData);
          } else {
            socket.emit('bot-message', messageData);
          }
        });

        // Mark all messages as read
        socket.emit('all-messages-read');
      }

      logger.info(`Session resumed: ${sessionId}`);
    });

    // Handle chat opened event
    socket.on('chat-opened', async (data) => {
      const { sessionId } = data;
      clientSessionId = sessionId;

      // Notify operators that a chat has been opened
      if (clientSessionId) {
        await resolveClientCompany(sessionId, data);
        toOperators(clientCompanyId, 'chat-activity', {
          type: 'opened',
          sessionId: clientSessionId,
          timestamp: new Date()
        });
      }
    });

    // Handle user details from widget
    socket.on('user-details', async (data) => {
      try {
        const { sessionId, name, email, phone } = data;
        clientSessionId = sessionId;

        // Save user details to conversation metadata
        const conversation = await getOrCreateConversation(sessionId, data);

        // Initialize metadata if it doesn't exist
        if (!conversation.metadata) {
          conversation.metadata = new Map();
        }

        // Update metadata with user details
        conversation.metadata.set('name', name || '');
        conversation.metadata.set('email', email || '');
        conversation.metadata.set('phone', phone || '');

        // Now that they have told us who they are, re-resolve: an email may
        // merge this session with a person we already know.
        const contact = await contactService.resolve({
          companyId: clientCompanyId,
          sessionId,
          externalId: data.externalId || socket.handshake.auth?.externalId,
          userHash: data.userHash || socket.handshake.auth?.userHash,
          email,
          name,
          phone
        });

        if (contact) {
          await contactService.linkConversation(contact, conversation);
        }

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();

        // Notify operators that user details have been updated
        toOperators(clientCompanyId, 'user-details-updated', {
          sessionId,
          name,
          email,
          phone,
          timestamp: new Date()
        });

        logger.info(`User details updated for session: ${sessionId}`);
      } catch (error) {
        logger.error('Error handling user details:', error);
        socket.emit('error', { message: 'Failed to save user details' });
      }
    });

    // Handle user messages from widget
    socket.on('user-message', async (data) => {
      try {
        const { sessionId, messageId, timestamp } = data;
        clientSessionId = sessionId;

        // Decrypt message if encryption is enabled
        let message = data.message;
        if (encryptionEnabled && data.encrypted) {
          message = encryptionService.decryptFromClient(
            sessionId,
            data.encryptedMessage,
            data.nonce
          );

          if (!message) {
            socket.emit('error', { message: 'Failed to decrypt message' });
            return;
          }
        }

        // Save message to database
        const conversation = await getOrCreateConversation(sessionId, data);

        // Check if the conversation was ended and reactivate it if needed
        if (conversation.status === 'ended') {
          conversation.status = 'active';
          conversation.endedAt = null;

          // Notify operators that this chat has been reactivated
          toOperators(clientCompanyId, 'chat-reactivated', {
            sessionId,
            timestamp: new Date()
          });
        }

        // Add the new message with messageId
        const messageDoc = {
          content: message,
          sender: 'user',
          messageId, // Store client-generated message ID for tracking
          timestamp: new Date(timestamp),
          encrypted: encryptionEnabled // Track if message was encrypted
        };

        // Add user name to message if available in data or metadata
        if (data.userName) {
          messageDoc.userName = data.userName;
        } else if (conversation.metadata && conversation.metadata.get('name')) {
          messageDoc.userName = conversation.metadata.get('name');
        }

        conversation.messages.push(messageDoc);

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();
        // Get the database ID of the newly added message
        let dbMessageId = 'temp-id';
        if (conversation.messages &&
            conversation.messages.length > 0 &&
            conversation.messages[conversation.messages.length - 1]._id) {
          dbMessageId = conversation.messages[conversation.messages.length - 1]._id.toString();
        }

        // Broadcast to operators (admin dashboard)
        const broadcastData = {
          sessionId,
          message,
          sender: 'user',
          messageId: dbMessageId,
          clientMessageId: messageId,
          timestamp: new Date()
        };

        // Add user name to broadcast if available
        if (messageDoc.userName) {
          broadcastData.userName = messageDoc.userName;
        }

        toOperators(clientCompanyId, 'new-message', broadcastData);

        usageService.record(clientCompanyId, { messages: 1 });

        // Only generate suggestions if there are operators and suggestions are enabled
        if (conversation.hasOperator) {
          // Check if suggestions are enabled for this conversation
          if (conversation.suggestionsEnabled !== false) {
            // Process with AI to get operator suggestion
            const aiService = await AIService.forCompany(clientCompanyId);

            // Get conversation history for context
            const messageHistory = conversation.messages
              .slice(-10) // Last 10 messages for context
              .map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.content
              }));

            // Get AI suggestion for operator
            const suggestion = await aiService.generateOperatorSuggestion(message, messageHistory);

            // Import the Suggestion model
            const Suggestion = require('./models/suggestion');

            // Save suggestion to database
            const newSuggestion = new Suggestion({
              conversationId: conversation._id,
              sessionId,
              userMessageId: dbMessageId,
              userMessage: message,
              content: suggestion,
              createdAt: new Date()
            });

            await newSuggestion.save();

            // Send suggestion to operators
            toOperators(clientCompanyId, 'operator-suggestion', {
              sessionId,
              userMessageId: dbMessageId,
              userMessage: message,
              suggestion,
              suggestionId: newSuggestion._id.toString(),
              timestamp: new Date()
            });
          }
        } else if (conversation.botEnabled !== false) {
          // No operator connected and bot enabled, generate an AI response for the user
          const aiService = await AIService.forCompany(clientCompanyId);
          const messageHistory = conversation.messages
            .slice(-10)
            .map(msg => ({
              role: msg.sender === 'user' ? 'user' : 'assistant',
              content: msg.content
            }));

          const botResponse = await aiService.generateResponse(message, messageHistory);

          // Create a message ID for the bot response
          const botMessageId = 'bot_' + Date.now();

          // Save bot response
          const botMessageDoc = {
            content: botResponse,
            sender: 'bot',
            messageId: botMessageId,
            timestamp: new Date(),
            encrypted: encryptionEnabled
          };

          conversation.messages.push(botMessageDoc);
          conversation.lastActivity = new Date();
          await conversation.save();

          // Get the database ID of the bot message
          let dbBotMessageId = 'temp-bot-id';
          if (conversation.messages &&
              conversation.messages.length > 0 &&
              conversation.messages[conversation.messages.length - 1]._id) {
            dbBotMessageId = conversation.messages[conversation.messages.length - 1]._id.toString();
          }

          const responseData = {
            id: dbBotMessageId,
            clientId: botMessageId,
            timestamp: new Date()
          };

          if (encryptionEnabled && encryptionService.hasClientPublicKey(sessionId)) {
            const encrypted = encryptionService.encryptForClient(sessionId, botResponse);
            if (encrypted) {
              responseData.encrypted = true;
              responseData.encryptedMessage = encrypted.encryptedMessage;
              responseData.nonce = encrypted.nonce;
            } else {
              responseData.text = botResponse;
            }
          } else {
            responseData.text = botResponse;
          }

          socket.emit('bot-message', responseData);

          usageService.record(clientCompanyId, { aiResponses: 1, messages: 1 });

          toOperators(clientCompanyId, 'new-message', {
            sessionId,
            message: botResponse,
            sender: 'bot',
            messageId: dbBotMessageId,
            timestamp: new Date()
          });
        }

        // Send read receipt for the user message
        socket.emit('message-read', {
          messageId,
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error handling message:', { error });
        socket.emit('error', { message: 'Failed to process message' });
      }
    });// Handle file uploads
    socket.on('file-uploaded', async (data) => {
      const { sessionId, fileId, fileName, timestamp } = data;

      try {
        const conversation = await getOrCreateConversation(sessionId, data);

        // POST /api/upload already recorded the message. This event is the
        // widget telling us the upload finished, so only append when the
        // message is missing - otherwise every attachment appears twice.
        const alreadyRecorded = fileId &&
          conversation.messages.some(message => message.fileId === fileId);

        if (!alreadyRecorded) {
          conversation.messages.push({
            content: `[File uploaded: ${fileName}]`,
            sender: 'user',
            fileId,
            fileName,
            timestamp: timestamp ? new Date(timestamp) : new Date()
          });
        }

        conversation.lastActivity = new Date();
        await conversation.save();

        // Tell the operators, so an attachment shows up in their queue.
        // The previous handler instead waited two seconds and sent a canned
        // "I've received your file" from the bot, which was a placeholder for
        // file analysis that does not exist - and it fired even when a human
        // operator was already handling the conversation.
        toOperators(clientCompanyId, 'new-message', {
          sessionId,
          message: `[File uploaded: ${fileName}]`,
          sender: 'user',
          timestamp: new Date(),
          fileInfo: { fileName, fileId, url: `/api/upload/${fileId}` }
        });

        socket.emit('message-read', { messageId: fileId, timestamp: new Date() });
      } catch (error) {
        logger.error('Error handling file upload:', { error });
      }
    });

    // Handle typing indicators from users
    socket.on('user-typing', (data) => {
      const { sessionId, isTyping } = data;

      // Broadcast typing status to operators
      toOperators(clientCompanyId, 'user-typing', {
        sessionId,
        isTyping,
        timestamp: new Date()
      });
    });

    // Handle typing indicators from operators
    socket.on('operator-typing', (data) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, isTyping } = data;

      // Broadcast typing status to users in the session
      io.to(sessionId).emit('operator-typing', {
        isTyping,
        timestamp: new Date()
      });
    });

    // Handle message read receipts
    socket.on('message-read', (data) => {
      const { sessionId, messageId, timestamp } = data;

      // Broadcast read receipt to operators
      toOperators(clientCompanyId, 'message-read', {
        sessionId,
        messageId,
        timestamp: new Date(timestamp)
      });
    });

    // Handle marking all messages as read
    socket.on('mark-all-read', (data) => {
      const { sessionId } = data;

      // Broadcast to operators
      toOperators(clientCompanyId, 'all-messages-read', {
        sessionId,
        timestamp: new Date()
      });
    });

    // Handle operator joining monitoring room
    socket.on('join-operator-room', () => {
      if (!isOperator) {
        return;
      }
      if (isSuperadmin) {
        socket.join(GLOBAL_OPERATOR_ROOM);
      } else {
        socket.join(operatorRoom(operatorCompanyId));
      }
      logger.info('Operator joined monitoring room', {
        role: socket.user.role,
        company: operatorCompanyId
      });
    });

    // Handle operator taking over chat
    socket.on('operator-takeover', async (data) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, operatorName } = data;

      if (!(await canOperateOn(sessionId))) {
        logger.warn('Operator takeover denied', { sessionId, operator: socket.user.username });
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      // Join the session room to receive real-time updates
      socket.join(sessionId);
      logger.info(`Operator joined session room: ${sessionId}`);

      // Notify user that operator has joined
      io.to(sessionId).emit('operator-message', {
        text: `${operatorName} has joined the conversation and will assist you.`,
        senderName: operatorName,
        timestamp: new Date()
      });

      // Notify all operators that an operator has joined this chat
      allOperators(operatorCompanyId, 'operator-joined', {
        sessionId,
        operatorId: socket.user.id,
        operatorName,
        timestamp: new Date()
      });

      // Update conversation status in database
      try {
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              hasOperator: true,
              operatorId: socket.user.id,
              operatorName
            }
          },
          { new: true }
        );

        // Generate suggestions for the operator if there are messages
        if (conversation && conversation.messages.length > 0) {
          // Get the last user message
          const lastUserMessage = [...conversation.messages]
            .reverse()
            .find(msg => msg.sender === 'user');

          if (lastUserMessage) {
            // Get message history for context (last 5 messages)
            const messageHistory = conversation.messages
              .slice(-5)
              .map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.content
              }));

            // Generate suggestions
            const suggestionService = await AIService.forCompany(clientCompanyId);
            const suggestion = await suggestionService.generateOperatorSuggestion(
              lastUserMessage.content,
              messageHistory
            );

            // Import the Suggestion model
            const Suggestion = require('./models/suggestion');

            // Save suggestion to database
            const newSuggestion = new Suggestion({
              conversationId: conversation._id,
              sessionId,
              userMessageId: lastUserMessage._id,
              userMessage: lastUserMessage.content,
              content: suggestion,
              createdAt: new Date()
            });

            await newSuggestion.save();

            // Send suggestion to the operator
            socket.emit('operator-suggestion', {
              sessionId,
              userMessageId: lastUserMessage._id.toString(),
              userMessage: lastUserMessage.content,
              suggestion,
              suggestionId: newSuggestion._id.toString(),
              timestamp: new Date()
            });
          }
        }
      } catch (error) {
        logger.error('Error updating conversation:', { error });
      }
    });

    // Handle operator message
    // Operator replies are metered separately from bot replies: they are what
    // a "human hours" style plan would price on.
    socket.on('operator-message', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId, message } = data;

      try {
        // Save to database
        const conversation = await Conversation.findOne({ sessionId });
        if (conversation) {
          const operatorName = socket.user.displayName || socket.user.username;

          // An email thread is answered from the same composer; only delivery
          // differs. Sent before persisting so a failure can be reported to
          // the operator rather than leaving a message that never went out.
          let delivery = { sent: true };

          if (conversation.channel === 'email') {
            delivery = await emailChannel.sendReply(conversation, message, operatorName);

            if (!delivery.sent) {
              socket.emit('error', {
                message: `Could not send that email: ${delivery.reason}`
              });
              return;
            }
          }

          conversation.messages.push({
            content: message,
            sender: 'operator',
            operatorId: socket.user.id,
            operatorName,
            emailMessageId: delivery.messageId,
            timestamp: new Date()
          });

          conversation.lastActivity = new Date();
          await conversation.save();

          usageService.record(conversation.company, { operatorMessages: 1, messages: 1 });

          // Chat visitors get it over the socket. Email visitors already have
          // it in their inbox.
          if (conversation.channel !== 'email') {
            io.to(sessionId).emit('operator-message', {
              text: message,
              senderName: operatorName,
              timestamp: new Date()
            });
          }
        }
      } catch (error) {
        logger.error('Error handling operator message:', { error });
      }
    });

    // Add a new handler for when an operator requests suggestions
    socket.on('request-suggestions', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId, messageId } = data;

      try {
        // Find the conversation
        const conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          return;
        }

        // Find the specific message if messageId is provided, otherwise use the last user message
        let targetMessage;
        if (messageId) {
          targetMessage = conversation.messages.find(
            msg => msg._id.toString() === messageId && msg.sender === 'user'
          );
        } else {
          targetMessage = [...conversation.messages]
            .reverse()
            .find(msg => msg.sender === 'user');
        }

        if (!targetMessage) {
          return;
        }

        // Get message history for context (last 5 messages)
        const messageHistory = conversation.messages
          .slice(-5)
          .map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: msg.content
          }));

        // Generate suggestions
        const suggestionService = await AIService.forCompany(operatorCompanyId);
        const suggestion = await suggestionService.generateOperatorSuggestion(
          targetMessage.content,
          messageHistory
        );

        // Import the Suggestion model
        const Suggestion = require('./models/suggestion');

        // Save suggestion to database
        const newSuggestion = new Suggestion({
          conversationId: conversation._id,
          sessionId,
          userMessageId: targetMessage._id,
          userMessage: targetMessage.content,
          content: suggestion,
          createdAt: new Date()
        });

        await newSuggestion.save();

        // Send suggestion to the operator
        socket.emit('operator-suggestion', {
          sessionId,
          userMessageId: targetMessage._id.toString(),
          userMessage: targetMessage.content,
          suggestion,
          suggestionId: newSuggestion._id.toString(),
          timestamp: new Date()
        });
      } catch (error) {
        logger.error('Error generating suggestions:', { error });
      }
    });

    // Handle operator using a suggestion
    socket.on('use-suggestion', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId, suggestionId, edited } = data;

      try {
        // Import the Suggestion model
        const Suggestion = require('./models/suggestion');

        // Find the suggestion
        const suggestion = await Suggestion.findById(suggestionId);

        if (!suggestion) {
          socket.emit('error', { message: 'Suggestion not found' });
          return;
        }

        // Get the content to use (either edited or original)
        const messageContent = edited || suggestion.content;

        // Save to database
        const conversation = await Conversation.findOne({ sessionId });
        if (conversation) {
          // Create the message
          const messageDoc = {
            content: messageContent,
            sender: 'operator',
            operatorId: socket.user.id,
            operatorName: socket.user.displayName || socket.user.username,
            timestamp: new Date()
          };

          conversation.messages.push(messageDoc);
          conversation.lastActivity = new Date();
          await conversation.save();

          // Get the database ID of the newly added message
          let dbMessageId = 'temp-id';
          if (conversation.messages &&
              conversation.messages.length > 0 &&
              conversation.messages[conversation.messages.length - 1]._id) {
            dbMessageId = conversation.messages[conversation.messages.length - 1]._id.toString();
          }

          // Update the suggestion to mark it as used
          suggestion.used = true;
          suggestion.usedAt = new Date();
          suggestion.editedContent = edited;
          suggestion.resultingMessageId = dbMessageId;
          await suggestion.save();

          // Send to user
          io.to(sessionId).emit('operator-message', {
            text: messageContent,
            senderName: socket.user.displayName || socket.user.username,
            timestamp: new Date()
          });

          // Notify all operators that the suggestion was used
          allOperators(operatorCompanyId, 'suggestion-used', {
            sessionId,
            suggestionId,
            operatorId: socket.user.id,
            operatorName: socket.user.displayName || socket.user.username,
            wasEdited: !!edited,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error handling suggestion use:', { error });
        socket.emit('error', { message: 'Failed to use suggestion' });
      }
    });

    // Operator requests the user to provide contact details
    socket.on('request-user-details', (data) => {
      if (!isOperator) {
        return;
      }
      const { sessionId } = data;
      io.to(sessionId).emit('request-user-details');
    });

    // Handle toggling suggestions for a chat
    socket.on('toggle-suggestions', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId, enabled } = data;

      try {
        // Update conversation in database
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          { $set: { suggestionsEnabled: enabled } },
          { new: true }
        );

        if (conversation) {
          // Notify all operators about the change
          allOperators(operatorCompanyId, 'suggestions-status-changed', {
            sessionId,
            enabled,
            timestamp: new Date()
          });

          // Send confirmation to the requesting operator
          socket.emit('suggestions-toggled', {
            sessionId,
            enabled,
            success: true,
            timestamp: new Date()
          });
        } else {
          socket.emit('suggestions-toggled', {
            sessionId,
            success: false,
            error: 'Conversation not found',
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error toggling suggestions:', { error });
        socket.emit('suggestions-toggled', {
          sessionId,
          success: false,
          error: 'Failed to toggle suggestions',
          timestamp: new Date()
        });
      }
    });

    // Handle operator leaving a chat without ending it
    socket.on('operator-leave', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId, passToBot } = data;

      try {
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              hasOperator: false,
              operatorId: null,
              operatorName: null,
              botEnabled: passToBot !== false
            }
          },
          { new: true }
        );

        if (conversation) {
          const opName = socket.user.displayName || socket.user.username;
          io.to(sessionId).emit('operator-message', {
            text: passToBot
              ? `${opName} has left the conversation. The chatbot will assist you.`
              : `${opName} has left the conversation. Please wait for the next available operator.`,
            senderName: opName,
            timestamp: new Date()
          });

          allOperators(operatorCompanyId, 'operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: operatorDisplayName,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error handling operator leave:', { error });
      }
    });

    // Handle end chat
    socket.on('end-chat', async (data) => {
      if (!isOperator) {
        return;
      }

      // Tenant guard: never let an operator act on another company's chat.
      if (!(await canOperateOn(data && data.sessionId))) {
        return socket.emit('error', { message: 'You do not have access to this conversation' });
      }

      const { sessionId } = data;

      try {
        // Update conversation status in database
        const conversation = await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              status: 'ended',
              endedAt: new Date(),
              hasOperator: false,
              operatorId: null,
              operatorName: null
            }
          },
          { new: true }
        );

        if (conversation) {
          // Notify user that chat has ended
          io.to(sessionId).emit('chat-ended', {
            message: 'This conversation has been ended by the operator.',
            timestamp: new Date()
          });

          // Notify all operators that this chat has ended
          allOperators(operatorCompanyId, 'chat-ended', {
            sessionId,
            timestamp: new Date()
          });

          // Notify all operators that the operator has left this chat
          allOperators(operatorCompanyId, 'operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: operatorDisplayName,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error ending chat:', { error });
      }
    });    // Handle heartbeat to keep connection alive
    socket.on('heartbeat', (data) => {
      // Respond with an acknowledgment
      socket.emit('heartbeat-ack', {
        timestamp: new Date().toISOString(),
        received: data.timestamp
      });

      // If this is an operator, make sure they're still in the operators room
      if (isOperator) {
        const room = isSuperadmin ? GLOBAL_OPERATOR_ROOM : operatorRoom(operatorCompanyId);
        if (!socket.rooms.has(room)) {
          socket.join(room);
          logger.info('Operator rejoined monitoring room during heartbeat');
        }
      }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
      logger.info('Client disconnected');

      // Clean up encryption keys when client disconnects
      if (clientSessionId) {
        encryptionService.removeClientPublicKey(clientSessionId);
      }

      // If it was a user (not an operator), notify operators
      if (!isOperator && clientSessionId) {
        toOperators(clientCompanyId, 'chat-activity', {
          type: 'closed',
          sessionId: clientSessionId,
          timestamp: new Date()
        });
      }

      // If it was an operator, keep the chat assignment intact so
      // refreshing the page doesn't remove them from the conversation.
      if (isOperator) {
        logger.info('Operator disconnected, assignments preserved');
      }
    });
  });

  return io;
}

module.exports = setupWebSockets;
