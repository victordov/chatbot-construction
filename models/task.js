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
    ref: 'User'
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
  parentTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
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
          return !v || /^[\d\s+\-()]{7,20}$/.test(v);
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
  // Company reference for multi-tenancy
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false, // Made optional to support super admin users
    default: null
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

// Indexes.
//
// Every dashboard query is scoped to a company first, so leading each index
// with `company` lets one index serve the filter, the sort and the covering
// scan. The previous ten single-field indexes could not do that: a query for
// "this company's open tasks sorted by due date" used one of them and then
// sorted in memory, while the other nine cost write throughput for nothing.
TaskSchema.index({ company: 1, createdAt: -1 });
TaskSchema.index({ company: 1, status: 1, dueDate: 1 });
TaskSchema.index({ company: 1, assignee: 1, status: 1 });
TaskSchema.index({ company: 1, priority: 1, dueDate: 1 });

// Follow-up lookups and the conversation drill-through.
TaskSchema.index({ parentTaskId: 1 });
TaskSchema.index({ conversationId: 1 });

// The deadline sweep scans across companies by due date and status.
TaskSchema.index({ dueDate: 1, status: 1 });

const Task = mongoose.model('Task', TaskSchema);

module.exports = Task;
