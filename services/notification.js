/**
 * Service for notification management
 */

const Notification = require('../models/notification');
const Task = require('../models/task');
const socketManager = require('../socketManager');
const push = require('./push');
const { logger } = require('./logging');

/** How many notifications the bell asks for at a time. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

class NotificationService {
  /**
   * Tell one member of staff about something, in the bell and live.
   *
   * The one way anything raises a notification for a person: it is stored, so
   * it is still there after a reload or for someone who was offline, and it is
   * pushed to that person's own room so an open dashboard shows it at once.
   * Deadline reminders used to be the only kind, and chat assignments and
   * transfers lived only as toasts that vanished if nobody was looking.
   *
   * Never throws. A notification is a courtesy on top of something that has
   * already happened - a transfer, an assignment - and failing to write it
   * must not undo or fail that.
   *
   * @param {string|object} userId the recipient
   * @param {object} details
   * @param {string} details.type one of the Notification model's types
   * @param {string} details.message what the bell shows
   * @param {string} [details.sessionId] the conversation it is about
   * @param {string} [details.taskId] the task it is about
   * @param {string} [details.link] where clicking it goes, e.g.
   *        `?section=active-chats&chat=<sessionId>`
   * @returns {Promise<object|null>} the stored notification, or null
   */
  static async notifyUser(userId, details = {}) {
    if (!userId || !details.type || !details.message) {
      return null;
    }

    try {
      const notification = await Notification.create({
        userId,
        type: details.type,
        message: String(details.message).slice(0, 500),
        taskId: details.taskId || undefined,
        sessionId: details.sessionId || undefined,
        link: details.link || NotificationService.defaultLink(details)
      });

      const payload = notification.toObject();
      socketManager.emitToUser(userId, 'notification-created', { notification: payload });
      // And to their phone, for the kinds worth one buzzing. Not awaited: a
      // push service must not hold up whatever raised this.
      push.notificationEvent(userId, payload);

      return payload;
    } catch (error) {
      logger.error('Could not create a notification', {
        type: details.type,
        error: error.message
      });
      return null;
    }
  }

  /** Where a notification about a conversation or a task should open. */
  static defaultLink(details = {}) {
    if (details.sessionId) {
      return `?section=active-chats&chat=${encodeURIComponent(details.sessionId)}`;
    }
    if (details.taskId) {
      return `?section=tasks&taskId=${encodeURIComponent(String(details.taskId))}`;
    }
    return undefined;
  }

  /** Instance form, for callers holding a service object. */
  notifyUser(userId, details) {
    return NotificationService.notifyUser(userId, details);
  }

  /**
   * Get notifications for a user, newest first, a page at a time.
   *
   * Paged by time rather than by offset: new notifications arrive at the top
   * while somebody is reading, and an offset would then repeat or skip rows
   * on "Load more".
   *
   * @param {string} userId - The user ID
   * @param {Object} filters - Optional filters: `read`, `type`, `limit`, and
   *        `before` (an ISO date; only older notifications are returned)
   * @returns {Promise<Array>} - Array of notifications
   */
  async getNotifications(userId, filters = {}) {
    try {
      const query = { userId };

      // Apply filters
      if (filters.read !== undefined) {
        query.read = filters.read;
      }

      if (filters.type) {
        query.type = filters.type;
      }

      if (filters.before) {
        const before = new Date(filters.before);
        if (!Number.isNaN(before.getTime())) {
          query.createdAt = { $lt: before };
        }
      }

      const limit = Math.min(
        Math.max(1, parseInt(filters.limit, 10) || DEFAULT_PAGE_SIZE),
        MAX_PAGE_SIZE
      );

      // Get notifications
      const notifications = await Notification.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .populate('taskId', 'title dueDate status')
        .lean();

      return notifications;
    } catch (error) {
      logger.error('Error getting notifications', { error });
      throw error;
    }
  }

  /** How many of a user's notifications are unread, for the bell's badge. */
  async unreadCount(userId) {
    return Notification.countDocuments({ userId, read: false });
  }

  /**
   * Mark a notification as read
   * @param {string} notificationId - The notification ID
   * @param {string} userId - The user ID
   * @returns {Promise<Object>} - The updated notification
   */
  async markAsRead(notificationId, userId) {
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { read: true },
        { new: true }
      );

      if (!notification) {
        throw new Error('Notification not found');
      }

      return notification;
    } catch (error) {
      logger.error(`Error marking notification ${notificationId} as read`, { error });
      throw error;
    }
  }

  /**
   * Mark all notifications as read for a user
   * @param {string} userId - The user ID
   * @returns {Promise<Object>} - Result of the operation
   */
  async markAllAsRead(userId) {
    try {
      const result = await Notification.updateMany(
        { userId, read: false },
        { read: true }
      );

      return result;
    } catch (error) {
      logger.error(`Error marking all notifications as read for user ${userId}`, { error });
      throw error;
    }
  }

  /**
   * Create a notification
   * @param {Object} notificationData - The notification data
   * @returns {Promise<Object>} - The created notification
   */
  async createNotification(notificationData) {
    try {
      const notification = new Notification(notificationData);
      await notification.save();
      return notification;
    } catch (error) {
      logger.error('Error creating notification', { error });
      throw error;
    }
  }

  /**
   * Delete a notification
   * @param {string} notificationId - The notification ID
   * @param {string} userId - The user ID
   * @returns {Promise<boolean>} - True if successful
   */
  async deleteNotification(notificationId, userId) {
    try {
      const result = await Notification.findOneAndDelete({
        _id: notificationId,
        userId
      });

      if (!result) {
        throw new Error('Notification not found');
      }

      return true;
    } catch (error) {
      logger.error(`Error deleting notification ${notificationId}`, { error });
      throw error;
    }
  }

  /**
   * Check for tasks that need notifications
   * @returns {Promise<Array>} - Array of created notifications
   */
  async checkTaskDeadlines() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      const endOfTomorrow = new Date(tomorrow);
      endOfTomorrow.setHours(23, 59, 59, 999);

      const today = new Date(now);
      today.setHours(0, 0, 0, 0);

      const endOfToday = new Date(today);
      endOfToday.setHours(23, 59, 59, 999);

      // Find tasks due tomorrow
      const tasksDueTomorrow = await Task.find({
        dueDate: { $gte: tomorrow, $lte: endOfTomorrow },
        status: { $ne: 'completed' }
      }).populate('assignee', 'username');

      // Find tasks due today
      const tasksDueToday = await Task.find({
        dueDate: { $gte: today, $lte: endOfToday },
        status: { $ne: 'completed' }
      }).populate('assignee', 'username');

      // Find overdue tasks
      const tasksOverdue = await Task.find({
        dueDate: { $lt: today },
        status: { $ne: 'completed' }
      }).populate('assignee', 'username');

      const notifications = [];

      // Create notifications for tasks due tomorrow
      for (const task of tasksDueTomorrow) {
        // Check if notification already exists
        const existingNotification = await Notification.findOne({
          taskId: task._id,
          type: 'task_due_tomorrow',
          createdAt: { $gte: today }
        });

        if (!existingNotification && task.assignee) {
          const notification = await this.createNotification({
            type: 'task_due_tomorrow',
            taskId: task._id,
            userId: task.assignee._id,
            message: `Task "${task.title}" is due tomorrow`
          });
          notifications.push(notification);
        }
      }

      // Create notifications for tasks due today
      for (const task of tasksDueToday) {
        // Check if notification already exists
        const existingNotification = await Notification.findOne({
          taskId: task._id,
          type: 'task_due_today',
          createdAt: { $gte: today }
        });

        if (!existingNotification && task.assignee) {
          const notification = await this.createNotification({
            type: 'task_due_today',
            taskId: task._id,
            userId: task.assignee._id,
            message: `Task "${task.title}" is due today`
          });
          notifications.push(notification);
        }
      }

      // Create notifications for overdue tasks
      for (const task of tasksOverdue) {
        // Check if notification already exists
        const existingNotification = await Notification.findOne({
          taskId: task._id,
          type: 'task_overdue',
          createdAt: { $gte: today }
        });

        if (!existingNotification && task.assignee) {
          const notification = await this.createNotification({
            type: 'task_overdue',
            taskId: task._id,
            userId: task.assignee._id,
            message: `Task "${task.title}" is overdue`
          });
          notifications.push(notification);
        }
      }

      return notifications;
    } catch (error) {
      logger.error('Error checking task deadlines', { error });
      throw error;
    }
  }
}

NotificationService.DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;

module.exports = NotificationService;
