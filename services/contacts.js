/**
 * Resolving a browser session to a person, and proving who that person is.
 *
 * The security-relevant part is `verifyIdentity`. A widget runs on the
 * customer's own page, so anything it sends is attacker-controlled: a visitor
 * can set `userId` to someone else's id and read their conversation history
 * unless the tenant signs it. The HMAC below is what makes it safe to show
 * account data in chat, and it is why `identityLevel` exists rather than a
 * boolean "logged in" flag.
 */

const crypto = require('crypto');
const Contact = require('../models/contact');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const { logger } = require('./logging');

/**
 * Verify a tenant-signed identity.
 *
 * The tenant computes `HMAC-SHA256(identitySecret, externalId)` on their own
 * server and hands it to the widget. We recompute it here: matching proves the
 * tenant vouched for this person, because only they hold the secret.
 *
 * @returns {boolean}
 */
function verifyIdentity(externalId, userHash, secret) {
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
 * Find or create the contact behind a session.
 *
 * Resolution runs strongest-evidence-first:
 *
 *   1. a verified externalId  - the tenant told us who this is
 *   2. a known sessionId      - we have seen this browser before
 *   3. a claimed email        - they typed it; weak, but useful for threading
 *
 * @param {object} input
 * @param {string} input.companyId
 * @param {string} [input.sessionId]
 * @param {string} [input.externalId]  requires userHash to be trusted
 * @param {string} [input.userHash]
 * @param {string} [input.email]
 * @param {string} [input.name]
 * @param {string} [input.phone]
 * @param {object} [input.attributes]
 * @returns {Promise<object|null>} the Contact document
 */
async function resolve(input = {}) {
  const { companyId, sessionId, externalId, userHash, email, name, phone, attributes } = input;

  if (!companyId) {
    // Without a tenant there is nobody to be a contact of.
    return null;
  }

  try {
    let verified = false;

    if (externalId && userHash) {
      const company = await Company.findById(companyId).select('identitySecret').lean();
      verified = verifyIdentity(externalId, userHash, company?.identitySecret);

      if (!verified) {
        // Loud, because an unsigned or wrongly-signed id is either a
        // misconfiguration or an impersonation attempt, and both need finding.
        logger.warn('Rejected an unverified identity claim', {
          companyId: String(companyId),
          externalId: String(externalId).slice(0, 40)
        });
      }
    }

    let contact = null;

    if (verified) {
      contact = await Contact.findOne({ company: companyId, externalId });
    }

    if (!contact && sessionId) {
      contact = await Contact.findOne({ company: companyId, sessionIds: sessionId });
    }

    if (!contact && email) {
      contact = await Contact.findOne({ company: companyId, email: String(email).toLowerCase() });
    }

    if (!contact) {
      contact = new Contact({ company: companyId, sessionIds: sessionId ? [sessionId] : [] });
    }

    // A verified identity can be attached to a contact we first met
    // anonymously - that is the normal path when someone browses, then logs in.
    if (verified) {
      // If a *different* contact already holds this externalId, that one is
      // the real person and this session should join it rather than duplicate.
      const owner = await Contact.findOne({ company: companyId, externalId });

      if (owner && (!contact._id || !owner._id.equals(contact._id))) {
        if (contact._id) {
          await mergeInto(owner, contact);
        }
        contact = owner;
      } else {
        contact.externalId = externalId;
      }

      contact.identityLevel = 'verified';
    } else if (email && contact.identityLevel !== 'verified') {
      // Never downgrade a verified contact because a form was filled in.
      contact.identityLevel = 'claimed';
    }

    if (sessionId && !contact.sessionIds.includes(sessionId)) {
      contact.sessionIds.push(sessionId);
    }

    // Fill gaps rather than overwrite: a verified name should not be replaced
    // by whatever someone typed into the pre-chat form.
    if (email && !contact.email) {
      contact.email = String(email).toLowerCase();
    }
    if (name && !contact.name) {
      contact.name = name;
    }
    if (phone && !contact.phone) {
      contact.phone = phone;
    }

    if (attributes && typeof attributes === 'object') {
      contact.attributes = contact.attributes || new Map();
      Object.entries(attributes).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          contact.attributes.set(String(key), String(value));
        }
      });
    }

    contact.lastSeenAt = new Date();
    await contact.save();

    return contact;
  } catch (error) {
    // Contact resolution failing must not stop a conversation.
    logger.error('Could not resolve contact', { error: error.message });
    return null;
  }
}

/**
 * Fold one contact into another, keeping the target's stronger identity.
 *
 * Happens when an anonymous browsing session later logs in as someone we
 * already know.
 */
async function mergeInto(target, source) {
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
  ['email', 'name', 'phone'].forEach(field => {
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
  mergeInto,
  linkConversation,
  verifyIdentity
};
