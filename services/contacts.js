/**
 * Resolving a browser session to a person, and proving who that person is.
 *
 * The security-relevant part is how a contact becomes `verified`. A widget runs
 * on the customer's own page, so anything it sends is attacker-controlled: a
 * visitor can set `userId` to someone else's id and read their conversation
 * history unless the tenant signs it. The signed token or HMAC checked in
 * services/visitor-identity.js is what makes it safe to show account data in
 * chat, and it is why `identityLevel` exists rather than a boolean "logged in"
 * flag.
 *
 * Verification belongs to the session that proved it. A contact can hold
 * several browser sessions, some joined only because somebody typed the same
 * email address into a form - which anyone can do. So:
 *
 *   - a typed address never threads a session onto a verified contact;
 *   - a verified contact's email and phone are only ever what was proven,
 *     never what was typed, because actions look accounts up by them
 *     (services/actions.js, `verified` inputs);
 *   - a session that proves an identity moves to that identity's contact on
 *     its own, unless its contact was only ever this browser, in which case
 *     the whole contact comes along (the everyday "browsed, then logged in").
 */

const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const identity = require('./visitor-identity');
const { logger } = require('./logging');

/**
 * Verify a tenant-signed identity (the HMAC scheme).
 *
 * Kept here because callers and tests have always found it here; the check
 * itself lives beside the token check in services/visitor-identity.js.
 *
 * @returns {boolean}
 */
function verifyIdentity(externalId, userHash, secret) {
  return identity.verifyHash(externalId, userHash, secret);
}

/** Whether `contact` is this browser session and nothing else. */
function onlyThisSession(contact, sessionId) {
  return (contact.sessionIds || []).every(id => id === sessionId);
}

/**
 * Bring a session over to `target`, the identity it has just proved.
 *
 * If the session's contact was only ever this browser, and is nobody's
 * signed identity, it is folded in whole: history, name and all. If it is
 * shared with other sessions, or is somebody else's signed identity, only
 * this session leaves it - the others have proved nothing - taking its own
 * conversations along unless they belong to that other verified person.
 *
 * `target` is not saved here unless folding needs it to exist; the caller
 * saves it once it is complete.
 */
async function bringSession(source, target, sessionId) {
  if (!source || (target._id && source._id.equals(target._id))) {
    return;
  }

  if (!source.externalId && onlyThisSession(source, sessionId)) {
    if (target.isNew) {
      // Folding moves conversations by id, so the target has to exist.
      await target.save();
    }
    await mergeInto(target, source, { proofOnly: true });
    return;
  }

  source.sessionIds = (source.sessionIds || []).filter(id => id !== sessionId);

  let moved = 0;
  if (!source.externalId && sessionId) {
    const result = await Conversation.updateMany(
      { contact: source._id, sessionId },
      { $set: { contact: target._id } }
    );
    moved = result.modifiedCount || 0;
  }

  source.conversationCount = Math.max(0, (source.conversationCount || 0) - moved);
  await source.save();

  if (sessionId && !target.sessionIds.includes(sessionId)) {
    target.sessionIds.push(sessionId);
  }
  target.conversationCount = (target.conversationCount || 0) + moved;
}

/**
 * The contact a session belongs to once it has proved a signed identity.
 *
 * @returns {Promise<object>} a Contact document, possibly not saved yet
 */
async function contactForSigned(companyId, sessionId, current, externalId) {
  const owner = await Contact.findOne({ company: companyId, externalId });

  if (owner) {
    await bringSession(current, owner, sessionId);
    return owner;
  }

  // Never re-point somebody's verified contact at a different person: the
  // next user of a shared computer gets a contact of their own.
  if (current && !current.externalId && onlyThisSession(current, sessionId)) {
    current.externalId = externalId;
    return current;
  }

  const fresh = new Contact({ company: companyId, externalId, sessionIds: [] });
  await bringSession(current, fresh, sessionId);
  return fresh;
}

/** Copy what a verified token says about the person onto their contact. */
function applySignedClaims(contact, proof) {
  if (proof.email) {
    contact.email = proof.email;
  }
  if (proof.name) {
    contact.name = proof.name;
  }

  if (proof.hasAttributes) {
    // The token is the whole truth about what is signed as of now: a key the
    // tenant stopped sending keeps its value in `attributes`, but is no
    // longer vouched for.
    contact.signedAttributes = new Map(Object.entries(proof.attributes || {}));
    contact.attributes = contact.attributes || new Map();
    Object.entries(proof.attributes || {}).forEach(([key, value]) => {
      contact.attributes.set(key, value);
    });
  }
}

/**
 * Find or create the contact behind a session.
 *
 * Resolution runs strongest-evidence-first:
 *
 *   1. a verified externalId  - the tenant signed who this is (a token or a
 *                               hash; see services/visitor-identity.js)
 *   2. a known sessionId      - we have seen this browser before
 *   3. a claimed email        - they typed it; weak, but useful for threading,
 *                               and never onto somebody verified
 *
 * @param {object} input
 * @param {string} input.companyId
 * @param {string} [input.sessionId]
 * @param {string} [input.userJwt]     a token signed by the tenant
 * @param {string} [input.externalId]  requires userHash to be trusted
 * @param {string} [input.userHash]
 * @param {string} [input.email]
 * @param {string} [input.name]
 * @param {string} [input.phone]
 * @param {object} [input.attributes]  unsigned; never replaces a signed one
 * @returns {Promise<object|null>} the Contact document
 */
async function resolve(input = {}) {
  const { companyId, sessionId, email, name, phone, attributes } = input;

  if (!companyId) {
    // Without a tenant there is nobody to be a contact of.
    return null;
  }

  try {
    const proof = await identity.prove(companyId, {
      externalId: input.externalId,
      userHash: input.userHash,
      userJwt: input.userJwt
    });
    const verified = Boolean(proof && proof.ok);

    if (proof && !proof.ok) {
      if (proof.reason === 'expired') {
        // Routine: a tab left open past the token's life. The widget tells
        // the page, which can fetch a fresh one.
        logger.info('An expired visitor token was presented', { companyId: String(companyId) });
      } else {
        // Loud, because an unsigned or wrongly-signed id is either a
        // misconfiguration or an impersonation attempt, and both need finding.
        logger.warn('Rejected an unverified identity claim', {
          companyId: String(companyId),
          reason: proof.reason,
          externalId: input.externalId ? String(input.externalId).slice(0, 40) : undefined
        });
      }
    }

    const current = sessionId
      ? await Contact.findOne({ company: companyId, sessionIds: sessionId })
      : null;

    let contact;
    // Captured before anything changes, because the webhooks are about the
    // transition, not the result.
    let wasVerified;
    let wasSigned;

    if (verified) {
      contact = await contactForSigned(companyId, sessionId, current, proof.externalId);
      wasVerified = contact.identityLevel === 'verified';
      wasSigned = identity.isSigned(contact);

      if (!wasVerified) {
        // Becoming verified: whatever address or number was typed before is
        // not part of what was proven. The token's own `email`, if any,
        // takes its place below.
        contact.email = undefined;
        contact.phone = undefined;
      }

      contact.identityLevel = 'verified';
      contact.verifiedBy = proof.method;
      contact.verifiedAt = new Date();
      applySignedClaims(contact, proof);
    } else {
      contact = current;

      if (!contact && email) {
        // A typed address threads this session onto somebody we know - but
        // never onto a verified person: knowing somebody's address is not
        // being them.
        contact = await Contact.findOne({
          company: companyId,
          email: String(email).toLowerCase(),
          identityLevel: { $ne: 'verified' }
        });
      }

      if (!contact) {
        contact = new Contact({ company: companyId, sessionIds: sessionId ? [sessionId] : [] });
      }

      wasVerified = contact.identityLevel === 'verified';
      wasSigned = identity.isSigned(contact);

      // Never downgrade a verified contact because a form was filled in.
      if (email && !wasVerified) {
        contact.identityLevel = 'claimed';
      }
    }

    const isNewContact = contact.isNew;

    if (sessionId && !contact.sessionIds.includes(sessionId)) {
      contact.sessionIds.push(sessionId);
    }

    // Fill gaps rather than overwrite: a verified name should not be replaced
    // by whatever someone typed into the pre-chat form. A verified contact's
    // address and phone are not filled from a form at all.
    const proven = contact.identityLevel === 'verified';
    if (email && !contact.email && !proven) {
      contact.email = String(email).toLowerCase();
    }
    if (name && !contact.name) {
      contact.name = name;
    }
    if (phone && !contact.phone && !proven) {
      contact.phone = phone;
    }

    if (attributes && typeof attributes === 'object') {
      contact.attributes = contact.attributes || new Map();
      const signed = contact.signedAttributes;
      Object.entries(attributes).forEach(([key, value]) => {
        // An unsigned value never replaces one the tenant signed.
        if (value !== undefined && value !== null && !(signed && signed.has(String(key)))) {
          contact.attributes.set(String(key), String(value));
        }
      });
    }

    contact.lastSeenAt = new Date();
    await contact.save();

    announce(companyId, contact, { isNewContact, wasVerified, wasSigned, sessionId });

    return contact;
  } catch (error) {
    // Contact resolution failing must not stop a conversation.
    logger.error('Could not resolve contact', { error: error.message });
    return null;
  }
}

/**
 * The webhooks for a contact that was just created or just proved who it is.
 *
 * `contact.identified` fires on the transition only - firing on every message
 * from a verified person would turn one sign-in into a delivery per turn -
 * and once more when somebody verified by an email code later signs in,
 * because that is when their account id becomes known.
 */
function announce(companyId, contact, { isNewContact, wasVerified, wasSigned, sessionId }) {
  const webhooks = require('./webhooks');

  if (isNewContact) {
    webhooks.dispatch(companyId, 'contact.created', {
      contactId: String(contact._id),
      name: contact.name,
      email: contact.email,
      identityLevel: contact.identityLevel,
      sessionId
    });
  }

  const nowVerified = contact.identityLevel === 'verified';
  const nowSigned = identity.isSigned(contact);
  if (nowVerified && (!wasVerified || (nowSigned && !wasSigned))) {
    webhooks.dispatch(companyId, 'contact.identified', {
      contactId: String(contact._id),
      externalId: contact.externalId,
      name: contact.name,
      email: contact.email,
      verifiedBy: contact.verifiedBy
    });
  }
}

/**
 * Record that a session's visitor proved an email address with a code.
 *
 * Called by services/visitor-verification.js once the visitor has typed back
 * the code sent to `email`. The session joins the contact already verified by
 * code for that address; or its own contact is promoted, when it was only
 * ever this browser; or it gets a new one. It never joins a contact the
 * tenant signed, even one with the same address: a code proves the inbox,
 * not the login, and the tenant decides per action whether the inbox is
 * enough.
 *
 * @param {{companyId: string, sessionId: string, email: string}} input
 * @returns {Promise<{contact: object, alreadyVerified: boolean}|null>}
 */
async function verifyEmail({ companyId, sessionId, email }) {
  if (!companyId || !sessionId || !email) {
    return null;
  }

  const address = String(email).trim().toLowerCase();
  const current = await Contact.findOne({ company: companyId, sessionIds: sessionId });

  // Already proven more strongly, or already proven this way for this
  // address: nothing changes.
  if (current && (identity.isSigned(current) ||
      (current.identityLevel === 'verified' && current.verifiedBy === 'email_code' && current.email === address))) {
    return { contact: current, alreadyVerified: true };
  }

  let target = await Contact.findOne({
    company: companyId,
    email: address,
    identityLevel: 'verified',
    verifiedBy: 'email_code',
    externalId: { $exists: false }
  });

  if (!target) {
    target = current && !current.externalId && onlyThisSession(current, sessionId)
      ? current
      : new Contact({ company: companyId, sessionIds: [] });
  }

  await bringSession(current, target, sessionId);

  const isNewContact = target.isNew;
  const wasVerified = target.identityLevel === 'verified';
  const wasSigned = identity.isSigned(target);

  if (!wasVerified) {
    // A phone number typed before is not part of what the code proved.
    target.phone = undefined;
  }
  target.identityLevel = 'verified';
  target.verifiedBy = 'email_code';
  target.verifiedAt = new Date();
  target.email = address;
  if (!target.sessionIds.includes(sessionId)) {
    target.sessionIds.push(sessionId);
  }
  target.lastSeenAt = new Date();
  await target.save();

  announce(companyId, target, { isNewContact, wasVerified, wasSigned, sessionId });

  return { contact: target, alreadyVerified: false };
}

/**
 * A contact's attributes, each marked with whether the tenant signed it.
 *
 * Signed means the value in `attributes` is the one the tenant's token
 * carried; a value changed since, by hand or from an unsigned source, is not.
 *
 * @returns {Array<{key: string, value: string, signed: boolean}>}
 */
function attributeList(contact) {
  const entries = map => (map instanceof Map ? [...map.entries()] : Object.entries(map || {}));
  const signed = new Map(entries(contact && contact.signedAttributes));

  return entries(contact && contact.attributes).map(([key, value]) => ({
    key,
    value,
    signed: signed.has(key) && signed.get(key) === value
  }));
}

/**
 * Fold one contact into another, keeping the target's stronger identity.
 *
 * Happens when an anonymous browsing session later logs in as someone we
 * already know, and when an operator merges two records by hand. With
 * `proofOnly` - an automatic merge into a verified person - the source's
 * typed address and phone are left behind: the target's are what was proven.
 */
async function mergeInto(target, source, { proofOnly = false } = {}) {
  if (!target || !source || target._id.equals(source._id)) {
    return target;
  }

  source.sessionIds.forEach(sessionId => {
    if (!target.sessionIds.includes(sessionId)) {
      target.sessionIds.push(sessionId);
    }
  });

  // The target is the more strongly identified record, so it only gains
  // details it was missing.
  (proofOnly ? ['name'] : ['email', 'name', 'phone']).forEach(field => {
    if (!target[field] && source[field]) {
      target[field] = source[field];
    }
  });

  if (source.attributes) {
    target.attributes = target.attributes || new Map();
    source.attributes.forEach((value, key) => {
      if (!target.attributes.has(key)) {
        target.attributes.set(key, value);
      }
    });
  }

  source.tags.forEach(tag => {
    if (!target.tags.includes(tag)) {
      target.tags.push(tag);
    }
  });

  target.firstSeenAt = new Date(Math.min(
    new Date(target.firstSeenAt).getTime(),
    new Date(source.firstSeenAt).getTime()
  ));

  await target.save();

  // Move the conversations across before deleting, so nothing is orphaned.
  await Conversation.updateMany({ contact: source._id }, { $set: { contact: target._id } });
  await Contact.deleteOne({ _id: source._id });

  target.conversationCount = await Conversation.countDocuments({ contact: target._id });
  await target.save();

  logger.info('Merged contacts', {
    into: target._id.toString(),
    from: source._id.toString()
  });

  return target;
}

/**
 * Attach a conversation to a contact and keep the counter honest.
 */
async function linkConversation(contact, conversation) {
  if (!contact || !conversation) {
    return;
  }

  if (conversation.contact && conversation.contact.equals(contact._id)) {
    return;
  }

  conversation.contact = contact._id;

  await Contact.updateOne(
    { _id: contact._id },
    { $inc: { conversationCount: 1 }, $set: { lastSeenAt: new Date() } }
  );
}

module.exports = {
  resolve,
  verifyEmail,
  mergeInto,
  linkConversation,
  verifyIdentity,
  attributeList
};
