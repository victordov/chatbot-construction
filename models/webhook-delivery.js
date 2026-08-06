const mongoose = require('mongoose');

/**
 * Every attempt to deliver a webhook, and what came back.
 *
 * This is the difference between a webhook system somebody can integrate
 * against and one that generates support tickets. "It isn't firing" is
 * unanswerable without a record; with one it is a thirty-second question —
 * did we send it, what did we send, what did they say, and when do we try
 * again.
 *
 * It is also the retry queue. Holding pending retries in memory would lose
 * them on every deploy, which is precisely when endpoints are most likely to
 * have been failing, so a pending attempt is a row with a time on it and a
 * scheduled sweep picks it up.
 */
const WebhookDeliverySchema = new mongoose.Schema({
  webhook: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Webhook',
    required: true
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  event: {
    type: String,
    required: true
  },
  /** The exact body sent, so a mismatch can be diagnosed rather than argued about. */
  payload: {
    type: mongoose.Schema.Types.Mixed
  },
  status: {
    type: String,
    enum: ['pending', 'delivered', 'failed'],
    default: 'pending',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  /** When the next attempt is due. Null once the delivery is settled. */
  nextAttemptAt: {
    type: Date
  },
  responseStatus: { type: Number },
  /**
   * A short excerpt of the response. Capped deliberately: this is a debugging
   * aid, and storing whatever an arbitrary endpoint returns in full would let
   * somebody else decide how much of our database they use.
   */
  responseBody: { type: String, maxlength: 2000 },
  error: { type: String },
  durationMs: { type: Number },
  createdAt: { type: Date, default: Date.now },
  deliveredAt: { type: Date }
});

// The sweep: everything due, across tenants.
WebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
// The tenant's own delivery log, newest first.
WebhookDeliverySchema.index({ company: 1, createdAt: -1 });
WebhookDeliverySchema.index({ webhook: 1, createdAt: -1 });

/**
 * Retention. A delivery log is a debugging aid with a short useful life, and
 * one kept forever is a bill rather than a feature.
 */
const RETENTION_DAYS = parseInt(process.env.WEBHOOK_LOG_RETENTION_DAYS, 10) || 30;

WebhookDeliverySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 }
);

const WebhookDelivery = mongoose.model('WebhookDelivery', WebhookDeliverySchema);

module.exports = WebhookDelivery;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
