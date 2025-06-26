const mongoose = require('mongoose');

const WorkflowVersionSchema = new mongoose.Schema({
  workflowId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workflow',
    required: true
  },
  
  version: {
    type: Number,
    required: true
  },
  
  // Snapshot of workflow state at this version
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
  
  // Compiled execution plan for this version
  compiledChain: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Version metadata
  changeDescription: {
    type: String,
    trim: true
  },
  
  isRollback: {
    type: Boolean,
    default: false
  },
  
  rollbackFromVersion: {
    type: Number
  },
  
  // Performance data for this version
  performanceMetrics: {
    compilationTime: { type: Number }, // milliseconds
    validationTime: { type: Number }, // milliseconds
    nodeCount: { type: Number },
    edgeCount: { type: Number },
    complexityScore: { type: Number } // calculated complexity metric
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
});

// Compound index for efficient version queries
WorkflowVersionSchema.index({ workflowId: 1, version: -1 });
WorkflowVersionSchema.index({ createdAt: -1 });
WorkflowVersionSchema.index({ workflowId: 1, createdAt: -1 });

// Static methods
WorkflowVersionSchema.statics.getVersionHistory = function(workflowId, limit = 10) {
  return this.find({ workflowId })
    .populate('createdBy', 'username displayName')
    .sort({ version: -1 })
    .limit(limit);
};

WorkflowVersionSchema.statics.getVersion = function(workflowId, version) {
  return this.findOne({ workflowId, version });
};

WorkflowVersionSchema.statics.getLatestVersion = function(workflowId) {
  return this.findOne({ workflowId })
    .sort({ version: -1 });
};

// Methods
WorkflowVersionSchema.methods.calculateComplexity = function() {
  const nodeCount = this.nodes.length;
  const edgeCount = this.edges.length;
  
  // Simple complexity calculation based on nodes, edges, and node types
  let complexityScore = nodeCount + (edgeCount * 0.5);
  
  // Add complexity based on node types
  this.nodes.forEach(node => {
    switch (node.type) {
      case 'router':
        complexityScore += 2; // Routing logic adds complexity
        break;
      case 'knowledge':
        complexityScore += 1.5; // Knowledge retrieval adds some complexity
        break;
      case 'moderation':
        complexityScore += 1; // Moderation is relatively simple
        break;
      default:
        complexityScore += 0.5; // Base node complexity
    }
  });
  
  return Math.round(complexityScore * 100) / 100; // Round to 2 decimal places
};

// Pre-save middleware to calculate metrics
WorkflowVersionSchema.pre('save', function(next) {
  if (this.isNew) {
    this.performanceMetrics = this.performanceMetrics || {};
    this.performanceMetrics.nodeCount = this.nodes.length;
    this.performanceMetrics.edgeCount = this.edges.length;
    this.performanceMetrics.complexityScore = this.calculateComplexity();
  }
  next();
});

const WorkflowVersion = mongoose.model('WorkflowVersion', WorkflowVersionSchema);

module.exports = WorkflowVersion;
