/**
 * API routes for task management
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { auth, operator } = require('../middleware/auth');
const TaskService = require('../services/task');
const CommentService = require('../services/comment');
const NotificationService = require('../services/notification');
const webhookService = require('../services/webhooks');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const socketManager = require('../socketManager');
const { canAccessCompany, companyFilter, parsePagination } = require('../utils/query');
const { logger } = require('../services/logging');

// Initialize services
const taskService = new TaskService();
const commentService = new CommentService();

/** Who can be given a task: the people who answer customers. */
const ASSIGNABLE_ROLES = ['operator', 'company_admin'];

/**
 * Check that an assignee named in a request body is a real user of the
 * caller's own company. `assignee` comes straight from the client, so without
 * this a task - with the customer's name, email and phone on it - can be
 * handed to somebody at another tenant.
 *
 * Company admins are assignees too: in a small team the admin is often the
 * person who rings the customer back.
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

  const user = await User.findOne({
    _id: assignee,
    ...companyFilter(req.user),
    role: { $in: ASSIGNABLE_ROLES },
    isActive: { $ne: false }
  }).select('_id').lean();
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return false;
  }

  return true;
}

/**
 * A due date, as the day it was chosen on.
 *
 * A date picker gives "2026-10-23". `new Date('2026-10-23')` is midnight UTC,
 * which is the evening of the 22nd anywhere west of Greenwich - so a task
 * picked for Friday showed as due Thursday, and went overdue a day early. A
 * bare date is stored at midday UTC, which is the same calendar day for every
 * timezone a team is plausibly in. The dashboard sends local midday itself;
 * this covers anything else that calls the API with a bare date.
 *
 * @returns {Date|null|undefined} undefined when absent, null when unreadable
 */
function parseDueDate(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' && !(value instanceof Date)) {
    return null;
  }
  const bareDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(bareDate ? `${value}T12:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Where a task opens in the dashboard. */
function taskLink(task) {
  return `?section=tasks&taskId=${encodeURIComponent(String(task._id))}`;
}

/**
 * Tell somebody they have been given a task - unless they gave it to
 * themselves, which they already know about.
 */
function notifyAssignee(task, assignedBy, verb = 'assigned you') {
  const assignee = task.assignee && (task.assignee._id || task.assignee);
  if (!assignee || String(assignee) === String(assignedBy.id)) {
    return;
  }
  NotificationService.notifyUser(assignee, {
    type: 'task_assigned',
    message: `${assignedBy.displayName || assignedBy.username} ${verb} "${String(task.title).slice(0, 120)}"`,
    taskId: task._id,
    link: taskLink(task)
  });
}

/**
 * `task.created` for integrations.
 *
 * It only fired for tasks a workflow raised, so an integration listening for
 * new work never heard about the ones people created - most of them.
 */
function announceTaskCreated(task, req) {
  const company = task.company && (task.company._id || task.company);
  if (!company) {
    return;
  }
  webhookService.dispatch(company, 'task.created', {
    taskId: String(task._id),
    title: task.title,
    priority: task.priority,
    dueDate: task.dueDate,
    status: task.status,
    assignee: task.assigneeName || null,
    parentTaskId: task.parentTaskId ? String(task.parentTaskId._id || task.parentTaskId) : null,
    raisedBy: 'operator',
    createdBy: req.user.displayName || req.user.username
  });
}

/**
 * The people tasks can be given to: operators and company admins of the
 * caller's company, active ones only.
 *
 * The task form used the operator list, which leaves admins out, although
 * the API always accepted them.
 */
router.get('/assignees', auth, operator, async (req, res) => {
  try {
    const people = await User.find({
      ...companyFilter(req.user),
      role: { $in: ASSIGNABLE_ROLES },
      isActive: { $ne: false }
    }).select('username displayName role').sort({ displayName: 1, username: 1 }).lean();

    res.json({
      assignees: people.map(person => ({
        _id: String(person._id),
        username: person.username,
        displayName: person.displayName || person.username,
        role: person.role
      }))
    });
  } catch (error) {
    logger.error('Error listing assignees', { error });
    res.status(500).json({ error: 'Failed to load the people tasks can be given to' });
  }
});

// Get tasks, a page at a time, with every filter combined
router.get('/', auth, operator, async (req, res) => {
  try {
    const filters = {};
    const text = value => (typeof value === 'string' ? value.trim() : '');

    // Extract filter parameters from query. Several statuses may be asked for
    // at once: "still to do" is open and in progress.
    const statuses = text(req.query.status).split(',')
      .map(status => status.trim())
      .filter(status => ['open', 'in_progress', 'completed'].includes(status));
    if (statuses.length === 1) {
      filters.status = statuses[0];
    } else if (statuses.length > 1) {
      filters.status = statuses;
    }

    // `me` is whoever is asking, `unassigned` is nobody: the two views an
    // operator starts from.
    const assignee = text(req.query.assignee);
    if (assignee === 'me') {
      filters.assignee = String(req.user.id);
    } else if (assignee === 'unassigned') {
      filters.assignee = 'unassigned';
    } else if (assignee && mongoose.Types.ObjectId.isValid(assignee)) {
      filters.assignee = assignee;
    }

    if (['low', 'medium', 'high', 'urgent'].includes(text(req.query.priority))) {
      filters.priority = text(req.query.priority);
    }

    const conversationId = text(req.query.conversationId);
    if (conversationId) {
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(400).json({ error: 'Invalid conversation' });
      }
      filters.conversationId = conversationId;
    }

    if (req.query.dueBefore || req.query.dueAfter) {
      filters.dueDate = {};

      if (req.query.dueBefore) {
        filters.dueDate.before = text(req.query.dueBefore);
      }

      if (req.query.dueAfter) {
        filters.dueDate.after = text(req.query.dueAfter);
      }
    }

    if (req.query.overdue === 'true') {
      filters.overdue = true;
    }

    if (text(req.query.search)) {
      filters.search = text(req.query.search);
    }

    if (req.query.sort === 'due') {
      filters.sort = 'due';
    }

    // Paged: the list used to stop at 500 without saying so, and the 501st
    // task simply did not exist as far as the board was concerned.
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    filters.skip = skip;
    filters.limit = limit;

    const [tasks, total] = await Promise.all([
      taskService.getTasks(filters, req.user.company?.id, req.user.role),
      taskService.countTasks(filters, req.user.company?.id, req.user.role)
    ]);

    res.json({
      tasks,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
    });
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

/**
 * A parent task named in a request, checked against the caller's company.
 *
 * @returns {Promise<string|null|false>} the id; null when none was given;
 *          false when the response has been sent
 */
async function parentTaskFrom(req, res, parentTaskId) {
  if (!parentTaskId) {
    return null;
  }
  if (typeof parentTaskId !== 'string' || !mongoose.Types.ObjectId.isValid(parentTaskId)) {
    res.status(400).json({ error: 'Invalid parent task' });
    return false;
  }
  try {
    // The service's lookup applies the caller's company scope and throws
    // when the task is not theirs.
    await taskService.getTaskById(parentTaskId, req.user.company?.id, req.user.role);
  } catch (error) {
    if (error.message === 'Task not found') {
      res.status(404).json({ error: 'Parent task not found' });
      return false;
    }
    throw error;
  }
  return parentTaskId;
}

// Create a new task
router.post('/', auth, operator, async (req, res) => {
  try {
    // Extract task data from request body
    const {
      title,
      description,
      priority,
      assignee,
      conversationId,
      contactInfo,
      parentTaskId
    } = req.body;

    // Validate required fields
    if (!title || !description || !req.body.dueDate) {
      return res.status(400).json({
        error: 'Please provide title, description, and due date'
      });
    }

    const dueDate = parseDueDate(req.body.dueDate);
    if (!dueDate) {
      return res.status(400).json({ error: 'The due date is not a date' });
    }

    if (!(await assigneeAllowed(req, res, assignee))) {
      return;
    }

    // A follow-up created from the task form names its parent. This was
    // ignored, so "Create follow-up" made an unrelated task.
    const parent = await parentTaskFrom(req, res, parentTaskId);
    if (parent === false) {
      return;
    }

    // Create task data object
    const taskData = {
      title,
      description,
      dueDate,
      priority: priority || 'medium',
      assignee: assignee || null,
      status: 'open',
      contactInfo,
      createdBy: req.user.id,
      company: req.user.company?.id
    };

    if (parent) {
      taskData.parentTaskId = parent;
    }

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

    if (parent) {
      // The parent's history says a follow-up was raised from it.
      const parentTask = await taskService.getTaskById(parent, req.user.company?.id, req.user.role);
      await taskService.activityService.logFollowUpCreated(parentTask, task, req.user);
    }

    // Notify only this tenant's operators - a global emit would push task
    // contact details to every connected widget visitor as well.
    socketManager.emitToOperators(req.user.company?.id, 'task-created', { task });
    announceTaskCreated(task, req);
    notifyAssignee(task, req.user, 'created a task for you:');

    res.status(201).json({ task });
  } catch (error) {
    logger.error('Error creating task', {
      error: error.message,
      stack: error.stack
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
    if (req.body.dueDate) {
      const dueDate = parseDueDate(req.body.dueDate);
      if (!dueDate) {
        return res.status(400).json({ error: 'The due date is not a date' });
      }
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

    // Reassignment. Present-but-empty means "nobody"; absent means unchanged.
    if (Object.prototype.hasOwnProperty.call(req.body, 'assignee')) {
      const assignee = req.body.assignee || null;
      if (!(await assigneeAllowed(req, res, assignee))) {
        return;
      }
      updateData.assignee = assignee;
    }

    const parent = await parentTaskFrom(req, res, parentTaskId);
    if (parent === false) {
      return;
    }
    if (parent) {
      if (parent === String(req.params.id)) {
        return res.status(400).json({ error: 'A task cannot follow up on itself' });
      }
      updateData.parentTaskId = parent;
    }

    // Update the task
    const task = await taskService.updateTask(req.params.id, updateData, req.user, req.user.company?.id, req.user.role);

    socketManager.emitToOperators(req.user.company?.id, 'task-updated', { task });

    if (task.$locals && task.$locals.assigneeChanged) {
      socketManager.emitToOperators(req.user.company?.id, 'task-assigned', { task });
      notifyAssignee(task, req.user, 'assigned you');
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
    const task = await taskService.assignTask(req.params.id, userId, userName, req.user.company?.id || null);

    socketManager.emitToOperators(req.user.company?.id, 'task-assigned', { task });
    notifyAssignee(task, req.user, 'assigned you');

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

    // The task is checked against the caller's company first, and the comment
    // must belong to it: a comment id alone reached any tenant's thread.
    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);

    // Create update data object
    const updateData = {
      content,
      attachments: attachments || []
    };

    // Update the comment
    const comment = await commentService.updateComment(
      req.params.commentId,
      updateData,
      req.user,
      req.params.id
    );

    socketManager.emitToOperators(req.user.company?.id, 'comment-updated', { comment, taskId: req.params.id });

    res.json({ comment });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

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
    await taskService.getTaskById(req.params.id, req.user.company?.id, req.user.role);

    // Its author may delete it, or an admin tidying up.
    await commentService.deleteComment(req.params.commentId, req.user, req.params.id);

    socketManager.emitToOperators(req.user.company?.id, 'comment-deleted', { commentId: req.params.commentId, taskId: req.params.id });

    res.json({ success: true, message: 'Comment deleted successfully' });
  } catch (error) {
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }

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
    if (error.message === 'Task not found') {
      return res.status(404).json({ error: 'Task not found' });
    }
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
      priority,
      assignee,
      contactInfo
    } = req.body;

    // Validate required fields
    if (!title || !description || !req.body.dueDate) {
      return res.status(400).json({
        error: 'Please provide title, description, and due date'
      });
    }

    const dueDate = parseDueDate(req.body.dueDate);
    if (!dueDate) {
      return res.status(400).json({ error: 'The due date is not a date' });
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
      assignee: assignee || null,
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
    announceTaskCreated(task, req);
    notifyAssignee(task, req.user, 'created a follow-up for you:');

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

    // As a string: the service compares it with `task.company.toString()`,
    // and the ObjectId the auth middleware holds never equals a string - so
    // every operator and admin was told "access denied" on their own tasks.
    const companyId = req.user.company?.id ? String(req.user.company.id) : null;
    const activities = await activityService.getTaskActivities(req.params.id, companyId, req.user.role);

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
