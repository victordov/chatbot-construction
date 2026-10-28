const mongoose = require('mongoose');

/**
 * A one-time code sent to a visitor's email address, waiting to be typed back.
 *
 * One per chat session: asking again replaces it. Only a salted hash is kept,
 * so a copy of the database does not hand anyone the codes that are live, and
 * the document removes itself when it expires (the TTL index below) - a
 * pending code is not something to keep.
 *
 * The address is kept until the code is used, because it is what the code
 * proves; nothing else about the visitor is.
 *
 * See services/visitor-verification.js.
 */
const VisitorCodeSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  sessionId: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  codeHash: { type: String, required: true },
  salt: { type: String, required: true },
  /** Wrong guesses so far. The code is spent at the limit. */
  attempts: { type: Number, default: 0 },
  /** Reaped by MongoDB once this passes; also checked on use, since the sweep runs late. */
  expiresAt: { type: Date, required: true, expires: 0 },
  createdAt: { type: Date, default: Date.now }
});

VisitorCodeSchema.index({ company: 1, sessionId: 1 }, { unique: true });

module.exports = mongoose.models.VisitorCode || mongoose.model('VisitorCode', VisitorCodeSchema);
