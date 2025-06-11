const express = require('express');
const Conversation = require('../models/conversation');
const socketManager = require('../socketManager');
const { logger } = require('../services/logging');

const router = express.Router();

// Get chat history for the current session
router.get('/history', async (req, res) => {
  try {
    if (!req.session || !req.session.sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }

    const conversation = await Conversation.findOne({ sessionId: req.session.sessionId });

    if (!conversation) {
      return res.json({ messages: [] });
    }

    res.json({ messages: conversation.messages });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

// Send a message (this will be processed by WebSockets, but we also provide a REST endpoint)
router.post('/message', async (req, res) => {
  try {
    if (!req.session || !req.session.sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }
    logger.info('sending message back to the client: ' + req.body.message);
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    let conversation = await Conversation.findOne({ sessionId: req.session.sessionId });

    if (!conversation) {
      conversation = new Conversation({
        sessionId: req.session.sessionId,
        domain: req.get('Origin') || req.get('Referer') || 'unknown',
        messages: []
      });
    }

    // Add user message
    conversation.messages.push({
      content: message,
      sender: 'user'
    });

    // Update last activity
    conversation.lastActivity = new Date();

    await conversation.save();

    // For now, simple echo response (will be replaced with AI integration)
    const botResponse = `Echo: ${message}`;

    // Add bot response
    conversation.messages.push({
      content: botResponse,
      sender: 'bot'
    });

    await conversation.save();

    // Get the io instance from socketManager
    const io = socketManager.getIo();

    // Emit the bot response through websocket
    io.to(req.session.sessionId).emit('bot-message', {
      text: botResponse,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: {
        content: botResponse,
        sender: 'bot',
        timestamp: new Date()
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process message' });
  }
});

module.exports = router;
