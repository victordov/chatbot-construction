const mongoose = require('mongoose');

/**
 * A website read into the knowledge base, and how the latest read is going.
 *
 * One row per site (company + origin). It is both the job a dashboard polls
 * while a crawl runs ("12 of 20 pages") and the site's standing record: which
 * `url:` sources the crawl owns, so the next crawl can drop the pages that have
 * disappeared from the site rather than letting the bot quote a page that no
 * longer exists, and whether to read it again every week.
 *
 * Crawls run in the web process, not a queue, so a crawl interrupted by a
 * restart is left `running` with a stale `heartbeatAt`; the routes report such
 * a job as failed rather than letting the dashboard poll it for ever.
 */
const KnowledgeCrawlSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  /** Scheme, host and port: the crawl never leaves it. */
  origin: { type: String, required: true },
  startUrl: { type: String, required: true },
  maxPages: { type: Number, default: 20 },

  status: {
    type: String,
    enum: ['queued', 'running', 'done', 'failed'],
    default: 'queued'
  },
  // `read` pages fetched out of `planned` (the page cap), then `saved` of the
  // pages read as they are embedded and stored.
  progress: {
    phase: { type: String, enum: ['reading', 'saving'], default: 'reading' },
    read: { type: Number, default: 0 },
    planned: { type: Number, default: 0 },
    saved: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }
  },
  /** The latest run's results. Capped: a summary, not a log. */
  imported: [{
    _id: false,
    sourceId: String,
    url: String,
    title: String,
    chunks: Number
  }],
  skipped: [{
    _id: false,
    url: String,
    reason: String,
    status: Number
  }],
  /** Pages the latest run removed because the site no longer has them. */
  removed: [{ type: String }],
  /** The `url:` sources this site currently owns. */
  pages: [{ type: String }],
  error: { type: String },
  /** `PLAN_LIMIT_REACHED` when the plan stopped it, so the UI can offer an upgrade. */
  errorCode: { type: String },

  refreshWeekly: { type: Boolean, default: false },
  startedAt: { type: Date },
  finishedAt: { type: Date },
  /** Touched as the crawl progresses; a running job that stops touching it died. */
  heartbeatAt: { type: Date },
  lastRunAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});

KnowledgeCrawlSchema.index({ company: 1, origin: 1 }, { unique: true });
KnowledgeCrawlSchema.index({ refreshWeekly: 1, lastRunAt: 1 });

/** How many skipped pages a job keeps; the rest are counted, not listed. */
KnowledgeCrawlSchema.statics.SKIPPED_LIMIT = 50;

module.exports = mongoose.model('KnowledgeCrawl', KnowledgeCrawlSchema);
