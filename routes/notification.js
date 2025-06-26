/**
 * API routes for notification management
 */

const express = require('express');
const router = express.Router();
const { auth, operator } = require('../middleware/auth');
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

    // Emit WebSocket event for notification update
    try {
      const io = socketManager.getIo();
      io.emit('notification-updated', { notification });
    } catch (socketError) {
      logger.error('Error emitting notification-updated event', { error: socketError });
    }

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

    // Emit WebSocket event for notifications update
    try {
      const io = socketManager.getIo();
      io.emit('notifications-all-read', { userId: req.user.id });
    } catch (socketError) {
      logger.error('Error emitting notifications-all-read event', { error: socketError });
    }

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

    // Emit WebSocket event for notification deletion
    try {
      const io = socketManager.getIo();
      io.emit('notification-deleted', { notificationId: req.params.id, userId: req.user.id });
    } catch (socketError) {
      logger.error('Error emitting notification-deleted event', { error: socketError });
    }

    res.json({ success: true, message: 'Notification deleted successfully' });
  } catch (error) {
    if (error.message === 'Notification not found') {
      return res.status(404).json({ error: 'Notification not found' });
    }

    logger.error(`Error deleting notification ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Manually check for task deadlines and create notifications (for testing)
router.post('/check-deadlines', auth, operator, async (req, res) => {
  try {
    // Check if user is an admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to perform this action' });
    }

    const notifications = await notificationService.checkTaskDeadlines();

    // Emit WebSocket events for new notifications
    try {
      const io = socketManager.getIo();
      for (const notification of notifications) {
        io.emit('notification-created', { notification });
      }
    } catch (socketError) {
      logger.error('Error emitting notification-created events', { error: socketError });
    }

    res.json({ success: true, message: 'Task deadlines checked', notificationsCreated: notifications.length });
  } catch (error) {
    logger.error('Error checking task deadlines', { error });
    res.status(500).json({ error: 'Failed to check task deadlines' });
  }
});

module.exports = router;