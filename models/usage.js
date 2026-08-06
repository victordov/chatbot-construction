const mongoose = require('mongoose');

/**
 * Metered usage for one company in one calendar month.
 *
 * Keyed by month rather than by billing period so that a mid-month plan change
 * does not reset a tenant's counters, and so historical usage can be read back
 * for reporting without reconstructing period boundaries.
 *
 * Counters are only ever moved with `$inc` inside an upsert, so concurrent
 * conversations on several processes cannot lose increments the way a
 * read-modify-write would.
 */
const UsageSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  /** `YYYY-MM`, in UTC. */
  period: {
    type: String,
    required: true
  },
  conversations: { type: Number, default: 0 },
  messages: { type: Number, default: 0 },
  aiResponses: { type: Number, default: 0 },
  operatorMessages: { type: Number, default: 0 },
  filesUploaded: { type: Number, default: 0 },
  fileBytes: { type: Number, default: 0 },
  knowledgeChunksIngested: { type: Number, default: 0 },
  /** Times an action was refused because a limit was reached. */
  limitHits: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

// One document per company per month, enforced by the database rather than by
// convention, so a race cannot create two.
UsageSchema.index({ company: 1, period: 1 }, { unique: true });
UsageSchema.index({ period: 1 });

/**
 * The current period key, in UTC so that a tenant's month does not shift with
 * the server's timezone.
 */
UsageSchema.statics.currentPeriod = function(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const Usage = mongoose.model('Usage', UsageSchema);

module.exports = Usage;
