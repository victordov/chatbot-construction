const express = require('express');
const Conversation = require('../models/conversation');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get user data - requires authentication
router.get('/user-data/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Validate that the requesting user can access this data
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all conversations for this user
    const conversations = await Conversation.find({ userId });

    res.json({ conversations });
  } catch (error) {
    console.error('Error retrieving user data:', error);
    res.status(500).json({ error: 'Failed to retrieve user data' });
  }
});

// Delete user data (GDPR right to be forgotten)
router.delete('/user-data/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Validate that the requesting user can delete this data
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete all conversations for this user
    const result = await Conversation.deleteMany({ userId });

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} conversations`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting user data:', error);
    res.status(500).json({ error: 'Failed to delete user data' });
  }
});

// Export user data (GDPR right to data portability)
router.get('/export/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Validate that the requesting user can access this data
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all conversations for this user
    const conversations = await Conversation.find({ userId });

    // Format the data for export
    const exportData = {
      userId,
      exportDate: new Date(),
      conversations: conversations.map(conv => ({
        sessionId: conv.sessionId,
        startedAt: conv.startedAt,
        endedAt: conv.endedAt,
        status: conv.status,
        messages: conv.messages.map(msg => ({
          content: msg.content,
          sender: msg.sender,
          timestamp: msg.timestamp
        }))
      }))
    };

    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=user-data-${userId}.json`);

    res.json(exportData);
  } catch (error) {
    console.error('Error exporting user data:', error);
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// Get privacy policy
router.get('/privacy-policy', (req, res) => {
  res.sendFile('privacy-policy.html', { root: './public' });
});

// Update consent preferences
router.post('/consent', auth, async (req, res) => {
  try {
    const { marketing, analytics, storage } = req.body;
    // eslint-disable-next-line no-unused-vars
    const userId = req.user.id;

    // In a real app, this would update the user's consent preferences in the database

    res.json({
      success: true,
      message: 'Consent preferences updated',
      preferences: {
        marketing,
        analytics,
        storage
      }
    });
  } catch (error) {
    console.error('Error updating consent preferences:', error);
    res.status(500).json({ error: 'Failed to update consent preferences' });
  }
});

module.exports = router;
