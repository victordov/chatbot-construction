/**
 * Proving who a widget visitor is, from what the tenant's own server signed.
 *
 * Two proofs are accepted, both made with the company's identity secret:
 *
 *   jwt    a short-lived HS256 token: `{sub, exp, iat, aud?, email?, name?,
 *          attrs?}`. Recommended. It expires, so a copy lifted from a page
 *          stops working within the day, and it carries attributes the
 *          tenant vouches for (a plan, an account number) alongside the id.
 *   hmac   `HMAC-SHA256(secret, userId)` as hex. The older scheme, still
 *          accepted: it never expires and carries nothing but the id, which
 *          is why the market is moving away from it.
 *
 * Everything the widget sends is attacker-controlled, so a proof that fails
 * any check is simply not a proof: the visitor stays anonymous. The reason is
 * returned for logging and for one visitor-facing case, an expired token,
 * which the page can fix by fetching a fresh one (the widget's
 * `identity-expired` event).
 *
 * Nothing here writes. services/contacts.js decides what a proof does to a
 * contact; websockets.js asks `presentedExternalId` whether a reconnecting
 * browser is the person a verified conversation belongs to.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Company = require('../models/company');
const { logger } = require('./logging');

/** The longest a token may live, from `iat` (or from now) to `exp`. */
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;

/** Clocks disagree; a minute either way is not an attack. */
const CLOCK_SKEW_SECONDS = 60;

/** Far more than any honest token, small enough not to be a parsing cost. */
const MAX_TOKEN_LENGTH = 8192;
const MAX_SUBJECT_LENGTH = 255;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

/** Signed attributes kept per token, and how large each may be. */
const MAX_ATTRIBUTES = 50;
const MAX_ATTRIBUTE_VALUE = 500;

/**
 * Attribute names become keys of a MongoDB map, where `.` and a leading `$`
 * are not allowed, and are shown in the dashboard; plain identifiers only.
 */
const ATTRIBUTE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The verification methods that are the tenant vouching, as opposed to a code. */
const SIGNED_METHODS = ['jwt', 'hmac'];

/** Whether a value is shaped like a compact JWT at all. */
function looksLikeToken(value) {
  return typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH && JWT_SHAPE.test(value);
}

/**
 * Verify the older HMAC proof.
 *
 * The tenant computes `HMAC-SHA256(identitySecret, externalId)` on their own
 * server and hands it to the widget. We recompute it here: matching proves the
 * tenant vouched for this person, because only they hold the secret.
 *
 * @returns {boolean}
 */
function verifyHash(externalId, userHash, secret) {
  if (!externalId || !userHash || !secret) {
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(String(externalId))
      .digest('hex');

    const provided = String(userHash).toLowerCase();

    // Length check first: timingSafeEqual throws on a length mismatch, and
    // comparing with === would leak the answer through timing.
    if (provided.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (error) {
    logger.warn('Identity verification failed', { error: error.message });
    return false;
  }
}

/**
 * The `attrs` claim, reduced to what can be stored and shown.
 *
 * Scalars become strings, as the contact's attribute map holds strings; a
 * nested value is kept as JSON when it is small. Anything with an unusable
 * name or too large to be an attribute is dropped rather than rejecting the
 * whole token: the identity is still good.
 */
function cleanAttributes(attrs) {
  const clean = {};
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return clean;
  }

  Object.keys(attrs).slice(0, MAX_ATTRIBUTES).forEach(key => {
    const raw = attrs[key];
    if (!ATTRIBUTE_KEY.test(key) || raw === undefined || raw === null) {
      return;
    }

    let value;
    if (typeof raw === 'string') {
      value = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      value = String(raw);
    } else {
      try {
        value = JSON.stringify(raw);
      } catch {
        return;
      }
    }

    if (typeof value === 'string' && value.length <= MAX_ATTRIBUTE_VALUE) {
      clean[key] = value;
    }
  });

  return clean;
}

/** Map a jsonwebtoken error to a reason we can act on. */
function failureReason(error) {
  if (error instanceof jwt.TokenExpiredError) {
    return 'expired';
  }
  if (error instanceof jwt.NotBeforeError) {
    return 'not_yet_valid';
  }
  const message = String((error && error.message) || '');
  if (message === 'invalid signature') {
    return 'bad_signature';
  }
  if (message === 'invalid algorithm') {
    return 'bad_algorithm';
  }
  return 'invalid';
}

/**
 * Verify a visitor token signed by the tenant.
 *
 * Checks, in order: the shape; HS256 and the signature, with the company's
 * identity secret; `exp`, which is required, and `nbf`, each with a minute of
 * clock skew; a lifetime of at most 24 hours; `sub`; and `aud`, which when
 * present must name this company's widget key - so a token minted for some
 * other use of the same secret is not a widget identity.
 *
 * @param {string} token
 * @param {object} options
 * @param {string} options.secret the company's identity secret
 * @param {string} [options.widgetKey] the company's widget key, for `aud`
 * @param {number} [options.now] milliseconds, for tests
 * @returns {{ok: true, method: 'jwt', externalId: string, email?: string,
 *            name?: string, attributes: object, expiresAt: Date}
 *          |{ok: false, reason: string}}
 */
function verifyToken(token, { secret, widgetKey, now = Date.now() } = {}) {
  if (!secret) {
    return { ok: false, reason: 'no_secret' };
  }
  if (!looksLikeToken(token)) {
    return { ok: false, reason: 'malformed' };
  }

  const nowSeconds = Math.floor(now / 1000);
  let payload;

  try {
    payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      clockTolerance: CLOCK_SKEW_SECONDS,
      clockTimestamp: nowSeconds
    });
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'invalid' };
  }

  // jsonwebtoken lets a token without `exp` live for ever; that is exactly
  // the property of the HMAC scheme this replaces.
  if (typeof payload.exp !== 'number') {
    return { ok: false, reason: 'no_expiry' };
  }

  if (payload.iat !== undefined) {
    if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
      return { ok: false, reason: 'issued_in_future' };
    }
    if (payload.exp - payload.iat > MAX_LIFETIME_SECONDS) {
      return { ok: false, reason: 'lifetime_too_long' };
    }
  } else if (payload.exp - nowSeconds > MAX_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'lifetime_too_long' };
  }

  const subject = typeof payload.sub === 'number' ? String(payload.sub) : payload.sub;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, reason: 'no_subject' };
  }

  if (payload.aud !== undefined) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!widgetKey || !audiences.some(audience => audience === widgetKey)) {
      return { ok: false, reason: 'audience_mismatch' };
    }
  }

  const result = {
    ok: true,
    method: 'jwt',
    externalId: subject.trim(),
    attributes: cleanAttributes(payload.attrs),
    // Whether the token said anything about attributes at all: a token with
    // no `attrs` leaves the signed ones from an earlier token alone, while
    // one with an empty `attrs` says there are none.
    hasAttributes: Boolean(payload.attrs && typeof payload.attrs === 'object' && !Array.isArray(payload.attrs)),
    expiresAt: new Date(payload.exp * 1000)
  };

  if (typeof payload.email === 'string') {
    const email = payload.email.trim().toLowerCase();
    if (email.length <= MAX_EMAIL_LENGTH && EMAIL_ADDRESS.test(email)) {
      result.email = email;
    }
  }
  if (typeof payload.name === 'string' && payload.name.trim()) {
    result.name = payload.name.trim().slice(0, MAX_NAME_LENGTH);
  }

  return result;
}

/**
 * What a visitor presented, checked against the company's secret.
 *
 * A token is tried first; a hash only when there is no token, so a page
 * mid-migration that sends both is judged on the stronger one.
 *
 * @param {string} companyId
 * @param {{externalId?: string, userHash?: string, userJwt?: string}} hints
 * @param {{now?: number}} [options]
 * @returns {Promise<null|{ok: boolean, method?: string, externalId?: string,
 *           reason?: string, email?: string, name?: string,
 *           attributes?: object, hasAttributes?: boolean}>} null when nothing
 *           was presented at all
 */
async function prove(companyId, hints = {}, options = {}) {
  const userJwt = typeof hints.userJwt === 'string' && hints.userJwt ? hints.userJwt : null;
  const hmacPresented = Boolean(hints.externalId && hints.userHash);

  if (!userJwt && !hmacPresented) {
    return null;
  }
  if (!companyId) {
    return { ok: false, reason: 'no_company' };
  }

  const company = await Company.findById(companyId).select('identitySecret widgetKey').lean();
  const secret = company && company.identitySecret;

  if (userJwt) {
    return verifyToken(userJwt, { secret, widgetKey: company && company.widgetKey, now: options.now });
  }

  return verifyHash(hints.externalId, hints.userHash, secret)
    ? { ok: true, method: 'hmac', externalId: String(hints.externalId), attributes: {}, hasAttributes: false }
    : { ok: false, reason: 'bad_signature' };
}

/**
 * The verified user id a connection presents, if the tenant signed it.
 *
 * Used when a browser resumes a conversation that belongs to a verified
 * person: one presenting somebody else is refused (see websockets.js).
 *
 * @returns {Promise<string|null>}
 */
async function presentedExternalId(companyId, hints = {}) {
  try {
    const proof = await prove(companyId, hints);
    return proof && proof.ok ? proof.externalId : null;
  } catch (error) {
    logger.warn('Could not check a presented identity', { error: error.message });
    return null;
  }
}

/** Whether a contact's verification was the tenant vouching, rather than a code. */
function isSigned(contact) {
  if (!contact || contact.identityLevel !== 'verified') {
    return false;
  }
  if (contact.verifiedBy) {
    return SIGNED_METHODS.includes(contact.verifiedBy);
  }
  // Verified before the method was recorded: only signatures existed then,
  // and they always left an externalId.
  return Boolean(contact.externalId);
}

module.exports = {
  verifyToken,
  verifyHash,
  prove,
  presentedExternalId,
  isSigned,
  cleanAttributes,
  looksLikeToken,
  SIGNED_METHODS,
  MAX_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS
};
