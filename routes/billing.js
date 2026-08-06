/**
 * Plans, usage and subscription management.
 *
 * Payment collection is deliberately not implemented here. Taking money needs
 * a processor account, webhook verification and PCI scope decisions that are
 * the operator's to make. What this owns is entitlement: which plan a tenant
 * is on and what that permits. `PATCH /subscription` is the single seam a
 * processor's webhook handler calls once a payment succeeds.
 */

const express = require('express');
const router = express.Router();

const Company = require('../models/company');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const usageService = require('../services/usage');
const audit = require('../services/audit');
const { listPlans, PLANS } = require('../config/plans');
const { auth, admin, superadmin } = require('../middleware/auth');
const { logger } = require('../services/logging');

/**
 * The plan catalogue. Public: a pricing page needs it before anyone signs in.
 */
router.get('/plans', (req, res) => {
  res.json({
    plans: listPlans().map(plan => ({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      interval: plan.interval,
      description: plan.description,
      limits: plan.limits,
      features: plan.features
    }))
  });
});

/**
 * The caller's own plan and consumption.
 */
router.get('/me', auth, admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    res.json(await usageService.summary(req.user.company.id));
  } catch (error) {
    logger.error('Failed to build usage summary', { error: error.message });
    res.status(500).json({ error: 'Failed to load plan and usage' });
  }
});

/**
 * Usage history, for a tenant to see their own trend.
 */
router.get('/me/history', auth, admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 12));

    const history = await Usage.find({ company: req.user.company.id })
      .sort({ period: -1 })
      .limit(months)
      .lean();

    res.json({
      history: history.reverse().map(row => ({
        period: row.period,
        conversations: row.conversations,
        messages: row.messages,
        aiResponses: row.aiResponses,
        filesUploaded: row.filesUploaded,
        limitHits: row.limitHits
      }))
    });
  } catch (error) {
    logger.error('Failed to load usage history', { error: error.message });
    res.status(500).json({ error: 'Failed to load usage history' });
  }
});

/**
 * Change a company's plan.
 *
 * Superadmin only: a tenant self-serving an upgrade must go through payment
 * first, and this route is what the processor's webhook calls once it has.
 * Leaving it open to company admins would let anyone grant themselves the
 * enterprise plan.
 */
router.patch('/companies/:companyId/subscription', auth, superadmin, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { planId, status, overageAllowed, currentPeriodEnd, limitOverrides,
      externalCustomerId, externalSubscriptionId } = req.body;

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (planId && !PLANS[planId]) {
      return res.status(400).json({
        error: `Unknown plan "${planId}". Valid plans: ${Object.keys(PLANS).join(', ')}`
      });
    }

    const subscription = await Subscription.forCompany(companyId);

    if (planId) {
      subscription.planId = planId;
      // Moving off the trial onto a real plan should clear the trial clock,
      // otherwise isEntitled() keeps checking an expiry that no longer applies.
      if (planId !== 'trial' && subscription.status === 'trialing') {
        subscription.status = 'active';
        subscription.trialEndsAt = undefined;
      }
    }

    if (status) {
      subscription.status = status;
    }
    if (overageAllowed !== undefined) {
      subscription.overageAllowed = Boolean(overageAllowed);
    }
    if (currentPeriodEnd) {
      subscription.currentPeriodEnd = new Date(currentPeriodEnd);
    }
    if (externalCustomerId !== undefined) {
      subscription.externalCustomerId = externalCustomerId;
    }
    if (externalSubscriptionId !== undefined) {
      subscription.externalSubscriptionId = externalSubscriptionId;
    }

    if (limitOverrides && typeof limitOverrides === 'object') {
      subscription.limitOverrides = new Map(
        Object.entries(limitOverrides)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => [key, Number(value)])
      );
    }

    await subscription.save();
    // The service caches subscriptions for 30s; a plan change must take effect
    // immediately rather than after the cache expires.
    usageService.invalidateSubscription(companyId);

    logger.info('Subscription updated', {
      companyId,
      planId: subscription.planId,
      status: subscription.status,
      by: req.user.username
    });

    // A plan change alters what a tenant is charged and what they can reach,
    // and only a superadmin can make one — which is exactly why it is recorded
    // against the tenant rather than only in the platform's own logs.
    audit.record({
      req,
      action: 'plan.changed',
      company: companyId,
      target: { type: 'company', id: String(companyId), label: company.name },
      details: {
        planId: subscription.planId,
        status: subscription.status,
        overageAllowed: subscription.overageAllowed
      }
    });

    res.json({
      success: true,
      subscription: {
        planId: subscription.planId,
        status: subscription.status,
        overageAllowed: subscription.overageAllowed,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd
      }
    });
  } catch (error) {
    logger.error('Failed to update subscription', { error: error.message });
    res.status(500).json({ error: 'Failed to update the subscription' });
  }
});

/**
 * One company's plan and usage, for the superadmin company detail view.
 */
router.get('/companies/:companyId', auth, superadmin, async (req, res) => {
  try {
    res.json(await usageService.summary(req.params.companyId));
  } catch (error) {
    logger.error('Failed to load company usage', { error: error.message });
    res.status(500).json({ error: 'Failed to load company usage' });
  }
});

/**
 * Usage across every tenant, for the superadmin overview.
 */
router.get('/usage', auth, superadmin, async (req, res) => {
  try {
    const period = req.query.period || Usage.currentPeriod();
    const rows = await usageService.allTenantUsage(period);

    const totals = rows.reduce((acc, row) => ({
      conversations: acc.conversations + (row.conversations || 0),
      messages: acc.messages + (row.messages || 0),
      aiResponses: acc.aiResponses + (row.aiResponses || 0),
      limitHits: acc.limitHits + (row.limitHits || 0)
    }), { conversations: 0, messages: 0, aiResponses: 0, limitHits: 0 });

    res.json({ period, tenants: rows, totals });
  } catch (error) {
    logger.error('Failed to load tenant usage', { error: error.message });
    res.status(500).json({ error: 'Failed to load tenant usage' });
  }
});

module.exports = router;
