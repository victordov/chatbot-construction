/**
 * Starting a payment from inside the product.
 *
 * The webhook side already moves a tenant between plans; this covers the part
 * a tenant touches: asking for a Checkout Session for a plan, and the portal
 * for a tenant who already pays. Stripe itself is never called - axios is
 * stubbed - so what is under test is what we send and what we refuse to send.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');

const Company = require('../models/company');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const AuditLog = require('../models/audit-log');
const usageService = require('../services/usage');
const stripe = require('../services/stripe');
const eventually = require('./eventually');

describe('Stripe checkout and portal', () => {
  let app;
  let acme;
  let adminToken;
  let operatorToken;
  let postSpy;

  const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_BASIC', 'STRIPE_PRICE_PROFESSIONAL',
    'STRIPE_PRICE_ENTERPRISE', 'PUBLIC_URL'];
  const savedEnv = {};

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const decodeForm = body => Object.fromEntries(
    String(body).split('&').map(pair => pair.split('=').map(decodeURIComponent))
  );

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    ENV_KEYS.forEach(key => {
      savedEnv[key] = process.env[key];
    });

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/billing', require('../routes/billing'));

    acme = await Company.create({ name: 'Acme Checkout' });

    await User.create({
      username: 'checkout-admin', email: 'admin@checkout.example',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    await User.create({
      username: 'checkout-operator', email: 'operator@checkout.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });

    adminToken = await login('checkout-admin');
    operatorToken = await login('checkout-operator');
  });

  beforeEach(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_PRICE_BASIC = 'price_basic';
    process.env.STRIPE_PRICE_PROFESSIONAL = 'price_professional';
    delete process.env.STRIPE_PRICE_ENTERPRISE;
    process.env.PUBLIC_URL = 'https://app.example.com/';

    await Subscription.deleteMany({ company: acme._id });
    usageService.invalidateSubscription(acme._id);

    postSpy = jest.spyOn(axios, 'post').mockImplementation(async url => {
      if (url.endsWith('/checkout/sessions')) {
        return { data: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } };
      }
      if (url.endsWith('/billing_portal/sessions')) {
        return { data: { id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' } };
      }
      throw new Error(`unexpected ${url}`);
    });
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

  afterAll(async () => {
    ENV_KEYS.forEach(key => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    await Subscription.deleteMany({ company: acme._id });
    await AuditLog.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@checkout\.example$/ });
    await Company.deleteMany({ name: 'Acme Checkout' });
    await mongoose.connection.close();
  });

  describe('POST /api/billing/checkout', () => {
    it('creates a subscription Checkout Session that names the tenant', async () => {
      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'professional' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

      expect(postSpy).toHaveBeenCalledTimes(1);
      const [url, body, options] = postSpy.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(options.headers.Authorization).toBe('Bearer sk_test_123');
      expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const form = decodeForm(body);
      expect(form).toMatchObject({
        mode: 'subscription',
        'line_items[0][price]': 'price_professional',
        'line_items[0][quantity]': '1',
        client_reference_id: String(acme._id),
        'metadata[companyId]': String(acme._id),
        'metadata[planId]': 'professional',
        'subscription_data[metadata][companyId]': String(acme._id),
        success_url: 'https://app.example.com/admin/#billing?checkout=success',
        cancel_url: 'https://app.example.com/admin/#billing?checkout=cancelled',
        customer_email: 'admin@checkout.example'
      });
      expect(form.customer).toBeUndefined();
    });

    it('reuses the Stripe customer the tenant already has', async () => {
      const subscription = await Subscription.forCompany(acme._id);
      subscription.externalCustomerId = 'cus_existing';
      subscription.status = 'cancelled';
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'basic' });

      expect(response.status).toBe(200);
      const form = decodeForm(postSpy.mock.calls[0][1]);
      expect(form.customer).toBe('cus_existing');
      expect(form.customer_email).toBeUndefined();
      expect(form['line_items[0][price]']).toBe('price_basic');
    });

    it('records who started a checkout', async () => {
      await AuditLog.deleteMany({ company: acme._id });
      await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'basic' });

      // audit.record is fire-and-forget; give it a moment to land.
      const entry = await eventually(() => AuditLog.findOne({ company: acme._id, action: 'billing.checkout_started' }));
      expect(entry).not.toBeNull();
      expect(entry.details.planId).toBe('basic');
      expect(entry.actor.username).toBe('checkout-admin');
    });

    it('answers 503 when the secret key is missing', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'basic' });

      expect(response.status).toBe(503);
      expect(response.body.configured).toBe(false);
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('answers 503 for a plan with no price configured', async () => {
      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'enterprise' });

      expect(response.status).toBe(503);
      expect(response.body.configured).toBe(false);
    });

    it('refuses plans that cannot be bought', async () => {
      for (const plan of ['trial', 'platinum', undefined]) {
        const response = await request(app)
          .post('/api/billing/checkout')
          .set('x-auth-token', adminToken)
          .send({ plan });
        expect(response.status).toBe(400);
      }
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('refuses a second subscription for a tenant who already pays', async () => {
      const subscription = await Subscription.forCompany(acme._id);
      Object.assign(subscription, {
        externalCustomerId: 'cus_paying', externalSubscriptionId: 'sub_paying',
        status: 'active', planId: 'basic'
      });
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'professional' });

      expect(response.status).toBe(409);
      expect(response.body.portalAvailable).toBe(true);
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('is not open to operators', async () => {
      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', operatorToken)
        .send({ plan: 'basic' });

      expect(response.status).toBe(403);
    });

    it('turns a Stripe error into a 502 without leaking it', async () => {
      postSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), {
        response: { status: 400, data: { error: { message: 'No such price: price_basic' } } }
      }));

      const response = await request(app)
        .post('/api/billing/checkout')
        .set('x-auth-token', adminToken)
        .send({ plan: 'basic' });

      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain('No such price');
    });
  });

  describe('POST /api/billing/portal', () => {
    it('opens the portal for a tenant Stripe knows', async () => {
      const subscription = await Subscription.forCompany(acme._id);
      subscription.externalCustomerId = 'cus_portal';
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .post('/api/billing/portal')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ url: 'https://billing.stripe.com/p/session/bps_1' });

      const [url, body] = postSpy.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
      expect(decodeForm(body)).toEqual({
        customer: 'cus_portal',
        return_url: 'https://app.example.com/admin/#billing'
      });
    });

    it('answers 409 for a tenant with no Stripe customer', async () => {
      const response = await request(app)
        .post('/api/billing/portal')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(409);
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/billing/me', () => {
    it('says which plans can be bought and whether the portal is available', async () => {
      const response = await request(app)
        .get('/api/billing/me')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.checkout).toEqual({ available: true, plans: ['basic', 'professional'] });
      expect(response.body.portalAvailable).toBe(false);
    });

    it('offers nothing without a secret key', async () => {
      delete process.env.STRIPE_SECRET_KEY;

      const response = await request(app)
        .get('/api/billing/me')
        .set('x-auth-token', adminToken);

      expect(response.body.checkout).toEqual({ available: false, plans: [] });
      expect(response.body.portalAvailable).toBe(false);
    });
  });

  describe('formEncode', () => {
    it('flattens nested objects and arrays the way Stripe reads them', () => {
      expect(stripe.formEncode({ a: 'x y', b: [{ c: 1 }], d: { e: 'f' }, g: undefined }).join('&'))
        .toBe('a=x%20y&b%5B0%5D%5Bc%5D=1&d%5Be%5D=f');
    });
  });
});
