/**
 * Telling a tenant they are near a limit before they hit it, the platform's
 * view of every tenant, and invoices.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');

const User = require('../models/user');
const Company = require('../models/company');
const Usage = require('../models/usage');
const Subscription = require('../models/subscription');
const Notification = require('../models/notification');
const AlertService = require('../services/alerting');
const usageService = require('../services/usage');
const usageAlerts = require('../services/usage-alerts');

const PASSWORD = 'TestPassword123!';

describe('Usage warnings and billing', () => {
  let app;
  let company;
  let quiet;
  let adminToken;
  let rootToken;
  let sendMail;

  const setUsage = async (fields, companyId = company._id) => {
    await Usage.updateOne(
      { company: companyId, period: Usage.currentPeriod() },
      { $set: fields },
      { upsert: true }
    );
  };

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: PASSWORD })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/billing', require('../routes/billing'));

    company = await Company.create({ name: 'Billwarn Busy' });
    quiet = await Company.create({ name: 'Billwarn Quiet' });

    await User.create([
      { username: 'billwarn-admin', email: 'admin@billwarn.example', password: PASSWORD, role: 'company_admin', company: company._id, displayName: 'Ann' },
      { username: 'billwarn-admin2', email: 'second@billwarn.example', password: PASSWORD, role: 'company_admin', company: company._id },
      { username: 'billwarn-invited', email: 'invited@billwarn.example', password: PASSWORD, role: 'company_admin', company: company._id, invitePending: true },
      { username: 'billwarn-gone', email: 'gone@billwarn.example', password: PASSWORD, role: 'company_admin', company: company._id, isActive: false },
      { username: 'billwarn-op', email: 'op@billwarn.example', password: PASSWORD, role: 'operator', company: company._id },
      { username: 'billwarn-root', email: 'root@billwarn.example', password: PASSWORD, role: 'superadmin' }
    ]);

    adminToken = await login('billwarn-admin');
    rootToken = await login('billwarn-root');
  });

  beforeEach(async () => {
    sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
    await Usage.deleteMany({ company: { $in: [company._id, quiet._id] } });
    await Subscription.deleteMany({ company: { $in: [company._id, quiet._id] } });
    await Subscription.create({ company: company._id, planId: 'trial', status: 'trialing' });
    await Company.updateOne({ _id: company._id }, { $unset: { usageAlerts: 1 } });
    await Notification.deleteMany({ type: 'usage_warning' });
    usageService.invalidateSubscription(company._id);
    usageService.invalidateSubscription(quiet._id);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterAll(async () => {
    const ids = [company._id, quiet._id];
    await Promise.all([
      User.deleteMany({ email: /@billwarn\.example$/ }),
      Usage.deleteMany({ company: { $in: ids } }),
      Subscription.deleteMany({ company: { $in: ids } }),
      Notification.deleteMany({ type: 'usage_warning' }),
      Company.deleteMany({ _id: { $in: ids } })
    ]);
  });

  describe('warnings', () => {
    test('a meter at 80% or more is a warning; a feature not on the plan is not', async () => {
      await setUsage({ conversations: 85, aiResponses: 10 });
      await Subscription.updateOne({ company: company._id }, { $set: { limitOverrides: { actions: 0 } } });
      usageService.invalidateSubscription(company._id);

      const warnings = await usageService.warnings(company._id);
      expect(warnings).toEqual([expect.objectContaining({
        meter: 'conversationsPerMonth', used: 85, limit: 100, percent: 85
      })]);
    });

    test('a full allowance of seats or live workflows is not a warning; being over one is', () => {
      const warnings = usageService.warningsFrom([
        { meter: 'workflows', label: 'Live workflows', used: 1, limit: 1, percent: 100 },
        { meter: 'operators', label: 'Operator seats', used: 3, limit: 2, percent: 150 },
        { meter: 'conversationsPerMonth', label: 'Conversations', used: 90, limit: 100, percent: 90 }
      ]);

      expect(warnings.map(warning => warning.meter)).toEqual(['operators', 'conversationsPerMonth']);
    });

    test('the billing screen and the banner both carry them', async () => {
      await setUsage({ conversations: 100 });

      const me = await request(app).get('/api/billing/me').set('x-auth-token', adminToken);
      expect(me.body.warnings[0]).toMatchObject({ meter: 'conversationsPerMonth', percent: 100 });

      const status = await request(app).get('/api/billing/me/status').set('x-auth-token', adminToken);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ planId: 'trial', status: 'trialing' });
      expect(status.body.features.apiAccess).toBe(false);
      expect(status.body.warnings[0].percent).toBe(100);
    });

    test('an ended trial is said as such', async () => {
      await Subscription.updateOne({ company: company._id }, { $set: { trialEndsAt: new Date(Date.now() - 1000) } });
      usageService.invalidateSubscription(company._id);

      const status = await request(app).get('/api/billing/me/status').set('x-auth-token', adminToken);
      expect(status.body.status).toBe('trial_expired');
      const me = await request(app).get('/api/billing/me').set('x-auth-token', adminToken);
      expect(me.body.subscription.status).toBe('trial_expired');
    });
  });

  describe('emails and notifications', () => {
    test('once at 80% and once at 100%, to each active admin, per period', async () => {
      await setUsage({ conversations: 82 });

      const first = await usageAlerts.checkCompany(company._id);
      expect(first.sent).toEqual([{ meter: 'conversationsPerMonth', level: 80 }]);

      // The two active admins; not the invited one, not the deactivated one,
      // not the operator.
      const recipients = sendMail.mock.calls.map(call => call[0].to).sort();
      expect(recipients).toEqual(['admin@billwarn.example', 'second@billwarn.example']);
      expect(sendMail.mock.calls[0][0].subject).toMatch(/82% of your conversations used/);

      const notes = await Notification.find({ type: 'usage_warning' });
      expect(notes).toHaveLength(2);
      expect(notes[0].link).toBe('?section=billing');

      // Again: nothing new.
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([]);
      expect(sendMail).toHaveBeenCalledTimes(2);

      await setUsage({ conversations: 100 });
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([{ meter: 'conversationsPerMonth', level: 100 }]);
      expect(sendMail.mock.calls[2][0].subject).toMatch(/reached your conversations limit/);
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([]);

      // A new month starts afresh.
      await Company.updateOne({ _id: company._id }, { $set: { 'usageAlerts.period': '2000-01' } });
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([{ meter: 'conversationsPerMonth', level: 100 }]);
    });

    test('jumping straight past both lines sends one warning, not two', async () => {
      await setUsage({ conversations: 120 });
      const result = await usageAlerts.checkCompany(company._id);
      expect(result.sent).toEqual([{ meter: 'conversationsPerMonth', level: 100 }]);
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([]);
    });

    test('two instances checking at once send it once', async () => {
      await setUsage({ conversations: 90 });
      const [a, b] = await Promise.all([usageAlerts.checkCompany(company._id), usageAlerts.checkCompany(company._id)]);
      expect(a.sent.length + b.sent.length).toBe(1);
    });

    test('runAll checks every active company and never throws', async () => {
      await setUsage({ conversations: 90 });
      const result = await usageAlerts.runAll();
      expect(result.companies).toBeGreaterThanOrEqual(2);
      expect(result.sent).toBeGreaterThanOrEqual(1);
    });

    test('a switched-off company is left alone', async () => {
      await setUsage({ conversations: 90 });
      await Company.updateOne({ _id: company._id }, { $set: { isActive: false } });
      try {
        expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([]);
      } finally {
        await Company.updateOne({ _id: company._id }, { $set: { isActive: true } });
      }
    });
  });

  describe('usage by tenant', () => {
    test('lists every company, the quiet ones too, with an AI cost estimate', async () => {
      await setUsage({ conversations: 3, aiResponses: 1000 });
      await Company.updateOne({ _id: company._id }, { $set: { widgetSeen: { at: new Date(), origin: 'https://busy.example' } } });

      const response = await request(app).get('/api/billing/usage').set('x-auth-token', rootToken);
      expect(response.status).toBe(200);

      const busy = response.body.tenants.find(row => row.companyName === 'Billwarn Busy');
      const silent = response.body.tenants.find(row => row.companyName === 'Billwarn Quiet');
      expect(busy).toMatchObject({ conversations: 3, aiResponses: 1000, installed: true, estimatedAiCost: 2 });
      expect(silent).toMatchObject({ conversations: 0, installed: false, planId: 'trial' });

      expect(response.body.neverInstalled.map(row => row.companyName)).toContain('Billwarn Quiet');
      expect(response.body.trialsEndingSoon.map(row => row.companyName)).not.toContain('Billwarn Busy');
      expect(response.body.totals.estimatedAiCost).toBeGreaterThanOrEqual(2);
    });

    test('shows trials ending this week, and reads an earlier month', async () => {
      await Subscription.updateOne({ company: company._id }, { $set: { trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) } });
      await Usage.create({ company: company._id, period: '2025-12', conversations: 42 });

      const now = await request(app).get('/api/billing/usage').set('x-auth-token', rootToken);
      expect(now.body.trialsEndingSoon.map(row => row.companyName)).toContain('Billwarn Busy');

      const december = await request(app).get('/api/billing/usage?period=2025-12').set('x-auth-token', rootToken);
      expect(december.body.period).toBe('2025-12');
      expect(december.body.tenants.find(row => row.companyName === 'Billwarn Busy').conversations).toBe(42);

      expect((await request(app).get('/api/billing/usage?period=last-month').set('x-auth-token', rootToken)).status).toBe(400);
    });
  });

  describe('invoices', () => {
    test('are not offered without Stripe', async () => {
      const response = await request(app).get('/api/billing/invoices').set('x-auth-token', adminToken);
      expect(response.body).toEqual({ available: false, invoices: [] });
    });

    test('come from Stripe for a tenant Stripe knows', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_invoices';
      const none = await request(app).get('/api/billing/invoices').set('x-auth-token', adminToken);
      expect(none.body).toEqual({ available: true, invoices: [] });

      await Subscription.updateOne({ company: company._id }, { $set: { externalCustomerId: 'cus_123' } });
      usageService.invalidateSubscription(company._id);
      const get = jest.spyOn(axios, 'get').mockResolvedValue({
        data: {
          data: [{
            id: 'in_1', number: 'A-001', status: 'paid', total: 2900, currency: 'usd',
            created: 1767225600, hosted_invoice_url: 'https://invoice.stripe.com/i/1', invoice_pdf: null
          }]
        }
      });

      const response = await request(app).get('/api/billing/invoices').set('x-auth-token', adminToken);
      expect(get).toHaveBeenCalledWith('https://api.stripe.com/v1/invoices', expect.objectContaining({
        params: expect.objectContaining({ customer: 'cus_123' })
      }));
      expect(response.body.invoices[0]).toMatchObject({
        id: 'in_1', number: 'A-001', status: 'paid', total: 29, currency: 'USD', hostedUrl: 'https://invoice.stripe.com/i/1'
      });
    });
  });
});
