const mongoose = require('mongoose');

/**
 * A question the bot must keep answering properly.
 *
 * Every change to a bot - a new source, an edited persona, a canned reply, a
 * workflow published - can quietly break an answer that used to be right, and
 * the only way anybody found out was a customer. A saved test is a question
 * with what a good answer looks like, re-run on demand from Test your bot and
 * automatically after somebody teaches the bot something new.
 *
 * What "good" means is deliberately coarse, because the answer is written by a
 * model and changes wording every time:
 *
 *   contains  the answer mentions this ("£25", "30 days")
 *   handover  the bot hands over, or offers a person (it should not try)
 *   cites     the answer drew on this source (title or address), or on any
 *             source at all when no value is given
 */
const TestCaseSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  question: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  expect: {
    type: {
      type: String,
      enum: ['contains', 'handover', 'cites'],
      required: true
    },
    value: { type: String, trim: true, maxlength: 300, default: '' }
  },
  /** The last time it ran: whether it passed, and what the bot said. */
  lastRun: {
    passed: { type: Boolean },
    answer: { type: String },
    path: { type: String },
    reason: { type: String },
    at: { type: Date }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

TestCaseSchema.index({ company: 1, createdAt: 1 });

/** How many tests a company may keep. Each run is a model call per test. */
TestCaseSchema.statics.LIMIT = 50;

module.exports = mongoose.model('TestCase', TestCaseSchema);
