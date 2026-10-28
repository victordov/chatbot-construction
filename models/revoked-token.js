const mongoose = require('mongoose');

/**
 * Sessions signed out one at a time.
 *
 * A JWT cannot be recalled, so "sign out of this browser" used to mean "sign
 * out everywhere": the only lever was the user's `tokenVersion`, which every
 * token shares. Each token now carries an id (`jti`), and signing out of one
 * browser records that id here until the token would have expired anyway.
 * The auth middleware refuses an id it finds.
 *
 * The id is the document's `_id`, so the check is one lookup on the primary
 * index, and the TTL index drops each row once its token is dead regardless.
 */
const RevokedTokenSchema = new mongoose.Schema({
  _id: { type: String },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true }
});

RevokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RevokedToken = mongoose.models.RevokedToken || mongoose.model('RevokedToken', RevokedTokenSchema);

module.exports = RevokedToken;
