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
    });    // Handle user messages from widget
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

        // Add the new message with messageId
        const messageDoc = {
          content: message,
          sender: 'user',
          messageId, // Store client-generated message ID for tracking
          timestamp: new Date(timestamp),
          encrypted: encryptionEnabled // Track if message was encrypted
        };

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
        socket.to('operators').emit('new-message', {
          sessionId,
          message,
          sender: 'user',
          messageId: dbMessageId,
          clientMessageId: messageId,
          timestamp: new Date()
        });

        // Show typing indicator to user
        socket.emit('bot-typing');

        // Process with AI and get response
        const aiService = new AIService();

        // Get conversation history for context
        const messageHistory = conversation.messages
          .slice(-10) // Last 10 messages for context
          .map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: msg.content
          }));

        // Get AI response
        const botResponse = await aiService.generateResponse(message, messageHistory);
        // Add slight delay to simulate typing
        setTimeout(() => {
          // Create a message ID for the bot response
          const botMessageId = 'bot_' + Date.now();

          // Save bot response
          const botMessageDoc = {
            content: botResponse,
            sender: 'bot',
            messageId: botMessageId,
            timestamp: new Date(),
            encrypted: encryptionEnabled // Track if message was encrypted
          };

          conversation.messages.push(botMessageDoc);
          conversation.save();
          // Get the database ID of the bot message
          let dbBotMessageId = 'temp-bot-id';
          if (conversation.messages &&
              conversation.messages.length > 0 &&
              conversation.messages[conversation.messages.length - 1]._id) {
            dbBotMessageId = conversation.messages[conversation.messages.length - 1]._id.toString();
          }

          // Prepare response data
          const responseData = {
            id: dbBotMessageId,
            clientId: botMessageId,
            timestamp: new Date()
          };

          // Encrypt the message if encryption is enabled
          if (encryptionEnabled && encryptionService.hasClientPublicKey(sessionId)) {
            const encrypted = encryptionService.encryptForClient(sessionId, botResponse);

            if (encrypted) {
              responseData.encrypted = true;
              responseData.encryptedMessage = encrypted.encryptedMessage;
              responseData.nonce = encrypted.nonce;
            } else {
              // Fallback to unencrypted if encryption fails
              responseData.text = botResponse;
              logger.error('Encryption failed, sending unencrypted message');
            }
          } else {
            responseData.text = botResponse;
          }

          // Send bot response to client
          socket.emit('bot-message', responseData);

          // Send to operators monitoring the chat (always unencrypted for operators)
          socket.to('operators').emit('new-message', {
            sessionId,
            message: botResponse,
            sender: 'bot',
            messageId: dbBotMessageId,
            timestamp: new Date()
          });

          // Send read receipt for the user message
          socket.emit('message-read', {
            messageId,
            timestamp: new Date()
          });
        }, 1500);
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
        await Conversation.findOneAndUpdate(
          { sessionId },
          {
            $set: {
              hasOperator: true,
              operatorId: socket.user.id,
              operatorName
            }
          }
        );
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
            operatorName: socket.user.username,
            timestamp: new Date()
          });

          conversation.lastActivity = new Date();
          await conversation.save();

          // Send to user
          io.to(sessionId).emit('operator-message', {
            text: message,
            senderName: socket.user.username,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error('Error handling operator message:', { error });
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

          // For each conversation, update the status and notify other operators
          for (const conversation of conversations) {
            // Notify all operators that this operator has left the chat
            io.to('operators').emit('operator-left', {
              sessionId: conversation.sessionId,
              operatorId: socket.user.id,
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
