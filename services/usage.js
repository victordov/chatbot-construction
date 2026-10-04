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
    return User.countDocuments({ company: companyId, isActive: true });
  case 'workflows':
    return Workflow.countDocuments({ company: companyId, status: { $ne: 'archived' } });
  case 'knowledgeChunks':
    return KnowledgeChunk.countDocuments({ company: companyId });
  case 'actions':
    // Required lazily so this file's import graph stays what it was.
    return require('../models/action').countDocuments({ company: companyId });
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

/**
 * A full picture of a company's plan and consumption, for the billing screen.
 */
async function summary(companyId) {
  const subscription = await getSubscription(companyId);
  const plan = getPlan(subscription.planId);

  const meters = await Promise.all(
    Object.keys(METERS).map(async meter => {
      const limit = subscription.limitFor(meter);
      const used = await currentValue(companyId, meter);

      return {
        meter,
        label: METERS[meter].label,
        resets: METERS[meter].resets,
        used,
        limit,
        // Unlimited meters have no meaningful percentage; the UI shows usage
        // rather than a bar.
        percentage: limit ? Math.min(100, Math.round((used / limit) * 100)) : null
      };
    })
  );

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
      entitled: subscription.isEntitled()
    },
    period: Usage.currentPeriod(),
    meters,
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
 * Usage across every tenant for one period, for the superadmin view.
 */
async function allTenantUsage(period = Usage.currentPeriod()) {
  return Usage.aggregate([
    { $match: { period } },
    { $lookup: { from: 'companies', localField: 'company', foreignField: '_id', as: 'companyDoc' } },
    { $unwind: { path: '$companyDoc', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'subscriptions', localField: 'company', foreignField: 'company', as: 'sub'
      }
    },
    { $unwind: { path: '$sub', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        companyId: '$company',
        companyName: '$companyDoc.name',
        planId: { $ifNull: ['$sub.planId', 'trial'] },
        status: { $ifNull: ['$sub.status', 'trialing'] },
        conversations: 1,
        messages: 1,
        aiResponses: 1,
        filesUploaded: 1,
        limitHits: 1
      }
    },
    { $sort: { conversations: -1 } }
  ]);
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
  currentValue,
  allTenantUsage,
  recordLimitHit,
  getSubscription,
  invalidateSubscription
};
