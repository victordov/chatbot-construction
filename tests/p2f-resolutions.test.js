/**
 * Per-resolution pricing: the count, the cap, the warnings and Stripe.
 *
 * What a tenant is billed for has to be exactly what their own value report
 * calls "resolved by the bot", never more than the cap they set, and never
 * reported to Stripe twice. Stripe itself is never called: axios is stubbed,
 * so what is under test is what we would send.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const User = require('../models/user');
const AuditLog = require('../models/audit-log');
const AlertService = require('../services/alerting');
const analytics = require('../services/analytics');
const resolutions = require('../services/resolutions');
const stripe = require('../services/stripe');
const usageService = require('../services/usage');
const usageAlerts = require('../services/usage-alerts');
const { resolutionPricing } = require('../config/plans');
const eventually = require('./eventually');

const PASSWORD = 'TestPassword123!';
const HOUR = 60 * 60 * 1000;
let sequence = 0;

/**
 * One conversation of a given kind. `resolved` is what the value report
 * counts; the others are each one way a conversation can look handled
 * without being a resolution.
 */
function conversation(companyId, kind, { startedAt = new Date(), lastActivity, status = 'ended' } = {}) {
  sequence += 1;
  const visitor = [
    { content: 'Do you open on Saturdays?', sender: 'user' },
    { content: 'And Sundays?', sender: 'user' }
  ];
  const answer = { content: 'Saturdays 9 to 1.', sender: 'bot', path: 'assistant' };
  const base = {
    sessionId: `p2f-res-${Date.now()}-${sequence}`,
    company: companyId,
    startedAt,
    lastActivity: lastActivity || startedAt,
    status
  };

  switch (kind) {
  case 'resolved':
    return { ...base, messages: [...visitor, answer] };
  case 'handover':
    return { ...base, messages: [...visitor, answer], handoff: { requestedAt: startedAt } };
  case 'joined':
    return { ...base, operatorEverJoined: true, messages: [...visitor, answer, { content: 'Hi, Sam here', sender: 'operator' }] };
  case 'unanswered':
    return { ...base, messages: [...visitor, { ...answer, unanswered: true }] };
  case 'rated-low':
    return { ...base, messages: [...visitor, answer], rating: { score: 1 } };
  case 'silent':
    return { ...base, messages: [answer] };
  default:
    throw new Error(kind);
  }
}

describe('P2F: resolutions, the cap and metered billing', () => {
  let app;
  let company;
  let adminToken;
  let sendMail;
  let postSpy;

  const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_RESOLUTION', 'STRIPE_PRICE_PROFESSIONAL',
    'STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION', 'STRIPE_RESOLUTION_EVENT', 'PUBLIC_URL'];
  const savedEnv = {};

  const decodeForm = body => Object.fromEntries(
    String(body).split('&').map(pair => pair.split('=').map(decodeURIComponent))
  );

  const setPlan = async ({ spendCap, ...fields }) => {
    await Subscription.updateOne({ company: company._id }, { $set: fields, $unset: { spendCap: '' } });
    if (spendCap !== undefined) {
      await Subscription.updateOne({ company: company._id }, { $set: { spendCap } });
    }
    usageService.invalidateSubscription(company._id);
    resolutions.forget(company._id);
  };

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

    company = await Company.create({ name: 'P2F Resolutions Clinic' });
    await User.create({
      username: 'p2f-res-admin', email: 'admin@p2f-res.example', password: PASSWORD,
      role: 'company_admin', company: company._id, displayName: 'Rita'
    });
    adminToken = (await request(app).post('/api/auth/login')
      .send({ username: 'p2f-res-admin', password: PASSWORD })).body.token;
  });

  beforeEach(async () => {
    ENV_KEYS.forEach(key => delete process.env[key]);
    sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
    postSpy = jest.spyOn(axios, 'post').mockResolvedValue({ data: { object: 'billing.meter_event' } });

    await Promise.all([
      Conversation.deleteMany({ company: company._id }),
      Usage.deleteMany({ company: company._id }),
      Subscription.deleteMany({ company: company._id }),
      Company.updateOne({ _id: company._id }, { $unset: { usageAlerts: 1 } })
    ]);
    await Subscription.create({ company: company._id, planId: 'professional', status: 'active' });
    usageService.invalidateSubscription(company._id);
    resolutions.forget(company._id);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    ENV_KEYS.forEach(key => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    await Promise.all([
      Conversation.deleteMany({ company: company._id }),
      Usage.deleteMany({ company: company._id }),
      Subscription.deleteMany({ company: company._id }),
      AuditLog.deleteMany({ company: company._id }),
      User.deleteMany({ email: /@p2f-res\.example$/ }),
      Company.deleteOne({ _id: company._id })
    ]);
  });

  describe('counting', () => {
    test('counts exactly what the value report calls resolved by the bot', async () => {
      const kinds = ['resolved', 'resolved', 'resolved', 'handover', 'joined', 'unanswered', 'rated-low', 'silent'];
      await Conversation.insertMany(kinds.map(kind => conversation(company._id, kind)));

      const report = await analytics.value({ company: company._id }, 30);
      const counted = await resolutions.countForPeriod(company._id, Usage.currentPeriod());

      expect(report.botResolved).toBe(3);
      expect(counted).toBe(report.botResolved);
      expect(analytics.value.toString()).toContain('resolvedPipeline');
    });

    test('a conversation still open is not billed until it has been quiet for a day', async () => {
      const now = new Date();
      await Conversation.insertMany([
        conversation(company._id, 'resolved', { status: 'active', startedAt: now, lastActivity: now }),
        conversation(company._id, 'resolved', { status: 'ended' })
      ]);

      // The report counts both; the bill only the one that is over.
      expect((await analytics.value({ company: company._id }, 30)).botResolved).toBe(2);
      expect(await resolutions.countForPeriod(company._id, Usage.currentPeriod(now), { now })).toBe(1);

      // A day later, with nothing more said, it has settled.
      const tomorrow = new Date(now.getTime() + 25 * HOUR);
      expect(await resolutions.countForPeriod(company._id, Usage.currentPeriod(now), { now: tomorrow })).toBe(2);
    });

    test('the nightly job writes the month into Usage.resolutions', async () => {
      await Conversation.insertMany([
        conversation(company._id, 'resolved'),
        conversation(company._id, 'resolved'),
        conversation(company._id, 'handover')
      ]);

      const result = await resolutions.recordResolutions();
      expect(result.companies).toBeGreaterThan(0);

      const usage = await Usage.findOne({ company: company._id, period: Usage.currentPeriod() });
      expect(usage.resolutions).toBe(2);
      expect(usage.resolutionsCountedAt).toBeInstanceOf(Date);
    });
  });

  describe('the cap', () => {
    const pricing = { perResolution: 0.49, includedResolutions: 0 };

    test('billing never goes past it, in whole resolutions', () => {
      const bill = resolutions.bill({ resolutions: 300, pricing, cap: 100 });
      expect(bill).toMatchObject({ billable: 204, amount: 99.96, unbilled: 96, capReached: true });

      const under = resolutions.bill({ resolutions: 132, pricing, cap: 100 });
      expect(under).toMatchObject({ billable: 132, amount: 64.68, unbilled: 0, capReached: false });

      const free = resolutions.bill({ resolutions: 60, pricing: { perResolution: 0.49, includedResolutions: 50 }, cap: null });
      expect(free).toMatchObject({ chargeable: 10, billable: 10, amount: 4.9 });
    });

    test('past the cap the bot keeps answering: no meter refuses anything', async () => {
      await setPlan({ pricingModel: 'per_resolution', spendCap: 1 });
      await Conversation.insertMany(Array.from({ length: 5 }, () => conversation(company._id, 'resolved')));

      const summary = (await request(app).get('/api/billing/me').set('x-auth-token', adminToken)).body;
      expect(summary.pricing.model).toBe('per_resolution');
      expect(summary.pricing.bill).toMatchObject({ resolutions: 5, billable: 2, amount: 0.98, capReached: true });
      expect(summary.pricing.bill.amount).toBeLessThanOrEqual(1);

      for (const meter of ['conversationsPerMonth', 'aiResponsesPerMonth']) {
        expect((await usageService.check(company._id, meter)).allowed).toBe(true);
      }
    });

    test('the tenant sets it on Plan & billing, and it is recorded', async () => {
      await setPlan({ pricingModel: 'per_resolution' });

      const set = await request(app).put('/api/billing/me/spend-cap')
        .set('x-auth-token', adminToken).send({ cap: 100 });
      expect(set.status).toBe(200);
      expect(set.body.pricing.cap).toBe(100);
      expect((await Subscription.findOne({ company: company._id })).spendCap).toBe(100);

      const audit = await eventually(() => AuditLog.findOne({ company: company._id, action: 'billing.spend_cap_changed' }));
      expect(audit.details).toMatchObject({ from: 'none', to: 100 });

      const bad = await request(app).put('/api/billing/me/spend-cap')
        .set('x-auth-token', adminToken).send({ cap: -5 });
      expect(bad.status).toBe(400);

      const cleared = await request(app).put('/api/billing/me/spend-cap')
        .set('x-auth-token', adminToken).send({ cap: null });
      expect(cleared.body.pricing.cap).toBeNull();
    });

    test('a plan with no per-resolution option has no cap to set', async () => {
      await setPlan({ planId: 'basic' });
      const response = await request(app).put('/api/billing/me/spend-cap')
        .set('x-auth-token', adminToken).send({ cap: 50 });
      expect(response.status).toBe(400);
    });

    test('a flat tenant keeps flat pricing and sees what per resolution would cost', async () => {
      await Conversation.insertMany([conversation(company._id, 'resolved')]);
      const summary = (await request(app).get('/api/billing/me').set('x-auth-token', adminToken)).body;
      expect(summary.subscription.pricingModel).toBe('flat');
      expect(summary.pricing).toMatchObject({ model: 'flat', available: true, resolutions: 1 });
      expect(summary.pricing.definition).toBe(analytics.RESOLVED_DEFINITION);
      // No cap meter for a flat tenant: it would only read "unlimited".
      expect(summary.meters.map(meter => meter.meter)).not.toContain('resolutionSpend');
    });
  });

  describe('warnings at the cap', () => {
    test('once at 80% and once at 100% of the cap, through the usual alerts', async () => {
      // 17 × $0.49 = $8.33 of a $10 cap.
      await setPlan({ pricingModel: 'per_resolution', spendCap: 10 });
      await Conversation.insertMany(Array.from({ length: 17 }, () => conversation(company._id, 'resolved')));

      const first = await usageAlerts.checkCompany(company._id);
      expect(first.sent).toEqual([{ meter: 'resolutionSpend', level: 80 }]);
      expect(sendMail.mock.calls[0][0].subject).toMatch(/83% of your resolution spending cap used/);
      expect(sendMail.mock.calls[0][0].text).toMatch(/\$8\.33 of the \$10\.00 cap/);
      expect(sendMail.mock.calls[0][0].text).toMatch(/keeps answering/);

      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([]);

      await Conversation.insertMany(Array.from({ length: 8 }, () => conversation(company._id, 'resolved')));
      resolutions.forget(company._id);
      const second = await usageAlerts.checkCompany(company._id);
      expect(second.sent).toEqual([{ meter: 'resolutionSpend', level: 100 }]);
      expect(sendMail.mock.calls[sendMail.mock.calls.length - 1][0].subject).toMatch(/reached your resolution spending cap/);
    });

    test('a new cap clears the warnings for the old one', async () => {
      await setPlan({ pricingModel: 'per_resolution', spendCap: 1 });
      await Conversation.insertMany(Array.from({ length: 3 }, () => conversation(company._id, 'resolved')));
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([{ meter: 'resolutionSpend', level: 100 }]);

      await request(app).put('/api/billing/me/spend-cap').set('x-auth-token', adminToken).send({ cap: 1.8 });
      expect((await usageAlerts.checkCompany(company._id)).sent).toEqual([{ meter: 'resolutionSpend', level: 80 }]);
    });

    test('the banner carries the cap as money', async () => {
      await setPlan({ pricingModel: 'per_resolution', spendCap: 1 });
      await Conversation.insertMany(Array.from({ length: 2 }, () => conversation(company._id, 'resolved')));
      const status = (await request(app).get('/api/billing/me/status').set('x-auth-token', adminToken)).body;
      expect(status.warnings).toEqual([expect.objectContaining({ meter: 'resolutionSpend', money: true, used: 0.98, limit: 1 })]);
    });
  });

  describe('Stripe meter events', () => {
    // A fixed month, so the day boundaries below are the same on any run.
    const day1 = new Date('2026-03-15T12:00:00Z');
    const day2 = new Date('2026-03-16T12:00:00Z');
    const started = new Date('2026-03-10T09:00:00Z');

    const meterCalls = () => postSpy.mock.calls.filter(call => call[0] === 'https://api.stripe.com/v1/billing/meter_events');

    beforeEach(async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_PRICE_RESOLUTION = 'price_resolution';
      await setPlan({ pricingModel: 'per_resolution', externalCustomerId: 'cus_p2f', externalSubscriptionId: 'sub_p2f' });
    });

    const addResolved = count => Conversation.insertMany(
      Array.from({ length: count }, () => conversation(company._id, 'resolved', { startedAt: started }))
    );

    test('reports the month once a day, with an idempotency key per company, month and day', async () => {
      await addResolved(3);

      const result = await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(result).toMatchObject({ configured: true, sent: 3, failed: 0 });

      expect(meterCalls()).toHaveLength(1);
      const [url, body, options] = meterCalls()[0];
      const identifier = `res_${company._id}_2026-03_2026-03-15`;
      expect(url).toBe('https://api.stripe.com/v1/billing/meter_events');
      expect(decodeForm(body)).toMatchObject({
        event_name: 'resolutions',
        identifier,
        'payload[stripe_customer_id]': 'cus_p2f',
        'payload[value]': '3',
        timestamp: String(Math.floor(day1.getTime() / 1000))
      });
      expect(options.headers['Idempotency-Key']).toBe(identifier);
      expect(options.headers.Authorization).toBe('Bearer sk_test_123');

      // The same day again: nothing more is sent, even with more to say.
      await addResolved(1);
      await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(meterCalls()).toHaveLength(1);

      // The next day sends only the difference, under the next day's key.
      await resolutions.reportResolutionsToStripe({ now: day2, retryDelayMs: 0 });
      expect(meterCalls()).toHaveLength(2);
      expect(decodeForm(meterCalls()[1][1])).toMatchObject({
        identifier: `res_${company._id}_2026-03_2026-03-16`,
        'payload[value]': '1'
      });

      const usage = await Usage.findOne({ company: company._id, period: '2026-03' });
      expect(usage.stripeReport.reported).toBe(4);
      expect(usage.resolutions).toBe(4);
    });

    test('never reports past the cap, and takes back what a lower cap no longer allows', async () => {
      await Subscription.updateOne({ company: company._id }, { $set: { spendCap: 1 } });
      await addResolved(5);

      await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(decodeForm(meterCalls()[0][1])['payload[value]']).toBe('2');

      // Lowered to below one resolution: the next report is a correction.
      await Subscription.updateOne({ company: company._id }, { $set: { spendCap: 0.4 } });
      await resolutions.reportResolutionsToStripe({ now: day2, retryDelayMs: 0 });
      expect(decodeForm(meterCalls()[1][1])['payload[value]']).toBe('-2');
    });

    test('a report that got no answer is resent unchanged, so it cannot count twice', async () => {
      await addResolved(2);
      postSpy.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

      const failed = await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(failed.sent).toBe(0);
      // Tried, and retried, under the same key.
      const attempts = meterCalls().map(call => decodeForm(call[1]).identifier);
      expect(new Set(attempts).size).toBe(1);
      expect(attempts.length).toBe(3);

      let usage = await Usage.findOne({ company: company._id, period: '2026-03' }).lean();
      expect(usage.stripeReport.pending).toMatchObject({ value: 2 });
      expect(usage.stripeReport.reported).toBe(0);

      // Stripe is back, and two more resolutions have happened.
      postSpy.mockResolvedValue({ data: {} });
      await addResolved(2);
      await resolutions.reportResolutionsToStripe({ now: day2, retryDelayMs: 0 });

      const sent = meterCalls().slice(3).map(call => decodeForm(call[1]));
      expect(sent).toEqual([
        expect.objectContaining({ identifier: `res_${company._id}_2026-03_2026-03-15`, 'payload[value]': '2' }),
        expect.objectContaining({ identifier: `res_${company._id}_2026-03_2026-03-16`, 'payload[value]': '2' })
      ]);
      usage = await Usage.findOne({ company: company._id, period: '2026-03' }).lean();
      expect(usage.stripeReport.reported).toBe(4);
      expect(usage.stripeReport.pending).toBeUndefined();
    });

    test('a report Stripe refuses is dropped and folded into the next one', async () => {
      await addResolved(2);
      postSpy.mockRejectedValue(Object.assign(new Error('bad'), {
        response: { status: 400, data: { error: { message: 'No such customer' } } }
      }));

      await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(meterCalls()).toHaveLength(1);
      const usage = await Usage.findOne({ company: company._id, period: '2026-03' }).lean();
      expect(usage.stripeReport.pending).toBeUndefined();

      postSpy.mockResolvedValue({ data: {} });
      await resolutions.reportResolutionsToStripe({ now: day2, retryDelayMs: 0 });
      expect(decodeForm(meterCalls()[1][1])['payload[value]']).toBe('2');
    });

    test('nothing is sent unless a key and the metered price are configured', async () => {
      delete process.env.STRIPE_PRICE_RESOLUTION;
      await addResolved(2);
      expect(await resolutions.reportResolutionsToStripe({ now: day1 })).toMatchObject({ configured: false });
      expect(postSpy).not.toHaveBeenCalled();
    });

    test('a flat tenant is never reported', async () => {
      await setPlan({ pricingModel: 'flat' });
      await addResolved(2);
      await resolutions.reportResolutionsToStripe({ now: day1, retryDelayMs: 0 });
      expect(meterCalls()).toHaveLength(0);
    });
  });

  describe('per-resolution checkout', () => {
    test('a base fee and the metered price, anchored to the first of the month', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_PRICE_RESOLUTION = 'price_resolution';
      process.env.STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION = 'price_pro_base';
      process.env.PUBLIC_URL = 'https://app.example.com';
      await setPlan({ planId: 'trial', status: 'trialing' });
      postSpy.mockResolvedValue({ data: { id: 'cs_1', url: 'https://checkout.stripe.com/c/1' } });

      const me = (await request(app).get('/api/billing/me').set('x-auth-token', adminToken)).body;
      expect(me.resolutionCheckout).toEqual({ available: true, plans: ['professional'] });

      const response = await request(app).post('/api/billing/checkout')
        .set('x-auth-token', adminToken).send({ plan: 'professional', pricing: 'per_resolution' });
      expect(response.status).toBe(200);

      const sent = decodeForm(postSpy.mock.calls[0][1]);
      expect(sent).toMatchObject({
        'line_items[0][price]': 'price_pro_base',
        'line_items[0][quantity]': '1',
        'line_items[1][price]': 'price_resolution',
        'metadata[pricingModel]': 'per_resolution',
        'subscription_data[metadata][pricingModel]': 'per_resolution'
      });
      // A metered price takes no quantity.
      expect(sent['line_items[1][quantity]']).toBeUndefined();
      const anchor = new Date(Number(sent['subscription_data[billing_cycle_anchor]']) * 1000);
      expect(anchor.getUTCDate()).toBe(1);
      expect(anchor.getUTCHours()).toBe(0);
      expect(anchor.getTime()).toBeGreaterThan(Date.now());
    });

    test('a plan with no per-resolution option is refused', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_PRICE_RESOLUTION = 'price_resolution';
      const response = await request(app).post('/api/billing/checkout')
        .set('x-auth-token', adminToken).send({ plan: 'basic', pricing: 'per_resolution' });
      expect(response.status).toBe(400);
    });

    test('Stripe\'s subscription events say which model the tenant is on', () => {
      process.env.STRIPE_PRICE_RESOLUTION = 'price_resolution';
      process.env.STRIPE_PRICE_PROFESSIONAL = 'price_professional';
      const translated = stripe.translate({
        type: 'customer.subscription.updated',
        created: 1700000000,
        data: {
          object: {
            id: 'sub_1', customer: 'cus_1', status: 'active', metadata: {},
            items: { data: [{ price: { id: 'price_resolution' } }, { price: { id: 'price_professional' } }] }
          }
        }
      });
      expect(translated.changes).toMatchObject({ planId: 'professional', pricingModel: 'per_resolution' });
    });

    test('per-resolution prices are configuration, with placeholders as fallbacks', () => {
      const pricing = resolutionPricing('professional');
      expect(pricing.options).toEqual(['flat', 'per_resolution']);
      expect(pricing.model).toBe('flat');
      expect(Number.isFinite(pricing.perResolution)).toBe(true);
      expect(resolutionPricing('basic')).toBeNull();
    });
  });
});
