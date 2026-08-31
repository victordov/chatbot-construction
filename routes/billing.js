/**
 * Plans, usage and subscription management.
 *
 * What this owns is entitlement: which plan a tenant is on and what that
 * permits. Card details never reach this server — the customer enters them on
 * Stripe's own page — so the PCI surface stays where it belongs.
 *
 * Two things change a subscription: a superadmin using the dashboard, and
 * Stripe telling us a payment succeeded, failed or was cancelled. Both go
 * through `services/billing.js#applySubscriptionChange`, because two
 * implementations of "what a plan change means" would eventually disagree
 * about what a customer is allowed to do and what they are charged.
 */

const express = require('express');
const router = express.Router();

const Usage = require('../models/usage');
const usageService = require('../services/usage');
const billingService = require('../services/billing');
const stripe = require('../services/stripe');
const audit = require('../services/audit');
const { listPlans } = require('../config/plans');
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

    const { subscription, company } = await billingService.applySubscriptionChange(companyId, {
      planId, status, overageAllowed, currentPeriodEnd, limitOverrides,
      externalCustomerId, externalSubscriptionId
    });

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
    if (error instanceof billingService.UnknownCompanyError) {
      return res.status(404).json({ error: 'Company not found' });
    }
    if (error instanceof billingService.UnknownPlanError) {
      return res.status(400).json({ error: error.message });
    }

    logger.error('Failed to update subscription', { error: error.message });
    res.status(500).json({ error: 'Failed to update the subscription' });
  }
});

/**
 * Stripe telling us what happened to somebody's money.
 *
 * Public by necessity, so the signature is the authentication: the raw body is
 * verified against `STRIPE_WEBHOOK_SECRET` before anything is read out of it.
 * A body that has been through `JSON.parse` and back cannot be verified —
 * re-serialising produces different bytes — so `server.js` keeps the original
 * buffer for this path alone.
 *
 * Every reply is a 200 unless the signature itself is wrong. An event we have
 * no opinion about, or one naming a customer we cannot place, is acknowledged
 * rather than refused: Stripe disables an endpoint that keeps failing, and
 * losing the events that *do* matter is a far worse outcome than ignoring one
 * that does not.
 */
router.post('/webhook/stripe', async (req, res) => {
  let event;

  try {
    event = stripe.verifyEvent(
      req.rawBody || req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    logger.warn('Rejected a Stripe webhook', { error: error.message });
    return res.status(400).json({ error: 'Signature verification failed' });
  }

  try {
    const translated = stripe.translate(event);

    if (!translated) {
      return res.json({ received: true, handled: false, reason: 'event not relevant' });
    }

    const companyId = await billingService.findCompanyForExternal(translated.lookup);

    if (!companyId) {
      // Somebody paid and we cannot tell who they are. Acknowledged so Stripe
      // stops retrying, and logged loudly because it needs a person.
      logger.error('Stripe event could not be matched to a tenant', {
        type: event.type,
        customer: translated.lookup.customerId,
        subscription: translated.lookup.subscriptionId
      });
      return res.json({ received: true, handled: false, reason: 'no matching tenant' });
    }

    const { subscription, applied } = await billingService.applySubscriptionChange(
      companyId,
      translated.changes
    );

    logger.info('Applied a Stripe event', {
      type: event.type,
      companyId,
      planId: subscription.planId,
      status: subscription.status,
      applied
    });

    // Entitlement changed because of something outside this system, so the
    // actor is Stripe rather than a person — which is precisely what somebody
    // reading the log later needs to see.
    audit.record({
      action: 'plan.changed',
      actor: { username: 'stripe', displayName: 'Stripe webhook', role: 'system' },
      company: companyId,
      target: { type: 'company', id: companyId },
      details: { event: event.type, planId: subscription.planId, status: subscription.status, applied }
    });

    res.json({ received: true, handled: true, applied });
  } catch (error) {
    // A verified event we failed to process is worth retrying, so this one is
    // allowed to be a 500.
    logger.error('Failed to process a Stripe event', { type: event.type, error: error.message });
    res.status(500).json({ error: 'Failed to process the event' });
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
