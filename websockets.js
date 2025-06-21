const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('./models/conversation');
const User = require('./models/user');
const AIService = require('./services/ai');
const EncryptionService = require('./services/encryption');
const { logger } = require('./services/logging');

function setupWebSockets(server) {
  // Initialize encryption service
  const encryptionService = new EncryptionService();

  const io = socketIO(server, {
    cors: {
      origin: function (origin, callback) {
        // Use the same domain whitelist from the main Express app
        const allowedDomains = process.env.ALLOWED_DOMAINS
          ? process.env.ALLOWED_DOMAINS.split(',')
          : [
            'http://localhost:3000',
            'http://localhost:5500', // For local testing
            'http://127.0.0.1:5500' // For local testing
            // Add other allowed domains here
          ];

        if (!origin || allowedDomains.some(domain => origin.startsWith(domain))) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
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
      const user = await User.findById(decoded.id);
      if (!user || !user.isActive) {
        return next(new Error('Authentication failed'));
      }

      // Add user info to socket
      socket.user = {
        id: user._id,
        username: user.username,
        role: user.role
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
    const isOperator = socket.user && socket.user.role === 'admin';

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
    socket.on('join', (sessionId) => {
      clientSessionId = sessionId;
      socket.join(sessionId);
      logger.info(`Client joined room: ${sessionId}`);
      // Send confirmation that client joined the room
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
            messageData.fileUrl = `/api/download/${message.fileId}`;
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
    socket.on('chat-opened', (data) => {
      const { sessionId } = data;
      clientSessionId = sessionId;

      // Notify operators that a chat has been opened
      if (clientSessionId) {
        socket.to('operators').emit('chat-activity', {
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
        let conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          conversation = new Conversation({
            sessionId,
            messages: []
          });
        }

        // Initialize metadata if it doesn't exist
        if (!conversation.metadata) {
          conversation.metadata = new Map();
        }

        // Update metadata with user details
        conversation.metadata.set('name', name || '');
        conversation.metadata.set('email', email || '');
        conversation.metadata.set('phone', phone || '');

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();

        // Notify operators that user details have been updated
        socket.to('operators').emit('user-details-updated', {
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
        let conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          conversation = new Conversation({
            sessionId,
            messages: []
          });
        }

        // Check if the conversation was ended and reactivate it if needed
        if (conversation.status === 'ended') {
          conversation.status = 'active';
          conversation.endedAt = null;

          // Notify operators that this chat has been reactivated
          socket.to('operators').emit('chat-reactivated', {
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

        socket.to('operators').emit('new-message', broadcastData);

        // Only generate suggestions if there are operators and suggestions are enabled
        if (conversation.hasOperator) {
          // Check if suggestions are enabled for this conversation
          if (conversation.suggestionsEnabled !== false) {
            // Process with AI to get operator suggestion
            const aiService = new AIService();

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
            socket.to('operators').emit('operator-suggestion', {
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
          const aiService = new AIService();
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

          socket.to('operators').emit('new-message', {
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
        // Find conversation
        let conversation = await Conversation.findOne({ sessionId });

        if (!conversation) {
          conversation = new Conversation({
            sessionId,
            messages: []
          });
        }

        // Add file message
        conversation.messages.push({
          content: `[File uploaded: ${fileName}]`,
          sender: 'user',
          fileId,
          fileName,
          timestamp: new Date(timestamp)
        });

        // Update last activity
        conversation.lastActivity = new Date();

        await conversation.save();

        // Show typing indicator
        socket.emit('bot-typing');

        // Process file with AI (placeholder)
        setTimeout(() => {
          const response = `I've received your file "${fileName}". Let me know if you have any questions about it.`;

          // Save bot response
          conversation.messages.push({
            content: response,
            sender: 'bot',
            timestamp: new Date()
          });
          conversation.save();

          // Send bot response to client
          socket.emit('bot-message', {
            text: response,
            timestamp: new Date()
          });

          // Send to operators
          socket.to('operators').emit('new-message', {
            sessionId,
            message: response,
            sender: 'bot',
            timestamp: new Date(),
            fileInfo: { fileName, fileId }
          });
        }, 2000);
      } catch (error) {
        logger.error('Error handling file upload:', { error });
      }
    });    // Handle typing indicators from users
    socket.on('user-typing', (data) => {
      const { sessionId, isTyping } = data;

      // Broadcast typing status to operators
      socket.to('operators').emit('user-typing', {
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
      socket.to('operators').emit('message-read', {
        sessionId,
        messageId,
        timestamp: new Date(timestamp)
      });
    });

    // Handle marking all messages as read
    socket.on('mark-all-read', (data) => {
      const { sessionId } = data;

      // Broadcast to operators
      socket.to('operators').emit('all-messages-read', {
        sessionId,
        timestamp: new Date()
      });
    });

    // Handle operator joining monitoring room
    socket.on('join-operator-room', () => {
      if (isOperator) {
        socket.join('operators');
        logger.info('Operator joined monitoring room');
      }
    });

    // Handle operator taking over chat
    socket.on('operator-takeover', async (data) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, operatorName } = data;

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
      io.to('operators').emit('operator-joined', {
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
            const suggestionService = new AIService();
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
    socket.on('operator-message', async (data) => {
      if (!isOperator) {
        return;
      }

      const { sessionId, message } = data;

      try {
        // Save to database
        const conversation = await Conversation.findOne({ sessionId });
        if (conversation) {
          conversation.messages.push({
            content: message,
            sender: 'operator',
            operatorId: socket.user.id,
            operatorName: socket.user.displayName || socket.user.username,
            timestamp: new Date()
          });

          conversation.lastActivity = new Date();
          await conversation.save();

          // Send to user
          io.to(sessionId).emit('operator-message', {
            text: message,
            senderName: socket.user.displayName || socket.user.username,
            timestamp: new Date()
          });
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
        const suggestionService = new AIService();
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
          io.to('operators').emit('suggestion-used', {
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

    // Handle toggling suggestions for a chat
    socket.on('toggle-suggestions', async (data) => {
      if (!isOperator) {
        return;
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
          io.to('operators').emit('suggestions-status-changed', {
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

          io.to('operators').emit('operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: opName,
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
          io.to('operators').emit('chat-ended', {
            sessionId,
            timestamp: new Date()
          });

          // Notify all operators that the operator has left this chat
          io.to('operators').emit('operator-left', {
            sessionId,
            operatorId: socket.user.id,
            operatorName: opName,
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
        const rooms = Array.from(socket.rooms);
        if (!rooms.includes('operators')) {
          socket.join('operators');
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
        socket.to('operators').emit('chat-activity', {
          type: 'closed',
          sessionId: clientSessionId,
          timestamp: new Date()
        });
      }

      // If it was an operator, check if they were connected to any chats
      if (isOperator) {
        try {
          // Find all conversations where this operator was connected
          const conversations = await Conversation.find({
            operatorId: socket.user.id,
            hasOperator: true,
            status: 'active'
          });

          const opName = socket.user.displayName || socket.user.username;

          // For each conversation, update the status and notify other operators
          for (const conversation of conversations) {
            // Notify all operators that this operator has left the chat
            io.to('operators').emit('operator-left', {
              sessionId: conversation.sessionId,
              operatorId: socket.user.id,
              operatorName: opName,
              timestamp: new Date()
            });

            // Update the conversation in the database
            await Conversation.findOneAndUpdate(
              { _id: conversation._id },
              {
                $set: {
                  hasOperator: false,
                  operatorId: null,
                  operatorName: null
                }
              }
            );
          }
        } catch (error) {
          logger.error('Error handling operator disconnect:', { error });
        }
      }
    });
  });

  return io;
}

module.exports = setupWebSockets;
