const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
  // Reference to the task this activity belongs to
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  
  // Type of activity
  type: {
    type: String,
    enum: [
      'task_created',
      'task_updated', 
      'task_assigned',
      'task_unassigned',
      'status_changed',
      'priority_changed',
      'due_date_changed',
      'comment_added',
      'comment_updated',
      'comment_deleted',
      'follow_up_created',
      'task_completed',
      'task_deleted'
    ],
    required: true
  },
  
  // User who performed the action
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // User details for faster queries (denormalized)
  userName: {
    type: String,
    required: true
  },
  
  // Description of the activity
  description: {
    type: String,
    required: true
  },
  
  // Additional metadata for the activity
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  
  // Old and new values for update activities
  changes: {
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
    field: String
  },
  
  // Company context (for scoping activities to company)
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false, // Made optional to support super admin users
    default: null
  },
  
  // Timestamp
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for faster querying
ActivitySchema.index({ taskId: 1, createdAt: -1 });
ActivitySchema.index({ user: 1 });
ActivitySchema.index({ company: 1 });
ActivitySchema.index({ type: 1 });
ActivitySchema.index({ createdAt: -1 });

const Activity = mongoose.model('Activity', ActivitySchema);

module.exports = Activity;
