/**
 * Tasks: the follow-up work a conversation leaves behind.
 *
 * Descriptions are Markdown (headers, **bold**, *italic*, lists, links),
 * rendered through renderMarkdown() in utils.js, which sanitises the output.
 *
 * Due dates are days, not instants. A date picker gives "2026-10-23", and
 * `new Date('2026-10-23')` is midnight UTC - the evening of the 22nd anywhere
 * west of Greenwich, so tasks showed as due a day early and went overdue a day
 * early. Dates go up as midday local time and come back as the local date.
 */

import * as bootstrap from 'bootstrap';
import feather from 'feather-icons';
import { marked } from 'marked';
import { openConversation, selectedSessionId } from './inbox.js';
import { registerSection, showSection } from './nav.js';
import { state } from './state.js';
import { api, confirmDialog, errorMessage, escapeHtml, formatRelativeTime, logger, renderMarkdown, setLoading, showToast, updateUrlWithParams } from './utils.js';

// Configure marked.js for Markdown rendering
if (typeof marked !== 'undefined') {
  // `sanitize` was removed from marked in v5 and this call has been a silent
  // no-op ever since. Sanitising now happens in renderMarkdown() instead.
  marked.setOptions({
    gfm: true,
    breaks: true
  });
}

const PAGE_SIZE = 50;

const taskState = {
  /** mine | unassigned | overdue | all */
  view: 'mine',
  page: 1,
  /** `{id, label}` when showing one conversation's tasks. */
  conversation: null,
  loaded: []
};

/** Each load is numbered; an answer to an older one is ignored. */
let loadSequence = 0;

const $ = id => document.getElementById(id);

function myId() {
  return state.currentUser ? String(state.currentUser.id || state.currentUser._id || '') : '';
}

function isAdmin() {
  const role = state.currentUser && state.currentUser.role;
  return role === 'company_admin' || role === 'superadmin';
}

// ------------------------------------------------------------- due dates

/** A stored due date as `YYYY-MM-DD` in the viewer's own calendar. */
export function toDateInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A picked `YYYY-MM-DD` as midday local time, which is that day everywhere nearby. */
export function fromDateInput(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

/** Days from today to the due date, by calendar day. Negative is late. */
function daysUntil(value) {
  const due = new Date(value);
  const today = new Date();
  const startOf = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOf(due) - startOf(today)) / 86400000);
}

/** Late: due on a day that has already finished, and not done. */
function isOverdue(task) {
  return task.status !== 'completed' && daysUntil(task.dueDate) < 0;
}

function dueLabel(task) {
  const days = daysUntil(task.dueDate);
  const date = new Date(task.dueDate).toLocaleDateString();
  if (task.status === 'completed') {
    return date;
  }
  if (days === 0) {
    return `${date} (today)`;
  }
  if (days === 1) {
    return `${date} (tomorrow)`;
  }
  if (days < 0) {
    return `${date} (${-days} day${days === -1 ? '' : 's'} late)`;
  }
  return date;
}

function assigneeLabel(task) {
  if (task.assignee && typeof task.assignee === 'object') {
    return task.assignee.displayName || task.assignee.username || task.assigneeName || 'Unassigned';
  }
  return task.assigneeName || 'Unassigned';
}

const STATUS_TEXT = { open: 'Open', in_progress: 'In Progress', completed: 'Completed' };
const STATUS_BADGE = { open: 'bg-secondary', in_progress: 'bg-primary', completed: 'bg-success' };
const PRIORITY_BADGE = { low: 'bg-secondary', medium: 'bg-primary', high: 'bg-warning text-dark', urgent: 'bg-danger' };

// -------------------------------------------------------------- assignees

/**
 * Operators and company admins, for the form and the filter. Admins are
 * assignees too: in a small team the admin is often who rings back.
 */
async function loadAssignees() {
  try {
    const { assignees } = await api('/api/tasks/assignees');
    const fill = (select, firstLabel) => {
      if (!select) {
        return;
      }
      const current = select.value;
      select.innerHTML = `<option value="">${escapeHtml(firstLabel)}</option>` + (assignees || []).map(person => `
        <option value="${escapeHtml(person._id)}">
          ${escapeHtml(person.displayName)}${person.role === 'company_admin' ? ' (admin)' : ''}${person._id === myId() ? ' (you)' : ''}
        </option>`).join('');
      select.value = current;
    };
    fill($('task-assignee-input'), 'Nobody yet');
    fill($('task-assignee-filter'), 'All Assignees');
    return assignees || [];
  } catch (error) {
    logger.error('Error loading assignees:', error);
    return [];
  }
}

// ------------------------------------------------------------------ list

/** The query for the current view and filters. */
function listQuery(page) {
  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  const status = $('task-status-filter').value;
  const priority = $('task-priority-filter').value;
  const assignee = $('task-assignee-filter').value;
  const search = $('task-search').value.trim();

  // Still to do, unless a status was chosen.
  const todo = status || 'open,in_progress';

  if (taskState.view === 'mine') {
    params.set('assignee', 'me');
    params.set('status', todo);
    params.set('sort', 'due');
  } else if (taskState.view === 'unassigned') {
    params.set('assignee', 'unassigned');
    params.set('status', todo);
    params.set('sort', 'due');
  } else if (taskState.view === 'overdue') {
    params.set('overdue', 'true');
    params.set('sort', 'due');
  } else if (status) {
    params.set('status', status);
  }

  if (assignee && taskState.view === 'all') {
    params.set('assignee', assignee);
  }
  if (priority) {
    params.set('priority', priority);
  }
  if (search) {
    params.set('search', search);
  }
  if (taskState.conversation) {
    params.set('conversationId', taskState.conversation.id);
  }
  return params;
}

export async function loadTasks({ append = false } = {}) {
  const page = append ? taskState.page + 1 : 1;
  const sequence = ++loadSequence;

  if (!append) {
    $('task-list').innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Loading…</td></tr>';
  }

  try {
    const data = await api(`/api/tasks?${listQuery(page).toString()}`);
    if (sequence !== loadSequence) {
      return;
    }
    taskState.page = page;
    taskState.loaded = append ? taskState.loaded.concat(data.tasks || []) : (data.tasks || []);
    displayTasks(taskState.loaded);

    const pagination = data.pagination || { total: taskState.loaded.length, totalPages: 1, page: 1 };
    $('task-list-summary').textContent = pagination.total
      ? `Showing ${taskState.loaded.length} of ${pagination.total}`
      : '';
    $('task-load-more-btn').style.display = page < pagination.totalPages ? '' : 'none';
  } catch (error) {
    if (sequence !== loadSequence) {
      return;
    }
    logger.error('Error loading tasks:', error);
    $('task-list').innerHTML = `<tr><td colspan="7" class="text-center text-danger py-3">${escapeHtml(errorMessage(error, 'Could not load the tasks'))}</td></tr>`;
  }
}

const EMPTY_TEXT = {
  mine: 'Nothing on your list. Tasks assigned to you appear here.',
  unassigned: 'Every task has somebody on it.',
  overdue: 'Nothing is late.',
  all: 'No tasks yet.'
};

export function displayTasks(tasks) {
  const taskList = $('task-list');
  taskList.innerHTML = '';

  if (tasks.length === 0) {
    taskList.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">${escapeHtml(
      taskState.conversation ? 'No tasks for this conversation.' : EMPTY_TEXT[taskState.view] || EMPTY_TEXT.all
    )}</td></tr>`;
    return;
  }

  tasks.forEach(task => {
    const row = document.createElement('tr');
    row.dataset.taskId = task._id;
    if (isOverdue(task)) {
      row.classList.add('overdue-task');
    }

    // In the list, a plain-text preview: rendering Markdown in a truncated
    // string could leave broken tags.
    const description = String(task.description || '');
    const preview = description.length > 50 ? `${description.substring(0, 50)}...` : description;

    row.innerHTML = `
      <td>
        <button type="button" class="btn btn-link p-0 text-start task-title-link" data-view-task>${escapeHtml(task.title)}</button>
        ${task.createdByBot ? '<span class="badge text-bg-info ms-1" title="Raised by a workflow on a customer\'s behalf">Bot</span>' : ''}
        ${task.parentTaskId ? '<span class="badge bg-light text-dark ms-1" title="A follow-up to another task">Follow-up</span>' : ''}
        ${task.hasFollowUps ? '<span class="badge bg-light text-dark ms-1" title="Has follow-up tasks">Has follow-ups</span>' : ''}
      </td>
      <td class="description-cell">${escapeHtml(preview)}</td>
      <td class="${isOverdue(task) ? 'text-danger fw-semibold' : ''}">${escapeHtml(dueLabel(task))}</td>
      <td><span class="badge ${PRIORITY_BADGE[task.priority] || 'bg-secondary'}">${escapeHtml(task.priority.charAt(0).toUpperCase() + task.priority.slice(1))}</span></td>
      <td>${escapeHtml(assigneeLabel(task))}</td>
      <td><span class="badge ${STATUS_BADGE[task.status] || 'bg-secondary'}">${escapeHtml(STATUS_TEXT[task.status] || task.status)}</span></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary me-1" data-view-task title="View task" aria-label="View task"><i data-feather="eye"></i></button>
        <button class="btn btn-sm btn-outline-secondary me-1" data-edit-task title="Edit task" aria-label="Edit task"><i data-feather="edit"></i></button>
        <button class="btn btn-sm btn-outline-danger" data-delete-task title="Delete task" aria-label="Delete task"><i data-feather="trash-2"></i></button>
      </td>`;

    taskList.appendChild(row);
  });

  feather.replace();
}

/** "Tasks for this conversation", as a chip that can be removed. */
function renderConversationChip() {
  const chip = $('task-conversation-chip');
  if (!taskState.conversation) {
    chip.style.display = 'none';
    chip.innerHTML = '';
    return;
  }
  chip.innerHTML = `
    <span class="tag-chip">
      Conversation: ${escapeHtml(taskState.conversation.label)}
      <button type="button" class="tag-chip-remove" id="task-conversation-chip-remove" aria-label="Show all tasks">&times;</button>
    </span>`;
  chip.style.display = '';
  chip.querySelector('button').addEventListener('click', () => {
    taskState.conversation = null;
    renderConversationChip();
    updateUrlWithParams({ section: 'tasks' });
    loadTasks();
  });
}

function setView(view) {
  taskState.view = view;
  document.querySelectorAll('[data-task-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.taskView === view);
  });
}

// ---------------------------------------------------------------- detail

export async function loadTaskDetails(taskId) {
  // Update URL with task ID
  updateUrlWithParams({ section: 'tasks', taskId });

  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    displayTaskDetails(task);
    loadTaskComments(taskId);
    loadTaskActivities(taskId);
  } catch (error) {
    logger.error('Error loading task details:', error);
    showToast(errorMessage(error, 'Could not load the task'), 'danger');
  }
}

export function displayTaskDetails(task) {
  $('task-detail-container').style.display = 'block';
  $('task-detail-container').dataset.taskId = task._id;
  // By id: the first `.row.mb-3` in the document is whichever section
  // happens to come first, not the task list.
  $('task-list-container').style.display = 'none';

  // Show parent task info if this is a follow-up task
  const parentTaskInfo = $('parent-task-info');
  if (task.parentTaskId) {
    parentTaskInfo.style.display = 'block';
    $('parent-task-title').textContent = task.parentTaskId.title || 'Parent Task';
    $('parent-task-link').onclick = function() {
      loadTaskDetails(task.parentTaskId._id || task.parentTaskId);
      return false;
    };
  } else {
    parentTaskInfo.style.display = 'none';
  }

  loadFollowUpTasks(task._id);

  $('task-title').textContent = task.title;
  if (task.createdByBot) {
    $('task-title').insertAdjacentHTML('beforeend', ' <span class="badge text-bg-info fs-6 align-middle">Raised by the bot</span>');
  }

  // Render task description with Markdown
  $('task-description').innerHTML = renderMarkdown(task.description);

  const dueElement = $('task-due-date');
  dueElement.textContent = dueLabel(task);
  dueElement.classList.toggle('text-danger', isOverdue(task));
  if (isOverdue(task)) {
    dueElement.insertAdjacentHTML('beforeend', ' <span class="badge bg-danger">OVERDUE</span>');
  }

  const prioritySpan = $('task-priority');
  prioritySpan.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  prioritySpan.className = {
    low: 'text-secondary', medium: 'text-primary', high: 'text-warning', urgent: 'text-danger'
  }[task.priority] || '';

  $('task-assignee').textContent = assigneeLabel(task);
  $('task-status-update').value = task.status;

  $('create-follow-up-btn').onclick = function() {
    openFollowUpTaskModal(task._id);
  };

  // Set conversation link if available
  const conversationLink = $('task-conversation-link');
  if (task.conversationId) {
    const sessionId = task.conversationId.sessionId || task.conversationId;
    conversationLink.href = `?section=active-chats&chat=${encodeURIComponent(sessionId)}`;
    conversationLink.style.display = 'inline-block';
    conversationLink.onclick = function(event) {
      event.preventDefault();
      openConversation(sessionId);
      return false;
    };
  } else {
    conversationLink.style.display = 'none';
  }

  const contact = task.contactInfo || {};
  [['contact-name', contact.name], ['contact-email', contact.email], ['contact-phone', contact.phone]]
    .forEach(([id, value]) => {
      $(id).textContent = value || 'Not provided';
      $(id).className = value ? '' : 'text-muted fst-italic';
    });
}

export async function loadTaskComments(taskId) {
  try {
    const { comments } = await api(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
    displayComments(comments || []);
  } catch (error) {
    logger.error('Error loading comments:', error);
    showToast(errorMessage(error, 'Could not load the comments'), 'danger');
  }
}

export async function loadTaskActivities(taskId) {
  try {
    const { activities } = await api(`/api/tasks/${encodeURIComponent(taskId)}/activities`);
    displayTaskActivities(activities || []);
  } catch (error) {
    // Not critical: show the empty state rather than an error.
    logger.error('Error loading task activities:', error);
    displayTaskActivities([]);
  }
}

// Display task activities
export function displayTaskActivities(activities) {
  const activityList = $('task-activity-list');
  activityList.innerHTML = '';

  if (activities.length === 0) {
    activityList.innerHTML = '<li class="list-group-item text-center text-muted">No activity yet</li>';
    return;
  }

  activities.forEach(activity => {
    const activityItem = document.createElement('li');
    activityItem.className = 'list-group-item';
    const formattedTime = new Date(activity.createdAt).toLocaleString();

    activityItem.innerHTML = `
      <div class="d-flex align-items-start">
        <div class="me-2">
          <i data-feather="${getActivityIcon(activity.type)}" class="text-muted" style="width: 16px; height: 16px;"></i>
        </div>
        <div class="flex-grow-1">
          <div class="fw-bold">${escapeHtml(activity.userName)}</div>
          <div class="text-muted small">${escapeHtml(activity.description)}</div>
          <div class="text-muted small" title="${escapeHtml(formattedTime)}">${escapeHtml(formatRelativeTime(activity.createdAt))}</div>
        </div>
      </div>
    `;

    activityList.appendChild(activityItem);
  });

  feather.replace();
}

// Get appropriate icon for activity type
export function getActivityIcon(activityType) {
  const iconMap = {
    'task_created': 'plus',
    'task_updated': 'edit',
    'task_assigned': 'user',
    'task_unassigned': 'user-x',
    'status_changed': 'check-circle',
    'priority_changed': 'flag',
    'due_date_changed': 'calendar',
    'comment_added': 'message-circle',
    'comment_updated': 'edit',
    'comment_deleted': 'trash-2',
    'follow_up_created': 'git-branch',
    'task_completed': 'check',
    'task_deleted': 'trash-2'
  };

  return iconMap[activityType] || 'activity';
}

export async function loadFollowUpTasks(taskId) {
  try {
    const { tasks } = await api(`/api/tasks/${encodeURIComponent(taskId)}/follow-ups`);
    displayFollowUpTasks(tasks || []);
  } catch (error) {
    logger.error('Error loading follow-up tasks:', error);
    displayFollowUpTasks([]);
  }
}

export function displayFollowUpTasks(tasks) {
  const followUpsList = $('follow-ups-list');
  const followUpsSection = $('follow-ups-section');
  followUpsList.innerHTML = '';

  if (tasks.length === 0) {
    followUpsSection.style.display = 'none';
    return;
  }

  followUpsSection.style.display = 'block';

  tasks.forEach(task => {
    const taskItem = document.createElement('div');
    taskItem.className = 'card mb-2';
    taskItem.innerHTML = `
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="mb-0"><a href="#" class="follow-up-link">${escapeHtml(task.title)}</a></h6>
          <span class="badge ${STATUS_BADGE[task.status] || 'bg-secondary'}">${escapeHtml(STATUS_TEXT[task.status] || task.status)}</span>
        </div>
        <div class="d-flex justify-content-between align-items-center">
          <small class="text-muted">Assigned to: ${escapeHtml(assigneeLabel(task))}</small>
          <small class="${isOverdue(task) ? 'text-danger' : ''}">Due: ${escapeHtml(dueLabel(task))}</small>
        </div>
      </div>
    `;

    taskItem.querySelector('.follow-up-link').addEventListener('click', event => {
      event.preventDefault();
      loadTaskDetails(task._id);
    });

    followUpsList.appendChild(taskItem);
  });
}

/**
 * Comments, with edit and delete on your own (an admin may delete any).
 * Both used to fail with a 500 every time, and the UI offered neither.
 */
export function displayComments(comments) {
  const commentsList = $('comments-list');
  commentsList.innerHTML = '';

  if (comments.length === 0) {
    commentsList.innerHTML = '<div class="text-center text-muted">No comments yet</div>';
    return;
  }

  comments.forEach(comment => {
    const authorId = comment.author && typeof comment.author === 'object'
      ? String(comment.author._id)
      : String(comment.author || '');
    const mine = authorId === myId();
    const commentDiv = document.createElement('div');
    commentDiv.className = 'card mb-2 task-comment';
    commentDiv.dataset.commentId = comment._id;
    const formattedDate = new Date(comment.createdAt).toLocaleString();

    commentDiv.innerHTML = `
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2 gap-2">
          <strong>${escapeHtml(comment.authorName || (comment.author && comment.author.username) || 'Unknown')}</strong>
          <span class="d-flex align-items-center gap-2">
            <small class="text-muted" title="${escapeHtml(formattedDate)}">
              ${escapeHtml(formatRelativeTime(comment.createdAt))}${comment.isEdited ? ' · edited' : ''}
            </small>
            ${mine ? '<button type="button" class="btn btn-link btn-sm p-0" data-edit-comment>Edit</button>' : ''}
            ${mine || isAdmin() ? '<button type="button" class="btn btn-link btn-sm p-0 text-danger" data-delete-comment>Delete</button>' : ''}
          </span>
        </div>
        <p class="mb-0 comment-content"></p>
      </div>
    `;
    commentDiv.querySelector('.comment-content').textContent = comment.content;

    commentsList.appendChild(commentDiv);
  });
}

function editComment(commentDiv) {
  const taskId = $('task-detail-container').dataset.taskId;
  const contentEl = commentDiv.querySelector('.comment-content');
  if (commentDiv.querySelector('textarea')) {
    return;
  }
  const original = contentEl.textContent;

  const editor = document.createElement('div');
  editor.innerHTML = `
    <textarea class="form-control form-control-sm mb-2" rows="2"></textarea>
    <button type="button" class="btn btn-sm btn-primary me-1" data-save>Save</button>
    <button type="button" class="btn btn-sm btn-outline-secondary" data-cancel>Cancel</button>`;
  editor.querySelector('textarea').value = original;
  contentEl.style.display = 'none';
  contentEl.after(editor);

  editor.querySelector('[data-cancel]').addEventListener('click', () => {
    editor.remove();
    contentEl.style.display = '';
  });
  editor.querySelector('[data-save]').addEventListener('click', async event => {
    const content = editor.querySelector('textarea').value.trim();
    if (!content) {
      return;
    }
    setLoading(event.currentTarget, true);
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentDiv.dataset.commentId)}`, {
        method: 'PUT',
        body: { content }
      });
      loadTaskComments(taskId);
    } catch (error) {
      showToast(errorMessage(error, 'Could not save the comment'), 'danger');
      setLoading(event.currentTarget, false);
    }
  });
}

async function deleteComment(commentDiv) {
  const taskId = $('task-detail-container').dataset.taskId;
  const ok = await confirmDialog({
    title: 'Delete this comment?',
    message: 'It is removed for everybody.',
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) {
    return;
  }
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentDiv.dataset.commentId)}`, {
      method: 'DELETE'
    });
    loadTaskComments(taskId);
  } catch (error) {
    showToast(errorMessage(error, 'Could not delete the comment'), 'danger');
  }
}

export function showTaskList() {
  $('task-detail-container').style.display = 'none';
  $('task-list-container').style.display = 'block';
  delete $('task-detail-container').dataset.taskId;
}

// ------------------------------------------------------------------ form

/**
 * A blank form. The hidden fields matter most: `form.reset()` does not clear
 * a hidden input, and neither did anything else, so "New task" after viewing
 * a follow-up created another follow-up - and "Create follow-up" after an
 * edit overwrote the task last edited, through a stale `taskId`.
 */
function resetTaskForm() {
  const form = $('task-form');
  form.reset();
  delete form.dataset.taskId;
  $('conversation-id').value = '';
  $('parent-task-id').value = '';
  $('parent-task-info-modal').style.display = 'none';
  ['name-missing', 'email-missing', 'phone-missing'].forEach(id => {
    $(id).style.display = 'none';
  });
  ['task-title-input', 'task-description-input', 'task-due-date-input'].forEach(id => {
    $(id).classList.remove('is-invalid');
  });
}

function fillContact(contact = {}) {
  $('contact-name-input').value = contact.name || '';
  $('contact-email-input').value = contact.email || '';
  $('contact-phone-input').value = contact.phone || '';
  $('name-missing').style.display = contact.name ? 'none' : 'block';
  $('email-missing').style.display = contact.email ? 'none' : 'block';
  $('phone-missing').style.display = contact.phone ? 'none' : 'block';
}

function showTaskModal() {
  bootstrap.Modal.getOrCreateInstance($('taskModal')).show();
}

export async function openTaskModal(conversationId = null, task = null) {
  resetTaskForm();
  await loadAssignees();

  if (conversationId) {
    $('conversation-id').value = conversationId;

    if (state.currentConversation && state.currentConversation.sessionId === conversationId) {
      const metadata = state.currentConversation.metadata instanceof Map
        ? Object.fromEntries(state.currentConversation.metadata)
        : (state.currentConversation.metadata || {});
      fillContact(metadata);
    } else {
      try {
        const conversation = await api(`/api/admin/chat/${encodeURIComponent(conversationId)}`);
        fillContact((conversation && conversation.metadata) || {});
      } catch (error) {
        logger.error('Error loading conversation:', error);
      }
    }
  }

  if (task) {
    $('taskModalLabel').textContent = 'Edit Task';
    $('save-task-btn').textContent = 'Update Task';

    $('conversation-id').value = task.conversationId ? (task.conversationId._id || task.conversationId) : '';
    $('task-title-input').value = task.title;
    $('task-description-input').value = task.description;
    $('task-due-date-input').value = toDateInput(task.dueDate);
    $('task-priority-input').value = task.priority;
    $('task-assignee-input').value = task.assignee && typeof task.assignee === 'object'
      ? (task.assignee._id || '')
      : (task.assignee || '');

    if (task.parentTaskId) {
      $('parent-task-info-modal').style.display = 'block';
      $('parent-task-title-modal').textContent = task.parentTaskId.title || 'Parent Task';
    }

    if (task.contactInfo) {
      fillContact(task.contactInfo);
    }

    $('task-form').dataset.taskId = task._id;
  } else {
    $('taskModalLabel').textContent = 'Create New Task';
    $('save-task-btn').textContent = 'Create Task';

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    $('task-due-date-input').value = toDateInput(tomorrow);
    // A task raised from a conversation is usually for whoever is in it.
    if (conversationId) {
      $('task-assignee-input').value = myId();
    }
  }

  showTaskModal();
}

export async function openFollowUpTaskModal(parentTaskId) {
  resetTaskForm();

  let parentTask;
  try {
    ({ task: parentTask } = await api(`/api/tasks/${encodeURIComponent(parentTaskId)}`));
  } catch (error) {
    logger.error('Error loading parent task details:', error);
    showToast(errorMessage(error, 'Could not load the task'), 'danger');
    return;
  }

  await loadAssignees();

  $('parent-task-info-modal').style.display = 'block';
  $('parent-task-title-modal').textContent = parentTask.title;
  $('parent-task-id').value = parentTaskId;

  // Due a week after the parent, or a week from today if that is already past.
  const base = new Date(Math.max(new Date(parentTask.dueDate).getTime(), Date.now()));
  base.setDate(base.getDate() + 7);
  $('task-due-date-input').value = toDateInput(base);

  if (parentTask.conversationId) {
    $('conversation-id').value = parentTask.conversationId._id || parentTask.conversationId;
  }
  if (parentTask.contactInfo) {
    fillContact(parentTask.contactInfo);
  }
  const parentAssignee = parentTask.assignee && (parentTask.assignee._id || parentTask.assignee);
  $('task-assignee-input').value = parentAssignee ? String(parentAssignee) : '';

  $('taskModalLabel').textContent = 'Create Follow-up Task';
  $('save-task-btn').textContent = 'Create Follow-up Task';

  showTaskModal();
}

export async function saveTask() {
  const form = $('task-form');
  const taskId = form.dataset.taskId;
  const parentTaskId = $('parent-task-id').value;
  const conversationId = $('conversation-id').value;
  const titleInput = $('task-title-input');
  const descriptionInput = $('task-description-input');
  const dueDateInput = $('task-due-date-input');

  const title = titleInput.value.trim();
  const description = descriptionInput.value.trim();
  const dueDate = fromDateInput(dueDateInput.value);

  titleInput.classList.toggle('is-invalid', !title);
  descriptionInput.classList.toggle('is-invalid', !description);
  dueDateInput.classList.toggle('is-invalid', !dueDate);
  if (!title || !description || !dueDate) {
    return;
  }

  const taskData = {
    title,
    description,
    dueDate,
    priority: $('task-priority-input').value,
    // Sent even when empty: empty means nobody, and an edit must be able to
    // say so.
    assignee: $('task-assignee-input').value,
    contactInfo: {
      name: $('contact-name-input').value.trim(),
      email: $('contact-email-input').value.trim(),
      phone: $('contact-phone-input').value.trim()
    }
  };

  let method = 'POST';
  let url = '/api/tasks';
  if (taskId) {
    method = 'PUT';
    url = `/api/tasks/${encodeURIComponent(taskId)}`;
  } else if (parentTaskId) {
    // A follow-up inherits its parent's company, conversation and contact.
    url = `/api/tasks/${encodeURIComponent(parentTaskId)}/follow-ups`;
  } else if (conversationId) {
    taskData.conversationId = conversationId;
  }

  const button = $('save-task-btn');
  setLoading(button, true);
  try {
    await api(url, { method, body: taskData });

    bootstrap.Modal.getOrCreateInstance($('taskModal')).hide();
    showToast(taskId ? 'Task updated' : parentTaskId ? 'Follow-up created' : 'Task created', 'success');

    const currentTaskId = $('task-detail-container').dataset.taskId;
    if (currentTaskId && (currentTaskId === taskId || currentTaskId === parentTaskId)) {
      loadTaskDetails(currentTaskId);
    }
    resetTaskForm();
    loadTasks();
  } catch (error) {
    logger.error('Error saving task:', error);
    showToast(errorMessage(error, 'Could not save the task'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

export async function updateTaskStatus(status) {
  const taskId = $('task-detail-container').dataset.taskId;
  if (!taskId) {
    return;
  }
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PUT', body: { status } });
    showToast('Status updated', 'success');
    loadTaskActivities(taskId);
  } catch (error) {
    logger.error('Error updating task status:', error);
    showToast(errorMessage(error, 'Could not update the status'), 'danger');
  }
}

export async function addComment() {
  const taskId = $('task-detail-container').dataset.taskId;
  const input = $('comment-input');
  const content = input.value.trim();
  if (!content || !taskId) {
    return;
  }

  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/comments`, { method: 'POST', body: { content } });
    input.value = '';
    loadTaskComments(taskId);
    loadTaskActivities(taskId);
  } catch (error) {
    logger.error('Error adding comment:', error);
    showToast(errorMessage(error, 'Could not add the comment'), 'danger');
  }
}

export async function editTaskFromDetails(taskId) {
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    openTaskModal(null, task);
  } catch (error) {
    logger.error('Error loading task for editing:', error);
    showToast(errorMessage(error, 'Could not load the task'), 'danger');
  }
}

export async function deleteTask(taskId) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    showToast('Task deleted', 'success');
    if ($('task-detail-container').dataset.taskId === taskId) {
      showTaskList();
    }
    loadTasks();
  } catch (error) {
    logger.error('Error deleting task:', error);
    showToast(errorMessage(error, 'Could not delete the task'), 'danger');
  }
}

// ----------------------------------------------------------------- setup

const tasksVisible = () => $('tasks-section')?.classList.contains('active');

export function setupTaskSocketListeners() {
  const socket = state.socket;
  if (!socket) {
    return;
  }

  const refreshList = () => {
    if (tasksVisible() && $('task-list-container').style.display !== 'none') {
      loadTasks();
    }
  };
  const currentTaskId = () => $('task-detail-container')?.dataset.taskId;

  socket.on('task-created', refreshList);

  socket.on('task-updated', data => {
    if (data && data.task && currentTaskId() === String(data.task._id)) {
      loadTaskDetails(currentTaskId());
    }
    refreshList();
  });

  // Being given a task arrives in the bell (notification-created), with a
  // link; here the list only catches up.
  socket.on('task-assigned', refreshList);

  socket.on('task-deleted', data => {
    if (data && currentTaskId() === String(data.taskId)) {
      showTaskList();
    }
    refreshList();
  });

  ['comment-created', 'comment-updated', 'comment-deleted'].forEach(event => {
    socket.on(event, data => {
      if (data && currentTaskId() === String(data.taskId)) {
        loadTaskComments(currentTaskId());
      }
    });
  });
}

// Task Management Functions
export function setupTaskManagement() {
  // A task from the open conversation.
  $('create-task-btn').addEventListener('click', () => {
    const selectedChatId = selectedSessionId();
    if (selectedChatId) {
      openTaskModal(selectedChatId);
    }
  });

  // The tasks raised from the open conversation, on the Tasks screen.
  $('view-tasks-btn').addEventListener('click', () => {
    const conversation = state.currentConversation;
    if (conversation && conversation._id) {
      showSection('tasks', { params: { conversation: conversation._id, chat: conversation.sessionId } });
    }
  });

  $('new-task-btn').addEventListener('click', () => openTaskModal());
  $('save-task-btn').addEventListener('click', () => saveTask());
  $('back-to-tasks-btn').addEventListener('click', () => {
    showTaskList();
    updateUrlWithParams({ section: 'tasks' });
    loadTasks();
  });
  $('edit-task-btn').addEventListener('click', () => {
    editTaskFromDetails($('task-detail-container').dataset.taskId);
  });

  document.querySelectorAll('[data-task-view]').forEach(button => {
    button.addEventListener('click', () => {
      setView(button.dataset.taskView);
      // A view is who and when; the assignee filter only applies to "All".
      $('task-assignee-filter').value = '';
      loadTasks();
    });
  });

  ['task-status-filter', 'task-priority-filter'].forEach(id => {
    $(id).addEventListener('change', () => loadTasks());
  });
  $('task-assignee-filter').addEventListener('change', () => {
    // Choosing somebody means everybody's tasks, filtered to them.
    if ($('task-assignee-filter').value) {
      setView('all');
    }
    loadTasks();
  });

  $('task-search-btn').addEventListener('click', () => loadTasks());
  $('task-search').addEventListener('keypress', event => {
    if (event.key === 'Enter') {
      loadTasks();
    }
  });
  $('task-load-more-btn').addEventListener('click', () => loadTasks({ append: true }));

  $('task-list').addEventListener('click', async event => {
    const row = event.target.closest('tr[data-task-id]');
    if (!row) {
      return;
    }
    const task = taskState.loaded.find(item => item._id === row.dataset.taskId);
    if (event.target.closest('[data-edit-task]')) {
      openTaskModal(null, task);
    } else if (event.target.closest('[data-delete-task]')) {
      const ok = await confirmDialog({
        title: 'Delete this task?',
        message: `"${task ? task.title : 'This task'}" and its comments are removed for good.`,
        confirmLabel: 'Delete',
        danger: true
      });
      if (ok) {
        deleteTask(row.dataset.taskId);
      }
    } else if (event.target.closest('[data-view-task]')) {
      loadTaskDetails(row.dataset.taskId);
    }
  });

  $('task-status-update').addEventListener('change', function() {
    updateTaskStatus(this.value);
  });

  $('add-comment-btn').addEventListener('click', () => addComment());
  $('comment-input').addEventListener('keypress', event => {
    if (event.key === 'Enter') {
      addComment();
    }
  });

  $('comments-list').addEventListener('click', event => {
    const commentDiv = event.target.closest('[data-comment-id]');
    if (!commentDiv) {
      return;
    }
    if (event.target.closest('[data-edit-comment]')) {
      editComment(commentDiv);
    } else if (event.target.closest('[data-delete-comment]')) {
      deleteComment(commentDiv);
    }
  });

  // Remove validation styling when the user interacts with a field.
  ['task-title-input', 'task-description-input', 'task-due-date-input', 'task-assignee-input'].forEach(fieldId => {
    const field = $(fieldId);
    field.addEventListener('input', function() {
      this.classList.remove('is-invalid');
    });
    field.addEventListener('change', function() {
      this.classList.remove('is-invalid');
    });
  });

  setupTaskSocketListeners();
}

registerSection('tasks', {
  show(params) {
    loadAssignees();
    if (params.taskId) {
      loadTaskDetails(params.taskId);
      return;
    }
    showTaskList();
    if (params.conversation) {
      // One conversation's tasks, whoever has them, as a removable filter.
      const label = params.chat ? params.chat.substring(0, 8) : params.conversation.substring(0, 8);
      taskState.conversation = { id: params.conversation, label };
      setView('all');
    } else {
      taskState.conversation = null;
    }
    renderConversationChip();
    loadTasks();
  }
});
