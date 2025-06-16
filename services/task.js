/**
 * Task service for handling task-related operations
 */

const Task = require('../models/task');
const Conversation = require('../models/conversation');
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

      return tasks;
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
        .populate('conversationId', 'messages sessionId');

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
        .populate('createdBy', 'username email');

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
        .populate('createdBy', 'username email');

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
