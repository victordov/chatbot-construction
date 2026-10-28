const mongoose = require('mongoose');

/**
 * A person, as opposed to a conversation.
 *
 * Until now the product only knew about sessions: a visitor who came back on
 * their phone was a stranger, and an operator had no way to see what the same
 * customer had asked last week. A Contact owns the conversations, so history,
 * CSAT attribution and email threading all have something to hang off.
 *
 * Identity comes in three strengths, and the difference matters:
 *
 *   verified   proven, and `verifiedBy` says how: the tenant vouched for
 *              who this is (a signed token, `jwt`, or an HMAC of their own
 *              user id, `hmac`), or the visitor proved they read an email
 *              address by typing back a code sent to it (`email_code`). The
 *              two are not equally strong - see
 *              services/visitor-verification.js#isVerifiedEnough.
 *   claimed    the visitor typed an email address. Useful for threading,
 *              worthless as proof - anyone can type any address.
 *   anonymous  a browser session and nothing more.
 */
const ContactSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /**
   * The tenant's own id for this person, set only when the identity was
   * verified. Never accept this from the browser unsigned.
   */
  externalId: {
    type: String,
    trim: true
  },
  identityLevel: {
    type: String,
    enum: ['anonymous', 'claimed', 'verified'],
    default: 'anonymous'
  },
  // ---- P2D: how a verified identity was proven, and what was signed ----
  /** How the identity was proven. Unset on contacts verified before it was recorded. */
  verifiedBy: {
    type: String,
    enum: ['jwt', 'hmac', 'email_code']
  },
  verifiedAt: { type: Date },
  /**
   * The attributes the tenant signed into the visitor's token (`attrs`), as
   * signed. They are also copied into `attributes` so the dashboard shows
   * them, but that map can be edited by operators and filled from unsigned
   * sources; this one is only ever written from a verified token, so it is
   * the copy to trust.
   */
  signedAttributes: {
    type: Map,
    of: String
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  phone: { type: String, trim: true },
  name: { type: String, trim: true },
  /**
   * Browser sessions known to belong to this person. This is what lets a
   * returning visitor be recognised, and what gets merged when an anonymous
   * session later identifies itself.
   */
  sessionIds: [{ type: String }],
  /**
   * Whatever the tenant wants to record: plan, signup date, lifetime value.
   * A Map rather than a fixed schema because every business tracks different
   * things.
   */
  attributes: {
    type: Map,
    of: String
  },
  tags: [{ type: String, trim: true, lowercase: true }],
  conversationCount: { type: Number, default: 0 },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Resolution paths, in the order the service tries them.
//
// A *partial* index, not a sparse one. On a compound index MongoDB indexes a
// document when any indexed field is present, and `company` always is - so
// `sparse` would still index every anonymous contact with externalId null and
// the unique constraint would reject the second visitor who never logs in.
// The partial filter restricts the constraint to contacts that actually have
// an externalId, which is the only place uniqueness is wanted.
ContactSchema.index(
  { company: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);
ContactSchema.index(
  { company: 1, email: 1 },
  { partialFilterExpression: { email: { $type: 'string' } } }
);
ContactSchema.index({ company: 1, sessionIds: 1 });
ContactSchema.index({ company: 1, lastSeenAt: -1 });
ContactSchema.index({ company: 1, tags: 1 });

// Free-text search across the fields an operator would actually search by.
ContactSchema.index({ name: 'text', email: 'text', phone: 'text' });

ContactSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Whether this contact's identity was proven by the tenant, rather than typed
 * into a form. Routes that expose account data must check this.
 */
ContactSchema.methods.isVerified = function() {
  return this.identityLevel === 'verified';
};

/**
 * A display label that degrades gracefully as identity weakens.
 */
ContactSchema.methods.displayName = function() {
  return this.name || this.email || this.phone || 'Anonymous visitor';
};

const Contact = mongoose.model('Contact', ContactSchema);

module.exports = Contact;
