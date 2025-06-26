/**
 * Activity service for handling task activity tracking
 */

const Activity = require('../models/activity');
const Task = require('../models/task');
const User = require('../models/user');
const { logger } = require('./logging');

class ActivityService {
  /**
   * Generic method to log an activity
   * @param {Object} activityData - Activity data containing userId, action, details, etc.
   */
  async logActivity(activityData) {
    try {
      await this.createActivity({
        taskId: activityData.taskId,
        type: activityData.action, // Map 'action' to 'type'
        user: activityData.userId,
        userName: activityData.userName,
        description: activityData.details,
        company: activityData.company || null, // Allow null for super admin users
        metadata: activityData.metadata || new Map(),
        changes: activityData.changes
      });
    } catch (error) {
      logger.error('Error logging activity', { error, activityData });
    }
  }

  /**
   * Create a new activity entry
   * @param {Object} activityData - Activity data
   * @returns {Promise<Object>} - Created activity
   */
  async createActivity(activityData) {
    try {
      logger.info('Creating activity with data', { 
        activityData: {
          ...activityData,
          metadata: activityData.metadata ? 'Map object' : undefined
        }
      });
      
      const activity = new Activity(activityData);
      await activity.save();
      
      // Populate user and return
      await activity.populate('user', 'username displayName');
      
      logger.info('Activity created successfully', { 
        activityId: activity._id, 
        type: activity.type,
        taskId: activity.taskId,
        userId: activity.user?._id
      });
      
      return activity;
    } catch (error) {
      logger.error('Error creating activity', { error, activityData });
      throw error;
    }
  }

  /**
   * Get activities for a specific task (filtered by company)
   * @param {string} taskId - Task ID
   * @param {string} userCompanyId - User's company ID for filtering (null for super admin)
   * @param {string} userRole - User's role to determine access level
   * @returns {Promise<Array>} - Array of activities
   */
  async getTaskActivities(taskId, userCompanyId, userRole = null) {
    try {
      // First verify the task exists
      const task = await Task.findById(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Super admin can see all activities
      if (userRole === 'superadmin') {
        const activities = await Activity.find({
          taskId: taskId
        })
        .populate('user', 'username displayName')
        .sort({ createdAt: -1 });

        logger.info(`Found ${activities.length} activities for task ${taskId} (super admin access)`);
        return activities;
      }

      // Regular users: Check if user has access to this task's activities
      if (task.company && task.company.toString() !== userCompanyId) {
        throw new Error('Access denied: Task not accessible');
      }

      // For regular users, filter by company
      const activities = await Activity.find({
        taskId: taskId,
        company: userCompanyId
      })
      .populate('user', 'username displayName')
      .sort({ createdAt: -1 });

      logger.info(`Found ${activities.length} activities for task ${taskId}`);
      return activities;
    } catch (error) {
      logger.error(`Error getting activities for task ${taskId}`, { error });
      throw error;
    }
  }

  /**
   * Log task creation activity
   */
  async logTaskCreated(task, createdByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'task_created',
        user: createdByUser.id,
        userName: createdByUser.username || createdByUser.displayName,
        description: `Task "${task.title}" was created`,
        company: createdByUser.company?.id || createdByUser.company || null,
        metadata: new Map([
          ['priority', task.priority],
          ['dueDate', task.dueDate],
          ['assignee', task.assigneeName || 'Unassigned']
        ])
      });
    } catch (error) {
      logger.error('Error logging task creation activity', { error });
    }
  }

  /**
   * Log task assignment activity
   */
  async logTaskAssigned(task, assignedUser, assignedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'task_assigned',
        user: assignedByUser.id,
        userName: assignedByUser.username || assignedByUser.displayName,
        description: `Task assigned to ${assignedUser.username || assignedUser.displayName}`,
        company: assignedByUser.company?.id || assignedByUser.company || null,
        metadata: new Map([
          ['assignedTo', assignedUser.username || assignedUser.displayName],
          ['assignedToId', assignedUser._id.toString()]
        ])
      });
    } catch (error) {
      logger.error('Error logging task assignment activity', { error });
    }
  }

  /**
   * Log task status change activity
   */
  async logStatusChanged(task, oldStatus, newStatus, changedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'status_changed',
        user: changedByUser.id,
        userName: changedByUser.username || changedByUser.displayName,
        description: `Task status changed from "${oldStatus}" to "${newStatus}"`,
        company: changedByUser.company?.id || changedByUser.company || null,
        changes: {
          field: 'status',
          oldValue: oldStatus,
          newValue: newStatus
        }
      });
    } catch (error) {
      logger.error('Error logging status change activity', { error });
    }
  }

  /**
   * Log task priority change activity
   */
  async logPriorityChanged(task, oldPriority, newPriority, changedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'priority_changed',
        user: changedByUser.id,
        userName: changedByUser.username || changedByUser.displayName,
        description: `Task priority changed from "${oldPriority}" to "${newPriority}"`,
        company: changedByUser.company?.id || changedByUser.company || null,
        changes: {
          field: 'priority',
          oldValue: oldPriority,
          newValue: newPriority
        }
      });
    } catch (error) {
      logger.error('Error logging priority change activity', { error });
    }
  }

  /**
   * Log due date change activity
   */
  async logDueDateChanged(task, oldDueDate, newDueDate, changedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'due_date_changed',
        user: changedByUser.id,
        userName: changedByUser.username || changedByUser.displayName,
        description: `Task due date changed from "${new Date(oldDueDate).toLocaleDateString()}" to "${new Date(newDueDate).toLocaleDateString()}"`,
        company: changedByUser.company?.id || changedByUser.company || null,
        changes: {
          field: 'dueDate',
          oldValue: oldDueDate,
          newValue: newDueDate
        }
      });
    } catch (error) {
      logger.error('Error logging due date change activity', { error });
    }
  }

  /**
   * Log comment added activity
   */
  async logCommentAdded(task, comment, addedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'comment_added',
        user: addedByUser.id,
        userName: addedByUser.username || addedByUser.displayName,
        description: `Comment added: "${comment.content.substring(0, 50)}${comment.content.length > 50 ? '...' : ''}"`,
        company: addedByUser.company?.id || addedByUser.company || null,
        metadata: new Map([
          ['commentId', comment._id.toString()],
          ['commentContent', comment.content]
        ])
      });
    } catch (error) {
      logger.error('Error logging comment added activity', { error });
    }
  }

  /**
   * Log follow-up task creation activity
   */
  async logFollowUpCreated(parentTask, followUpTask, createdByUser) {
    try {
      await this.createActivity({
        taskId: parentTask._id,
        type: 'follow_up_created',
        user: createdByUser.id,
        userName: createdByUser.username || createdByUser.displayName,
        description: `Follow-up task "${followUpTask.title}" was created`,
        company: createdByUser.company?.id || null,
        metadata: new Map([
          ['followUpTaskId', followUpTask._id.toString()],
          ['followUpTitle', followUpTask.title]
        ])
      });
    } catch (error) {
      logger.error('Error logging follow-up creation activity', { error });
    }
  }

  /**
   * Log task completion activity
   */
  async logTaskCompleted(task, completedByUser) {
    try {
      await this.createActivity({
        taskId: task._id,
        type: 'task_completed',
        user: completedByUser.id,
        userName: completedByUser.username || completedByUser.displayName,
        description: `Task "${task.title}" was completed`,
        company: completedByUser.company?.id || null,
        metadata: new Map([
          ['completedAt', new Date().toISOString()]
        ])
      });
    } catch (error) {
      logger.error('Error logging task completion activity', { error });
    }
  }

  /**
   * Log task update activity (generic)
   */
  async logTaskUpdated(task, updatedFields, updatedByUser) {
    try {
      const changedFields = Object.keys(updatedFields).join(', ');
      
      await this.createActivity({
        taskId: task._id,
        type: 'task_updated',
        user: updatedByUser.id,
        userName: updatedByUser.username || updatedByUser.displayName,
        description: `Task updated: ${changedFields}`,
        company: updatedByUser.company?.id || null,
        metadata: new Map([
          ['updatedFields', changedFields],
          ['updateData', JSON.stringify(updatedFields)]
        ])
      });
    } catch (error) {
      logger.error('Error logging task update activity', { error });
    }
  }

  /**
   * Get activities for multiple tasks (filtered by company)
   */
  async getActivitiesForTasks(taskIds, userCompanyId) {
    try {
      const activities = await Activity.find({
        taskId: { $in: taskIds },
        company: userCompanyId
      })
      .populate('user', 'username displayName')
      .sort({ createdAt: -1 });

      return activities;
    } catch (error) {
      logger.error('Error getting activities for multiple tasks', { error });
      throw error;
    }
  }
}

module.exports = ActivityService;
