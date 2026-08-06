/**
 * Plans, usage metering and quota enforcement.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const usageService = require('../services/usage');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/billing', require('../routes/billing'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
};

describe('Plans and usage', () => {
  let app;
  let company;
  let adminToken;
  let superToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    company = await Company.create({ name: 'Billing Co' });

    await User.create({
      username: 'billing-admin', email: 'admin@billing.example',
      password: 'TestPassword123!', role: 'company_admin', company: company._id
    });
    await User.create({
      username: 'billing-super', email: 'super@billing.example',
      password: 'TestPassword123!', role: 'superadmin'
    });

    adminToken = await login('billing-admin');
    superToken = await login('billing-super');
  });

  afterAll(async () => {
    await Usage.deleteMany({});
    await Subscription.deleteMany({});
    await User.deleteMany({ email: /@billing\.example$/ });
    await Company.deleteMany({ name: /^Billing / });
  });

  beforeEach(async () => {
    await Usage.deleteMany({});
    await Subscription.deleteMany({});
    usageService.invalidateSubscription(company._id);
  });

  describe('metering', () => {
    test('increments are additive across calls', async () => {
      await usageService.record(company._id, { conversations: 2, messages: 5 });
      await usageService.record(company._id, { conversations: 3 });

      const usage = await Usage.findOne({ company: company._id });
      expect(usage.conversations).toBe(5);
      expect(usage.messages).toBe(5);
    });

    test('concurrent increments do not lose counts', async () => {
      // A read-modify-write would drop most of these.
      await Promise.all(
        Array.from({ length: 25 }, () => usageService.record(company._id, { conversations: 1 }))
      );

      const usage = await Usage.findOne({ company: company._id });
      expect(usage.conversations).toBe(25);
    });

    test('recording never throws, even without a company', async () => {
      await expect(usageService.record(null, { conversations: 1 })).resolves.toBeNull();
    });

    test('usage is kept per calendar month', async () => {
      await usageService.record(company._id, { conversations: 1 });
      const usage = await Usage.findOne({ company: company._id });
      expect(usage.period).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe('limits', () => {
    test('a new company starts on the trial plan', async () => {
      const summary = await usageService.summary(company._id);
      expect(summary.plan.id).toBe('trial');
      expect(summary.subscription.entitled).toBe(true);
    });

    test('allows an action below the limit', async () => {
      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(true);
    });

    test('refuses an action at the limit, and explains why', async () => {
      await usageService.record(company._id, { conversations: 100 });

      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/limit reached/i);
      expect(result.used).toBe(100);
    });

    test('overage lets a tenant past their limit when a superadmin allows it', async () => {
      await usageService.record(company._id, { conversations: 100 });

      const subscription = await Subscription.forCompany(company._id);
      subscription.overageAllowed = true;
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(true);
      expect(result.overage).toBe(true);
    });

    test('an expired trial blocks everything', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.trialEndsAt = new Date(Date.now() - 86400000);
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/trial has ended/i);
    });

    test('an unlimited plan reports no limit', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'enterprise';
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(true);
      expect(result.limit).toBeNull();
    });

    test('a per-company override beats the plan limit', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'basic';
      subscription.status = 'active';
      subscription.limitOverrides = new Map([['conversationsPerMonth', 3]]);
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      await usageService.record(company._id, { conversations: 3 });

      const result = await usageService.check(company._id, 'conversationsPerMonth');
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3);
    });
  });

  describe('features', () => {
    test('the basic plan excludes AI suggestions', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'basic';
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      expect(await usageService.hasFeature(company._id, 'aiSuggestions')).toBe(false);
    });

    test('the professional plan includes AI suggestions', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'professional';
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      expect(await usageService.hasFeature(company._id, 'aiSuggestions')).toBe(true);
    });
  });

  describe('enforcement on routes', () => {
    test('creating an operator past the seat limit returns 402, not 500', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'basic'; // 1 seat
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      await User.create({
        username: 'seat-1', email: 'seat1@billing.example',
        password: 'TestPassword123!', role: 'operator', company: company._id
      });

      const response = await request(app)
        .post('/api/admin/operators')
        .set('x-auth-token', adminToken)
        .send({
          username: 'seat-2', email: 'seat2@billing.example',
          password: 'TestPassword123!', confirmPassword: 'TestPassword123!',
          companyId: company._id.toString()
        });

      expect(response.status).toBe(402);
      expect(response.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(await User.findOne({ username: 'seat-2' })).toBeNull();

      await User.deleteMany({ email: /^seat\d@billing\.example$/ });
    });

    test('a blocked action is counted, so the tenant can see it happened', async () => {
      const subscription = await Subscription.forCompany(company._id);
      subscription.planId = 'basic';
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(company._id);

      await User.create({
        username: 'seat-a', email: 'seata@billing.example',
        password: 'TestPassword123!', role: 'operator', company: company._id
      });

      await request(app)
        .post('/api/admin/operators')
        .set('x-auth-token', adminToken)
        .send({
          username: 'seat-b', email: 'seatb@billing.example',
          password: 'TestPassword123!', confirmPassword: 'TestPassword123!',
          companyId: company._id.toString()
        });

      const usage = await Usage.findOne({ company: company._id });
      expect(usage.limitHits).toBeGreaterThan(0);

      await User.deleteMany({ email: /^seat[ab]@billing\.example$/ });
    });
  });

  describe('API', () => {
    test('the plan catalogue is available', async () => {
      const response = await request(app).get('/api/billing/plans');

      expect(response.status).toBe(200);
      expect(response.body.plans.map(p => p.id)).toEqual(
        expect.arrayContaining(['trial', 'basic', 'professional', 'enterprise'])
      );
    });

    test('an admin sees their own plan and usage', async () => {
      await usageService.record(company._id, { conversations: 7 });

      const response = await request(app)
        .get('/api/billing/me')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.detail.conversations).toBe(7);
      expect(Array.isArray(response.body.meters)).toBe(true);
    });

    test('a company admin cannot change their own plan', async () => {
      // Otherwise anyone could grant themselves the enterprise plan.
      const response = await request(app)
        .patch(`/api/billing/companies/${company._id}/subscription`)
        .set('x-auth-token', adminToken)
        .send({ planId: 'enterprise' });

      expect(response.status).toBe(403);
    });

    test('a superadmin can change a plan, and it takes effect immediately', async () => {
      const response = await request(app)
        .patch(`/api/billing/companies/${company._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'professional', status: 'active' });

      expect(response.status).toBe(200);
      expect(response.body.subscription.planId).toBe('professional');

      // The 30s subscription cache must not delay this.
      expect(await usageService.hasFeature(company._id, 'aiSuggestions')).toBe(true);
    });

    test('an unknown plan is refused', async () => {
      const response = await request(app)
        .patch(`/api/billing/companies/${company._id}/subscription`)
        .set('x-auth-token', superToken)
        .send({ planId: 'platinum-unlimited' });

      expect(response.status).toBe(400);
    });

    test('a superadmin sees usage across tenants', async () => {
      await usageService.record(company._id, { conversations: 4 });

      const response = await request(app)
        .get('/api/billing/usage')
        .set('x-auth-token', superToken);

      expect(response.status).toBe(200);
      expect(response.body.totals.conversations).toBeGreaterThanOrEqual(4);
    });
  });
});
