/**
 * Notification bell, and how the dashboard gets somebody's attention.
 *
 * The notification model, service, scheduler and REST API all existed, but
 * nothing in the dashboard ever called them - deadline reminders were written
 * to the database and never seen by anyone. Chats assigned or transferred to
 * somebody now land here too, with a link straight to them.
 *
 * Alerts - a desktop notification, a short sound, a toast with an "Open"
 * button - go through one place, so the person's preference means the same
 * thing everywhere. "Important only" used to behave exactly like "All".
 */

import { Toast } from 'bootstrap';
import feather from 'feather-icons';
import { showSection } from './nav.js';
import { api, escapeHtml, formatRelativeTime, logger, showToast } from './utils.js';

let notifications = [];
let unreadCount = 0;
let hasMore = false;

const PAGE_SIZE = 20;

const ICONS = {
  task_overdue: { icon: 'alert-circle', className: 'text-danger' },
  task_due_today: { icon: 'clock', className: 'text-warning' },
  task_due_tomorrow: { icon: 'calendar', className: 'text-info' },
  task_assigned: { icon: 'check-square', className: 'text-primary' },
  chat_assigned: { icon: 'message-square', className: 'text-primary' },
  chat_transferred: { icon: 'corner-up-right', className: 'text-primary' },
  visitor_waiting: { icon: 'user', className: 'text-warning' },
  low_rating: { icon: 'thumbs-down', className: 'text-danger' },
  usage_warning: { icon: 'bar-chart-2', className: 'text-warning' }
};

/** Which kind of alert each stored notification is, for the preference. */
const KIND_OF = {
  task_assigned: 'assignment',
  chat_assigned: 'assignment',
  chat_transferred: 'transfer',
  visitor_waiting: 'handoff',
  low_rating: 'rating',
  usage_warning: 'usage',
  task_overdue: 'task',
  task_due_today: 'task',
  task_due_tomorrow: 'task'
};

// --------------------------------------------------------------- alerting

/**
 * What "Important only" lets through: somebody waiting for a person, and work
 * handed to you. Everything else - a new chat the bot is handling, a message,
 * a deadline reminder - waits in the bell.
 */
const IMPORTANT = new Set(['handoff', 'assignment', 'transfer']);

function preference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (error) {
    return fallback;
  }
}

/**
 * Whether an alert of this kind may interrupt (desktop notification, sound).
 *
 * @param {'new-chat'|'message'|'handoff'|'assignment'|'transfer'|'task'|'rating'|'usage'} kind
 */
export function alertAllowed(kind) {
  const setting = preference('notification-setting', 'all');
  if (setting === 'none') {
    return false;
  }
  if (setting === 'important') {
    return IMPORTANT.has(kind);
  }
  return true;
}

/** A short beep, when the person has sounds on. No audio is not an error. */
export function beep() {
  if (preference('sound-notifications', 'false') !== 'true') {
    return;
  }
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 800;
    gain.gain.value = 0.1;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioContext.close().catch(() => {});
    }, 200);
  } catch (error) {
    // No audio is not worth an error.
  }
}

const recentlyAlerted = new Map();

/**
 * The same event often arrives twice - live over the socket and again as a
 * stored notification - and should interrupt once.
 */
function firstTime(key) {
  if (!key) {
    return true;
  }
  const now = Date.now();
  recentlyAlerted.forEach((at, seen) => {
    if (now - at > 15000) {
      recentlyAlerted.delete(seen);
    }
  });
  if (recentlyAlerted.has(key)) {
    return false;
  }
  recentlyAlerted.set(key, now);
  return true;
}

/**
 * Get somebody's attention for one event: a desktop notification and a sound
 * when the preference allows, and a toast with a way straight to it.
 *
 * @param {object} options
 * @param {string} options.kind see alertAllowed
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {string} [options.key] the same key alerts once in fifteen seconds
 * @param {Function} [options.open] what "Open" (and clicking the desktop
 *        notification) does
 * @param {boolean} [options.toast=true] also show a toast in the dashboard
 * @param {string} [options.tone='info'] the toast's colour
 */
/** Whether this browser receives push notifications (push.js says so). */
let pushActive = false;

export function setPushActive(active) {
  pushActive = Boolean(active);
}

export function alertPerson({ kind, title, body = '', key, open, toast = true, tone = 'info' }) {
  if (!firstTime(key)) {
    return;
  }

  const allowed = alertAllowed(kind);

  if (toast && (allowed || IMPORTANT.has(kind))) {
    actionToast(body ? `${title}: ${body}` : title, { type: tone, onAction: open });
  }

  if (!allowed) {
    return;
  }

  // With push on in this browser the service worker shows it (and stays
  // quiet while this window is in front); showing one here too doubles it.
  if (!pushActive && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const notification = new Notification(title, { body, tag: key || undefined });
      notification.onclick = () => {
        window.focus();
        notification.close();
        if (open) {
          open();
        }
      };
    } catch (error) {
      // Some browsers only allow notifications from a service worker.
    }
  }

  beep();
}

/**
 * A toast with an action button: "Bea asked for a person [Open]".
 *
 * The shared toast has no button, and a toast that names somebody waiting but
 * gives no way to reach them leaves the operator hunting through the queue.
 */
export function actionToast(message, { type = 'info', actionLabel = 'Open', onAction, delay = 10000 } = {}) {
  if (!onAction) {
    showToast(message, type, delay);
    return;
  }

  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    document.body.appendChild(container);
  }

  const variant = ['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark'].includes(type)
    ? type
    : 'info';
  const urgent = variant === 'danger' || variant === 'warning';
  const wrapper = document.createElement('div');
  wrapper.className = `toast align-items-center text-bg-${variant} border-0`;
  wrapper.setAttribute('role', urgent ? 'alert' : 'status');
  wrapper.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  wrapper.setAttribute('aria-atomic', 'true');
  wrapper.innerHTML = `
    <div class="d-flex align-items-center">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn btn-sm btn-light toast-action me-1">${escapeHtml(actionLabel)}</button>
      <button type="button" class="btn-close btn-close-white me-2" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(wrapper);

  const instance = new Toast(wrapper, { delay });
  wrapper.querySelector('.toast-action').addEventListener('click', () => {
    instance.hide();
    onAction();
  });
  instance.show();
  wrapper.addEventListener('hidden.bs.toast', () => wrapper.remove());
}

/**
 * Follow a dashboard link such as `?section=active-chats&chat=abc`, without
 * reloading the page.
 */
export function openLink(link) {
  if (!link) {
    return;
  }
  const query = String(link).includes('?') ? String(link).slice(String(link).indexOf('?') + 1) : String(link);
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  const section = params.section || (params.chat ? 'active-chats' : null);
  delete params.section;
  if (section) {
    showSection(section, { params });
  }
}

// ------------------------------------------------------------------ bell

/** Where a stored notification goes when clicked. */
function linkOf(notification) {
  if (notification.link) {
    return notification.link;
  }
  if (notification.sessionId) {
    return `?section=active-chats&chat=${encodeURIComponent(notification.sessionId)}`;
  }
  const taskId = notification.taskId && (notification.taskId._id || notification.taskId);
  return taskId ? `?section=tasks&taskId=${encodeURIComponent(taskId)}` : null;
}

function render() {
  const list = document.getElementById('notification-list');
  const badge = document.getElementById('notification-count');
  if (!list || !badge) {
    return;
  }

  badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  badge.classList.toggle('d-none', unreadCount === 0);

  const more = document.getElementById('notifications-more-btn');
  if (more) {
    more.style.display = hasMore ? '' : 'none';
  }

  if (notifications.length === 0) {
    list.innerHTML = '<div class="text-muted small text-center py-3">You are all caught up</div>';
    return;
  }

  list.innerHTML = notifications.map(n => {
    const meta = ICONS[n.type] || { icon: 'bell', className: 'text-secondary' };
    return `
      <div class="notification-row ${n.read ? '' : 'is-unread'}" data-notification-id="${escapeHtml(n._id)}">
        <button type="button" class="notification-item ${n.read ? '' : 'is-unread'}" data-open-notification>
          <span class="notification-icon ${meta.className}"><i data-feather="${meta.icon}"></i></span>
          <span class="notification-body">
            <span class="notification-message">${escapeHtml(n.message)}</span>
            <span class="notification-time">${escapeHtml(formatRelativeTime(n.createdAt))}</span>
          </span>
        </button>
        <button type="button" class="btn-close notification-delete" data-delete-notification
                aria-label="Remove this notification"></button>
      </div>`;
  }).join('');

  if (typeof feather !== 'undefined') {
    feather.replace();
  }
}

async function load({ append = false } = {}) {
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (append && notifications.length) {
      params.set('before', notifications[notifications.length - 1].createdAt);
    }
    const data = await api(`/api/notifications?${params.toString()}`);
    const fetched = data.notifications || [];

    if (append) {
      const known = new Set(notifications.map(n => n._id));
      notifications = notifications.concat(fetched.filter(n => !known.has(n._id)));
    } else {
      notifications = fetched;
    }
    hasMore = Boolean(data.hasMore);
    unreadCount = typeof data.unread === 'number'
      ? data.unread
      : notifications.filter(n => !n.read).length;
    render();
  } catch (error) {
    logger.error('Failed to load notifications:', error);
  }
}

async function open(notificationId) {
  const notification = notifications.find(n => n._id === notificationId);
  if (!notification) {
    return;
  }

  if (!notification.read) {
    notification.read = true;
    unreadCount = Math.max(0, unreadCount - 1);
    render();
    try {
      await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PUT' });
    } catch (error) {
      // Revert so the badge does not lie about what has been read.
      notification.read = false;
      unreadCount += 1;
      render();
      logger.error('Failed to mark notification read:', error);
    }
  }

  openLink(linkOf(notification));
}

async function remove(notificationId) {
  const index = notifications.findIndex(n => n._id === notificationId);
  if (index < 0) {
    return;
  }
  const [removed] = notifications.splice(index, 1);
  if (!removed.read) {
    unreadCount = Math.max(0, unreadCount - 1);
  }
  render();

  try {
    await api(`/api/notifications/${encodeURIComponent(notificationId)}`, { method: 'DELETE' });
  } catch (error) {
    notifications.splice(index, 0, removed);
    if (!removed.read) {
      unreadCount += 1;
    }
    render();
    showToast('Could not remove that notification', 'danger');
  }
}

async function markAllRead() {
  const previous = notifications.map(n => n.read);
  const previousCount = unreadCount;
  notifications.forEach(n => {
    n.read = true;
  });
  unreadCount = 0;
  render();

  try {
    await api('/api/notifications/read-all', { method: 'PUT' });
  } catch (error) {
    notifications.forEach((n, i) => {
      n.read = previous[i];
    });
    unreadCount = previousCount;
    render();
    showToast('Could not mark notifications as read', 'danger');
  }
}

/** A stored notification arriving live: the bell, and maybe an alert. */
function received(notification) {
  if (notifications.some(n => n._id === notification._id)) {
    return;
  }
  notifications.unshift(notification);
  if (!notification.read) {
    unreadCount += 1;
  }
  render();

  const kind = KIND_OF[notification.type] || 'task';
  const link = linkOf(notification);
  // A chat assigned or transferred is usually announced live as well; the
  // key makes it interrupt once whichever arrives first.
  const key = notification.sessionId ? `${kind}:${notification.sessionId}` : `notification:${notification._id}`;

  alertPerson({
    kind,
    key,
    title: notification.message,
    open: link ? () => openLink(link) : undefined,
    // Deadline reminders are in the bell; a toast for each one would bury
    // the ones that are about a waiting customer.
    toast: kind !== 'task'
  });
}

export function setupNotifications(socket) {
  if (!document.getElementById('notification-list')) {
    return;
  }

  document.getElementById('mark-all-read-btn')?.addEventListener('click', markAllRead);
  document.getElementById('notifications-more-btn')?.addEventListener('click', () => load({ append: true }));

  document.getElementById('notification-list').addEventListener('click', event => {
    const row = event.target.closest('[data-notification-id]');
    if (!row) {
      return;
    }
    if (event.target.closest('[data-delete-notification]')) {
      event.stopPropagation();
      remove(row.dataset.notificationId);
    } else if (event.target.closest('[data-open-notification]')) {
      open(row.dataset.notificationId);
    }
  });

  // Live delivery: the server emits to the person's own room.
  if (socket) {
    socket.on('notification-created', data => {
      if (data && data.notification) {
        received(data.notification);
      }
    });

    // The same person in another tab.
    socket.on('notification-updated', data => {
      const updated = data && data.notification;
      const known = updated && notifications.find(n => n._id === String(updated._id));
      if (known && !known.read && updated.read) {
        known.read = true;
        unreadCount = Math.max(0, unreadCount - 1);
        render();
      }
    });
    socket.on('notification-deleted', data => {
      const index = notifications.findIndex(n => n._id === (data && data.notificationId));
      if (index >= 0) {
        const [removed] = notifications.splice(index, 1);
        if (!removed.read) {
          unreadCount = Math.max(0, unreadCount - 1);
        }
        render();
      }
    });
    socket.on('notifications-all-read', () => {
      notifications.forEach(n => {
        n.read = true;
      });
      unreadCount = 0;
      render();
    });
  }

  load();

  // A slow poll covers the case where the socket dropped and reconnected
  // while a notification was created.
  setInterval(() => load(), 5 * 60 * 1000);
}
