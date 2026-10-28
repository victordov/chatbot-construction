const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'task_due_tomorrow', 'task_due_today', 'task_overdue', 'task_assigned',
      'chat_assigned', 'chat_transferred', 'visitor_waiting', 'low_rating',
      'usage_warning'
    ],
    required: true
  },
  // Task notifications point at a task; conversation ones at a session.
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: function() {
      return /^task_/.test(this.type);
    }
  },
  sessionId: {
    type: String
  },
  /** Where clicking the notification goes, as a dashboard section link. */
  link: {
    type: String
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  message: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// The bell only ever asks for "this user's notifications, newest first", and
// the dedupe check asks for "a notification of this type for this task".
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, read: 1 });
NotificationSchema.index({ taskId: 1, type: 1 });

// Expire read notifications after 30 days so the collection does not grow
// without bound; nobody reads a month-old deadline reminder.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const Notification = mongoose.model('Notification', NotificationSchema);

module.exports = Notification;