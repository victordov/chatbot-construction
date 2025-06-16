/**
 * Comment service for handling comment-related operations
 */

const Comment = require('../models/comment');
const Task = require('../models/task');
const { logger } = require('./logging');

class CommentService {
  /**
   * Get all comments for a task
   * @param {string} taskId - Task ID
   * @returns {Promise<Array>} - Array of comments
   */
  async getCommentsByTaskId(taskId) {
    try {
      // Verify task exists
      const task = await Task.findById(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Get comments for the task
      const comments = await Comment.find({ taskId })
        .populate('author', 'username email')
        .sort({ createdAt: 1 });

      return comments;
    } catch (error) {
      logger.error(`Error getting comments for task with ID ${taskId}`, { error });
      throw new Error('Failed to get comments');
    }
  }

  /**
   * Get a comment by ID
   * @param {string} commentId - Comment ID
   * @returns {Promise<Object>} - Comment object
   */
  async getCommentById(commentId) {
    try {
      const comment = await Comment.findById(commentId)
        .populate('author', 'username email');

      if (!comment) {
        throw new Error('Comment not found');
      }

      return comment;
    } catch (error) {
      logger.error(`Error getting comment with ID ${commentId}`, { error });
      throw new Error('Failed to get comment');
    }
  }

  /**
   * Create a new comment
   * @param {Object} commentData - Comment data
   * @returns {Promise<Object>} - Created comment
   */
  async createComment(commentData) {
    try {
      // Verify task exists
      const task = await Task.findById(commentData.taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Create the comment
      const comment = new Comment(commentData);
      await comment.save();

      // Populate author information
      await comment.populate('author', 'username email');

      return comment;
    } catch (error) {
      logger.error('Error creating comment', { error });
      throw new Error('Failed to create comment');
    }
  }

  /**
   * Update a comment
   * @param {string} commentId - Comment ID
   * @param {Object} updateData - Data to update
   * @param {string} userId - User ID of the requester
   * @returns {Promise<Object>} - Updated comment
   */
  async updateComment(commentId, updateData, userId) {
    try {
      // Find the comment
      const comment = await Comment.findById(commentId);

      if (!comment) {
        throw new Error('Comment not found');
      }

      // Check if user is the author of the comment
      if (comment.author.toString() !== userId) {
        throw new Error('Not authorized to update this comment');
      }

      // Update comment data
      if (updateData.content) {
        comment.content = updateData.content;
      }

      if (updateData.attachments) {
        comment.attachments = updateData.attachments;
      }

      // Mark as edited and update timestamp
      comment.isEdited = true;
      comment.updatedAt = new Date();

      await comment.save();

      // Populate author information
      await comment.populate('author', 'username email');

      return comment;
    } catch (error) {
      logger.error(`Error updating comment with ID ${commentId}`, { error });
      throw new Error('Failed to update comment');
    }
  }

  /**
   * Delete a comment
   * @param {string} commentId - Comment ID
   * @param {string} userId - User ID of the requester
   * @returns {Promise<boolean>} - Success status
   */
  async deleteComment(commentId, userId) {
    try {
      // Find the comment
      const comment = await Comment.findById(commentId);

      if (!comment) {
        throw new Error('Comment not found');
      }

      // Check if user is the author of the comment
      if (comment.author.toString() !== userId) {
        throw new Error('Not authorized to delete this comment');
      }

      await Comment.findByIdAndDelete(commentId);

      return true;
    } catch (error) {
      logger.error(`Error deleting comment with ID ${commentId}`, { error });
      throw new Error('Failed to delete comment');
    }
  }
}

module.exports = CommentService;