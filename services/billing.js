/**
 * Entitlement changes.
 *
 * One function decides what a plan change means, because there are now two
 * callers - a superadmin using the dashboard and a payment processor's webhook
 * - and two implementations would eventually disagree about something that
 * decides what a customer is allowed to do and what they are charged for.
 */

const Subscription = require('../models/subscription');
const Company = require('../models/company');
const usageService = require('./usage');
const { PLANS, resolutionPricing } = require('../config/plans');
const { logger } = require('./logging');

class UnknownPlanError extends Error {}
class UnknownCompanyError extends Error {}

/**
 * Apply a change to a company's subscription.
 *
 * @param {string} companyId
 * @param {object} changes planId, status, pricingModel, overageAllowed, currentPeriodEnd,
 *   limitOverrides, externalCustomerId, externalSubscriptionId, eventAt
 * @returns {Promise<{subscription: object, company: object, applied: boolean}>}
 *   `applied: false` means the change was older than one already recorded.
 */
async function applySubscriptionChange(companyId, changes = {}) {
  const company = await Company.findById(companyId);

  if (!company) {
    throw new UnknownCompanyError(`Company ${companyId} not found`);
  }

  if (changes.planId && !PLANS[changes.planId]) {
    throw new UnknownPlanError(
      `Unknown plan "${changes.planId}". Valid plans: ${Object.keys(PLANS).join(', ')}`
    );
  }

  const subscription = await Subscription.forCompany(companyId);

  // Processors retry, and retries arrive out of order. Without this, a
  // redelivered "payment failed" from Tuesday could land after Wednesday's
  // "payment succeeded" and suspend a tenant who is paid up.
  if (changes.eventAt && subscription.externalEventAt
      && new Date(changes.eventAt) < subscription.externalEventAt) {
    logger.info('Ignoring a subscription event older than one already applied', {
      companyId: String(companyId),
      eventAt: changes.eventAt,
      lastApplied: subscription.externalEventAt
    });
    return { subscription, company, applied: false };
  }

  if (changes.planId) {
    subscription.planId = changes.planId;
    // Moving off the trial onto a real plan should clear the trial clock,
    // otherwise isEntitled() keeps checking an expiry that no longer applies.
    if (changes.planId !== 'trial' && subscription.status === 'trialing' && !changes.status) {
      subscription.status = 'active';
      subscription.trialEndsAt = undefined;
    }
  }

  if (changes.status) {
    subscription.status = changes.status;
    if (changes.status !== 'trialing') {
      subscription.trialEndsAt = undefined;
    }
  }

  if (changes.pricingModel === 'flat' || changes.pricingModel === 'per_resolution') {
    subscription.pricingModel = changes.pricingModel;
  }
  // A plan with no per-resolution option is paid for flat, whatever the
  // tenant paid on before: per resolution means nothing on it.
  if (subscription.pricingModel === 'per_resolution' && !resolutionPricing(subscription.planId)) {
    subscription.pricingModel = 'flat';
  }

  if (changes.overageAllowed !== undefined) {
    subscription.overageAllowed = Boolean(changes.overageAllowed);
  }

  if (changes.currentPeriodEnd) {
    subscription.currentPeriodEnd = new Date(changes.currentPeriodEnd);
  }

  if (changes.externalCustomerId !== undefined) {
    subscription.externalCustomerId = changes.externalCustomerId;
  }

  if (changes.externalSubscriptionId !== undefined) {
    subscription.externalSubscriptionId = changes.externalSubscriptionId;
  }

  if (changes.limitOverrides && typeof changes.limitOverrides === 'object') {
    subscription.limitOverrides = new Map(
      Object.entries(changes.limitOverrides)
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)])
    );
  }

  if (changes.eventAt) {
    subscription.externalEventAt = new Date(changes.eventAt);
  }

  await subscription.save();

  // Subscriptions are cached for 30 seconds; a plan change has to take effect
  // now rather than whenever the cache happens to expire.
  usageService.invalidateSubscription(companyId);

  return { subscription, company, applied: true };
}

/**
 * Find the tenant a processor event is about.
 *
 * The processor knows its own customer, not ours, so the link is whatever we
 * put in the metadata when the checkout was created - falling back to the
 * customer id recorded on a previous event, which is what makes renewals and
 * cancellations work without any metadata at all.
 */
async function findCompanyForExternal({ companyId, customerId, subscriptionId }) {
  if (companyId) {
    const company = await Company.findById(companyId).select('_id').lean().catch(() => null);
    if (company) {
      return String(company._id);
    }
  }

  const match = subscriptionId
    ? await Subscription.findOne({ externalSubscriptionId: subscriptionId }).select('company').lean()
    : null;

  if (match) {
    return String(match.company);
  }

  const byCustomer = customerId
    ? await Subscription.findOne({ externalCustomerId: customerId }).select('company').lean()
    : null;

  return byCustomer ? String(byCustomer.company) : null;
}

module.exports = {
  applySubscriptionChange,
  findCompanyForExternal,
  UnknownPlanError,
  UnknownCompanyError
};
