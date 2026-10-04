/**
 * Notification bell.
 *
 * The notification model, service, scheduler and REST API all existed, but
 * nothing in the dashboard ever called them - deadline reminders were written
 * to the database and never seen by anyone.
 */

import feather from 'feather-icons';
import { showSection } from './nav.js';
import { api, escapeHtml, formatRelativeTime, logger, showToast } from './utils.js';

let notifications = [];


const ICONS = {
  task_overdue: { icon: 'alert-circle', className: 'text-danger' },
  task_due_today: { icon: 'clock', className: 'text-warning' },
  task_due_tomorrow: { icon: 'calendar', className: 'text-info' }
};

function render() {
  const list = document.getElementById('notification-list');
  const badge = document.getElementById('notification-count');
  if (!list || !badge) {
    return;
  }

  const unread = notifications.filter(n => !n.read).length;
  badge.textContent = unread > 99 ? '99+' : unread;
  badge.classList.toggle('d-none', unread === 0);

  if (notifications.length === 0) {
    list.innerHTML = '<div class="text-muted small text-center py-3">You are all caught up</div>';
    return;
  }

  list.innerHTML = notifications.map(n => {
    const meta = ICONS[n.type] || { icon: 'bell', className: 'text-secondary' };
    return `
      <button type="button" class="notification-item ${n.read ? '' : 'is-unread'}"
              data-notification-id="${escapeHtml(n._id)}"
              data-task-id="${escapeHtml(n.taskId?._id || n.taskId || '')}">
        <span class="notification-icon ${meta.className}"><i data-feather="${meta.icon}"></i></span>
        <span class="notification-body">
          <span class="notification-message">${escapeHtml(n.message)}</span>
          <span class="notification-time">${escapeHtml(formatRelativeTime(n.createdAt))}</span>
        </span>
      </button>`;
  }).join('');

  list.querySelectorAll('[data-notification-id]').forEach(item => {
    item.addEventListener('click', () => open(item.dataset.notificationId, item.dataset.taskId));
  });

  if (typeof feather !== 'undefined') {
    feather.replace();
  }
}

async function load() {
  try {
    const { notifications: fetched } = await api('/api/notifications');
    notifications = fetched || [];
    render();
  } catch (error) {
    logger.error('Failed to load notifications:', error);
  }
}

async function open(notificationId, taskId) {
  const notification = notifications.find(n => n._id === notificationId);

  if (notification && !notification.read) {
    notification.read = true;
    render();
    try {
      await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PUT' });
    } catch (error) {
      // Revert so the badge does not lie about what has been read.
      notification.read = false;
      render();
      logger.error('Failed to mark notification read:', error);
    }
  }

  if (taskId) {
    showSection('tasks', { params: { taskId } });
  }
}

async function markAllRead() {
  const previous = notifications.map(n => n.read);
  notifications.forEach(n => {
    n.read = true;
  });
  render();

  try {
    await api('/api/notifications/read-all', { method: 'PUT' });
  } catch (error) {
    notifications.forEach((n, i) => {
      n.read = previous[i];
    });
    render();
    showToast('Could not mark notifications as read', 'danger');
  }
}

export function setupNotifications(socket) {
  if (!document.getElementById('notification-list')) {
    return;
  }

  document.getElementById('mark-all-read-btn')?.addEventListener('click', markAllRead);

  // Live delivery: the scheduler emits to the assignee's own room.
  if (socket) {
    socket.on('notification-created', data => {
      if (!data || !data.notification) {
        return;
      }
      notifications.unshift(data.notification);
      render();

      if (localStorage.getItem('notification-setting') !== 'none' &&
          'Notification' in window && Notification.permission === 'granted') {
        new Notification('Task reminder', { body: data.notification.message });
      }
    });
  }

  load();

  // A slow poll covers the case where the socket dropped and reconnected
  // while a notification was created.
  setInterval(load, 5 * 60 * 1000);
}
