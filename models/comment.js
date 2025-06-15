const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  authorName: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  isEdited: {
    type: Boolean,
    default: false
  },
  attachments: [{
    name: String,
    url: String,
    type: String
  }]
});

// Index for faster querying
CommentSchema.index({ taskId: 1 });
CommentSchema.index({ author: 1 });
CommentSchema.index({ createdAt: 1 });

const Comment = mongoose.model('Comment', CommentSchema);

module.exports = Comment;