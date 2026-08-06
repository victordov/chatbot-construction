const mongoose = require('mongoose');

/**
 * A canned reply a company can send without involving the model.
 *
 * Templates used to be a hardcoded module of property-management copy, which
 * meant every tenant's bot talked about mortgages and lease renewals whatever
 * business they were actually in. They are now owned by the company: nothing
 * about any particular industry lives in the codebase.
 *
 * Two ways a template is chosen:
 *
 *   `role`     a fixed conversational slot — the greeting, the fallback, the
 *              hand-off line. At most one enabled template per role.
 *   `triggers` example phrases matched semantically against what the visitor
 *              said, the same mechanism workflow router intents use.
 */
const ResponseTemplateSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  /**
   * Fixed slots the runtime looks up by name. `null` means the template is
   * only reachable through its triggers.
   */
  role: {
    type: String,
    enum: ['greeting', 'fallback', 'offTopic', 'handoff', null],
    default: null
  },
  /**
   * Example phrases. A visitor's message is matched against these by meaning,
   * so "can I get my money back" reaches a template whose triggers only say
   * "refund".
   */
  triggers: [{
    type: String,
    trim: true
  }],
  /**
   * Variations. One is chosen at random so a bot that answers the same
   * question twice does not sound like a recording.
   */
  responses: [{
    type: String,
    required: true
  }],
  /**
   * Values substituted into `[PLACEHOLDER]` markers. Per-company, because
   * opening hours and phone numbers are not platform constants.
   */
  variables: {
    type: Map,
    of: String
  },
  /**
   * How confident the semantic match must be. Exposed per template because a
   * narrow template ("cancel my account") wants a higher bar than a broad one
   * ("billing").
   */
  threshold: {
    type: Number,
    default: 0.35,
    min: 0,
    max: 1
  },
  enabled: {
    type: Boolean,
    default: true
  },
  /** How often this template has been sent, for pruning ones that never fire. */
  useCount: {
    type: Number,
    default: 0
  },
  lastUsedAt: { type: Date },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Lookups are always "this company's enabled templates", either all of them or
// the one filling a given role.
ResponseTemplateSchema.index({ company: 1, enabled: 1 });
ResponseTemplateSchema.index({ company: 1, role: 1 });

ResponseTemplateSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Every enabled template for a company.
 */
ResponseTemplateSchema.statics.forCompany = function(companyId) {
  return this.find({ company: companyId, enabled: true }).lean();
};

const ResponseTemplate = mongoose.model('ResponseTemplate', ResponseTemplateSchema);

module.exports = ResponseTemplate;
