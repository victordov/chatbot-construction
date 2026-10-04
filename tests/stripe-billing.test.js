/**
 * Taking money.
 *
 * Plans, limits and enforcement were complete and nothing charged anybody, so
 * this covers the part that was missing: Stripe saying a payment succeeded,
 * failed or was cancelled, and that changing what a tenant is entitled to.
 *
 * Two properties matter more than the mapping itself. The signature is the
 * only authentication this endpoint has, so anything it would accept without
 * one is a way to grant yourself the enterprise plan. And a processor retries,
 * so an event that arrives twice, or late, must not undo a newer one.
 */

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const usageService = require('../services/usage');
const stripe = require('../services/stripe');

const WEBHOOK_SECRET = 'whsec_test_secret';

describe('Stripe billing', () => {
  let app;
  let acme;
  let superToken;

  const sign = (payload, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    return { body, header: `t=${timestamp},v1=${signature}` };
  };

  const send = (payload, options = {}) => {
    const { body, header } = sign(payload, options);
    return request(app)
      .post('/api/billing/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', options.header || header)
      .send(body);
  };

  const subscriptionEvent = (type, overrides = {}) => ({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        metadata: {},
        items: { data: [{ price: { id: 'price_professional' } }] },
        ...overrides
      }
    }
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_PROFESSIONAL = 'price_professional';
    process.env.STRIPE_PRICE_BASIC = 'price_basic';

    app = express();
    app.use(express.json({
      verify: (req, res, buffer) => {
        if (req.originalUrl.startsWith('/api/billing/webhook')) {
          req.rawBody = buffer;
        }
      }
    }));
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/billing', require('../routes/billing'));

    acme = await Company.create({ name: 'Acme Payments' });

    await User.create({
      username: 'billing-super', email: 'super@payments.example',
      password: 'TestPassword123!', role: 'superadmin'
    });

    superToken = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'billing-super', password: 'TestPassword123!' })).body.token;
  });

  beforeEach(async () => {
    await Subscription.deleteMany({ company: acme._id });
    await stripe.StripeEvent.deleteMany({});
    usageService.invalidateSubscription(acme._id);
    delete process.env.STRIPE_ALLOW_CLIENT_REFERENCE;
  });

  afterAll(async () => {
    await Subscription.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@payments\.example$/ });
    await Company.deleteMany({ name: /Payments$/ });
    await mongoose.connection.close();
  });

  describe('the signature', () => {
    it('accepts an event Stripe signed', async () => {
      const response = await send({
        id: 'evt_1',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            customer: 'cus_1',
            subscription: 'sub_1',
            metadata: { companyId: String(acme._id), planId: 'professional' }
          }
        }
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ received: true, handled: true });
    });

    const paymentLinkCheckout = () => ({
      id: `evt_link_${Math.random().toString(36).slice(2)}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          customer: 'cus_link',
          subscription: 'sub_link',
          client_reference_id: String(acme._id),
          metadata: { planId: 'basic' }
        }
      }
    });

    it('does not let client_reference_id name the tenant by default', async () => {
      // The field is whatever the customer put in the payment link's URL, so
      // trusting it lets anyone apply a plan to a company id they found.
      const response = await send(paymentLinkCheckout());

      expect(response.status).toBe(200);
      expect(response.body.handled).toBe(false);
      expect(response.body.reason).toBe('no matching tenant');
      expect(await Subscription.findOne({ company: acme._id })).toBeNull();
    });

    it('accepts a payment link when the deployment has opted in', async () => {
      process.env.STRIPE_ALLOW_CLIENT_REFERENCE = 'true';

      const response = await send(paymentLinkCheckout());

      expect(response.body.handled).toBe(true);
      expect((await Subscription.findOne({ company: acme._id })).planId).toBe('basic');
    });

    it('refuses an unsigned request, which is the whole authentication', async () => {
      const response = await request(app)
        .post('/api/billing/webhook/stripe')
        .send({ type: 'checkout.session.completed', data: { object: {} } });

      expect(response.status).toBe(400);
    });

    it('refuses a signature made with the wrong secret', async () => {
      const response = await send(subscriptionEvent('customer.subscription.updated'), { secret: 'whsec_not_ours' });

      expect(response.status).toBe(400);
      expect(await Subscription.findOne({ company: acme._id })).toBeNull();
    });

    it('refuses a body that was changed after it was signed', async () => {
      const payload = {
        id: 'evt_x',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: { object: { metadata: { companyId: String(acme._id), planId: 'basic' } } }
      };
      const { header } = sign(payload);

      // Same signature, richer plan.
      payload.data.object.metadata.planId = 'enterprise';

      const response = await request(app)
        .post('/api/billing/webhook/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', header)
        .send(JSON.stringify(payload));

      expect(response.status).toBe(400);
    });

    it('refuses a replayed request from outside the tolerance window', async () => {
      const response = await send(
        subscriptionEvent('customer.subscription.updated'),
        { timestamp: Math.floor(Date.now() / 1000) - 60 * 60 }
      );

      expect(response.status).toBe(400);
    });
  });

  describe('what an event means', () => {
    it('puts a tenant on the plan they paid for', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      }));

      const subscription = await Subscription.findOne({ company: acme._id });
      expect(subscription.planId).toBe('professional');
      expect(subscription.status).toBe('active');
      expect(subscription.externalSubscriptionId).toBe('sub_123');
      expect(subscription.currentPeriodEnd).toBeInstanceOf(Date);
    });

    it('finds the tenant by customer on later events, with no metadata at all', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      }));

      await send({
        id: 'evt_renewal',
        type: 'invoice.payment_succeeded',
        created: Math.floor(Date.now() / 1000) + 10,
        data: { object: { customer: 'cus_123', subscription: 'sub_123', period_end: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60 } }
      });

      const subscription = await Subscription.findOne({ company: acme._id });
      expect(subscription.status).toBe('active');
    });

    it('marks a failed payment past due rather than cutting the desk off', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      }));

      await send({
        id: 'evt_failed',
        type: 'invoice.payment_failed',
        created: Math.floor(Date.now() / 1000) + 10,
        data: { object: { customer: 'cus_123', subscription: 'sub_123' } }
      });

      const subscription = await Subscription.findOne({ company: acme._id });
      expect(subscription.status).toBe('past_due');
      // A tenant's customers should not lose support because a card expired.
      expect(subscription.isEntitled()).toBe(true);
    });

    it('cancels when the subscription is deleted', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      }));

      await send({
        ...subscriptionEvent('customer.subscription.deleted'),
        created: Math.floor(Date.now() / 1000) + 10
      });

      const subscription = await Subscription.findOne({ company: acme._id });
      expect(subscription.status).toBe('cancelled');
      expect(subscription.isEntitled()).toBe(false);
    });

    it('acknowledges an event it has no opinion about', async () => {
      const response = await send({
        id: 'evt_other',
        type: 'customer.updated',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'cus_123' } }
      });

      // A 500 here would get the endpoint disabled by Stripe, taking the
      // events that do matter with it.
      expect(response.status).toBe(200);
      expect(response.body.handled).toBe(false);
    });

    it('acknowledges a payment it cannot match to a tenant instead of retrying forever', async () => {
      const response = await send(subscriptionEvent('customer.subscription.updated', {
        id: 'sub_unknown', customer: 'cus_unknown', metadata: {}
      }));

      expect(response.status).toBe(200);
      expect(response.body.reason).toBe('no matching tenant');
    });

    it('leaves the plan alone when no price is configured for it', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) },
        items: { data: [{ price: { id: 'price_nobody_configured' } }] }
      }));

      const subscription = await Subscription.findOne({ company: acme._id });
      // Better to leave a tenant where they are than to guess at what they
      // bought and either overcharge or over-serve them.
      expect(subscription.planId).toBe('trial');
      expect(subscription.status).toBe('active');
    });

    it('leaves a trial alone when a checkout names no plan we know', async () => {
      const response = await send({
        id: 'evt_mystery',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            customer: 'cus_mystery',
            subscription: 'sub_mystery',
            metadata: { companyId: String(acme._id) }
          }
        }
      });

      expect(response.body.handled).toBe(true);

      const subscription = await Subscription.findOne({ company: acme._id });
      // Activating them would put a paying customer on trial limits with no
      // trial clock; the subscription event that follows carries the price.
      expect(subscription.planId).toBe('trial');
      expect(subscription.status).toBe('trialing');
      expect(subscription.trialEndsAt).toBeInstanceOf(Date);
      // But the customer is remembered, so that later event can find them.
      expect(subscription.externalCustomerId).toBe('cus_mystery');
    });
  });

  describe('retries and ordering', () => {
    it('is unchanged by the same event arriving twice', async () => {
      const event = subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      });

      await send(event);
      await send(event);

      expect(await Subscription.countDocuments({ company: acme._id })).toBe(1);
      expect((await Subscription.findOne({ company: acme._id })).planId).toBe('professional');
    });

    it('acknowledges a redelivered event id without applying it again', async () => {
      const event = subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      });
      await send(event);

      // A person suspends the tenant in between.
      await request(app)
        .patch(`/api/billing/companies/${acme._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ status: 'suspended' });

      const again = await send(event);

      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ received: true, applied: false, reason: 'duplicate event' });
      // The retry's "active" must not undo the suspension.
      expect((await Subscription.findOne({ company: acme._id })).status).toBe('suspended');
    });

    it('does not let a newer-looking Stripe event overwrite a manual suspension made after it', async () => {
      await send(subscriptionEvent('customer.subscription.created', {
        metadata: { companyId: String(acme._id) }
      }));

      await request(app)
        .patch(`/api/billing/companies/${acme._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ status: 'suspended' });

      // A different event, raised a moment before the superadmin acted.
      const stale = await send({
        id: 'evt_before_suspension',
        type: 'invoice.payment_succeeded',
        created: Math.floor(Date.now() / 1000) - 30,
        data: { object: { customer: 'cus_123', subscription: 'sub_123' } }
      });

      expect(stale.body.applied).toBe(false);
      expect((await Subscription.findOne({ company: acme._id })).status).toBe('suspended');
    });

    it('does not let a redelivered older event undo a newer one', async () => {
      const now = Math.floor(Date.now() / 1000);

      await send({
        id: 'evt_old',
        type: 'invoice.payment_failed',
        created: now - 600,
        data: { object: { customer: 'cus_123', subscription: 'sub_123', metadata: { companyId: String(acme._id) } } }
      });

      await send({
        id: 'evt_new',
        type: 'invoice.payment_succeeded',
        created: now,
        data: { object: { customer: 'cus_123', subscription: 'sub_123', metadata: { companyId: String(acme._id) } } }
      });

      // Stripe redelivers the failure it never got an answer for.
      const late = await send({
        id: 'evt_old',
        type: 'invoice.payment_failed',
        created: now - 600,
        data: { object: { customer: 'cus_123', subscription: 'sub_123', metadata: { companyId: String(acme._id) } } }
      });

      expect(late.body.applied).toBe(false);
      expect((await Subscription.findOne({ company: acme._id })).status).toBe('active');
    });
  });

  describe('the superadmin route it shares', () => {
    it('changes a plan through the same seam', async () => {
      const response = await request(app)
        .patch(`/api/billing/companies/${acme._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'professional', status: 'active', overageAllowed: true });

      expect(response.status).toBe(200);
      expect(response.body.subscription).toMatchObject({ planId: 'professional', overageAllowed: true });
    });

    it('rejects a plan that does not exist', async () => {
      const response = await request(app)
        .patch(`/api/billing/companies/${acme._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'platinum' });

      expect(response.status).toBe(400);
    });

    it('404s for a company that does not exist', async () => {
      const response = await request(app)
        .patch(`/api/billing/companies/${new mongoose.Types.ObjectId()}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'basic' });

      expect(response.status).toBe(404);
    });

    it('reports an expired trial as expired rather than as trialing', async () => {
      const subscription = await Subscription.forCompany(acme._id);
      // The clock starts at creation now, so a fresh tenant has an end date.
      expect(subscription.trialEndsAt).toBeInstanceOf(Date);
      expect(subscription.trialEndsAt.getTime()).toBeGreaterThan(Date.now());

      subscription.trialEndsAt = new Date(Date.now() - 86400000);
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .get(`/api/billing/companies/${acme._id}`)
        .set('x-auth-token', superToken);

      expect(response.status).toBe(200);
      expect(response.body.subscription.status).toBe('trial_expired');
      expect(response.body.subscription.entitled).toBe(false);
    });

    it('takes effect immediately rather than when a cache expires', async () => {
      await request(app)
        .patch(`/api/billing/companies/${acme._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'professional', status: 'active' });

      // The quota middleware reads through this cache on every metered action.
      const subscription = await usageService.getSubscription(acme._id);
      expect(subscription.planId).toBe('professional');
    });
  });
});
