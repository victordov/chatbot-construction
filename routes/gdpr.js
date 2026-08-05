const express = require('express');
const Conversation = require('../models/conversation');
const { auth, admin } = require('../middleware/auth');
const { logger } = require('../services/logging');
const { companyFilter } = require('../utils/query');

const router = express.Router();

/**
 * Data-subject requests are handled by staff on behalf of end users, so these
 * routes require admin privileges and are scoped to the caller's tenant.
 * (The previous check compared against a non-existent 'admin' role and an
 * ObjectId, so it rejected every request including legitimate ones.)
 */
function subjectQuery(req) {
  return { userId: req.params.userId, ...companyFilter(req.user) };
}

// Get user data
router.get('/user-data/:userId', auth, admin, async (req, res) => {
  try {
    const conversations = await Conversation.find(subjectQuery(req)).lean();

    res.json({ conversations });
  } catch (error) {
    logger.error('Error retrieving user data', { error });
    res.status(500).json({ error: 'Failed to retrieve user data' });
  }
});

// Delete user data (GDPR right to be forgotten)
router.delete('/user-data/:userId', auth, admin, async (req, res) => {
  try {
    const result = await Conversation.deleteMany(subjectQuery(req));

    logger.info('GDPR erasure performed', {
      subject: req.params.userId,
      deletedCount: result.deletedCount,
      by: req.user.username
    });

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} conversations`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    logger.error('Error deleting user data', { error });
    res.status(500).json({ error: 'Failed to delete user data' });
  }
});

// Export user data (GDPR right to data portability)
router.get('/export/:userId', auth, admin, async (req, res) => {
  try {
    const { userId } = req.params;
    const conversations = await Conversation.find(subjectQuery(req)).lean();

    const exportData = {
      userId,
      exportDate: new Date(),
      conversations: conversations.map(conv => ({
        sessionId: conv.sessionId,
        startedAt: conv.startedAt,
        endedAt: conv.endedAt,
        status: conv.status,
        messages: (conv.messages || []).map(msg => ({
          content: msg.content,
          sender: msg.sender,
          timestamp: msg.timestamp
        }))
      }))
    };

    // Sanitise the id before putting it in a header to avoid response splitting.
    const safeId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="user-data-${safeId}.json"`);

    res.json(exportData);
  } catch (error) {
    logger.error('Error exporting user data', { error });
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// Get privacy policy
router.get('/privacy-policy', (req, res) => {
  res.sendFile('privacy-policy.html', { root: './public' });
});

// Update consent preferences for the current chat session
router.post('/consent', async (req, res) => {
  try {
    const { marketing = false, analytics = false, storage = false } = req.body;

    if (!req.session) {
      return res.status(400).json({ error: 'No active session' });
    }

    const preferences = {
      marketing: Boolean(marketing),
      analytics: Boolean(analytics),
      storage: Boolean(storage),
      recordedAt: new Date()
    };

    // Persist on the session so the widget and server agree on what the visitor
    // agreed to, and mirror it onto the conversation for audit purposes.
    req.session.consent = preferences;

    if (req.session.sessionId) {
      await Conversation.updateOne(
        { sessionId: req.session.sessionId },
        { $set: { 'metadata.consent': JSON.stringify(preferences) } }
      );
    }

    res.json({
      success: true,
      message: 'Consent preferences updated',
      preferences
    });
  } catch (error) {
    logger.error('Error updating consent preferences', { error });
    res.status(500).json({ error: 'Failed to update consent preferences' });
  }
});

module.exports = router;
