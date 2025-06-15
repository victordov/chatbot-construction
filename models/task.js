const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  dueDate: {
    type: Date,
    required: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  assignee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  assigneeName: {
    type: String
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'completed'],
    default: 'open'
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation'
  },
  contactInfo: {
    name: {
      type: String,
      trim: true
    },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Basic phone validation - can be enhanced based on requirements
          return !v || /^[\d\s\+\-\(\)]{7,20}$/.test(v);
        },
        message: props => `${props.value} is not a valid phone number!`
      }
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      validate: {
        validator: function(v) {
          // Basic email validation
          return !v || /^\S+@\S+\.\S+$/.test(v);
        },
        message: props => `${props.value} is not a valid email address!`
      }
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date
  }
});

// Index for faster querying
TaskSchema.index({ assignee: 1 });
TaskSchema.index({ status: 1 });
TaskSchema.index({ dueDate: 1 });
TaskSchema.index({ priority: 1 });
TaskSchema.index({ conversationId: 1 });
TaskSchema.index({ 'contactInfo.email': 1 });
TaskSchema.index({ 'contactInfo.phone': 1 });
TaskSchema.index({ 'contactInfo.name': 1 });

const Task = mongoose.model('Task', TaskSchema);

module.exports = Task;
