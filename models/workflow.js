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

  /**
   * Which messages this workflow answers.
   *
   *   always    every message the bot gets - the old behaviour, and still what
   *             a workflow saved before triggers existed means. At most one
   *             live per tenant, or two flows would fight over every message.
   *   intent    "when the visitor wants <description>", decided by a cheap
   *             classifier against every live intent workflow at once
   *   keywords  when the message contains one of these words
   *
   * Everything a live workflow does not answer goes to the assistant, so a
   * "where is my order?" flow no longer stops the bot answering from the
   * knowledge base the moment it is published.
   */
  trigger: {
    type: { type: String, enum: ['always', 'intent', 'keywords'], default: 'always' },
    description: { type: String, trim: true, maxlength: 200 },
    keywords: [{ type: String, trim: true, maxlength: 60 }]
  },

  /**
   * The version visitors are getting, while `version` is the one being edited.
   *
   * Saving a live workflow used to hot-swap it at once, so a half-finished edit
   * reached customers the moment somebody pressed Save. Now a save is a draft
   * (a new version snapshot) and only Publish moves `liveVersion`. A workflow
   * published before this existed has none, and serves its own nodes.
   */
  liveVersion: {
    type: Number
  },

  /** The trigger as it was published, so a draft edit to it is not live either. */
  liveTrigger: {
    type: { type: String, enum: ['always', 'intent', 'keywords'] },
    description: { type: String },
    keywords: [{ type: String }]
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
    // Which output the edge leaves from: a router's condition id or
    // "default", an action's "success" or "error".
    //
    // Missing from this schema until now, so mongoose dropped it on save and
    // every branch a tenant drew collapsed to "no handle" the moment the
    // workflow was reloaded - a router with three rules routed everything the
    // same way, and the failure branch of an action was unreachable.
    sourceHandle: { type: String, default: null },
    targetHandle: { type: String, default: null },
    type: { type: String, default: 'default' },
    data: { type: mongoose.Schema.Types.Mixed }
  }],

  // Compiled execution plan
  compiledChain: {
    type: mongoose.Schema.Types.Mixed
  },

  // Multi-tenancy. Null only for a workflow a superadmin created outside any
  // tenant; the service sets it from the user, never from the request.
  //
  // This used to be `required` when `this.createdBy.role !== 'superadmin'`,
  // but `createdBy` is an ObjectId, so `.role` was always undefined and the
  // guard was always true - it never did what it said.
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    default: null
  },

  // Root system prompt that tenants cannot edit
  rootSystemPrompt: {
    type: String,
    default: 'You are a helpful AI assistant. Always be respectful, accurate, and helpful. Follow all safety guidelines and never provide harmful information.'
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

  publishedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  /**
   * What the workflow has done with real visitors. Previews and "Test your
   * bot" are not counted.
   *
   *   runs         turns that started the flow from the top
   *   completions  turns that reached the end of the flow without a handover
   *   handoffs     turns that ended handing the visitor to a person
   *   errors       turns where a step failed
   *
   * Written by the runtime in batches (see workflow-runtime.js), never on the
   * path of a reply. These were declared before and never written, so every
   * workflow showed zero.
   */
  executionStats: {
    runs: { type: Number, default: 0 },
    completions: { type: Number, default: 0 },
    handoffs: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    lastRunAt: { type: Date }
  }
});

// Indexes for performance
WorkflowSchema.index({ company: 1, status: 1 });
WorkflowSchema.index({ createdBy: 1 });
WorkflowSchema.index({ status: 1, publishedAt: -1 });

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
  // Nothing is live any more, so nothing is "the live version".
  this.liveVersion = undefined;
  this.liveTrigger = undefined;
  return this.save();
};

// Static methods
WorkflowSchema.statics.getActiveWorkflow = function(companyId) {
  return this.findOne({
    company: companyId,
    status: 'published'
  }).sort({ publishedAt: -1 });
};

/**
 * Every workflow a tenant has live, oldest publish first, so the order in
 * which triggers are tried is stable between processes.
 */
WorkflowSchema.statics.getLiveWorkflows = function(companyId) {
  return this.find({ company: companyId, status: 'published' }).sort({ publishedAt: 1, _id: 1 });
};

/** A trigger with its gaps filled: no trigger at all means `always`. */
function normaliseTrigger(trigger) {
  const plain = trigger && typeof trigger.toObject === 'function' ? trigger.toObject() : (trigger || {});
  const type = ['always', 'intent', 'keywords'].includes(plain.type) ? plain.type : 'always';
  return {
    type,
    description: String(plain.description || '').trim(),
    keywords: (Array.isArray(plain.keywords) ? plain.keywords : [])
      .map(keyword => String(keyword || '').trim())
      .filter(Boolean)
  };
}

/** The trigger visitors are getting, which is the published one. */
WorkflowSchema.statics.liveTriggerOf = function(workflow) {
  const live = workflow && workflow.liveTrigger && workflow.liveTrigger.type ? workflow.liveTrigger : null;
  return normaliseTrigger(live || (workflow && workflow.trigger));
};

WorkflowSchema.statics.normaliseTrigger = normaliseTrigger;

/**
 * The graph visitors are getting: the `liveVersion` snapshot when the
 * workflow has unpublished edits, its own nodes otherwise.
 *
 * @returns {Promise<{nodes: Array, edges: Array, version: number,
 *                    trigger: object}>}
 */
WorkflowSchema.statics.liveGraph = async function(workflow) {
  const own = {
    nodes: workflow.nodes || [],
    edges: workflow.edges || [],
    version: workflow.version,
    trigger: this.liveTriggerOf(workflow)
  };

  if (!workflow.liveVersion || workflow.liveVersion === workflow.version) {
    return own;
  }

  // Required here: the version model requires nothing back, but keeping the
  // dependency one-way at load time costs nothing.
  const WorkflowVersion = require('./workflow-version');
  const snapshot = await WorkflowVersion.findOne({
    workflowId: workflow._id,
    version: workflow.liveVersion
  }).lean();

  if (!snapshot) {
    // Every save writes a snapshot, so this is a damaged history rather than a
    // normal state. Serving the draft is the least bad answer: the
    // alternative is a dead bot.
    return own;
  }

  return {
    nodes: snapshot.nodes || [],
    edges: snapshot.edges || [],
    version: snapshot.version,
    trigger: this.liveTriggerOf({ liveTrigger: workflow.liveTrigger, trigger: snapshot.trigger })
  };
};

/** Whether the draft differs from what visitors get. */
WorkflowSchema.statics.hasUnpublishedChanges = function(workflow) {
  return Boolean(workflow && workflow.status === 'published' &&
    workflow.liveVersion && workflow.liveVersion !== workflow.version);
};

WorkflowSchema.statics.getWorkflowsByCompany = function(companyId, status = null) {
  const filter = { company: companyId };
  if (status) {
    filter.status = status;
  }

  return this.find(filter)
    .populate('createdBy', 'username displayName')
    .sort({ updatedAt: -1 });
};

const Workflow = mongoose.model('Workflow', WorkflowSchema);

module.exports = Workflow;
