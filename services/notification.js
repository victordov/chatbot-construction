/**
 * Service for notification management
 */

const Notification = require('../models/notification');
const Task = require('../models/task');
const User = require('../models/user');
const { logger } = require('./logging');

class NotificationService {
  /**
   * Get notifications for a user
   * @param {string} userId - The user ID
   * @param {Object} filters - Optional filters
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

      // Get notifications
      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .populate('taskId', 'title dueDate status')
        .lean();

      return notifications;
    } catch (error) {
      logger.error('Error getting notifications', { error });
      throw error;
    }
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

module.exports = NotificationService;
