/**
 * Resolutions: what a per-resolution tenant pays for.
 *
 * A resolution is a conversation the bot resolved, by exactly the definition
 * the value report publishes (services/analytics.js `resolvedPipeline`) -
 * imported, not copied, because a tenant must be able to check their bill
 * against their own Reports screen and get the same number.
 *
 * Two rules sit on top of that definition, both in the tenant's favour:
 *
 *   settled  a conversation counts once it has ended or sat idle for a day.
 *            Until then the visitor may come back and ask for a person, and
 *            a resolution that becomes a handover must never have been
 *            billed.
 *   capped   the tenant sets a monthly spending cap. Past it, resolutions
 *            stop being billed - the bot keeps answering, nothing is
 *            refused - and the owner is warned at 80% and 100% by the
 *            ordinary usage alerts (the cap is the `resolutionSpend` meter).
 *
 * Months are calendar months in UTC, like every other meter (models/usage.js),
 * and a conversation belongs to the month it started in.
 *
 * Two jobs for the scheduler, neither of which throws:
 *
 *   recordResolutions()         nightly: counts every company's month into
 *                               `Usage.resolutions`
 *   reportResolutionsToStripe() daily: tells Stripe's meter what changed for
 *                               each per-resolution tenant who pays through it
 */

const Conversation = require('../models/conversation');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const analytics = require('./analytics');
const stripe = require('./stripe');
const { getPlan, resolutionPricing } = require('../config/plans');
const { toObjectId } = require('../utils/query');
const { logger } = require('./logging');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a conversation must sit idle before it can be billed. */
const SETTLE_MS = DAY_MS;

/**
 * How long after a month ends it is still counted and reported. Stripe keeps
 * an invoice open for usage for its finalization grace period, which is at
 * most three days; a conversation from the month's last evening settles a day
 * later and still has to reach it.
 */
const LATE_DAYS = 3;

/** Live counts are an aggregation; the banner asks on every page load. */
const LIVE_TTL_MS = 60 * 1000;
const liveCache = new Map();

/** `YYYY-MM` -> the first instant of that month and of the next, UTC. */
function periodBounds(period) {
  const [year, month] = String(period).split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1))
  };
}

function previousPeriod(period) {
  const { start } = periodBounds(period);
  return Usage.currentPeriod(new Date(start.getTime() - 1));
}

/** `YYYY-MM-DD`, UTC: one Stripe report per company, month and day. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The months still open to counting: this one, and last month for the first
 * few days of this one.
 */
function openPeriods(now = new Date()) {
  const current = Usage.currentPeriod(now);
  const { start } = periodBounds(current);
  return now.getTime() - start.getTime() < LATE_DAYS * DAY_MS
    ? [previousPeriod(current), current]
    : [current];
}

/**
 * The conversations a month's count looks at: the company's, started in the
 * month, and settled - ended, or quiet for a day.
 */
function settledMatch(companyId, period, now = new Date()) {
  const { start, end } = periodBounds(period);
  return {
    company: toObjectId(companyId),
    startedAt: { $gte: start, $lt: end },
    $or: [
      { status: { $in: ['ended', 'archived'] } },
      { endedAt: { $ne: null } },
      { lastActivity: { $lte: new Date(now.getTime() - SETTLE_MS) } }
    ]
  };
}

/**
 * Conversations and bot resolutions for one company and month.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {boolean} [options.settledOnly=true] false counts open conversations
 *   too, as the agency's client list does - a rate, not a bill
 * @returns {Promise<{conversations: number, botResolved: number}>}
 */
async function statsForPeriod(companyId, period, { now = new Date(), settledOnly = true } = {}) {
  const { start, end } = periodBounds(period);
  const match = settledOnly
    ? settledMatch(companyId, period, now)
    : { company: toObjectId(companyId), startedAt: { $gte: start, $lt: end } };

  const [row] = await Conversation.aggregate(analytics.resolvedPipeline(match));
  return { conversations: row ? row.conversations : 0, botResolved: row ? row.botResolved : 0 };
}

/**
 * Billable resolutions for one company and month: conversations the bot
 * resolved, started in the month, and settled.
 *
 * @param {string|ObjectId} companyId
 * @param {string} period `YYYY-MM`
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<number>}
 */
async function countForPeriod(companyId, period, options = {}) {
  return (await statsForPeriod(companyId, period, { ...options, settledOnly: true })).botResolved;
}

/**
 * This month's count, cached for a minute: the usage banner asks on every
 * page load, and a count a minute old is as true as one a second old.
 */
async function liveCount(companyId, now = new Date()) {
  const period = Usage.currentPeriod(now);
  const key = `${companyId}:${period}`;
  const hit = liveCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  const value = await countForPeriod(companyId, period, { now });
  liveCache.set(key, { value, expires: Date.now() + LIVE_TTL_MS });
  return value;
}

/** Forget cached counts, after a change that would alter them. */
function forget(companyId) {
  if (!companyId) {
    liveCache.clear();
    return;
  }
  for (const key of liveCache.keys()) {
    if (key.startsWith(`${companyId}:`)) {
      liveCache.delete(key);
    }
  }
}

const toCents = amount => Math.round(Number(amount || 0) * 100);
const fromCents = cents => Math.round(cents) / 100;

/**
 * What a month of resolutions costs, and how the cap bears on it.
 *
 * Worked in cents, and the cap in whole resolutions, so the bill is always a
 * whole number of resolutions at the published price and never a cent over
 * the cap - "204 × $0.49 = $99.96", not "$100.00".
 *
 * @param {object} terms
 * @param {number} terms.resolutions this month's count
 * @param {object} terms.pricing the plan's `pricing`
 * @param {number|null} [terms.cap] the tenant's monthly cap, in money
 * @returns {{resolutions, included, chargeable, billable, unbilled, price,
 *   amount, uncappedAmount, cap, capReached, capPercent}}
 */
function bill({ resolutions, pricing, cap = null }) {
  const included = Math.max(0, pricing.includedResolutions || 0);
  const priceCents = toCents(pricing.perResolution);
  const chargeable = Math.max(0, (resolutions || 0) - included);
  const hasCap = cap !== null && cap !== undefined && Number.isFinite(Number(cap));
  const capUnits = !hasCap ? null : (priceCents > 0 ? Math.floor(toCents(cap) / priceCents) : Infinity);
  const billable = capUnits === null ? chargeable : Math.min(chargeable, capUnits);

  return {
    resolutions: resolutions || 0,
    included,
    chargeable,
    billable,
    unbilled: chargeable - billable,
    price: fromCents(priceCents),
    amount: fromCents(billable * priceCents),
    uncappedAmount: fromCents(chargeable * priceCents),
    cap: hasCap ? Number(cap) : null,
    capReached: capUnits !== null && chargeable >= capUnits,
    capPercent: hasCap && toCents(cap) > 0
      ? Math.round((chargeable * priceCents / toCents(cap)) * 100)
      : null
  };
}

/**
 * What this month's resolutions cost before the cap, in money: the
 * `resolutionSpend` meter usage-alerts.js warns on. Zero for anyone not
 * paying per resolution.
 */
async function currentSpend(companyId, subscription) {
  const pricing = subscription && subscription.pricingModel === 'per_resolution'
    ? resolutionPricing(subscription.planId)
    : null;
  if (!pricing) {
    return 0;
  }
  return bill({ resolutions: await liveCount(companyId), pricing }).uncappedAmount;
}

/**
 * Everything the Plan & billing screen says about pricing: which model, the
 * count with its definition, the cap, and a projection for the month.
 */
async function summary(companyId, subscription, { now = new Date() } = {}) {
  const plan = getPlan(subscription.planId);
  const pricing = resolutionPricing(subscription.planId);
  const perResolution = subscription.pricingModel === 'per_resolution' && Boolean(pricing);
  const period = Usage.currentPeriod(now);

  const result = {
    model: perResolution ? 'per_resolution' : 'flat',
    available: Boolean(pricing),
    pricing: pricing ? {
      perResolution: pricing.perResolution,
      includedResolutions: pricing.includedResolutions,
      baseFee: pricing.baseFee
    } : null,
    flatPrice: plan.price,
    period,
    definition: analytics.RESOLVED_DEFINITION,
    settleHours: SETTLE_MS / (60 * 60 * 1000),
    cap: Number.isFinite(subscription.spendCap) ? subscription.spendCap : null,
    metered: stripe.meteredBillingConfigured()
  };

  if (!pricing) {
    return result;
  }

  const resolutions = await liveCount(companyId, now);
  const terms = bill({ resolutions, pricing, cap: result.cap });
  const usage = await Usage.findOne({ company: companyId, period }).select('stripeReport resolutionsCountedAt').lean();

  // A projection on two days of data is a guess dressed up as a number.
  const { start, end } = periodBounds(period);
  const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime());
  const projectedResolutions = elapsed >= 0.1 ? Math.round(resolutions / elapsed) : null;
  const projected = projectedResolutions === null
    ? null
    : bill({ resolutions: projectedResolutions, pricing, cap: result.cap });

  return {
    ...result,
    resolutions,
    bill: terms,
    // The month so far at per-resolution prices, base fee included - also
    // for a tenant on flat pricing, so the choice can be made on their own
    // numbers rather than on ours.
    total: Math.round((pricing.baseFee + terms.amount) * 100) / 100,
    projected: projected ? {
      resolutions: projectedResolutions,
      amount: projected.amount,
      total: Math.round((pricing.baseFee + projected.amount) * 100) / 100,
      capReached: projected.capReached
    } : null,
    reportedToStripe: usage && usage.stripeReport ? usage.stripeReport.reported || 0 : 0,
    countedAt: usage ? usage.resolutionsCountedAt || null : null
  };
}

/**
 * Store a month's count. Updates the row if it exists and only creates one
 * when there is something to say, so a quiet tenant's past months do not
 * fill up with zeros.
 */
async function store(companyId, period, count, now) {
  const set = { resolutions: count, resolutionsCountedAt: now };
  const updated = await Usage.updateOne({ company: companyId, period }, { $set: set });
  if (updated.matchedCount > 0 || count === 0) {
    return;
  }
  try {
    await Usage.updateOne({ company: companyId, period }, { $set: set }, { upsert: true });
  } catch (error) {
    // Another writer created the row in between; the unique index says so.
    if (error && error.code === 11000) {
      await Usage.updateOne({ company: companyId, period }, { $set: set });
      return;
    }
    throw error;
  }
}

/**
 * Count one company's open months into `Usage.resolutions`.
 *
 * @returns {Promise<Array<{period: string, resolutions: number}>>}
 */
async function recordCompany(companyId, { now = new Date() } = {}) {
  const results = [];
  for (const period of openPeriods(now)) {
    const count = await countForPeriod(companyId, period, { now });
    await store(companyId, period, count, now);
    results.push({ period, resolutions: count });
  }
  forget(companyId);
  return results;
}

/**
 * The nightly count, for every active company. One company's failure does
 * not stop the rest, and nothing here throws.
 *
 * @returns {Promise<{companies: number, failed: number}>}
 */
async function recordResolutions({ now = new Date() } = {}) {
  let companies = 0;
  let failed = 0;

  try {
    const cursor = Company.find({ isActive: { $ne: false } }).select('_id').lean().cursor();
    for await (const company of cursor) {
      companies += 1;
      try {
        await recordCompany(company._id, { now });
      } catch (error) {
        failed += 1;
        logger.error('Could not count a company\'s resolutions', { companyId: String(company._id), error: error.message });
      }
    }
  } catch (error) {
    logger.error('Resolution count failed', { error: error.message });
  }

  logger.info('Resolutions counted', { companies, failed });
  return { companies, failed };
}

/**
 * Send one meter event and remember that it landed.
 *
 * The report is already recorded as `pending` (and the day claimed) before
 * this runs. Success moves it into `reported`. A refusal from Stripe means
 * nothing was recorded there, so the pending report is dropped and the next
 * day's report carries the difference instead. A failure with no answer
 * leaves it pending, to be resent unchanged - same identifier, same value -
 * which Stripe deduplicates if the first one did land.
 */
async function send(usageId, customerId, pending, options) {
  try {
    await stripe.reportMeterEvent({
      customerId,
      value: pending.value,
      identifier: pending.identifier,
      timestamp: pending.timestamp
    }, options);
  } catch (error) {
    if (error.permanent) {
      await Usage.updateOne(
        { _id: usageId, 'stripeReport.pending.identifier': pending.identifier },
        { $unset: { 'stripeReport.pending': '' } }
      );
      logger.error('Stripe refused a resolution report; it will be part of the next one', {
        identifier: pending.identifier, status: error.status
      });
      return { ok: false, permanent: true };
    }
    logger.warn('A resolution report did not reach Stripe; it will be resent unchanged', {
      identifier: pending.identifier, error: error.message
    });
    return { ok: false };
  }

  await Usage.updateOne(
    { _id: usageId, 'stripeReport.pending.identifier': pending.identifier },
    { $inc: { 'stripeReport.reported': pending.value }, $unset: { 'stripeReport.pending': '' } }
  );
  return { ok: true };
}

/** Stripe accepts meter events from the last 35 days, and no older. */
const STRIPE_MAX_AGE_SECONDS = 35 * 24 * 60 * 60;

/**
 * Report one company's month to Stripe: what is billable now, less what has
 * been reported already. At most one new report per company, month and day;
 * its identifier (and Idempotency-Key) is `res_<company>_<YYYY-MM>_<day>`.
 *
 * @returns {Promise<{period: string, sent: number, skipped?: string}>}
 */
async function reportCompanyPeriod(subscription, period, { now = new Date(), retryDelayMs } = {}) {
  const companyId = String(subscription.company);
  const pricing = resolutionPricing(subscription.planId);
  if (!pricing) {
    return { period, sent: 0, skipped: 'plan_has_no_per_resolution_option' };
  }

  // Recounted here rather than trusted from last night, so the report is
  // right whichever of the two jobs the scheduler happens to run first.
  const resolutions = await countForPeriod(companyId, period, { now });
  await store(companyId, period, resolutions, now);
  const terms = bill({ resolutions, pricing, cap: Number.isFinite(subscription.spendCap) ? subscription.spendCap : null });

  let usage = await Usage.findOne({ company: companyId, period }).lean();
  if (!usage) {
    // Nothing counted and nothing ever reported: there is nothing to say.
    return { period, sent: 0, skipped: 'nothing_to_report' };
  }

  const options = retryDelayMs === undefined ? {} : { retryDelayMs };
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let sent = 0;

  // An earlier report that never got an answer goes first, exactly as it was.
  const earlier = usage.stripeReport && usage.stripeReport.pending;
  if (earlier && earlier.identifier) {
    if (nowSeconds - earlier.timestamp > STRIPE_MAX_AGE_SECONDS) {
      await Usage.updateOne({ _id: usage._id }, { $unset: { 'stripeReport.pending': '' } });
      logger.error('Dropped a resolution report too old for Stripe to accept', { identifier: earlier.identifier });
    } else {
      const result = await send(usage._id, subscription.externalCustomerId, earlier, options);
      if (!result.ok && !result.permanent) {
        return { period, sent: 0, skipped: 'previous_report_unconfirmed' };
      }
      sent += result.ok ? earlier.value : 0;
    }
    usage = await Usage.findOne({ _id: usage._id }).lean();
  }

  const day = isoDay(now);
  const reported = (usage.stripeReport && usage.stripeReport.reported) || 0;
  const delta = terms.billable - reported;

  if (usage.stripeReport && usage.stripeReport.day === day) {
    return { period, sent, skipped: 'already_reported_today' };
  }
  if (delta === 0) {
    return { period, sent, skipped: 'nothing_new' };
  }

  // Inside the month it describes, so last month's late resolutions land on
  // last month's invoice while Stripe still holds it open.
  const { end } = periodBounds(period);
  const pending = {
    identifier: `res_${companyId}_${period}_${day}`,
    value: delta,
    timestamp: Math.min(nowSeconds, Math.floor(end.getTime() / 1000) - 1)
  };

  // Claimed before sending, so two instances running the job at once send
  // one report between them.
  const claim = await Usage.updateOne(
    {
      _id: usage._id,
      'stripeReport.day': { $ne: day },
      'stripeReport.pending.identifier': { $exists: false }
    },
    { $set: { 'stripeReport.day': day, 'stripeReport.pending': pending } }
  );
  if (claim.modifiedCount !== 1) {
    return { period, sent, skipped: 'claimed_elsewhere' };
  }

  const result = await send(usage._id, subscription.externalCustomerId, pending, options);
  return { period, sent: sent + (result.ok ? delta : 0) };
}

/**
 * The daily report to Stripe, for every tenant paying per resolution through
 * it. Does nothing at all unless a secret key and the metered price are
 * configured. Nothing here throws.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.retryDelayMs] between retries of one request
 * @returns {Promise<{configured: boolean, companies: number, sent: number, failed: number}>}
 */
async function reportResolutionsToStripe({ now = new Date(), retryDelayMs } = {}) {
  if (!stripe.meteredBillingConfigured()) {
    return { configured: false, companies: 0, sent: 0, failed: 0 };
  }

  let companies = 0;
  let sent = 0;
  let failed = 0;

  try {
    const subscriptions = await Subscription.find({
      pricingModel: 'per_resolution',
      externalCustomerId: { $exists: true, $nin: [null, ''] },
      status: { $in: ['active', 'past_due'] }
    }).lean();

    for (const subscription of subscriptions) {
      companies += 1;
      for (const period of openPeriods(now)) {
        try {
          const result = await reportCompanyPeriod(subscription, period, { now, retryDelayMs });
          sent += result.sent;
        } catch (error) {
          failed += 1;
          logger.error('Could not report resolutions to Stripe', {
            companyId: String(subscription.company), period, error: error.message
          });
        }
      }
    }
  } catch (error) {
    logger.error('Resolution report to Stripe failed', { error: error.message });
  }

  logger.info('Resolutions reported to Stripe', { companies, sent, failed });
  return { configured: true, companies, sent, failed };
}

module.exports = {
  countForPeriod,
  statsForPeriod,
  liveCount,
  forget,
  bill,
  currentSpend,
  summary,
  recordCompany,
  recordResolutions,
  reportCompanyPeriod,
  reportResolutionsToStripe,
  periodBounds,
  openPeriods,
  settledMatch,
  SETTLE_MS,
  LATE_DAYS
};
