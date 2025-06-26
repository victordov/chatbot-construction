const mongoose = require('mongoose');

const WorkflowSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  version: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft'
  },
  
  // React Flow graph data
  nodes: [{
    id: { type: String, required: true },
    type: { type: String, required: true },
    position: {
      x: { type: Number, required: true },
      y: { type: Number, required: true }
    },
    data: { type: mongoose.Schema.Types.Mixed, required: true }
  }],
  
  edges: [{
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    type: { type: String, default: 'default' },
    data: { type: mongoose.Schema.Types.Mixed }
  }],
  
  // Compiled execution plan
  compiledChain: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Multi-tenancy
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      return this.createdBy && this.createdBy.role !== 'superadmin';
    },
    default: null
  },
  
  // Root system prompt that tenants cannot edit
  rootSystemPrompt: {
    type: String,
    default: "You are a helpful AI assistant. Always be respectful, accurate, and helpful. Follow all safety guidelines and never provide harmful information."
  },
  
  // Moderation settings (enforced by platform)
  moderationConfig: {
    enabled: { type: Boolean, default: true },
    strictness: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    customFilters: [String]
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
  
  publishedAt: {
    type: Date
  },
  
  // Performance tracking
  executionStats: {
    totalExecutions: { type: Number, default: 0 },
    averageExecutionTime: { type: Number, default: 0 },
    lastExecuted: { type: Date }
  }
});

// Indexes for performance
WorkflowSchema.index({ company: 1, status: 1 });
WorkflowSchema.index({ createdBy: 1 });
WorkflowSchema.index({ status: 1, publishedAt: -1 });
WorkflowSchema.index({ 'executionStats.lastExecuted': -1 });

// Pre-save middleware
WorkflowSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
WorkflowSchema.methods.incrementVersion = function() {
  this.version += 1;
  this.updatedAt = new Date();
  return this.save();
};

WorkflowSchema.methods.publish = function() {
  this.status = 'published';
  this.publishedAt = new Date();
  return this.save();
};

WorkflowSchema.methods.archive = function() {
  this.status = 'archived';
  return this.save();
};

// Static methods
WorkflowSchema.statics.getActiveWorkflow = function(companyId) {
  return this.findOne({
    company: companyId,
    status: 'published'
  }).sort({ publishedAt: -1 });
};

WorkflowSchema.statics.getWorkflowsByCompany = function(companyId, status = null) {
  const filter = { company: companyId };
  if (status) filter.status = status;
  
  return this.find(filter)
    .populate('createdBy', 'username displayName')
    .sort({ updatedAt: -1 });
};

const Workflow = mongoose.model('Workflow', WorkflowSchema);

module.exports = Workflow;
