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
 *
 * Per-resolution billing adds a metered price (`STRIPE_PRICE_RESOLUTION`)
 * attached to a Stripe Billing Meter whose event name is
 * `STRIPE_RESOLUTION_EVENT` (default `resolutions`), and optionally a base
 * fee price per plan (`STRIPE_PRICE_<PLAN>_PER_RESOLUTION`). Usage reaches the
 * meter as meter events (POST /v1/billing/meter_events), one a day per
 * company and month, sent by services/resolutions.js.
 */

const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { PLANS, resolutionPricing } = require('../config/plans');
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

/** Every price id on a Stripe subscription object. */
function pricesOf(subscription) {
  const items = subscription && subscription.items && Array.isArray(subscription.items.data)
    ? subscription.items.data
    : [];
  return items.map(item => (item && item.price ? item.price.id : null)).filter(Boolean);
}

/**
 * The price that names the plan on a Stripe subscription object, if it has
 * one. A per-resolution subscription also carries the metered resolution
 * price, which belongs to no plan, so that one is never the answer.
 */
function priceFrom(subscription) {
  const prices = pricesOf(subscription);
  const metered = resolutionPrice();
  return prices.find(price => price !== metered) || prices[0] || null;
}

/**
 * Whether a Stripe subscription is billed per resolution: it carries the
 * metered resolution price. Undefined when that price is not configured, so
 * a deployment without metered billing never changes anyone's model.
 */
function pricingModelFrom(subscription, metadata = {}) {
  if (metadata.pricingModel === 'per_resolution' || metadata.pricingModel === 'flat') {
    return metadata.pricingModel;
  }
  const metered = resolutionPrice();
  if (!metered || pricesOf(subscription).length === 0) {
    return undefined;
  }
  return pricesOf(subscription).includes(metered) ? 'per_resolution' : 'flat';
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
        // Only when the checkout said so: a session carries no prices, and
        // the subscription event that follows does.
        pricingModel: ['flat', 'per_resolution'].includes(metadata.pricingModel) ? metadata.pricingModel : undefined,
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
        pricingModel: pricingModelFrom(object, metadata),
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

/**
 * Plans a tenant can buy through Checkout, in catalogue order. Never the
 * trial. The agency plan only for a company a superadmin made an agency
 * (routes/billing.js checks).
 */
const PURCHASABLE_PLANS = ['basic', 'professional', 'agency', 'enterprise'];

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

/** The metered price resolutions are billed at, or null. */
function resolutionPrice() {
  return process.env.STRIPE_PRICE_RESOLUTION || null;
}

/** The meter's event name; must match the Billing Meter set up in Stripe. */
function resolutionEventName() {
  return (process.env.STRIPE_RESOLUTION_EVENT || '').trim() || 'resolutions';
}

/**
 * Whether resolutions can be reported to Stripe at all: a key and the
 * metered price. Without both, per-resolution billing is shown on the
 * billing screen and nothing is sent anywhere.
 */
function meteredBillingConfigured() {
  return Boolean(secretKey() && resolutionPrice());
}

/**
 * The Stripe prices a per-resolution checkout for a plan needs: the metered
 * price always, and the plan's base-fee price when the base fee is not zero.
 * Null when the plan has no per-resolution option or a price is missing.
 */
function resolutionPricesFor(planId) {
  const pricing = resolutionPricing(planId);
  if (!pricing || !meteredBillingConfigured() || !PURCHASABLE_PLANS.includes(planId)) {
    return null;
  }
  const base = process.env[`STRIPE_PRICE_${planId.toUpperCase()}_PER_RESOLUTION`] || null;
  if (pricing.baseFee > 0 && !base) {
    return null;
  }
  return { base: pricing.baseFee > 0 ? base : null, metered: resolutionPrice() };
}

/** Plans that can be bought per resolution through Checkout right now. */
function resolutionCheckoutPlans() {
  return PURCHASABLE_PLANS.filter(planId => Boolean(resolutionPricesFor(planId)));
}

/**
 * The first moment of next month, UTC, in seconds.
 *
 * A per-resolution subscription is anchored there so Stripe's billing
 * periods are calendar months - the same months usage is counted in and the
 * spending cap applies to. Otherwise an invoice running from the 15th to the
 * 15th would hold the tail of one month's capped usage and the head of the
 * next, and could come to nearly twice the cap.
 */
function nextMonthAnchor(now = new Date()) {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
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

async function stripePost(path, params, { idempotencyKey, failure = 'Stripe could not start the payment' } = {}) {
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
    throw new StripeRequestError(failure, status);
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
async function createCheckoutSession({ companyId, planId, customerId, email, baseUrl, pricingModel = 'flat', now }) {
  const perResolution = pricingModel === 'per_resolution';
  const price = perResolution ? null : priceFor(planId);
  const resolutionPrices = perResolution ? resolutionPricesFor(planId) : null;

  if (!secretKey() || (perResolution ? !resolutionPrices : !price)) {
    throw new StripeNotConfiguredError(`Checkout is not configured for the ${planId} plan`);
  }

  // A metered price takes no quantity: Stripe counts it from meter events.
  const lineItems = perResolution
    ? [
      ...(resolutionPrices.base ? [{ price: resolutionPrices.base, quantity: 1 }] : []),
      { price: resolutionPrices.metered }
    ]
    : [{ price, quantity: 1 }];

  const metadata = perResolution
    ? { companyId: String(companyId), planId, pricingModel }
    : { companyId: String(companyId), planId };
  const params = {
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: String(companyId),
    metadata,
    subscription_data: perResolution
      ? { metadata, billing_cycle_anchor: nextMonthAnchor(now) }
      : { metadata },
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

/**
 * A customer's invoices, newest first.
 *
 * Read straight from Stripe each time rather than mirrored here: they are
 * Stripe's documents, Stripe hosts the PDF, and a copy would only be a copy
 * that can be out of date.
 *
 * @returns {Promise<Array<{id, number, status, total, currency, created, hostedUrl, pdfUrl}>>}
 */
async function listInvoices(customerId, { limit = 24 } = {}) {
  if (!secretKey()) {
    throw new StripeNotConfiguredError('Stripe is not configured');
  }

  try {
    const response = await axios.get(`${STRIPE_API}/invoices`, {
      headers: { Authorization: `Bearer ${secretKey()}` },
      params: { customer: customerId, limit: Math.min(100, Math.max(1, limit)) },
      timeout: 15000
    });

    return ((response.data && response.data.data) || []).map(invoice => ({
      id: invoice.id,
      number: invoice.number || null,
      status: invoice.status,
      // Stripe counts in the currency's smallest unit.
      total: Number.isFinite(invoice.total) ? invoice.total / 100 : null,
      currency: invoice.currency ? String(invoice.currency).toUpperCase() : null,
      created: secondsToDate(invoice.created),
      periodStart: secondsToDate(invoice.period_start),
      periodEnd: secondsToDate(invoice.period_end),
      hostedUrl: invoice.hosted_invoice_url || null,
      pdfUrl: invoice.invoice_pdf || null
    }));
  } catch (error) {
    const status = error.response ? error.response.status : null;
    const detail = error.response && error.response.data && error.response.data.error
      ? error.response.data.error.message
      : error.message;
    logger.error('Stripe request failed', { path: '/invoices', status, error: detail });
    throw new StripeRequestError('Stripe could not list the invoices', status);
  }
}

/**
 * Report usage to the resolution meter.
 *
 * `identifier` is Stripe's own deduplication key for meter events (unique
 * within at least 24 hours) and goes as the Idempotency-Key as well, so a
 * request retried because the answer was lost cannot count twice. A value
 * may be negative: that is how Stripe takes a correction, and an invoice
 * line never goes below zero.
 *
 * Retries a 409, a 429, a 5xx and a request that never got an answer a
 * couple of times before giving up; the error carries `permanent` when
 * Stripe refused the event outright, in which case nothing was recorded.
 *
 * @param {object} event
 * @param {string} event.customerId the Stripe customer
 * @param {number} event.value resolutions to add (or take away)
 * @param {string} event.identifier at most 100 characters
 * @param {number} [event.timestamp] seconds; Stripe accepts the last 35 days
 * @param {object} [options]
 * @param {number} [options.retries=2]
 * @param {number} [options.retryDelayMs=500]
 */
async function reportMeterEvent({ customerId, value, identifier, timestamp }, { retries = 2, retryDelayMs = 500 } = {}) {
  if (!meteredBillingConfigured()) {
    throw new StripeNotConfiguredError('Metered billing is not configured');
  }

  const params = {
    event_name: resolutionEventName(),
    identifier,
    timestamp,
    payload: { stripe_customer_id: customerId, value: String(value) }
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await stripePost('/billing/meter_events', params, {
        idempotencyKey: identifier,
        failure: 'Stripe did not accept the usage report'
      });
    } catch (error) {
      const status = error.status;
      const transient = !status || status === 409 || status === 429 || status >= 500;
      if (!transient) {
        error.permanent = true;
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

module.exports = {
  listInvoices,
  reportMeterEvent,
  meteredBillingConfigured,
  resolutionPrice,
  resolutionEventName,
  resolutionPricesFor,
  resolutionCheckoutPlans,
  pricingModelFrom,
  nextMonthAnchor,
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
