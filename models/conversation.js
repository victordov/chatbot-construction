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
  metadata: {
    type: Map,
    of: String
  },
  tasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  }],
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
  }
});

// Index for faster querying
ConversationSchema.index({ sessionId: 1 });
ConversationSchema.index({ userId: 1 });
ConversationSchema.index({ status: 1 });
ConversationSchema.index({ lastActivity: 1 });

const Conversation = mongoose.model('Conversation', ConversationSchema);

module.exports = Conversation;
