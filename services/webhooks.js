/**
 * Telling a tenant's systems what happened here.
 *
 * The counterpart to workflow action nodes. Those let a conversation reach into
 * a tenant's API; this lets the platform push out — a conversation ended, a
 * rating arrived, a lead qualified itself — so their CRM, warehouse and on-call
 * rota learn about it without a person reading a dashboard.
 *
 * Three things make a webhook system usable rather than merely present:
 *
 *   signing    a receiver has to be able to prove a delivery came from us and
 *              is not a replay. Signature covers the timestamp as well as the
 *              body, which is what makes replay detectable.
 *   retries    endpoints are down sometimes. Retries are rows with a time on
 *              them rather than timers in memory, so a deploy does not lose
 *              them — deploys being exactly when things are failing.
 *   evidence   every attempt is logged with what was sent and what came back.
 *              "It isn't firing" is unanswerable without that.
 *
 * The destination is a URL a tenant typed, so it goes through the same
 * address-checked transport as workflow actions. A webhook pointed at
 * 169.254.169.254 would be an SSRF hole with a nicer name.
 */

const crypto = require('crypto');

const Webhook = require('../models/webhook');
const WebhookDelivery = require('../models/webhook-delivery');
const safeHttp = require('./safe-http');
const secrets = require('./secrets');
const { logger } = require('./logging');

/**
 * The events a tenant can subscribe to.
 *
 * A closed list on purpose. Letting a subscription match a pattern means a new
 * event type starts arriving at somebody's production endpoint the day we ship
 * it, which is a surprise we would be handing to them.
 */
const EVENTS = [
  { id: 'conversation.started', label: 'A conversation started' },
  { id: 'conversation.ended', label: 'A conversation ended' },
  { id: 'conversation.tagged', label: 'A conversation was tagged' },
  { id: 'conversation.rated', label: 'A customer rated a conversation' },
  { id: 'operator.assigned', label: 'A conversation was assigned to someone' },
  { id: 'contact.created', label: 'A new person was seen' },
  { id: 'contact.identified', label: 'A person was verified' },
  { id: 'task.created', label: 'A task was raised' }
];

const EVENT_IDS = new Set(EVENTS.map(event => event.id));

const MAX_ATTEMPTS = 5;

/**
 * How long to wait before each retry, in seconds.
 *
 * Backing off to roughly two hours over five attempts: long enough to ride out
 * a deploy or a short outage, short enough that a recovered endpoint is not
 * waiting a day for its backlog.
 */
const RETRY_DELAYS = [30, 120, 600, 3600];

/** Endpoints that fail this many times in a row are switched off. */
const FAILURES_BEFORE_DISABLE = 20;

const DELIVERY_TIMEOUT_MS = 10000;

/**
 * Sign a delivery.
 *
 * The timestamp is inside the signed material, not merely alongside it. Signing
 * the body alone lets an attacker who captured one delivery replay it forever;
 * with the timestamp signed, a receiver that rejects old timestamps is safe,
 * and it cannot be tampered with to look recent.
 *
 * The format is `t=<unix>,v1=<hex>`, which is the one most developers have
 * already written a verifier for.
 */
function sign(payloadBody, secret, timestamp) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payloadBody}`)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

/**
 * A fresh signing secret, in a form that is obviously a secret when it turns up
 * in somebody's configuration file.
 */
function generateSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Record that something happened, and start delivering it.
 *
 * Never throws and never awaited by the thing that caused it: a conversation
 * must not slow down or fail because a tenant's endpoint is unhappy. Callers
 * fire this and move on.
 */
async function dispatch(companyId, event, payload) {
  try {
    if (!companyId || !EVENT_IDS.has(event)) {
      return [];
    }

    const hooks = await Webhook.find({
      company: companyId,
      enabled: true,
      events: event
    }).select('+secret').lean();

    if (hooks.length === 0) {
      return [];
    }

    const deliveries = await Promise.all(hooks.map(async hook => {
      const delivery = await WebhookDelivery.create({
        webhook: hook._id,
        company: companyId,
        event,
        payload,
        status: 'pending',
        nextAttemptAt: new Date()
      });

      // Attempted immediately; a failure reschedules rather than blocking.
      attempt(hook, delivery).catch(error =>
        logger.error('Webhook delivery threw', { error: error.message }));

      return delivery;
    }));

    return deliveries;
  } catch (error) {
    logger.error('Failed to dispatch webhook', { event, error: error.message });
    return [];
  }
}

/**
 * One delivery attempt.
 *
 * @returns {Promise<{delivered: boolean, status?: number, error?: string}>}
 */
async function attempt(hook, delivery) {
  const started = Date.now();
  const body = JSON.stringify({
    id: String(delivery._id),
    event: delivery.event,
    // ISO rather than a unix stamp in the body: this is the part a human reads
    // when something has gone wrong.
    createdAt: delivery.createdAt,
    data: delivery.payload
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const secret = secrets.decrypt(hook.secret) || '';

  const check = safeHttp.validateUrl(hook.url);

  if (!check.valid) {
    // A URL that stopped being valid — a tenant edited it, or it always
    // pointed somewhere it should not. Not retryable, so it fails outright.
    return settle(hook, delivery, {
      delivered: false,
      error: check.error,
      durationMs: Date.now() - started,
      retryable: false
    });
  }

  try {
    const response = await safeHttp.request(
      check.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': process.env.WEBHOOK_USER_AGENT || 'chatbot-platform-webhooks/1.0',
          'x-webhook-event': delivery.event,
          'x-webhook-id': String(delivery._id),
          // The header a receiver checks. Without a secret configured this is
          // absent rather than empty, so a receiver cannot mistake an unsigned
          // delivery for a verified one.
          ...(secret ? { 'x-webhook-signature': sign(body, secret, timestamp) } : {})
        }
      },
      body,
      DELIVERY_TIMEOUT_MS
    );

    const ok = response.statusCode >= 200 && response.statusCode < 300;

    return settle(hook, delivery, {
      delivered: ok,
      status: response.statusCode,
      responseBody: (response.body || '').slice(0, 2000),
      durationMs: Date.now() - started,
      error: ok ? undefined : `The endpoint returned ${response.statusCode}`,
      // 4xx is the endpoint saying "this request is wrong", which retrying will
      // not fix. 429 is the exception: it is explicitly "try later".
      retryable: !ok && (response.statusCode >= 500 || response.statusCode === 429)
    });
  } catch (error) {
    // A network failure, a timeout, a refused connection: all worth retrying.
    return settle(hook, delivery, {
      delivered: false,
      error: error.message,
      durationMs: Date.now() - started,
      retryable: true
    });
  }
}

/**
 * Record the outcome and decide whether to try again.
 */
async function settle(hook, delivery, outcome) {
  const attempts = (delivery.attempts || 0) + 1;
  const canRetry = outcome.retryable && attempts < MAX_ATTEMPTS;

  const update = {
    attempts,
    responseStatus: outcome.status,
    responseBody: outcome.responseBody,
    error: outcome.error,
    durationMs: outcome.durationMs
  };

  if (outcome.delivered) {
    update.status = 'delivered';
    update.deliveredAt = new Date();
    update.nextAttemptAt = null;
  } else if (canRetry) {
    update.status = 'pending';
    const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
    update.nextAttemptAt = new Date(Date.now() + delay * 1000);
  } else {
    update.status = 'failed';
    update.nextAttemptAt = null;
  }

  await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: update });

  await recordHealth(hook, outcome.delivered);

  if (!outcome.delivered) {
    logger.warn('Webhook delivery failed', {
      webhook: String(hook._id),
      event: delivery.event,
      attempts,
      willRetry: canRetry,
      error: outcome.error
    });
  }

  return { delivered: outcome.delivered, status: outcome.status, error: outcome.error };
}

/**
 * Track whether an endpoint is alive, and switch it off when it plainly is not.
 *
 * An endpoint gone for a week is not coming back this second. Retrying it
 * forever wastes our capacity and fills their logs, and the tenant is better
 * served by the thing being visibly disabled with a reason than by a queue
 * quietly growing.
 */
async function recordHealth(hook, delivered) {
  if (delivered) {
    await Webhook.updateOne(
      { _id: hook._id },
      { $set: { consecutiveFailures: 0, lastSuccessAt: new Date() } }
    );
    return;
  }

  const updated = await Webhook.findOneAndUpdate(
    { _id: hook._id },
    { $inc: { consecutiveFailures: 1 }, $set: { lastFailureAt: new Date() } },
    { new: true }
  ).lean();

  if (updated && updated.consecutiveFailures >= FAILURES_BEFORE_DISABLE && updated.enabled) {
    await Webhook.updateOne({ _id: hook._id }, {
      $set: {
        enabled: false,
        disabledAt: new Date(),
        disabledReason: `Switched off automatically after ${updated.consecutiveFailures} failures in a row.`
      }
    });

    logger.warn('Webhook disabled after sustained failures', {
      webhook: String(hook._id),
      failures: updated.consecutiveFailures
    });
  }
}

/**
 * Deliver everything that is due.
 *
 * Called on a schedule. Bounded per run so a large backlog is worked through
 * over several sweeps rather than in one burst that competes with live traffic.
 */
async function processPending(limit = 100) {
  try {
    const due = await WebhookDelivery.find({
      status: 'pending',
      nextAttemptAt: { $lte: new Date() }
    }).sort({ nextAttemptAt: 1 }).limit(limit).lean();

    if (due.length === 0) {
      return { attempted: 0 };
    }

    // Endpoints are fetched per delivery rather than cached: one may have been
    // disabled or re-pointed since the delivery was queued, and sending to an
    // address a tenant has just removed would be the wrong outcome.
    let attempted = 0;

    for (const delivery of due) {
      const hook = await Webhook.findById(delivery.webhook).select('+secret').lean();

      if (!hook || !hook.enabled) {
        await WebhookDelivery.updateOne({ _id: delivery._id }, {
          $set: {
            status: 'failed',
            nextAttemptAt: null,
            error: hook ? 'The endpoint was switched off before this could be delivered' : 'The endpoint was deleted'
          }
        });
        continue;
      }

      await attempt(hook, delivery);
      attempted += 1;
    }

    logger.info(`Webhook sweep attempted ${attempted} pending deliveries`);
    return { attempted };
  } catch (error) {
    logger.error('Webhook sweep failed', { error: error.message });
    return { attempted: 0, error: error.message };
  }
}

/**
 * Send a made-up event, so a tenant can prove their endpoint works before
 * relying on it. The payload says plainly that it is a test.
 */
async function sendTest(hook) {
  const delivery = await WebhookDelivery.create({
    webhook: hook._id,
    company: hook.company,
    event: 'conversation.ended',
    payload: {
      test: true,
      message: 'This is a test delivery. Nothing happened; somebody pressed a button.',
      sessionId: 'test-session',
      at: new Date()
    },
    status: 'pending',
    nextAttemptAt: new Date()
  });

  const result = await attempt(hook, delivery);
  return { ...result, deliveryId: delivery._id };
}

module.exports = {
  dispatch,
  processPending,
  sendTest,
  sign,
  generateSecret,
  attempt,
  EVENTS,
  EVENT_IDS,
  MAX_ATTEMPTS,
  RETRY_DELAYS,
  FAILURES_BEFORE_DISABLE
};
