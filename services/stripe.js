/**
 * Stripe, without the Stripe library.
 *
 * Everything needed to take money through Stripe Checkout is here: verify that
 * a webhook really came from them, and translate the events that change what a
 * tenant is entitled to. Card details never touch this server - the customer
 * enters them on Stripe's own page - so the PCI surface stays where it belongs
 * and there is no dependency to keep current.
 *
 * The mapping from a Stripe price to one of our plans is configuration, not
 * code: `STRIPE_PRICE_<PLAN>` per plan, or a `planId` in the subscription's
 * metadata, which is what a manually created subscription will carry.
 */

const crypto = require('crypto');
const { PLANS } = require('../config/plans');
const { logger } = require('./logging');

/** How far out of date a signature may be. Stripe's own default. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * The raw body matters: re-serialising the parsed JSON produces different
 * bytes and the signature will never match, which is the classic way this is
 * got wrong - and it fails closed, so it looks like Stripe is broken.
 *
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @returns {object} the parsed event
 * @throws {Error} when the signature is missing, malformed, stale or wrong
 */
function verifyEvent(rawBody, signatureHeader, secret) {
  if (!secret) {
    throw new Error('Stripe webhook secret is not configured');
  }

  if (!signatureHeader) {
    throw new Error('Missing Stripe signature');
  }

  const parts = String(signatureHeader).split(',').reduce((acc, piece) => {
    const [key, value] = piece.split('=');
    if (key === 'v1') {
      acc.signatures.push(value);
    } else if (key === 't') {
      acc.timestamp = value;
    }
    return acc;
  }, { timestamp: null, signatures: [] });

  if (!parts.timestamp || parts.signatures.length === 0) {
    throw new Error('Malformed Stripe signature');
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    // Without this a captured request could be replayed at any point in the
    // future, and a signature alone would still say it was genuine.
    throw new Error('Stripe signature is outside the tolerance window');
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const matched = parts.signatures.some(signature => {
    const candidate = Buffer.from(String(signature), 'utf8');
    const target = Buffer.from(expected, 'utf8');
    return candidate.length === target.length && crypto.timingSafeEqual(candidate, target);
  });

  if (!matched) {
    throw new Error('Stripe signature does not match');
  }

  return JSON.parse(payload);
}

/**
 * Which of our plans a Stripe price or metadata refers to.
 */
function planFor({ priceId, metadata = {} }) {
  const fromMetadata = metadata.planId || metadata.plan;
  if (fromMetadata && PLANS[fromMetadata]) {
    return fromMetadata;
  }

  if (priceId) {
    const match = Object.keys(PLANS).find(
      planId => process.env[`STRIPE_PRICE_${planId.toUpperCase()}`] === priceId
    );
    if (match) {
      return match;
    }
    logger.warn('No plan is configured for this Stripe price', { priceId });
  }

  return null;
}

/** The price id on a Stripe subscription object, if it has one. */
function priceFrom(subscription) {
  const item = subscription && subscription.items && Array.isArray(subscription.items.data)
    ? subscription.items.data[0]
    : null;
  return item && item.price ? item.price.id : null;
}

function secondsToDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
}

/**
 * Translate one Stripe event into a subscription change.
 *
 * @returns {object|null} `{ lookup, changes }`, or null for an event we have
 *   no opinion about - most of what Stripe sends, and each one ignored rather
 *   than treated as an error, because an endpoint that 500s on an event it
 *   does not care about gets disabled by Stripe for being unreliable.
 */
function translate(event) {
  const object = event && event.data ? event.data.object : null;

  if (!object) {
    return null;
  }

  const eventAt = secondsToDate(event.created);

  switch (event.type) {
  case 'checkout.session.completed': {
    // The moment a customer has actually paid. The company id is whatever we
    // put in the metadata when creating the session — or `client_reference_id`,
    // which is the only field a Stripe Payment Link can carry. Reading both
    // means a tenant can be signed up with a link and no integration code at
    // all, which is how a small operator will actually start taking money.
    const metadata = object.metadata || {};
    return {
      lookup: {
        companyId: metadata.companyId || object.client_reference_id,
        customerId: object.customer,
        subscriptionId: object.subscription
      },
      changes: {
        planId: planFor({ metadata }),
        status: 'active',
        externalCustomerId: object.customer,
        externalSubscriptionId: object.subscription,
        eventAt
      }
    };
  }

  case 'customer.subscription.created':
  case 'customer.subscription.updated': {
    const metadata = object.metadata || {};
    // Stripe's own statuses do not map one to one onto ours: `unpaid` is a
    // suspension, `incomplete_expired` is a checkout that never completed.
    const statusMap = {
      active: 'active',
      trialing: 'trialing',
      past_due: 'past_due',
      canceled: 'cancelled',
      unpaid: 'suspended',
      incomplete: 'past_due',
      incomplete_expired: 'cancelled'
    };

    return {
      lookup: {
        companyId: metadata.companyId,
        customerId: object.customer,
        subscriptionId: object.id
      },
      changes: {
        planId: planFor({ priceId: priceFrom(object), metadata }),
        status: statusMap[object.status] || undefined,
        currentPeriodEnd: secondsToDate(object.current_period_end),
        externalCustomerId: object.customer,
        externalSubscriptionId: object.id,
        eventAt
      }
    };
  }

  case 'customer.subscription.deleted':
    return {
      lookup: {
        companyId: (object.metadata || {}).companyId,
        customerId: object.customer,
        subscriptionId: object.id
      },
      changes: { status: 'cancelled', eventAt }
    };

  case 'invoice.payment_succeeded':
    return {
      lookup: {
        companyId: (object.metadata || {}).companyId,
        customerId: object.customer,
        subscriptionId: object.subscription
      },
      changes: {
        status: 'active',
        currentPeriodEnd: secondsToDate(object.period_end),
        eventAt
      }
    };

  case 'invoice.payment_failed':
    // Deliberately `past_due` rather than `suspended`: cutting a support desk
    // off the moment a card fails punishes the tenant's customers, not the
    // tenant. `isEntitled()` still says yes; suspension is a decision somebody
    // makes.
    return {
      lookup: {
        companyId: (object.metadata || {}).companyId,
        customerId: object.customer,
        subscriptionId: object.subscription
      },
      changes: { status: 'past_due', eventAt }
    };

  default:
    return null;
  }
}

module.exports = { verifyEvent, translate, planFor, TOLERANCE_SECONDS };
