const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
  },
  sender: {
    type: String,
    enum: ['user', 'bot', 'operator'],
    required: true
  },
  messageId: {
    type: String
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  },
  encrypted: {
    type: Boolean,
    default: false
  },
  fileId: {
    type: String
  },
  fileName: {
    type: String
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  operatorName: {
    type: String
  },
  attachments: [{
    filename: String,
    url: String,
    mimeType: String
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const ConversationSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String
  },
  domain: {
    type: String
  },
  messages: [MessageSchema],
  status: {
    type: String,
    enum: ['active', 'ended', 'archived'],
    default: 'active'
  },
  hasOperator: {
    type: Boolean,
    default: false
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  operatorName: {
    type: String
  },
  suggestionsEnabled: {
    type: Boolean,
    default: true
  },
  botEnabled: {
    type: Boolean,
    default: true
  },
  metadata: {
    type: Map,
    of: String
  },
  tasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
  /**
   * Operator-only notes. Never sent to the visitor and never included in the
   * model's context — the whole point is somewhere to write things you would
   * not say out loud, and to carry context across a handover.
   */
  notes: [{
    body: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorName: { type: String },
    /** System notes record transfers and similar events. */
    system: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],
  /**
   * Who has handed this conversation on, and to whom. Kept so an operator
   * picking up a transferred chat can see where it came from.
   */
  transferredFrom: {
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    operatorName: { type: String },
    at: { type: Date }
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  endedAt: {
    type: Date
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company'
  },
  /**
   * The person behind this conversation. Lets an operator see everything the
   * same customer has asked before, across sessions and devices.
   */
  contact: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact'
  }
});

// Indexes tuned for the dashboard's access patterns.
// `sessionId` is already indexed by its `unique: true` constraint.
ConversationSchema.index({ userId: 1 });
// Active-chat list: filter by company + status, sort by lastActivity.
ConversationSchema.index({ company: 1, status: 1, lastActivity: -1 });
// Chat history and analytics: filter by company, sort/range by startedAt.
ConversationSchema.index({ company: 1, startedAt: -1 });
ConversationSchema.index({ status: 1, lastActivity: -1 });
// A contact's history, newest first.
ConversationSchema.index({ contact: 1, startedAt: -1 });

const Conversation = mongoose.model('Conversation', ConversationSchema);

module.exports = Conversation;
