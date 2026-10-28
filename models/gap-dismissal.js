const mongoose = require('mongoose');

/**
 * "Not worth answering": a group on the unanswered-questions list an admin
 * dismissed, or one they answered by teaching the bot.
 *
 * Groups are computed on every request rather than stored, so a dismissal
 * cannot point at a row. It keeps the words the group was recognised by
 * instead, and hides any group those words still match - but only for
 * occurrences up to the moment it was dismissed. The same question asked
 * again next week is news, and comes back.
 */
const GapDismissalSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  /** The group key at the time, for the audit trail and idempotency. */
  key: {
    type: String,
    required: true
  },
  /** The normalised words of the question the group was built around. */
  tokens: [{ type: String }],
  /** The question as a visitor asked it, for anyone reading the record. */
  question: {
    type: String,
    trim: true,
    maxlength: 500
  },
  reason: {
    type: String,
    enum: ['dismissed', 'taught'],
    default: 'dismissed'
  },
  at: {
    type: Date,
    default: Date.now
  },
  by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

GapDismissalSchema.index({ company: 1, at: -1 });

module.exports = mongoose.model('GapDismissal', GapDismissalSchema);
