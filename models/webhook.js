const mongoose = require('mongoose');

/**
 * Where a tenant wants to be told when something happens here.
 *
 * Until now this platform could be told things — a workflow action node calls
 * a tenant's API — but it could not tell anybody anything. A conversation
 * ended, a customer rated it one out of five, a lead qualified itself, and the
 * tenant's CRM, data warehouse and on-call rota learned none of it. That makes
 * the product a silo: everything it knows has to be read out of a dashboard by
 * a person.
 *
 * This is deliberately the same shape as every other webhook system a
 * developer has already integrated — a URL, a set of events, a signing secret —
 * because the value here is being unsurprising. Nobody wants to learn our
 * webhook format.
 */
const WebhookSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /** What it is for, in the tenant's words. Shown in the list. */
  description: {
    type: String,
    trim: true,
    maxlength: 200
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  /**
   * Which events to send. Empty means none — never "all", because a webhook
   * that silently starts receiving a new event type when we ship one is a
   * surprise, and surprises in someone else's production system are ours to
   * avoid.
   */
  events: [{ type: String }],
  /**
   * The signing secret, so a receiver can prove a delivery came from us.
   *
   * `select: false` because it is never needed for a listing, and a field you
   * have to ask for is a field that does not leak by accident. Encrypted at
   * rest by services/secrets.js.
   */
  secret: {
    type: String,
    select: false
  },
  enabled: {
    type: Boolean,
    default: true
  },
  /**
   * Failure tracking, so a dead endpoint stops being retried forever.
   *
   * An endpoint that has been gone for a week is not coming back this minute,
   * and hammering it wastes our capacity and their logs.
   */
  consecutiveFailures: {
    type: Number,
    default: 0
  },
  disabledAt: { type: Date },
  disabledReason: { type: String },
  lastSuccessAt: { type: Date },
  lastFailureAt: { type: Date },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

// Dispatch reads by company and event on every emitted event, which is the
// hottest path this collection has.
WebhookSchema.index({ company: 1, enabled: 1, events: 1 });

WebhookSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Webhook = mongoose.model('Webhook', WebhookSchema);

module.exports = Webhook;
