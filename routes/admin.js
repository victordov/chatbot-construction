const express = require('express');
const Conversation = require('../models/conversation');
const ColumnConfig = require('../models/columnConfig');
const { auth, operator } = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);
router.use(operator);

// Get active conversations
router.get('/active-chats', async (req, res) => {
  try {
    const activeChatsSummary = await Conversation.find(
      { status: 'active' },
      { sessionId: 1, startedAt: 1, domain: 1, 'messages.length': { $size: '$messages' } }
    ).sort({ lastActivity: -1 });

    res.json({ chats: activeChatsSummary });
  } catch (error) {
    console.error('Error fetching active chats:', error);
    res.status(500).json({ error: 'Failed to retrieve active chats' });
  }
});

// Get chat history
router.get('/chat-history', async (req, res) => {
  try {
    const chatHistory = await Conversation.find(
      {},
      { sessionId: 1, startedAt: 1, endedAt: 1, status: 1, domain: 1, 'messages.length': { $size: '$messages' } }
    ).sort({ startedAt: -1 }).limit(100);

    res.json({ history: chatHistory });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

// Get specific chat
router.get('/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to retrieve chat' });
  }
});

// Delete chat
router.delete('/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await Conversation.deleteOne({ sessionId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// End chat
router.post('/chat/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    conversation.status = 'ended';
    conversation.endedAt = new Date();
    await conversation.save();

    res.json({ success: true, message: 'Chat ended successfully' });
  } catch (error) {
    console.error('Error ending chat:', error);
    res.status(500).json({ error: 'Failed to end chat' });
  }
});

// Get analytics data
router.get('/analytics', async (req, res) => {
  try {
    // Get total chats today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalChatsToday = await Conversation.countDocuments({
      startedAt: { $gte: today }
    });

    // Get active chats
    const activeChats = await Conversation.countDocuments({
      status: 'active'
    });

    // Get chat volume per day for the last 7 days
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const chatVolumePerDay = await Conversation.aggregate([
      {
        $match: {
          startedAt: { $gte: last7Days }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$startedAt' },
            month: { $month: '$startedAt' },
            day: { $dayOfMonth: '$startedAt' }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1,
          '_id.day': 1
        }
      }
    ]);

    // Get average response time
    // In a real app, you would calculate this based on message timestamps
    const avgResponseTime = 5; // Placeholder

    res.json({
      totalChatsToday,
      activeChats,
      chatVolumePerDay,
      avgResponseTime
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});

// Get column configuration
router.get('/column-config/:type', async (req, res) => {
  try {
    const { type } = req.params;

    // Find existing config or create default
    let config = await ColumnConfig.findOne({ type });

    if (!config) {
      // Create default configuration based on pdfGenerator defaults
      const defaultColumns = [
        { key: 'address', label: 'Address', enabled: true, order: 0 },
        { key: 'size', label: 'Size (sq ft)', enabled: true, order: 1 },
        { key: 'rooms', label: 'Rooms', enabled: true, order: 2 },
        { key: 'price', label: 'Price', enabled: true, order: 3 },
        { key: 'details', label: 'Details', enabled: true, order: 4 }
      ];

      config = new ColumnConfig({
        type,
        columns: defaultColumns,
        createdBy: req.user.id,
        updatedBy: req.user.id
      });

      await config.save();
    }

    res.json(config);
  } catch (error) {
    console.error('Error fetching column configuration:', error);
    res.status(500).json({ error: 'Failed to retrieve column configuration' });
  }
});

// Update column configuration
router.post('/column-config/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { columns } = req.body;

    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Invalid columns data' });
    }

    // Find existing config or create new one
    let config = await ColumnConfig.findOne({ type });

    if (config) {
      // Update existing config
      config.columns = columns;
      config.updatedBy = req.user.id;
    } else {
      // Create new config
      config = new ColumnConfig({
        type,
        columns,
        createdBy: req.user.id,
        updatedBy: req.user.id
      });
    }

    await config.save();

    res.json({ success: true, config });
  } catch (error) {
    console.error('Error updating column configuration:', error);
    res.status(500).json({ error: 'Failed to update column configuration' });
  }
});

module.exports = router;
