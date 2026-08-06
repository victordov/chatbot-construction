const mongoose = require('mongoose');

/**
 * Who did what.
 *
 * Every product that holds other people's customer conversations eventually
 * gets the same question, usually at the worst moment: who deleted that, who
 * changed that person's role, who exported those transcripts. Reconstructing it
 * from application logs afterwards does not work — they are unstructured, they
 * roll over, and they do not record the actor.
 *
 * Two rules shape this schema:
 *
 *   append-only  nothing here is ever updated or deleted by the application. A
 *                record that can be edited is not evidence. There is no route
 *                that writes to an existing entry.
 *   no secrets   `details` holds context, never credentials, message bodies or
 *                anything else that would make the audit log itself the most
 *                sensitive collection in the database.
 */
const AuditLogSchema = new mongoose.Schema({
  /**
   * The company the action affected. Null for platform-level actions taken by
   * a superadmin, which only they can read.
   */
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    default: null
  },
  /**
   * Who did it. The name is copied rather than joined, because the point of an
   * audit trail is to survive the account being renamed or deleted.
   */
  actor: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: { type: String },
    displayName: { type: String },
    role: { type: String }
  },
  /**
   * `noun.verb`, e.g. `operator.deleted`, `plan.changed`. Sorting groups
   * related events, which is how someone actually reads this.
   */
  action: {
    type: String,
    required: true,
    index: true
  },
  /** What it was done to, in terms a person recognises. */
  target: {
    type: { type: String },
    id: { type: String },
    label: { type: String }
  },
  /**
   * Context. Deliberately loose, deliberately not secret: enough to answer
   * "what changed", never enough to be worth stealing.
   */
  details: {
    type: mongoose.Schema.Types.Mixed
  },
  /**
   * Whether the action succeeded. Failures matter more than successes here — a
   * run of denied attempts is the signal you are looking for.
   */
  outcome: {
    type: String,
    enum: ['success', 'failure', 'denied'],
    default: 'success'
  },
  ip: { type: String },
  userAgent: { type: String },
  at: {
    type: Date,
    default: Date.now
  }
});

// The way this is read: one company's history, newest first.
AuditLogSchema.index({ company: 1, at: -1 });
AuditLogSchema.index({ company: 1, action: 1, at: -1 });
AuditLogSchema.index({ 'actor.id': 1, at: -1 });

/**
 * Retention. An audit log that grows forever becomes a liability of its own,
 * and most obligations to keep one are measured in months rather than decades.
 * Configurable, because the right answer is a matter of policy and jurisdiction
 * rather than something this code can decide.
 */
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 400;

AuditLogSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

module.exports = AuditLog;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
