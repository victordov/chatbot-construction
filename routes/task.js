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
const User = require('../models/user');
const socketManager = require('../socketManager');
const { canAccessCompany, companyFilter } = require('../utils/query');
const { logger } = require('../services/logging');

// Initialize services
const taskService = new TaskService();
const commentService = new CommentService();

/**
 * Check that an assignee named in a request body is a real user of the
 * caller's own company. `assignee` comes straight from the client, so without
 * this a task - with the customer's name, email and phone on it - can be
 * handed to somebody at another tenant.
 *
 * @returns {Promise<boolean>} false when the response has been sent
 */
async function assigneeAllowed(req, res, assignee) {
  if (!assignee) {
    return true;
  }

  if (typeof assignee !== 'string' || !mongoose.Types.ObjectId.isValid(assignee)) {
    res.status(400).json({ error: 'Invalid assignee' });
    return false;
  }

  const user = await User.findOne({ _id: assignee, ...companyFilter(req.user) }).select('_id').lean();
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return false;
  }

  return true;
}

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
      const tasks = await taskService.searchTasks(req.query.search, req.user.company?.id, req.user.role);
      return res.json({ tasks });
    }

    // Get tasks with filters and company scoping
    const tasks = await taskService.getTasks(filters, req.user.company?.id, req.user.role);

    res.json({ tasks });
  } catch (error) {
    logger.error('Error getting tasks', { error });
    res.status(500).json({ error: 'Failed to get tasks' });
  }
});

// Get a task by ID
router.get('/:id', auth, operator, async (req, res) => {
  try {
    const task = await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);

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
    if (!title || !description || !dueDate) {
      return res.status(400).json({
        error: 'Please provide title, description, and due date'
      });
    }

    if (!(await assigneeAllowed(req, res, assignee))) {
      return;
    }

    // Create task data object
    const taskData = {
      title,
      description,
      dueDate,
      priority: priority || 'medium',
      assignee: assignee === '' ? null : assignee,
      status: 'open',
      contactInfo,
      createdBy: req.user.id,
      company: req.user.company?.id
    };

    // Handle conversationId - it could be a sessionId (string) or an ObjectId.
    // Either way it is looked up within the caller's own tenant: a task is
    // linked back from the conversation it names, so an id from another
    // company would pin this company's task onto their transcript.
    if (conversationId) {
      if (typeof conversationId !== 'string') {
        return res.status(400).json({ error: 'Invalid conversation' });
      }

      const byId = mongoose.Types.ObjectId.isValid(conversationId)
        ? { _id: conversationId }
        : { sessionId: conversationId };
      const conversation = await Conversation.findOne({ ...byId, ...companyFilter(req.user) })
        .select('_id')
        .lean();

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      taskData.conversationId = conversation._id;
    }

    // Create the task
    const task = await taskService.createTask(taskData, req.user);

    // Notify only this tenant's operators - a global emit would push task
    // contact details to every connected widget visitor as well.
    socketManager.emitToOperators(req.user.company?.id, 'task-created', { task });

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
      contactInfo,
      parentTaskId
    } = req.body;

    // Create update data object
    const updateData = {};

    if (title) {
      updateData.title = title;
    }
    if (description) {
      updateData.description = description;
    }
    if (dueDate) {
      updateData.dueDate = dueDate;
    }
    if (priority) {
      updateData.priority = priority;
    }
    if (status) {
      updateData.status = status;
    }
    if (contactInfo) {
      updateData.contactInfo = contactInfo;
    }
    if (parentTaskId) {
      // The parent must be one of this tenant's own tasks; the service's
      // lookup applies the caller's company scope and throws otherwise.
      if (typeof parentTaskId !== 'string' || !mongoose.Types.ObjectId.isValid(parentTaskId)) {
        return res.status(400).json({ error: 'Invalid parent task' });
      }
      try {
        await taskService.getTaskById(parentTaskId, req.user.company?.id, req.user.role);
      } catch (error) {
        if (error.message === 'Task not found') {
          return res.status(404).json({ error: 'Parent task not found' });
        }
        throw error;
      }
      updateData.parentTaskId = parentTaskId;
    }

    // Update the task
    const task = await taskService.updateTask(req.params.id, updateData, req.user, req.user.company?.id, req.user.role);

    socketManager.emitToOperators(req.user.company?.id, 'task-updated', { task });

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
    // `.id`, not the whole company object: passing `{ id, name }` where an
    // ObjectId is expected made mongoose cast it to "[object Object]", so
    // deleting a task failed with a 500 every single time.
    await taskService.deleteTask(req.params.id, req.user.company?.id, req.user);

    socketManager.emitToOperators(req.user.company?.id, 'task-deleted', { taskId: req.params.id });

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

    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);

    // The task was checked against the caller's tenant; the assignee was not.
    // Without this, `userId` straight from the body hands one company's work to
    // a stranger at another - and the conversation behind the task with it.
    const assignee = await User.findById(userId).select('company').lean();

    if (!assignee || !canAccessCompany(req.user, assignee.company)) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Assign the task
    const task = await taskService.assignTask(req.params.id, userId, userName);

    socketManager.emitToOperators(req.user.company?.id, 'task-assigned', { task });

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
    // Ensures the task exists and belongs to the caller's company before
    // exposing its comment thread.
    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);
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

    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);

    // Create comment data object
    const commentData = {
      taskId: req.params.id,
      content,
      attachments: attachments || [],
      author: req.user.id,
      // Prefer the display name so a comment is signed the way a colleague
      // would recognise, matching notes and transfers.
      authorName: req.user.displayName || req.user.username
    };

    // Create the comment
    const comment = await commentService.createComment(commentData, req.user);

    socketManager.emitToOperators(req.user.company?.id, 'comment-created', { comment, taskId: req.params.id });

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

    socketManager.emitToOperators(req.user.company?.id, 'comment-updated', { comment, taskId: req.params.id });

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

    socketManager.emitToOperators(req.user.company?.id, 'comment-deleted', { commentId: req.params.commentId, taskId: req.params.id });

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

// Get follow-up tasks for a task
router.get('/:id/follow-ups', auth, operator, async (req, res) => {
  try {
    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);
    const tasks = await taskService.getFollowUpTasks(req.params.id);
    res.json({ tasks });
  } catch (error) {
    logger.error(`Error getting follow-up tasks for task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to get follow-up tasks' });
  }
});

// Create a follow-up task
router.post('/:id/follow-ups', auth, operator, async (req, res) => {
  try {
    // Extract task data from request body
    const {
      title,
      description,
      dueDate,
      priority,
      assignee,
      contactInfo
    } = req.body;

    // Validate required fields
    if (!title || !description || !dueDate) {
      return res.status(400).json({
        error: 'Please provide title, description, and due date'
      });
    }

    if (!(await assigneeAllowed(req, res, assignee))) {
      return;
    }

    // Create task data object
    const taskData = {
      title,
      description,
      dueDate,
      priority: priority || 'medium',
      assignee: assignee === '' ? null : assignee,
      status: 'open',
      contactInfo,
      createdBy: req.user.id,
      company: req.user.company?.id
    };

    // Create the follow-up task, scoped to the caller's tenant: the parent is
    // where the company, the conversation and the contact details come from.
    const task = await taskService.createFollowUpTask(
      req.params.id,
      taskData,
      req.user,
      req.user.company?.id,
      req.user.role
    );

    socketManager.emitToOperators(req.user.company?.id, 'task-created', { task });

    res.status(201).json({ task });
  } catch (error) {
    if (error.message === 'Parent task not found') {
      return res.status(404).json({ error: 'Parent task not found' });
    }

    logger.error(`Error creating follow-up task for task with ID ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to create follow-up task' });
  }
});

// Get activities for a task
router.get('/:id/activities', auth, operator, async (req, res) => {
  try {
    const ActivityService = require('../services/activity');
    const activityService = new ActivityService();

    const activities = await activityService.getTaskActivities(req.params.id, req.user.company?.id, req.user.role);

    res.json({ activities });
  } catch (error) {
    if (error.message === 'Task not found' || error.message === 'Access denied: Task not accessible') {
      return res.status(404).json({ error: 'Task not found or access denied' });
    }

    logger.error(`Error getting activities for task ${req.params.id}`, { error });
    res.status(500).json({ error: 'Failed to get task activities' });
  }
});

module.exports = router;
