/**
 * Usage metering and quota checks.
 *
 * Two responsibilities, kept apart deliberately:
 *
 *   record(...)  never blocks and never throws. Metering must not be able to
 *                break a live conversation, so a failed write is logged and
 *                swallowed.
 *   check(...)   decides whether an action is allowed. This one is allowed to
 *                say no, and callers must handle that.
 */

const Usage = require('../models/usage');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const Workflow = require('../models/workflow');
const KnowledgeChunk = require('../models/knowledge-chunk');
const { METERS, getPlan } = require('../config/plans');
const { logger } = require('./logging');

// Subscriptions are read on nearly every metered action but change rarely.
const SUBSCRIPTION_CACHE_TTL_MS = 30 * 1000;
const subscriptionCache = new Map();

function cacheKey(companyId) {
  return String(companyId);
}

function invalidateSubscription(companyId) {
  subscriptionCache.delete(cacheKey(companyId));
}

async function getSubscription(companyId) {
  const key = cacheKey(companyId);
  const hit = subscriptionCache.get(key);

  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }

  const subscription = await Subscription.forCompany(companyId);
  subscriptionCache.set(key, { value: subscription, expires: Date.now() + SUBSCRIPTION_CACHE_TTL_MS });
  return subscription;
}

/**
 * Increment usage counters for a company.
 *
 * @param {string|ObjectId} companyId
 * @param {object} increments e.g. `{ conversations: 1, messages: 3 }`
 */
async function record(companyId, increments = {}) {
  if (!companyId) {
    // A conversation with no tenant cannot be billed to anyone; that is a
    // tenancy bug worth surfacing, but not worth failing the request over.
    return null;
  }

  const fields = Object.entries(increments).filter(([, value]) => Number.isFinite(value) && value !== 0);
  if (fields.length === 0) {
    return null;
  }

  try {
    return await Usage.findOneAndUpdate(
      { company: companyId, period: Usage.currentPeriod() },
      {
        // $inc inside an upsert is atomic, so parallel conversations across
        // several processes cannot lose increments.
        $inc: Object.fromEntries(fields),
        $set: { updatedAt: new Date() }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    // Never let metering break a conversation.
    logger.error('Failed to record usage', { companyId: String(companyId), error: error.message });
    return null;
  }
}

/**
 * Current value of a meter, for meters that count a live total rather than a
 * monthly tally.
 */
async function currentValue(companyId, meter) {
  switch (meter) {
  case 'operators':
    // Active operators, including those invited and not yet signed in.
    // Company admins are not seats.
    return User.countDocuments({ company: companyId, role: 'operator', isActive: true });
  case 'workflows':
    // Only what is live counts; drafts and archived versions are free.
    return Workflow.countDocuments({ company: companyId, status: 'published' });
  case 'knowledgeChunks':
    return KnowledgeChunk.countDocuments({ company: companyId });
  case 'actions': {
    // Saved Actions and switched-on MCP tools share one allowance: both are a
    // way for the bot to act in the tenant's systems. Required lazily so this
    // file's import graph stays what it was.
    const [saved, tools] = await Promise.all([
      require('../models/action').countDocuments({ company: companyId }),
      require('../models/mcp-server').aggregate([
        { $match: { company: new (require('mongoose').Types.ObjectId)(String(companyId)) } },
        { $unwind: '$tools' },
        { $match: { 'tools.enabled': true } },
        { $count: 'n' }
      ]).then(([row]) => (row ? row.n : 0))
    ]);
    return saved + tools;
  }
  case 'resolutionSpend':
    // Money, not a count: what this month's resolutions cost before the cap.
    return require('./resolutions').currentSpend(companyId, await getSubscription(companyId));
  default: {
    const usageKey = METERS[meter] ? METERS[meter].usageKey : meter;
    const usage = await Usage.findOne({ company: companyId, period: Usage.currentPeriod() }).lean();
    return usage ? (usage[usageKey] || 0) : 0;
  }
  }
}

/**
 * Whether a company may perform one more of `meter`.
 *
 * @returns {Promise<{allowed: boolean, reason?: string, limit: number|null,
 *                    used: number, remaining: number|null, planId: string}>}
 */
async function check(companyId, meter, requested = 1) {
  if (!companyId) {
    // Without a tenant there is no plan to enforce. Allow, and let the tenancy
    // layer be the thing that complains.
    return { allowed: true, limit: null, used: 0, remaining: null, planId: 'unknown' };
  }

  const subscription = await getSubscription(companyId);

  if (!subscription.isEntitled()) {
    return {
      allowed: false,
      reason: subscription.status === 'trialing'
        ? 'Your trial has ended. Choose a plan to continue.'
        : `This account is ${subscription.status}.`,
      limit: 0,
      used: 0,
      remaining: 0,
      planId: subscription.planId
    };
  }

  const limit = subscription.limitFor(meter);

  if (limit === null || limit === undefined) {
    return { allowed: true, limit: null, used: 0, remaining: null, planId: subscription.planId };
  }

  const used = await currentValue(companyId, meter);
  const allowed = used + requested <= limit || subscription.overageAllowed;

  return {
    allowed,
    reason: allowed ? undefined : `${METERS[meter]?.label || meter} limit reached (${used}/${limit}) on the ${getPlan(subscription.planId).name} plan.`,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    planId: subscription.planId,
    overage: allowed && used + requested > limit
  };
}

/**
 * Whether a company's plan includes a feature.
 */
async function hasFeature(companyId, feature) {
  if (!companyId) {
    return true;
  }
  const subscription = await getSubscription(companyId);
  return subscription.isEntitled() && subscription.hasFeature(feature);
}

/** From this share of a limit on, the owner is told. */
const WARN_AT_PERCENT = 80;

/**
 * Every meter's reading against its limit.
 *
 * `percentage` is capped at 100 for drawing a bar; `percent` is not, so a
 * tenant at 130% on overage reads as over rather than as exactly full.
 */
async function meterReadings(companyId, subscription) {
  // A meter in money (the spending cap) exists only for the tenant who set
  // one; for everyone else it is not "unlimited", it is not there.
  const applicable = Object.keys(METERS)
    .filter(meter => !METERS[meter].money || subscription.limitFor(meter) !== null);

  return Promise.all(
    applicable.map(async meter => {
      const limit = subscription.limitFor(meter);
      const used = await currentValue(companyId, meter);
      const percent = limit ? Math.round((used / limit) * 100) : null;

      return {
        meter,
        label: METERS[meter].label,
        resets: METERS[meter].resets,
        ...(METERS[meter].money ? { money: true } : {}),
        used,
        limit,
        // Unlimited meters have no meaningful percentage; the UI shows usage
        // rather than a bar.
        percentage: percent === null ? null : Math.min(100, percent),
        percent
      };
    })
  );
}

/**
 * The meters at or past the warning line, fullest first.
 *
 * A limit of 0 is "not on this plan" rather than "full", so it is never a
 * warning: a Basic tenant should not be told every day that they have used
 * 100% of a feature they do not have.
 */
/**
 * Meters that count what a company has rather than what it uses up. Having
 * every seat filled, or the one live workflow a plan allows, is a choice the
 * owner made, not something about to run out under their customers; only
 * being over (after a downgrade) is worth a warning.
 */
const CAPACITY_METERS = new Set(['operators', 'workflows', 'actions']);

function warningsFrom(meters) {
  return meters
    .filter(reading => reading.limit && reading.percent !== null && (
      CAPACITY_METERS.has(reading.meter) ? reading.percent > 100 : reading.percent >= WARN_AT_PERCENT
    ))
    .map(reading => ({
      meter: reading.meter,
      label: reading.label,
      used: reading.used,
      limit: reading.limit,
      percent: reading.percent,
      resets: reading.resets,
      ...(reading.money ? { money: true } : {})
    }))
    .sort((a, b) => b.percent - a.percent);
}

/**
 * The meters a company is close to, or over, the limit on.
 *
 * @returns {Promise<Array<{meter, label, used, limit, percent, resets}>>}
 */
async function warnings(companyId) {
  if (!companyId) {
    return [];
  }
  const subscription = await getSubscription(companyId);
  return warningsFrom(await meterReadings(companyId, subscription));
}

/**
 * A full picture of a company's plan and consumption, for the billing screen.
 */
async function summary(companyId) {
  const subscription = await getSubscription(companyId);
  const plan = getPlan(subscription.planId);

  const meters = await meterReadings(companyId, subscription);

  const usage = await Usage.findOne({ company: companyId, period: Usage.currentPeriod() }).lean();

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      price: plan.price,
      interval: plan.interval,
      description: plan.description,
      features: plan.features
    },
    subscription: {
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      overageAllowed: subscription.overageAllowed,
      entitled: subscription.isEntitled(),
      pricingModel: subscription.pricingModel || 'flat'
    },
    // How the plan is paid for, the month's resolutions and the cap.
    pricing: await require('./resolutions').summary(companyId, subscription),
    period: Usage.currentPeriod(),
    meters,
    warnings: warningsFrom(meters),
    detail: {
      conversations: usage?.conversations || 0,
      messages: usage?.messages || 0,
      aiResponses: usage?.aiResponses || 0,
      operatorMessages: usage?.operatorMessages || 0,
      filesUploaded: usage?.filesUploaded || 0,
      limitHits: usage?.limitHits || 0
    }
  };
}

/**
 * What one AI reply is assumed to cost the platform, for the superadmin's
 * estimate. A rough figure on purpose: the real bill depends on the model,
 * the prompt and the knowledge retrieved, and this is for spotting the tenant
 * whose usage costs more than they pay, not for accounting.
 */
function aiCostPerReply() {
  const value = parseFloat(process.env.AI_COST_PER_REPLY);
  return Number.isFinite(value) && value >= 0 ? value : 0.002;
}

/**
 * Usage across every tenant for one period, for the superadmin view.
 *
 * Starts from the companies rather than from the usage rows, so a tenant who
 * has not had a single conversation this month is listed - with zeros - rather
 * than missing. That tenant is usually the one somebody needs to call.
 */
async function allTenantUsage(period = Usage.currentPeriod()) {
  const Company = require('../models/company');
  const now = new Date();
  const costPerReply = aiCostPerReply();

  const rows = await Company.aggregate([
    {
      $lookup: {
        from: Usage.collection.name,
        let: { companyId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$company', '$$companyId'] }, { $eq: ['$period', period] }] } } }
        ],
        as: 'usage'
      }
    },
    { $unwind: { path: '$usage', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: Subscription.collection.name, localField: '_id', foreignField: 'company', as: 'sub'
      }
    },
    { $unwind: { path: '$sub', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        companyId: '$_id',
        companyName: '$name',
        isActive: { $ne: ['$isActive', false] },
        createdVia: { $ifNull: ['$createdVia', 'superadmin'] },
        createdAt: 1,
        planId: { $ifNull: ['$sub.planId', 'trial'] },
        storedStatus: { $ifNull: ['$sub.status', 'trialing'] },
        trialEndsAt: '$sub.trialEndsAt',
        overageAllowed: { $ifNull: ['$sub.overageAllowed', false] },
        widgetSeenAt: '$widgetSeen.at',
        widgetOrigin: '$widgetSeen.origin',
        conversations: { $ifNull: ['$usage.conversations', 0] },
        messages: { $ifNull: ['$usage.messages', 0] },
        aiResponses: { $ifNull: ['$usage.aiResponses', 0] },
        filesUploaded: { $ifNull: ['$usage.filesUploaded', 0] },
        limitHits: { $ifNull: ['$usage.limitHits', 0] }
      }
    },
    { $sort: { conversations: -1, companyName: 1 } }
  ]);

  return rows.map(row => {
    // The stored status of a lapsed trial is still `trialing`; say what it is.
    const trialExpired = row.storedStatus === 'trialing' && row.trialEndsAt && new Date(row.trialEndsAt) < now;
    const { storedStatus, ...rest } = row;
    return {
      ...rest,
      status: trialExpired ? 'trial_expired' : storedStatus,
      installed: Boolean(row.widgetSeenAt),
      estimatedAiCost: Math.round(row.aiResponses * costPerReply * 100) / 100
    };
  });
}

/**
 * Note that an action was refused, so the billing screen can show a tenant
 * they are being throttled rather than leaving them to guess.
 */
async function recordLimitHit(companyId) {
  return record(companyId, { limitHits: 1 });
}

/**
 * What a visitor is told when their message cannot be answered because of the
 * tenant's plan. Deliberately says nothing about quotas or billing: that is a
 * conversation between the platform and the tenant, not something to put in
 * front of the tenant's customer.
 */
const UNAVAILABLE_MESSAGE = 'Sorry, this chat is unavailable right now. Please try again later.';

/** What a visitor is told when generating a reply failed. */
const REPLY_FAILED_MESSAGE = 'Sorry, something went wrong while preparing a reply. Please try again in a moment.';

module.exports = {
  UNAVAILABLE_MESSAGE,
  REPLY_FAILED_MESSAGE,
  record,
  check,
  hasFeature,
  summary,
  warnings,
  warningsFrom,
  WARN_AT_PERCENT,
  currentValue,
  allTenantUsage,
  aiCostPerReply,
  recordLimitHit,
  getSubscription,
  invalidateSubscription
};
