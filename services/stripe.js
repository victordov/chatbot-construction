/**
 * Stripe, without the Stripe library.
 *
 * Everything needed to take money through Stripe Checkout is here: verify that
 * a webhook really came from them, and translate the events that change what a
 * tenant is entitled to. Card details never touch this server - the customer
 * enters them on Stripe's own page - so the PCI surface stays where it belongs
 * and there is no dependency to keep current.
 *
 * Starting a payment is two REST calls - create a Checkout Session, or a
 * Billing Portal session for a customer who already pays - made with axios
 * and `STRIPE_SECRET_KEY`. Two endpoints do not justify a vendor SDK.
 *
 * The mapping from a Stripe price to one of our plans is configuration, not
 * code: `STRIPE_PRICE_<PLAN>` per plan, or a `planId` in the subscription's
 * metadata, which is what a manually created subscription will carry.
 */

const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { PLANS } = require('../config/plans');
const { logger } = require('./logging');

/** How far out of date a signature may be. Stripe's own default. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * How long a processed event id is remembered. Stripe retries a delivery for
 * up to three days; a month is comfortably past that, and past the point at
 * which anyone replays a captured request by hand.
 */
const EVENT_MEMORY_DAYS = 30;

/**
 * Whether `client_reference_id` may name the tenant.
 *
 * It is the only field a Payment Link can carry, which makes it convenient -
 * and it is also whatever the customer typed into the link's URL, which makes
 * it attacker-chosen. Anyone who can find another tenant's company id can
 * buy the cheapest plan and have it applied to that tenant, or to themselves
 * under a company they do not own. So it is off unless the operator has
 * decided that convenience is worth it for their deployment.
 */
function clientReferenceAllowed() {
  return String(process.env.STRIPE_ALLOW_CLIENT_REFERENCE || '').toLowerCase() === 'true';
}

/**
 * Every Stripe event this deployment has acted on, so a redelivery is
 * acknowledged rather than applied a second time.
 *
 * The ordering check on `externalEventAt` is not enough by itself: a
 * redelivered event carries the same timestamp as the original, so it is not
 * "older" and would be applied again. Most events are idempotent in effect,
 * but not all - a plan change re-applied after a manual suspension would undo
 * the suspension.
 *
 * Kept in this file rather than under models/ because nothing else has a
 * reason to know it exists.
 */
const StripeEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String },
  receivedAt: { type: Date, default: Date.now }
});

StripeEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: EVENT_MEMORY_DAYS * 24 * 60 * 60 });

const StripeEvent = mongoose.models.StripeEvent || mongoose.model('StripeEvent', StripeEventSchema);

/**
 * Claim an event id before processing it.
 *
 * The unique index is what makes this safe under two deliveries arriving at
 * once: whichever insert lands second gets a duplicate-key error, not a
 * second application.
 *
 * @returns {Promise<boolean>} true if this is the first time the id was seen
 */
async function claimEvent(eventId, type) {
  if (!eventId) {
    // An event with no id cannot be deduplicated; let it through and rely on
    // the timestamp ordering, which is what happened before this existed.
    return true;
  }

  try {
    // The unique index is what makes this a claim. Mongoose builds indexes
    // in the background, so on a fresh database the first deliveries could
    // otherwise race it and a retry would be applied twice; `init()` resolves
    // once the index exists, and is cached after the first call.
    await StripeEvent.init();
    await StripeEvent.create({ eventId: String(eventId), type });
    return true;
  } catch (error) {
    if (error && error.code === 11000) {
      return false;
    }
    throw error;
  }
}

/**
 * Give an event back, so Stripe's retry of a delivery we failed to process is
 * treated as new rather than as a duplicate of the failure.
 */
async function releaseEvent(eventId) {
  if (eventId) {
    await StripeEvent.deleteOne({ eventId: String(eventId) }).catch(() => {});
  }
}

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
    // put in the metadata when creating the session. `client_reference_id`
    // is the only field a Payment Link can carry, and also the only one the
    // customer can choose, so it counts only when the deployment has opted in.
    const metadata = object.metadata || {};
    let companyId = metadata.companyId;

    if (!companyId && object.client_reference_id) {
      if (clientReferenceAllowed()) {
        companyId = object.client_reference_id;
      } else {
        logger.warn('Ignoring client_reference_id on a checkout; set STRIPE_ALLOW_CLIENT_REFERENCE=true to honour it', {
          clientReferenceId: String(object.client_reference_id).slice(0, 40)
        });
      }
    }

    const lookup = { companyId, customerId: object.customer, subscriptionId: object.subscription };
    const planId = planFor({ metadata });

    if (!planId) {
      // Somebody paid for something we cannot name. Activating them on their
      // current plan would put a paying customer on trial limits and clear a
      // trial clock we would then have no reason to restart; leaving the plan
      // alone and remembering the customer means the subscription event that
      // follows, which carries the price, can still put them where they
      // belong.
      logger.warn('Checkout completed without a plan we recognise; leaving the plan alone', {
        customer: object.customer,
        subscription: object.subscription
      });
      return {
        lookup,
        changes: {
          externalCustomerId: object.customer,
          externalSubscriptionId: object.subscription,
          eventAt
        }
      };
    }

    return {
      lookup,
      changes: {
        planId,
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

const STRIPE_API = 'https://api.stripe.com/v1';

/** Plans a tenant can buy through Checkout, in catalogue order. Never the trial. */
const PURCHASABLE_PLANS = ['basic', 'professional', 'enterprise'];

/** Raised when Stripe is not configured well enough to take this payment. */
class StripeNotConfiguredError extends Error {}

/** Raised when Stripe answered, but with an error. */
class StripeRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

/** The Stripe price configured for one of our plans, or null. */
function priceFor(planId) {
  if (!PURCHASABLE_PLANS.includes(planId)) {
    return null;
  }
  return process.env[`STRIPE_PRICE_${planId.toUpperCase()}`] || null;
}

/**
 * The plans a tenant could buy right now. Empty without a secret key, so the
 * dashboard does not offer a button that can only fail.
 */
function checkoutPlans() {
  if (!secretKey()) {
    return [];
  }
  return PURCHASABLE_PLANS.filter(planId => Boolean(priceFor(planId)));
}

/**
 * Flatten a nested object into Stripe's form encoding:
 * `{ line_items: [{ price: 'p' }] }` becomes `line_items[0][price]=p`.
 * Stripe's API takes form bodies, not JSON.
 */
function formEncode(value, prefix, pairs = []) {
  if (value === undefined || value === null) {
    return pairs;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEncode(item, `${prefix}[${index}]`, pairs));
  } else if (typeof value === 'object') {
    Object.keys(value).forEach(key => {
      formEncode(value[key], prefix ? `${prefix}[${key}]` : key, pairs);
    });
  } else {
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return pairs;
}

async function stripePost(path, params, { idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  try {
    const response = await axios.post(`${STRIPE_API}${path}`, formEncode(params).join('&'), {
      headers,
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    // Stripe's own message is useful in the log and useless (or revealing) to
    // a tenant, so only the log gets it.
    const status = error.response ? error.response.status : null;
    const detail = error.response && error.response.data && error.response.data.error
      ? error.response.data.error.message
      : error.message;
    logger.error('Stripe request failed', { path, status, error: detail });
    throw new StripeRequestError('Stripe could not start the payment', status);
  }
}

/**
 * Start a Checkout Session for a tenant buying a plan.
 *
 * The company id goes in three places on purpose: the session's metadata
 * (what `checkout.session.completed` reads), `client_reference_id` (what the
 * Stripe dashboard shows a person), and the subscription's metadata, so every
 * later `customer.subscription.*` event names the tenant even if the customer
 * id were ever lost. `planId` rides along so the completion event can place
 * the tenant before the subscription event with the price arrives.
 *
 * @returns {Promise<{id: string, url: string}>}
 */
async function createCheckoutSession({ companyId, planId, customerId, email, baseUrl }) {
  const price = priceFor(planId);
  if (!secretKey() || !price) {
    throw new StripeNotConfiguredError(`Checkout is not configured for the ${planId} plan`);
  }

  const metadata = { companyId: String(companyId), planId };
  const params = {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(companyId),
    metadata,
    subscription_data: { metadata },
    success_url: `${baseUrl}/admin/#billing?checkout=success`,
    cancel_url: `${baseUrl}/admin/#billing?checkout=cancelled`,
    allow_promotion_codes: 'true'
  };

  // Reusing the customer keeps one Stripe customer per tenant, with one card
  // and one invoice history, rather than a new one per upgrade attempt.
  if (customerId) {
    params.customer = customerId;
  } else if (email) {
    params.customer_email = email;
  }

  const session = await stripePost('/checkout/sessions', params);
  return { id: session.id, url: session.url };
}

/**
 * A Billing Portal session, where an existing customer changes card, plan or
 * cancels on Stripe's page rather than ours.
 *
 * @returns {Promise<{url: string}>}
 */
async function createPortalSession({ customerId, baseUrl }) {
  if (!secretKey()) {
    throw new StripeNotConfiguredError('Stripe is not configured');
  }

  const session = await stripePost('/billing_portal/sessions', {
    customer: customerId,
    return_url: `${baseUrl}/admin/#billing`
  });
  return { url: session.url };
}

module.exports = {
  verifyEvent,
  translate,
  planFor,
  claimEvent,
  releaseEvent,
  clientReferenceAllowed,
  StripeEvent,
  priceFor,
  checkoutPlans,
  createCheckoutSession,
  createPortalSession,
  formEncode,
  StripeNotConfiguredError,
  StripeRequestError,
  PURCHASABLE_PLANS,
  TOLERANCE_SECONDS,
  EVENT_MEMORY_DAYS
};
