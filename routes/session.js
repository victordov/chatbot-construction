const express = require('express');
const Conversation = require('../models/conversation');

const router = express.Router();

// Get user's current session
router.get('/session', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.session.sessionId });
    if (conversation) {
      return res.json({ sessionId: req.session.sessionId, conversation });
    }
    return res.json({ sessionId: req.session.sessionId, conversation: null });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// Add root GET / route for session info (for widget compatibility)
router.get('/', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.session.sessionId });
    if (conversation) {
      return res.json({ sessionId: req.session.sessionId, conversation });
    }
    return res.json({ sessionId: req.session.sessionId, conversation: null });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// End the current session
router.post('/session/end', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.session.sessionId });
    if (conversation) {
      conversation.status = 'ended';
      conversation.endedAt = new Date();
      await conversation.save();
    }
    req.session.destroy();
    res.json({ success: true, message: 'Session ended' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to end session' });
  }
});

module.exports = router;
