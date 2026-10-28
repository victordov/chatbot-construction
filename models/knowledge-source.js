const mongoose = require('mongoose');

/**
 * What a tenant has said about one knowledge source, beyond its chunks.
 *
 * A source is otherwise only the chunks that share a `sourceId`, and chunks are
 * replaced wholesale on every import, so anything that has to survive a
 * re-import lives here instead:
 *
 *   - whether to fetch a page again every week, and how the last attempt went;
 *   - the text a note was written as. Chunks overlap by a couple of hundred
 *     characters, so gluing them back together does not give the note back,
 *     and "Edit" has to show exactly what was typed.
 *
 * One row per (company, sourceId), created the first time there is something
 * to keep. A source with no row has no settings, which is the default.
 */
const KnowledgeSourceSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  sourceId: {
    type: String,
    required: true
  },
  /** The note as written, for a pasted (`text:`) source. */
  title: { type: String, trim: true },
  text: { type: String },
  /** Fetch this page again every week, so the bot does not quote last year's prices. */
  refreshWeekly: { type: Boolean, default: false },
  lastRefreshedAt: { type: Date },
  /** Why the last scheduled refresh failed, so the dashboard can say so. */
  lastError: { type: String },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now }
});

KnowledgeSourceSchema.index({ company: 1, sourceId: 1 }, { unique: true });
// The weekly refresh asks "which pages are due", across every tenant.
KnowledgeSourceSchema.index({ refreshWeekly: 1, lastRefreshedAt: 1 });

KnowledgeSourceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('KnowledgeSource', KnowledgeSourceSchema);
