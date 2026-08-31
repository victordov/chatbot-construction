const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * A key that lets a tenant's own systems read their data.
 *
 * Only a hash is stored. A key is shown once, at creation, and cannot be
 * recovered afterwards - which is the difference between "somebody read our
 * database backup" and "somebody read our database backup and now has every
 * tenant's API credentials".
 *
 * `prefix` is the first characters of the key, kept in the clear so a listing
 * can say *which* key without being able to reproduce it, and so a leaked key
 * found in a log can be matched to the row to revoke.
 */
const ApiKeySchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /** What it is for, in the tenant's words: "warehouse sync", "Zapier". */
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  prefix: {
    type: String,
    required: true,
    index: true
  },
  hash: {
    type: String,
    required: true,
    // Never needed to answer a request - the key is looked up by prefix and
    // the hash compared - and a field you have to ask for is a field that does
    // not leak by accident.
    select: false
  },
  /**
   * What this key may read. Deliberately per-resource: a warehouse backfill
   * needs conversations, an internal directory needs contacts, and neither has
   * any business holding a credential that reads both.
   */
  scopes: [{
    type: String,
    enum: ['conversations:read', 'contacts:read', 'tasks:read']
  }],
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  /**
   * Written at most once a minute rather than on every request: a key used at
   * ten requests a second would otherwise be ten writes a second to say
   * something only ever read to the nearest day.
   */
  lastUsedAt: { type: Date },
  expiresAt: { type: Date },
  revokedAt: { type: Date },
  revokedBy: { type: String }
});

ApiKeySchema.methods.isUsable = function() {
  if (this.revokedAt) {
    return false;
  }
  return !(this.expiresAt && this.expiresAt < new Date());
};

/** What is safe to show in a listing: everything except the key itself. */
ApiKeySchema.methods.toPublic = function() {
  return {
    id: String(this._id),
    name: this.name,
    prefix: this.prefix,
    scopes: this.scopes,
    createdAt: this.createdAt,
    createdBy: this.createdBy,
    lastUsedAt: this.lastUsedAt,
    expiresAt: this.expiresAt,
    revokedAt: this.revokedAt,
    active: this.isUsable()
  };
};

/**
 * SHA-256 rather than bcrypt.
 *
 * A password is short and chosen by a person, so it needs a slow hash to
 * survive being guessed. This is 32 random bytes: there is nothing to guess,
 * and it is verified on every API request, where a deliberately slow hash
 * would be a denial-of-service vector rather than a protection.
 */
ApiKeySchema.statics.hashKey = function(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
};

module.exports = mongoose.models.ApiKey || mongoose.model('ApiKey', ApiKeySchema);
