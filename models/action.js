const mongoose = require('mongoose');

/**
 * Something the bot can do in the tenant's own systems, defined once.
 *
 * Before this, calling a tenant's API meant drawing a Call an API node inside a
 * workflow: the request lived in one node of one graph, and the assistant —
 * which answers every conversation that has no workflow — could not use it at
 * all. Every support product we compete with converged on the same answer (see
 * docs/research/customer-data-connection-2026-09.md): a form-defined action
 * with a "when to use this" description, typed inputs, a vaulted credential,
 * and a switch between "the model may call it" and "only inside a flow".
 *
 * `description` is load-bearing: it is the text the model reads when deciding
 * whether this action answers the visitor's question, so it is written for the
 * model, not for the dashboard.
 *
 * Inputs come from one of three places, and the difference is the security
 * model:
 *
 *   visitor    the model collects it from the conversation. Anything a visitor
 *              says can be a lie, so these are never used to decide whose
 *              account is being read.
 *   verified   taken from the conversation's verified contact, server-side.
 *              Never from the model's arguments — a model can be talked into
 *              passing somebody else's customer id; a signed identity cannot.
 *   constant   fixed by the tenant (a shop domain, an API version).
 *
 * Tenant-scoped through `company`, so services/tenant-backup.js picks it up
 * without being told.
 */

const InputSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, maxlength: 300 },
  type: { type: String, enum: ['string', 'number', 'boolean'], default: 'string' },
  required: { type: Boolean, default: true },
  source: { type: String, enum: ['visitor', 'verified', 'constant'], default: 'visitor' },
  /** For `constant`. Not a secret — credentials go in `request.auth`. */
  value: { type: String, maxlength: 500 },
  /** For `verified`: which contact field, e.g. `externalId` or `email`. */
  attribute: { type: String, trim: true }
}, { _id: false });

const OutputSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  path: { type: String, required: true, trim: true }
}, { _id: false });

const ActionSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /** Slug, unique per company. Also the tool name the model sees. */
  name: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  /** "When to use this". Drives the model's choice. */
  description: { type: String, trim: true, maxlength: 1000, default: '' },
  inputs: [InputSchema],
  request: {
    method: { type: String, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
    url: { type: String, required: true, trim: true },
    headers: { type: mongoose.Schema.Types.Mixed, default: {} },
    body: { type: String, default: '' },
    timeoutMs: { type: Number },
    auth: {
      type: { type: String, enum: ['none', 'bearer', 'header', 'basic'], default: 'none' },
      header: { type: String, trim: true },
      // Encrypted by services/secrets.js. `select: false` so a listing never
      // loads it; only the code that sends the request asks for it.
      value: { type: String, select: false }
    }
  },
  response: {
    mode: { type: String, enum: ['raw', 'paths'], default: 'paths' },
    maxBytes: { type: Number, default: 4000 },
    outputs: [OutputSchema]
  },
  /** `auto`: the assistant may call it. `workflow_only`: only from a node. */
  mode: { type: String, enum: ['auto', 'workflow_only'], default: 'auto' },
  requiresVerified: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ActionSchema.index({ company: 1, name: 1 }, { unique: true });

/** Anything that is not a GET changes somebody's data. */
ActionSchema.methods.isWrite = function() {
  return String(this.request?.method || 'GET').toUpperCase() !== 'GET';
};

module.exports = mongoose.model('Action', ActionSchema);
