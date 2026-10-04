/**
 * The secret that proves a client owns a conversation.
 *
 * A session id is not a credential: it appears in dashboard URLs, exports and
 * webhook payloads, and the widget stores it in localStorage where any script
 * on the page can read it. Anyone holding one could resume the conversation,
 * read its history and write into it as the visitor. So the server issues a
 * second value at creation time that is shown to nobody but the client, and
 * every resume or write has to present it.
 *
 * Only the hash is stored, for the same reason passwords are hashed: a leaked
 * database dump must not hand out every open conversation.
 */

const crypto = require('crypto');

/** A fresh token: 32 random bytes as hex. */
function issue() {
  return crypto.randomBytes(32).toString('hex');
}

/** What is stored: sha256 of the token, hex. */
function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Does this token match the stored hash?
 *
 * Constant-time, so a wrong token cannot be narrowed down byte by byte, and
 * false whenever either side is missing: an absent hash is not "anything
 * goes", it is a legacy conversation the caller has to decide about
 * explicitly.
 */
function verify(storedHash, token) {
  if (!storedHash || !token || typeof token !== 'string') {
    return false;
  }

  const expected = Buffer.from(String(storedHash), 'utf8');
  const actual = Buffer.from(hash(token), 'utf8');

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { issue, hash, verify };
