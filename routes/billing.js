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
const Subscription = require('../models/subscription');
const usageService = require('../services/usage');
const billingService = require('../services/billing');
const stripe = require('../services/stripe');
const audit = require('../services/audit');
const Company = require('../models/company');
const resolutions = require('../services/resolutions');
const { listPlans, getPlan, resolutionPricing } = require('../config/plans');
const { auth, admin, superadmin, notWhileActing } = require('../middleware/auth');
const { logger } = require('../services/logging');

/**
 * A company's plan and usage, with the status a person would recognise.
 *
 * The stored status of a subscription whose trial ran out last week is still
 * `trialing`; only `isEntitled()` knows better. The dashboard should say
 * "trial expired", because "trialing" next to a widget that has stopped
 * answering is a support ticket.
 */
async function summaryFor(companyId) {
  // Sequential on purpose: a company with no subscription yet gets one created
  // on first read, and two concurrent first reads would both try to create it.
  const subscription = await usageService.getSubscription(companyId);
  const summary = await usageService.summary(companyId);

  summary.subscription.status = subscription.effectiveStatus();
  return summary;
}

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
      features: plan.features,
      // The per-resolution option and the agency's client terms, where a
      // plan has them. Prices are the deployment's (config/plans.js).
      pricing: plan.pricing || null,
      agency: plan.agency || null
    }))
  });
});

/**
 * Whether a company may be offered the agency plan: only one a superadmin
 * has made an agency. Buying the plan does not make anybody one.
 */
async function isAgency(companyId) {
  const company = await Company.findById(companyId).select('agency').lean();
  return Boolean(company && company.agency && company.agency.isAgency);
}

/**
 * The caller's own plan and consumption.
 */
router.get('/me', auth, admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const companyId = req.user.company.id;
    const summary = await summaryFor(companyId);
    const subscription = await usageService.getSubscription(companyId);

    // What the dashboard may offer: a plan is buyable only when Stripe has a
    // key and a price for it, and the portal only for a tenant Stripe knows.
    const agency = await isAgency(companyId);
    const buyable = stripe.checkoutPlans().filter(planId => planId !== 'agency' || agency);
    // So the plan list only shows the Agency plan to an agency.
    summary.isAgency = agency;
    summary.checkout = {
      available: buyable.length > 0,
      plans: buyable
    };
    // The same, for paying per resolution: needs the metered price as well.
    summary.resolutionCheckout = {
      available: stripe.resolutionCheckoutPlans().length > 0,
      plans: stripe.resolutionCheckoutPlans()
    };
    // Paying is between the client and whoever pays; an agency working in
    // the client's dashboard sees the screen but cannot change it.
    summary.actingAs = Boolean(req.user.actingAs);
    summary.portalAvailable = Boolean(process.env.STRIPE_SECRET_KEY && subscription.externalCustomerId);

    res.json(summary);
  } catch (error) {
    logger.error('Failed to build usage summary', { error: error.message });
    res.status(500).json({ error: 'Failed to load plan and usage' });
  }
});

/**
 * What the banner at the top of every screen needs: the trial's state and any
 * meter at or past 80%. Kept small because every page load asks for it.
 */
router.get('/me/status', auth, admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.json({ status: null, warnings: [] });
    }

    const companyId = req.user.company.id;
    const subscription = await usageService.getSubscription(companyId);
    const plan = getPlan(subscription.planId);

    res.json({
      planId: plan.id,
      planName: plan.name,
      // Which screens the dashboard offers: Developers needs API access.
      features: plan.features,
      status: subscription.effectiveStatus(),
      trialEndsAt: subscription.trialEndsAt,
      overageAllowed: subscription.overageAllowed,
      warnings: await usageService.warnings(companyId)
    });
  } catch (error) {
    logger.error('Failed to read the plan status', { error: error.message });
    res.status(500).json({ error: 'Failed to read the plan status' });
  }
});

/**
 * The tenant's invoices, from Stripe, when Stripe is how they pay.
 */
router.get('/invoices', auth, admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({ available: false, invoices: [] });
    }

    const subscription = await usageService.getSubscription(req.user.company.id);
    if (!subscription.externalCustomerId) {
      return res.json({ available: true, invoices: [] });
    }

    res.json({
      available: true,
      invoices: await stripe.listInvoices(subscription.externalCustomerId)
    });
  } catch (error) {
    if (error instanceof stripe.StripeRequestError) {
      return res.status(502).json({ error: 'Could not reach Stripe for your invoices. Try again shortly.' });
    }
    logger.error('Failed to list invoices', { error: error.message });
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

/** Where Stripe sends the customer back to. */
function publicBase(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/**
 * Start paying for a plan.
 *
 * Answers with Stripe's hosted Checkout URL; the browser goes there, the card
 * is taken there, and the plan changes only when Stripe's webhook says the
 * payment went through. Nothing here grants anything, which is why a company
 * admin may call it: the worst a forged request does is open a payment page.
 */
router.post('/checkout', auth, admin, notWhileActing, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const planId = req.body && req.body.plan;
    if (!stripe.PURCHASABLE_PLANS.includes(planId)) {
      return res.status(400).json({ error: `plan must be one of ${stripe.PURCHASABLE_PLANS.join(', ')}` });
    }

    const pricingModel = req.body.pricing === 'per_resolution' ? 'per_resolution' : 'flat';
    if (pricingModel === 'per_resolution' && !resolutionPricing(planId)) {
      return res.status(400).json({ error: `The ${getPlan(planId).name} plan cannot be paid per resolution` });
    }

    const configured = pricingModel === 'per_resolution'
      ? Boolean(stripe.resolutionPricesFor(planId))
      : Boolean(process.env.STRIPE_SECRET_KEY && stripe.priceFor(planId));
    if (!configured) {
      return res.status(503).json({ error: 'Online payment is not available for this plan', configured: false });
    }

    const companyId = req.user.company.id;

    if (planId === 'agency' && !(await isAgency(companyId))) {
      return res.status(403).json({ error: 'The agency plan is for agencies. Ask us to set your company up as one.' });
    }
    const subscription = await usageService.getSubscription(companyId);

    // A second Checkout for a tenant who already pays creates a second
    // subscription and two charges a month. Changing plan is the portal's job.
    if (subscription.externalSubscriptionId && ['active', 'past_due'].includes(subscription.status)) {
      return res.status(409).json({
        error: 'This company already has a paid subscription; change it from the billing portal',
        portalAvailable: Boolean(subscription.externalCustomerId)
      });
    }

    const session = await stripe.createCheckoutSession({
      companyId,
      planId,
      pricingModel,
      customerId: subscription.externalCustomerId || null,
      email: req.user.email,
      baseUrl: publicBase(req)
    });

    audit.record({
      req,
      action: 'billing.checkout_started',
      company: companyId,
      target: { type: 'company', id: String(companyId), label: req.user.company.name },
      details: { planId, pricingModel, sessionId: session.id }
    });

    res.json({ url: session.url });
  } catch (error) {
    if (error instanceof stripe.StripeNotConfiguredError) {
      return res.status(503).json({ error: 'Online payment is not available for this plan', configured: false });
    }
    if (error instanceof stripe.StripeRequestError) {
      return res.status(502).json({ error: error.message });
    }
    logger.error('Failed to start checkout', { error: error.message });
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

/**
 * Manage an existing subscription on Stripe's Billing Portal: card, invoices,
 * plan change, cancellation. Only for a tenant Stripe already knows.
 */
router.post('/portal', auth, admin, notWhileActing, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'Online payment is not configured', configured: false });
    }

    const subscription = await usageService.getSubscription(req.user.company.id);
    if (!subscription.externalCustomerId) {
      return res.status(409).json({ error: 'This company has no Stripe customer yet; start a checkout first' });
    }

    const session = await stripe.createPortalSession({
      customerId: subscription.externalCustomerId,
      baseUrl: publicBase(req)
    });

    res.json({ url: session.url });
  } catch (error) {
    if (error instanceof stripe.StripeNotConfiguredError) {
      return res.status(503).json({ error: 'Online payment is not configured', configured: false });
    }
    if (error instanceof stripe.StripeRequestError) {
      return res.status(502).json({ error: error.message });
    }
    logger.error('Failed to open the billing portal', { error: error.message });
    res.status(500).json({ error: 'Failed to open the billing portal' });
  }
});

/**
 * The tenant's monthly spending cap for resolutions.
 *
 * `{ cap: 100 }` sets it, `{ cap: null }` removes it. The cap is in the
 * plan's currency and covers resolutions only, never the base fee. Lowering
 * it below what has already been reported to Stripe this month is fine: the
 * next daily report takes the difference back off.
 */
router.put('/me/spend-cap', auth, admin, notWhileActing, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const raw = req.body ? req.body.cap : undefined;
    const cap = raw === null || raw === '' ? null : Number(raw);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 1000000)) {
      return res.status(400).json({ error: 'The cap must be an amount from 0 upwards, or empty for no cap' });
    }

    const companyId = req.user.company.id;
    const subscription = await usageService.getSubscription(companyId);
    if (!resolutionPricing(subscription.planId)) {
      return res.status(400).json({ error: `The ${getPlan(subscription.planId).name} plan is not paid per resolution, so it has no cap to set` });
    }

    const before = Number.isFinite(subscription.spendCap) ? subscription.spendCap : null;
    const rounded = cap === null ? null : Math.round(cap * 100) / 100;

    await Subscription.updateOne(
      { company: companyId },
      rounded === null
        ? { $unset: { spendCap: '' }, $set: { spendCapUpdatedAt: new Date(), updatedAt: new Date() } }
        : { $set: { spendCap: rounded, spendCapUpdatedAt: new Date(), updatedAt: new Date() } }
    );
    usageService.invalidateSubscription(companyId);
    resolutions.forget(companyId);

    // A new cap is a new line to be warned about: the 80% and 100% emails
    // for the old one should not stop the ones for this one.
    await Company.updateOne(
      { _id: companyId },
      { $pull: { 'usageAlerts.warned80': 'resolutionSpend', 'usageAlerts.warned100': 'resolutionSpend' } }
    );

    audit.record({
      req,
      action: 'billing.spend_cap_changed',
      company: companyId,
      target: { type: 'company', id: String(companyId), label: req.user.company.name },
      // "none" rather than null, which the audit log would leave out.
      details: { from: before === null ? 'none' : before, to: rounded === null ? 'none' : rounded }
    });

    const fresh = await usageService.getSubscription(companyId);
    res.json({ success: true, pricing: await resolutions.summary(companyId, fresh) });
  } catch (error) {
    logger.error('Failed to set the spending cap', { error: error.message });
    res.status(500).json({ error: 'Failed to set the spending cap' });
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
        limitHits: row.limitHits,
        resolutions: row.resolutions || 0
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
      externalCustomerId, externalSubscriptionId, pricingModel } = req.body;

    if (pricingModel !== undefined && !['flat', 'per_resolution'].includes(pricingModel)) {
      return res.status(400).json({ error: 'pricingModel must be flat or per_resolution' });
    }
    if (pricingModel === 'per_resolution') {
      const target = planId || (await usageService.getSubscription(companyId)).planId;
      if (!resolutionPricing(target)) {
        return res.status(400).json({ error: `The ${getPlan(target).name} plan cannot be paid per resolution` });
      }
    }

    const { subscription, company } = await billingService.applySubscriptionChange(companyId, {
      planId, status, overageAllowed, currentPeriodEnd, limitOverrides,
      externalCustomerId, externalSubscriptionId, pricingModel,
      // A person's decision is the newest thing that has happened to this
      // subscription. Stamping it with now means a Stripe event raised before
      // it - a redelivery, or one that was queued - cannot quietly undo a
      // manual suspension.
      eventAt: new Date()
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
        pricingModel: subscription.pricingModel,
        overageAllowed: subscription.overageAllowed
      }
    });

    res.json({
      success: true,
      subscription: {
        planId: subscription.planId,
        status: subscription.effectiveStatus(),
        pricingModel: subscription.pricingModel,
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
    // Stripe retries until it gets a 200, and a retry of something we already
    // applied must not be applied again. The id is claimed before any work is
    // done, and given back if the work fails so the retry is welcome.
    if (!(await stripe.claimEvent(event.id, event.type))) {
      logger.info('Acknowledged a Stripe event already processed', { id: event.id, type: event.type });
      return res.json({ received: true, handled: false, applied: false, reason: 'duplicate event' });
    }

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
    // allowed to be a 500 - and the id is released so the retry is not
    // mistaken for a duplicate.
    await stripe.releaseEvent(event.id);
    logger.error('Failed to process a Stripe event', { type: event.type, error: error.message });
    res.status(500).json({ error: 'Failed to process the event' });
  }
});

/**
 * One company's plan and usage, for the superadmin company detail view.
 */
router.get('/companies/:companyId', auth, superadmin, async (req, res) => {
  try {
    res.json(await summaryFor(req.params.companyId));
  } catch (error) {
    logger.error('Failed to load company usage', { error: error.message });
    res.status(500).json({ error: 'Failed to load company usage' });
  }
});

/**
 * Usage across every tenant, for the superadmin overview.
 *
 * Every company is listed, with zeros for a quiet month, and two short lists
 * beside the table: trials ending within a week, and tenants whose widget has
 * never been seen on a website - the two groups somebody should be calling.
 * `?period=YYYY-MM` reads an earlier month.
 */
router.get('/usage', auth, superadmin, async (req, res) => {
  try {
    const requested = typeof req.query.period === 'string' ? req.query.period : '';
    if (requested && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) {
      return res.status(400).json({ error: 'period must look like 2026-09' });
    }

    const period = requested || Usage.currentPeriod();
    const rows = await usageService.allTenantUsage(period);

    const totals = rows.reduce((acc, row) => ({
      conversations: acc.conversations + (row.conversations || 0),
      messages: acc.messages + (row.messages || 0),
      aiResponses: acc.aiResponses + (row.aiResponses || 0),
      limitHits: acc.limitHits + (row.limitHits || 0),
      estimatedAiCost: Math.round((acc.estimatedAiCost + (row.estimatedAiCost || 0)) * 100) / 100
    }), { conversations: 0, messages: 0, aiResponses: 0, limitHits: 0, estimatedAiCost: 0 });

    const now = Date.now();
    const weekAhead = now + 7 * 24 * 60 * 60 * 1000;

    const trialsEndingSoon = rows
      .filter(row => row.status === 'trialing' && row.trialEndsAt
        && new Date(row.trialEndsAt).getTime() >= now && new Date(row.trialEndsAt).getTime() <= weekAhead)
      .map(row => ({ companyId: row.companyId, companyName: row.companyName, trialEndsAt: row.trialEndsAt }))
      .sort((a, b) => new Date(a.trialEndsAt) - new Date(b.trialEndsAt));

    const neverInstalled = rows
      .filter(row => row.isActive && !row.installed)
      .map(row => ({ companyId: row.companyId, companyName: row.companyName, createdAt: row.createdAt }));

    res.json({
      period,
      currentPeriod: Usage.currentPeriod(),
      tenants: rows,
      totals,
      trialsEndingSoon,
      neverInstalled,
      aiCostPerReply: usageService.aiCostPerReply()
    });
  } catch (error) {
    logger.error('Failed to load tenant usage', { error: error.message });
    res.status(500).json({ error: 'Failed to load tenant usage' });
  }
});

module.exports = router;
