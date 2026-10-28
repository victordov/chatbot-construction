/**
 * Comment service for handling comment-related operations
 */

const mongoose = require('mongoose');
const Comment = require('../models/comment');
const Task = require('../models/task');
const ActivityService = require('./activity');
const { logger } = require('./logging');

/**
 * "Not found" and "not authorised" are answers the route turns into a 404 and
 * a 403; only anything else is a failure.
 */
function rethrowExpected(error) {
  if (error && /^(Comment not found|Not authorized to )/.test(error.message || '')) {
    throw error;
  }
}

class CommentService {
  constructor() {
    this.activityService = new ActivityService();
  }

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
   * @param {Object} authorUser - User who created the comment
   * @returns {Promise<Object>} - Created comment
   */
  async createComment(commentData, authorUser = null) {
    try {
      // Verify task exists
      const task = await Task.findById(commentData.taskId).populate('company', 'name');
      if (!task) {
        throw new Error('Task not found');
      }

      // Create the comment
      const comment = new Comment(commentData);
      await comment.save();

      // Populate author information
      await comment.populate('author', 'username email');

      // Log comment activity
      if (authorUser) {
        await this.activityService.logCommentAdded(task, comment, authorUser);
      }

      return comment;
    } catch (error) {
      logger.error('Error creating comment', { error });
      throw new Error('Failed to create comment');
    }
  }

  /**
   * Find a comment the requester may change.
   *
   * Two things made editing and deleting fail with a 500 every time: the
   * author check compared a string with an ObjectId, so nobody was ever the
   * author, and the catch below it relabelled "not found" and "not
   * authorised" as a generic failure the route could not tell apart. The
   * comment must also belong to the task in the URL, which the route has
   * already scoped to the caller's company - otherwise a comment id from
   * another tenant's task could be edited through one of your own.
   *
   * @param {string} commentId
   * @param {object} requester `{id, role}`, or a bare user id
   * @param {string} [taskId] the task the comment must belong to
   * @param {object} [options]
   * @param {boolean} [options.adminMayAct] admins may act on others' comments
   */
  async findOwnComment(commentId, requester, taskId, options = {}) {
    if (!mongoose.Types.ObjectId.isValid(String(commentId))) {
      throw new Error('Comment not found');
    }

    const query = { _id: commentId };
    if (taskId) {
      query.taskId = taskId;
    }

    const comment = await Comment.findOne(query);
    if (!comment) {
      throw new Error('Comment not found');
    }

    const userId = requester && typeof requester === 'object' ? requester.id : requester;
    const role = requester && typeof requester === 'object' ? requester.role : null;
    const isAuthor = comment.author && String(comment.author) === String(userId);
    const isAdmin = role === 'company_admin' || role === 'superadmin';

    if (!isAuthor && !(options.adminMayAct && isAdmin)) {
      throw new Error(options.action === 'delete'
        ? 'Not authorized to delete this comment'
        : 'Not authorized to update this comment');
    }

    return comment;
  }

  /**
   * Update a comment. Only its author may: putting words in a colleague's
   * mouth is not an edit.
   *
   * @param {string} commentId - Comment ID
   * @param {Object} updateData - Data to update
   * @param {object|string} requester - The requesting user (`{id, role}`) or id
   * @param {string} [taskId] - The task the comment must belong to
   * @returns {Promise<Object>} - Updated comment
   */
  async updateComment(commentId, updateData, requester, taskId) {
    try {
      const comment = await this.findOwnComment(commentId, requester, taskId, { action: 'update' });

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
      await comment.populate('author', 'username email displayName');

      return comment;
    } catch (error) {
      rethrowExpected(error);
      logger.error(`Error updating comment with ID ${commentId}`, { error });
      throw new Error('Failed to update comment');
    }
  }

  /**
   * Delete a comment: its author, or an admin tidying up.
   *
   * @param {string} commentId - Comment ID
   * @param {object|string} requester - The requesting user (`{id, role}`) or id
   * @param {string} [taskId] - The task the comment must belong to
   * @returns {Promise<boolean>} - Success status
   */
  async deleteComment(commentId, requester, taskId) {
    try {
      const comment = await this.findOwnComment(commentId, requester, taskId, {
        action: 'delete',
        adminMayAct: true
      });

      await Comment.deleteOne({ _id: comment._id });

      return true;
    } catch (error) {
      rethrowExpected(error);
      logger.error(`Error deleting comment with ID ${commentId}`, { error });
      throw new Error('Failed to delete comment');
    }
  }
}

module.exports = CommentService;
