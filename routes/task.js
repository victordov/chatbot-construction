/**
 * API routes for task management
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { auth, operator } = require('../middleware/auth');
const TaskService = require('../services/task');
const CommentService = require('../services/comment');
const Conversation = require('../models/conversation');
const socketManager = require('../socketManager');
const { logger } = require('../services/logging');

// Initialize services
const taskService = new TaskService();
const commentService = new CommentService();

// Get all tasks with optional filtering
router.get('/', auth, operator, async (req, res) => {
  try {
    const filters = {};

    // Extract filter parameters from query
    if (req.query.status) {
      filters.status = req.query.status;
    }

    if (req.query.assignee) {
      filters.assignee = req.query.assignee;
    }

    if (req.query.priority) {
      filters.priority = req.query.priority;
    }

    if (req.query.conversationId) {
      filters.conversationId = req.query.conversationId;
    }

    if (req.query.dueBefore || req.query.dueAfter) {
      filters.dueDate = {};

      if (req.query.dueBefore) {
        filters.dueDate.before = req.query.dueBefore;
      }

      if (req.query.dueAfter) {
        filters.dueDate.after = req.query.dueAfter;
      }
    }

    // Handle search parameter
    if (req.query.search) {
      const tasks = await taskService.searchTasks(req.query.search);
      return res.json({ tasks });
    }

    // Get tasks with filters
    const tasks = await taskService.getTasks(filters);

    res.json({ tasks });
  } catch (error) {
    logger.error('Error getting tasks', { error });
    res.status(500).json({ error: 'Failed to get tasks' });
  }
});

// Get a task by ID
router.get('/:id', auth, operator, async (req, res) => {
  try {
    const task = await taskService.getTaskById(req.params.id);

    res.json({ task });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error getting task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to get task' });
  }
});

// Create a new task
router.post('/', auth, operator, async (req, res) => {
  try {
    // Extract task data from request body
    const {
      title,
      description,
      dueDate,
      priority,
      assignee,
      conversationId,
      contactInfo
    } = req.body;

    // Validate required fields
    if (!title || !description || !dueDate || !assignee) {
      return res.status(400).json({
        error: 'Please provide title, description, due date, and assignee'
      });
    }

    // Create task data object
    const taskData = {
      title,
      description,
      dueDate,
      priority: priority || 'medium',
      assignee,
      status: 'open',
      contactInfo,
      createdBy: req.user.id
    };

    // Handle conversationId - it could be a sessionId (string) or an ObjectId
    if (conversationId) {
      // If it's a valid ObjectId, use it directly
      if (mongoose.Types.ObjectId.isValid(conversationId)) {
        taskData.conversationId = conversationId;
      } else {
        // If it's not a valid ObjectId, assume it's a sessionId and look up the conversation
        const conversation = await Conversation.findOne({ sessionId: conversationId });
        if (conversation) {
          taskData.conversationId = conversation._id;
        } else {
          logger.warn(`Conversation with sessionId ${conversationId} not found`);
        }
      }
    }

    // Create the task
    const task = await taskService.createTask(taskData);

    // Emit WebSocket event for task creation
    try {
      const io = socketManager.getIo();
      io.emit('task-created', { task });
    } catch (socketError) {
      logger.error('Error emitting task-created event', { error: socketError });
    }

    res.status(201).json({ task });
  } catch (error) {
    logger.error('Error creating task', { 
      error: error.message, 
      stack: error.stack,
      taskData: req.body 
    });
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update a task
router.put('/:id', auth, operator, async (req, res) => {
  try {
    // Extract update data from request body
    const {
      title,
      description,
      dueDate,
      priority,
      status,
      contactInfo
    } = req.body;

    // Create update data object
    const updateData = {};

    if (title) updateData.title = title;
    if (description) updateData.description = description;
    if (dueDate) updateData.dueDate = dueDate;
    if (priority) updateData.priority = priority;
    if (status) updateData.status = status;
    if (contactInfo) updateData.contactInfo = contactInfo;

    // Update the task
    const task = await taskService.updateTask(req.params.id, updateData);

    // Emit WebSocket event for task update
    try {
      const io = socketManager.getIo();
      io.emit('task-updated', { task });
    } catch (socketError) {
      logger.error('Error emitting task-updated event', { error: socketError });
    }

    res.json({ task });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error updating task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete a task
router.delete('/:id', auth, operator, async (req, res) => {
  try {
    // Delete the task
    await taskService.deleteTask(req.params.id);

    // Emit WebSocket event for task deletion
    try {
      const io = socketManager.getIo();
      io.emit('task-deleted', { taskId: req.params.id });
    } catch (socketError) {
      logger.error('Error emitting task-deleted event', { error: socketError });
    }

    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error deleting task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Assign a task to a user
router.post('/:id/assign', auth, operator, async (req, res) => {
  try {
    const { userId, userName } = req.body;

    if (!userId || !userName) {
      return res.status(400).json({
        error: 'Please provide userId and userName'
      });
    }

    // Assign the task
    const task = await taskService.assignTask(req.params.id, userId, userName);

    // Emit WebSocket event for task assignment
    try {
      const io = socketManager.getIo();
      io.emit('task-assigned', { task });
    } catch (socketError) {
      logger.error('Error emitting task-assigned event', { error: socketError });
    }

    res.json({ task });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error assigning task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// Get comments for a task
router.get('/:id/comments', auth, operator, async (req, res) => {
  try {
    const comments = await commentService.getCommentsByTaskId(req.params.id);

    res.json({ comments });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error getting comments for task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Add a comment to a task
router.post('/:id/comments', auth, operator, async (req, res) => {
  try {
    const { content, attachments } = req.body;

    if (!content) {
      return res.status(400).json({
        error: 'Comment content is required'
      });
    }

    // Create comment data object
    const commentData = {
      taskId: req.params.id,
      content,
      attachments: attachments || [],
      author: req.user.id,
      authorName: req.user.username
    };

    // Create the comment
    const comment = await commentService.createComment(commentData);

    // Emit WebSocket event for comment creation
    try {
      const io = socketManager.getIo();
      io.emit('comment-created', { comment, taskId: req.params.id });
    } catch (socketError) {
      logger.error('Error emitting comment-created event', { error: socketError });
    }

    res.status(201).json({ comment });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

    logger.error(`Error adding comment to task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Update a comment
router.put('/:id/comments/:commentId', auth, operator, async (req, res) => {
  try {
    const { content, attachments } = req.body;

    if (!content) {
      return res.status(400).json({
        error: 'Comment content is required'
      });
    }

    // Create update data object
    const updateData = {
      content,
      attachments: attachments || []
    };

    // Update the comment
    const comment = await commentService.updateComment(
      req.params.commentId,
      updateData,
      req.user.id
    );

    // Emit WebSocket event for comment update
    try {
      const io = socketManager.getIo();
      io.emit('comment-updated', { comment, taskId: req.params.id });
    } catch (socketError) {
      logger.error('Error emitting comment-updated event', { error: socketError });
    }

    res.json({ comment });
  } catch (error) {
    if (error.message === 'Comment not found') {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (error.message === 'Not authorized to update this comment') {
      return res.status(403).json({ error: 'Not authorized to update this comment' });
    }

    logger.error(`Error updating comment with ID ${req.params.commentId}`, { error });
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

// Delete a comment
router.delete('/:id/comments/:commentId', auth, operator, async (req, res) => {
  try {
    // Delete the comment
    await commentService.deleteComment(req.params.commentId, req.user.id);

    // Emit WebSocket event for comment deletion
    try {
      const io = socketManager.getIo();
      io.emit('comment-deleted', { commentId: req.params.commentId, taskId: req.params.id });
    } catch (socketError) {
      logger.error('Error emitting comment-deleted event', { error: socketError });
    }

    res.json({ success: true, message: 'Comment deleted successfully' });
  } catch (error) {
    if (error.message === 'Comment not found') {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (error.message === 'Not authorized to delete this comment') {
      return res.status(403).json({ error: 'Not authorized to delete this comment' });
    }

    logger.error(`Error deleting comment with ID ${req.params.commentId}`, { error });
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
