/**
 * Task service for handling task-related operations
 */

const Task = require('../models/task');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const { logger } = require('./logging');

class TaskService {
  /**
   * Get all tasks with optional filtering
   * @param {Object} filters - Optional filters for tasks
   * @returns {Promise<Array>} - Array of tasks
   */
  async getTasks(filters = {}) {
    try {
      const query = {};

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
   * @returns {Promise<Object>} - Task object
   */
  async getTaskById(taskId) {
    try {
      const task = await Task.findById(taskId)
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .populate('conversationId', 'messages sessionId')
        .populate('parentTaskId', 'title');

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
   * @returns {Promise<Object>} - Created task
   */
  async createTask(taskData) {
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
        { path: 'createdBy', select: 'username email' }
      ]);

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
   * @returns {Promise<Object>} - Updated task
   */
  async updateTask(taskId, updateData) {
    try {
      // Add updatedAt timestamp
      updateData.updatedAt = new Date();

      // If status is being updated to 'completed', add completedAt timestamp
      if (updateData.status === 'completed') {
        updateData.completedAt = new Date();
      }

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
      logger.error(`Error updating task with ID ${taskId}`, { error });
      throw new Error('Failed to update task');
    }
  }

  /**
   * Delete a task
   * @param {string} taskId - Task ID
   * @returns {Promise<boolean>} - Success status
   */
  async deleteTask(taskId) {
    try {
      const task = await Task.findById(taskId);

      if (!task) {
        throw new Error('Task not found');
      }

      // If task is linked to a conversation, update the conversation
      if (task.conversationId) {
        await Conversation.findByIdAndUpdate(
          task.conversationId,
          { $pull: { tasks: task._id } }
        );
      }

      await Task.findByIdAndDelete(taskId);

      return true;
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
   * @returns {Promise<Object>} - Created follow-up task
   */
  async createFollowUpTask(parentTaskId, taskData) {
    try {
      // Get the parent task
      const parentTask = await this.getTaskById(parentTaskId);

      if (!parentTask) {
        throw new Error('Parent task not found');
      }

      // Set the parent task ID
      taskData.parentTaskId = parentTaskId;

      // If parent task has a conversation, link the follow-up task to the same conversation
      if (parentTask.conversationId) {
        taskData.conversationId = parentTask.conversationId._id || parentTask.conversationId;
      }

      // If contact info is not provided, use the parent task's contact info
      if (!taskData.contactInfo && parentTask.contactInfo) {
        taskData.contactInfo = parentTask.contactInfo;
      }

      // Create the follow-up task
      const task = await this.createTask(taskData);

      return task;
    } catch (error) {
      logger.error(`Error creating follow-up task for parent task ${parentTaskId}`, { error });
      throw new Error('Failed to create follow-up task');
    }
  }

  /**
   * Search for tasks
   * @param {string} searchTerm - Search term
   * @returns {Promise<Array>} - Array of matching tasks
   */
  async searchTasks(searchTerm) {
    try {
      if (!searchTerm) {
        return [];
      }

      // Create a regex for case-insensitive search
      const searchRegex = new RegExp(searchTerm, 'i');

      // Search in title, description, and contact info
      const tasks = await Task.find({
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { 'contactInfo.name': searchRegex },
          { 'contactInfo.email': searchRegex },
          { 'contactInfo.phone': searchRegex }
        ]
      })
        .populate('assignee', 'username email')
        .populate('createdBy', 'username email')
        .sort({ createdAt: -1 });

      return tasks;
    } catch (error) {
      logger.error(`Error searching tasks with term "${searchTerm}"`, { error });
      throw new Error('Failed to search tasks');
    }
  }
}

module.exports = TaskService;
