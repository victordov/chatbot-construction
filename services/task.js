/**
 * Task service for handling task-related operations
 */

const Task = require('../models/task');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const ActivityService = require('./activity');
const { logger } = require('./logging');

class TaskService {
  constructor() {
    this.activityService = new ActivityService();
  }

  /**
   * Get all tasks with optional filtering
   * @param {Object} filters - Optional filters for tasks
   * @param {string} userCompanyId - User's company ID for filtering (null for super admin)
   * @param {string} userRole - User's role to determine access level
   * @returns {Promise<Array>} - Array of tasks
   */
  async getTasks(filters = {}, userCompanyId = null, userRole = null) {
    try {
      const query = {};

      // Apply company filter for multi-tenancy (skip for super admin)
      if (userRole !== 'superadmin' && userCompanyId) {
        query.company = userCompanyId;
      }

      // Apply filters if provided
      if (filters.status) {
        query.status = filters.status;
      }

      if (filters.assignee) {
        query.assignee = filters.assignee;
      }

      if (filters.priority) {
        query.priority = filters.priority;
      }

      if (filters.conversationId) {
        query.conversationId = filters.conversationId;
      }

      if (filters.parentTaskId) {
        query.parentTaskId = filters.parentTaskId;
      }

      if (filters.dueDate) {
        // Handle due date filtering (before, after, between)
        if (filters.dueDate.before) {
          query.dueDate = { ...query.dueDate, $lte: new Date(filters.dueDate.before) };
        }

        if (filters.dueDate.after) {
          query.dueDate = { ...query.dueDate, $gte: new Date(filters.dueDate.after) };
        }
      }

      // Get tasks with applied filters
      const tasks = await Task.find(query)
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('company', 'name')
        .sort({ createdAt: -1 });

      // Check if each task has follow-ups
      const tasksWithFollowUpInfo = await Promise.all(tasks.map(async (task) => {
        const taskObj = task.toObject();
        const followUpCount = await Task.countDocuments({ parentTaskId: task._id });
        taskObj.hasFollowUps = followUpCount > 0;
        return taskObj;
      }));

      return tasksWithFollowUpInfo;
    } catch (error) {
      logger.error('Error getting tasks', { error });
      throw new Error('Failed to get tasks');
    }
  }

  /**
   * Get a task by ID
   * @param {string} taskId - Task ID
   * @param {string} userCompanyId - User's company ID for access control (null for super admin)
   * @param {string} userRole - User's role to determine access level
   * @returns {Promise<Object>} - Task object
   */
  async getTaskById(taskId, userCompanyId = null, userRole = null) {
    try {
      const query = { _id: taskId };
      
      // Apply company filter for multi-tenancy (skip for super admin)
      if (userRole !== 'superadmin' && userCompanyId) {
        query.company = userCompanyId;
      }

      const task = await Task.findOne(query)
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('conversationId', 'messages sessionId')
        .populate('parentTaskId', 'title')
        .populate('company', 'name');

      if (!task) {
        throw new Error('Task not found');
      }

      return task;
    } catch (error) {
      logger.error(`Error getting task with ID ${taskId}`, { error });
      throw new Error('Failed to get task');
    }
  }

  /**
   * Create a new task
   * @param {Object} taskData - Task data
   * @param {Object} createdByUser - User who created the task
   * @returns {Promise<Object>} - Created task
   */
  async createTask(taskData, createdByUser = null) {
    try {
      // Lookup assignee name for easier display later
      if (taskData.assignee) {
        const user = await User.findById(taskData.assignee).select('username');
        if (user) {
          taskData.assigneeName = user.username;
        }
      }

      // Create the task
      const task = new Task(taskData);
      await task.save();

      // If task is linked to a conversation, update the conversation
      if (task.conversationId) {
        await Conversation.findByIdAndUpdate(
          task.conversationId,
          { $push: { tasks: task._id } }
        );
      }

      // Populate both fields in a single call
      await task.populate([
        { path: 'assignee', select: 'username email' },
        { path: 'createdBy', select: 'username email' },
        { path: 'company', select: 'name' }
      ]);

      // Log task creation activity
      if (createdByUser) {
        await this.activityService.logTaskCreated(task, createdByUser);
      }

      return task;
    } catch (error) {
      logger.error('Error creating task', {
        error: error.message,
        stack: error.stack,
        taskData
      });
      throw new Error(`Failed to create task: ${error.message}`);
    }
  }

  /**
   * Update a task
   * @param {string} taskId - Task ID
   * @param {Object} updateData - Data to update
   * @param {Object} updatedByUser - User who updated the task
   * @param {string} userCompanyId - User's company ID for access control (null for super admin)
   * @param {string} userRole - User's role to determine access level
   * @returns {Promise<Object>} - Updated task
   */
  async updateTask(taskId, updateData, updatedByUser = null, userCompanyId = null, userRole = null) {
    try {
      // First get the original task to track changes
      const originalTask = await this.getTaskById(taskId, userCompanyId, userRole);
      
      // Add updatedAt timestamp
      updateData.updatedAt = new Date();

      // If status is being updated to 'completed', add completedAt timestamp
      if (updateData.status === 'completed') {
        updateData.completedAt = new Date();
      }

      const query = { _id: taskId };
      // Apply company filter for regular users (skip for super admin)
      if (userRole !== 'superadmin' && userCompanyId) {
        query.company = userCompanyId;
      }

      const task = await Task.findOneAndUpdate(
        query,
        updateData,
        { new: true, runValidators: true }
      ).populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('parentTaskId', 'title')
        .populate('company', 'name');

      if (!task) {
        throw new Error('Task not found');
      }

      // Log specific activities for important changes
      if (updatedByUser) {
        logger.info('Task update - user object for activity logging', { 
          userId: updatedByUser.id, 
          username: updatedByUser.username,
          company: updatedByUser.company,
          userKeys: Object.keys(updatedByUser)
        });
        
        // Log status change
        if (updateData.status && updateData.status !== originalTask.status) {
          await this.activityService.logStatusChanged(task, originalTask.status, updateData.status, updatedByUser);
          
          // Log task completion if status changed to completed
          if (updateData.status === 'completed') {
            await this.activityService.logTaskCompleted(task, updatedByUser);
          }
        }

        // Log priority change
        if (updateData.priority && updateData.priority !== originalTask.priority) {
          await this.activityService.logPriorityChanged(task, originalTask.priority, updateData.priority, updatedByUser);
        }

        // Log due date change
        if (updateData.dueDate && new Date(updateData.dueDate).getTime() !== new Date(originalTask.dueDate).getTime()) {
          await this.activityService.logDueDateChanged(task, originalTask.dueDate, updateData.dueDate, updatedByUser);
        }

        // Log generic task update for other fields
        const significantFields = ['title', 'description', 'contactInfo'];
        const changedSignificantFields = {};
        significantFields.forEach(field => {
          if (updateData[field] !== undefined && JSON.stringify(updateData[field]) !== JSON.stringify(originalTask[field])) {
            changedSignificantFields[field] = updateData[field];
          }
        });

        if (Object.keys(changedSignificantFields).length > 0) {
          await this.activityService.logTaskUpdated(task, changedSignificantFields, updatedByUser);
        }
      }

      return task;
    } catch (error) {
      logger.error(`Error updating task with ID ${taskId}`, { error });
      throw new Error('Failed to update task');
    }
  }

  /**
   * Delete a task
   * @param {string} taskId - Task ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteTask(taskId, userCompanyId = null, user = null) {
    try {
      const query = { _id: taskId };
      
      // Apply company filter for multi-tenancy
      if (userCompanyId) {
        query.company = userCompanyId;
      }

      const task = await Task.findOne(query);

      if (!task) {
        throw new Error('Task not found');
      }

      // Log activity before deletion
      if (user) {
        await this.activityService.logActivity({
          taskId: task._id,
          userId: user.id,
          action: 'deleted',
          details: `Task "${task.title}" was deleted`,
          company: task.company
        });
      }

      // If task is linked to a conversation, update the conversation
      if (task.conversationId) {
        await Conversation.findByIdAndUpdate(
          task.conversationId,
          { $pull: { tasks: task._id } }
        );
      }

      await Task.findByIdAndDelete(taskId);

      return task; // Return the deleted task for reference
    } catch (error) {
      logger.error(`Error deleting task with ID ${taskId}`, { error });
      throw new Error('Failed to delete task');
    }
  }

  /**
   * Assign a task to a user
   * @param {string} taskId - Task ID
   * @param {string} userId - User ID to assign the task to
   * @param {string} userName - User name for display purposes
   * @returns {Promise<Object>} - Updated task
   */
  async assignTask(taskId, userId, userName) {
    try {
      const updateData = {
        assignee: userId,
        assigneeName: userName,
        updatedAt: new Date()
      };

      const task = await Task.findByIdAndUpdate(
        taskId,
        updateData,
        { new: true, runValidators: true }
      ).populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('parentTaskId', 'title');

      if (!task) {
        throw new Error('Task not found');
      }

      return task;
    } catch (error) {
      logger.error(`Error assigning task with ID ${taskId}`, { error });
      throw new Error('Failed to assign task');
    }
  }

  /**
   * Get follow-up tasks for a parent task
   * @param {string} parentTaskId - Parent task ID
   * @returns {Promise<Array>} - Array of follow-up tasks
   */
  async getFollowUpTasks(parentTaskId) {
    try {
      const tasks = await Task.find({ parentTaskId })
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .sort({ createdAt: -1 });

      return tasks;
    } catch (error) {
      logger.error(`Error getting follow-up tasks for parent task ${parentTaskId}`, { error });
      throw new Error('Failed to get follow-up tasks');
    }
  }

  /**
   * Create a follow-up task
   * @param {string} parentTaskId - Parent task ID
   * @param {Object} taskData - Task data
   * @param {Object} createdByUser - User who created the task
   * @returns {Promise<Object>} - Created follow-up task
   */
  async createFollowUpTask(parentTaskId, taskData, createdByUser = null) {
    try {
      // Get the parent task
      const parentTask = await this.getTaskById(parentTaskId);

      if (!parentTask) {
        throw new Error('Parent task not found');
      }

      // Set the parent task ID
      taskData.parentTaskId = parentTaskId;

      // Inherit company from parent task
      if (parentTask.company) {
        taskData.company = parentTask.company._id || parentTask.company;
      }

      // If parent task has a conversation, link the follow-up task to the same conversation
      if (parentTask.conversationId) {
        taskData.conversationId = parentTask.conversationId._id || parentTask.conversationId;
      }

      // If contact info is not provided, use the parent task's contact info
      if (!taskData.contactInfo && parentTask.contactInfo) {
        taskData.contactInfo = parentTask.contactInfo;
      }

      // Create the follow-up task
      const task = await this.createTask(taskData, createdByUser);

      return task;
    } catch (error) {
      logger.error(`Error creating follow-up task for parent task ${parentTaskId}`, { error });
      throw new Error('Failed to create follow-up task');
    }
  }

  /**
   * Search for tasks
   * @param {string} searchTerm - Search term
   * @param {string} userCompanyId - User's company ID for filtering (null for super admin)
   * @param {string} userRole - User's role to determine access level
   * @returns {Promise<Array>} - Array of matching tasks
   */
  async searchTasks(searchTerm, userCompanyId = null, userRole = null) {
    try {
      if (!searchTerm) {
        return [];
      }

      // Create a regex for case-insensitive search
      const searchRegex = new RegExp(searchTerm, 'i');

      // Build query with company filter
      const query = {
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { 'contactInfo.name': searchRegex },
          { 'contactInfo.email': searchRegex },
          { 'contactInfo.phone': searchRegex }
        ]
      };

      // Apply company filter for multi-tenancy (skip for super admin)
      if (userRole !== 'superadmin' && userCompanyId) {
        query.company = userCompanyId;
      }

      // Search in title, description, and contact info
      const tasks = await Task.find(query)
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('company', 'name')
        .sort({ createdAt: -1 });

      return tasks;
    } catch (error) {
      logger.error(`Error searching tasks with term "${searchTerm}"`, { error });
      throw new Error('Failed to search tasks');
    }
  }
}

module.exports = TaskService;
