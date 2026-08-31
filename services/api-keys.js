/**
 * API keys for the public read API.
 */

const crypto = require('crypto');
const ApiKey = require('../models/api-key');

const PREFIX = 'ck_';
const VALID_SCOPES = ['conversations:read', 'contacts:read', 'tasks:read'];

/**
 * Mint a key.
 *
 * @returns {Promise<{record: object, key: string}>} `key` is the only time the
 *   secret exists outside the caller's hands; nothing stores it.
 */
async function create({ companyId, name, scopes, createdBy, expiresAt }) {
  const requested = Array.isArray(scopes) ? scopes.filter(scope => VALID_SCOPES.includes(scope)) : [];

  if (requested.length === 0) {
    throw new Error('A key needs at least one scope');
  }

  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `${PREFIX}${secret}`;

  const record = await ApiKey.create({
    company: companyId,
    name: (name || 'API key').trim(),
    // Enough to identify the row and useless for reconstructing the key.
    prefix: key.slice(0, 11),
    hash: ApiKey.hashKey(key),
    scopes: requested,
    createdBy,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined
  });

  return { record, key };
}

/**
 * Resolve a presented key.
 *
 * Looked up by prefix and then compared in constant time. A plain
 * `findOne({ hash })` would be equivalent here, but the prefix keeps the index
 * small and the comparison explicit.
 *
 * @returns {Promise<object|null>} the key document, or null if it is unknown,
 *   revoked or expired - all three are the same answer to a caller.
 */
async function resolve(presented) {
  if (typeof presented !== 'string' || !presented.startsWith(PREFIX)) {
    return null;
  }

  const candidates = await ApiKey.find({ prefix: presented.slice(0, 11) }).select('+hash');

  if (candidates.length === 0) {
    return null;
  }

  const expected = ApiKey.hashKey(presented);

  const match = candidates.find(candidate => {
    const a = Buffer.from(candidate.hash, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!match || !match.isUsable()) {
    return null;
  }

  return match;
}

/**
 * Note that a key was used, at most once a minute.
 *
 * Never awaited by the request path: a caller should not wait on bookkeeping,
 * and a failure to record when a key was last used must not fail their read.
 */
const USE_WRITE_INTERVAL_MS = 60 * 1000;

function touch(record) {
  const now = Date.now();

  if (record.lastUsedAt && now - record.lastUsedAt.getTime() < USE_WRITE_INTERVAL_MS) {
    return;
  }

  ApiKey.updateOne({ _id: record._id }, { lastUsedAt: new Date(now) }).catch(() => {});
}

async function list(companyId) {
  const keys = await ApiKey.find({ company: companyId }).sort({ createdAt: -1 });
  return keys.map(key => key.toPublic());
}

/**
 * Revoke rather than delete: the row is the record that the key existed, who
 * created it and when it was last used, which is exactly what somebody
 * investigating an incident needs after it has been turned off.
 */
async function revoke(companyId, keyId, revokedBy) {
  const key = await ApiKey.findOne({ _id: keyId, company: companyId });

  if (!key) {
    return null;
  }

  if (!key.revokedAt) {
    key.revokedAt = new Date();
    key.revokedBy = revokedBy;
    await key.save();
  }

  return key;
}

module.exports = { create, resolve, touch, list, revoke, VALID_SCOPES, PREFIX };
