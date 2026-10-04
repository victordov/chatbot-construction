/**
 * API routes for notification management
 */

const express = require('express');
const router = express.Router();
const { auth, operator, admin } = require('../middleware/auth');
const NotificationService = require('../services/notification');
const socketManager = require('../socketManager');
const { logger } = require('../services/logging');

// Initialize service
const notificationService = new NotificationService();

// Get notifications for the current user
router.get('/', auth, operator, async (req, res) => {
  try {
    const filters = {};

    // Extract filter parameters from query
    if (req.query.read !== undefined) {
      filters.read = req.query.read === 'true';
    }

    if (req.query.type) {
      filters.type = req.query.type;
    }

    // Get notifications
    const notifications = await notificationService.getNotifications(req.user.id, filters);

    res.json({ notifications });
  } catch (error) {
    logger.error('Error getting notifications', { error });
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Mark a notification as read
router.put('/:id/read', auth, operator, async (req, res) => {
  try {
    const notification = await notificationService.markAsRead(req.params.id, req.user.id);

    // To the one person it belongs to, not to every socket on the platform.
    socketManager.emitToUser(req.user.id, 'notification-updated', { notification });

    res.json({ notification });
  } catch (error) {
    if (error.message === 'Notification not found') {
      return res.status(404).json({ error: 'Notification not found' });
    }

    logger.error(`Error marking notification ${req.params.id} as read`, { error });
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.put('/read-all', auth, operator, async (req, res) => {
  try {
    const result = await notificationService.markAllAsRead(req.user.id);

    socketManager.emitToUser(req.user.id, 'notifications-all-read', { userId: req.user.id });

    res.json({ success: true, message: 'All notifications marked as read', count: result.modifiedCount });
  } catch (error) {
    logger.error('Error marking all notifications as read', { error });
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// Delete a notification
router.delete('/:id', auth, operator, async (req, res) => {
  try {
    await notificationService.deleteNotification(req.params.id, req.user.id);

    socketManager.emitToUser(req.user.id, 'notification-deleted', {
      notificationId: req.params.id,
      userId: req.user.id
    });

    res.json({ success: true, message: 'Notification deleted successfully' });
  } catch (error) {
    if (error.message === 'Notification not found') {
      return res.status(404).json({ error: 'Notification not found' });
    }

    logger.error(`Error deleting notification ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Manually check for task deadlines and create notifications. The scheduler
// does this on its own timer; this is the "run it now" handle.
//
// The role check used to read `req.user.isAdmin`, which `middleware/auth.js`
// never sets - so the route answered 403 to everyone, including the superadmin
// it was meant for. The `admin` middleware is the guard the rest of the
// codebase uses for this.
router.post('/check-deadlines', auth, admin, async (req, res) => {
  try {
    const notifications = await notificationService.checkTaskDeadlines();

    // Each deadline notification belongs to whoever owns the task, and these
    // span every tenant - which is exactly why broadcasting them was so wrong.
    for (const notification of notifications) {
      socketManager.emitToUser(notification.userId, 'notification-created', { notification });
    }

    res.json({ success: true, message: 'Task deadlines checked', notificationsCreated: notifications.length });
  } catch (error) {
    logger.error('Error checking task deadlines', { error });
    res.status(500).json({ error: 'Failed to check task deadlines' });
  }
});

module.exports = router;