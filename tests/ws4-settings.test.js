/**
 * Account settings an admin changes: business hours (overnight, days off),
 * retention, the audit log, webhooks, API keys and the connector switch.
 */

const http = require('http');
const dns = require('dns');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const AuditLog = require('../models/audit-log');
const Webhook = require('../models/webhook');
const WebhookDelivery = require('../models/webhook-delivery');
const ApiKey = require('../models/api-key');
const Subscription = require('../models/subscription');
const availability = require('../services/availability');
const audit = require('../services/audit');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const usageService = require('../services/usage');

const PASSWORD = 'TestPassword123!';
const DAY = 24 * 60 * 60 * 1000;

/** Audit entries are written without holding up the response; wait briefly. */
async function audited(query) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await AuditLog.exists(query)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

describe('Account settings', () => {
  let app;
  let company;
  let adminToken;

  const as = () => ({ 'x-auth-token': adminToken });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/admin', require('../routes/admin'));
    app.use('/api/companies', require('../routes/company'));
    app.use('/api/webhooks', require('../routes/webhooks'));
    app.use('/api/api-keys', require('../routes/api-keys'));

    company = await Company.create({ name: 'Settings Co' });
    await User.create({
      username: 'settings-admin', email: 'admin@settings.example', password: PASSWORD,
      role: 'company_admin', company: company._id, displayName: 'Sid'
    });
    adminToken = (await request(app).post('/api/auth/login')
      .send({ username: 'settings-admin', password: PASSWORD })).body.token;
  });

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ email: /@settings\.example$/ }),
      Conversation.deleteMany({ company: company._id }),
      AuditLog.deleteMany({ company: company._id }),
      WebhookDelivery.deleteMany({ company: company._id }),
      Webhook.deleteMany({ company: company._id }),
      ApiKey.deleteMany({ company: company._id }),
      Subscription.deleteMany({ company: company._id }),
      Company.deleteMany({ _id: company._id })
    ]);
  });

  describe('business hours', () => {
    afterEach(() => availability.invalidate());

    test('an overnight shift is open late and early, and closed in the afternoon', () => {
      // Friday 22:00 to Saturday 06:00.
      const days = [{ day: 5, opensAt: 22 * 60, closesAt: 6 * 60, closed: false }];
      const none = new Set();

      expect(availability.openAt(days, none, 5, 23 * 60, '2026-10-23')).toBe(true);
      expect(availability.openAt(days, none, 6, 5 * 60, '2026-10-24')).toBe(true);
      expect(availability.openAt(days, none, 6, 7 * 60, '2026-10-24')).toBe(false);
      expect(availability.openAt(days, none, 5, 15 * 60, '2026-10-23')).toBe(false);
    });

    test('a closed date closes the whole day, and the next opening skips it', () => {
      const weekdays = [1, 2, 3, 4, 5].map(day => ({ day, opensAt: 540, closesAt: 1020, closed: false }));
      // Thursday 2026-12-24 at noon, with the 25th and 26th off.
      const closed = new Set(['2026-12-24', '2026-12-25']);

      expect(availability.openAt(weekdays, closed, 4, 12 * 60, '2026-12-24')).toBe(false);
      expect(availability.openAt(weekdays, new Set(), 4, 12 * 60, '2026-12-24')).toBe(true);
      // Friday the 25th is closed; the weekend has no hours; Monday the 28th.
      expect(availability.nextOpening(weekdays, 4, 12 * 60, { closed, date: '2026-12-24' }))
        .toBe('Monday at 09:00');
    });

    test('today on the closed list reads as closed, with its name', async () => {
      const today = availability.localDateIn('UTC');
      await Company.updateOne({ _id: company._id }, {
        $set: {
          businessHours: {
            enabled: true, timezone: 'UTC',
            days: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, opensAt: 0, closesAt: 1440, closed: false })),
            closedDates: [{ date: today, label: 'Founders day' }]
          }
        }
      });
      availability.invalidate();

      const status = await availability.isWithinBusinessHours(company._id);
      expect(status.open).toBe(false);
      expect(status.closedToday).toBe('Founders day');
    });

    test('saving accepts overnight hours and a list of days off, and is recorded', async () => {
      const response = await request(app).put('/api/companies/me/hours').set(as()).send({
        enabled: true,
        timezone: 'Europe/Bucharest',
        days: [{ day: 5, opensAt: 1320, closesAt: 360, closed: false }],
        closedDates: [{ date: '2026-12-25', label: 'Christmas' }, '2026-12-25', { date: '2026-01-01' }]
      });

      expect(response.status).toBe(200);
      expect(response.body.businessHours.closedDates).toEqual([
        { date: '2026-01-01' }, { date: '2026-12-25' }
      ]);
      expect(await audited({ action: 'company.hours_changed', company: company._id })).toBe(true);

      const read = await request(app).get('/api/companies/me/hours').set(as());
      expect(read.body.saved).toBe(true);
      expect(read.body.businessHours.days[0]).toMatchObject({ opensAt: 1320, closesAt: 360 });
    });

    test('refuses the same time twice, and a date that is not one', async () => {
      const same = await request(app).put('/api/companies/me/hours').set(as()).send({
        enabled: true, timezone: 'UTC', days: [{ day: 1, opensAt: 540, closesAt: 540 }]
      });
      expect(same.status).toBe(400);

      const badDate = await request(app).put('/api/companies/me/hours').set(as()).send({
        enabled: true, timezone: 'UTC', days: [], closedDates: ['2026-02-30']
      });
      expect(badDate.status).toBe(400);
    });

    test('a company that never saved hours says so, so the screen can offer the browser\'s zone', async () => {
      const fresh = await Company.create({ name: 'Settings Fresh' });
      await User.create({
        username: 'settings-fresh', email: 'fresh@settings.example', password: PASSWORD,
        role: 'company_admin', company: fresh._id
      });
      const token = (await request(app).post('/api/auth/login')
        .send({ username: 'settings-fresh', password: PASSWORD })).body.token;

      const read = await request(app).get('/api/companies/me/hours').set('x-auth-token', token);
      expect(read.body.saved).toBe(false);

      await Company.deleteOne({ _id: fresh._id });
    });
  });

  describe('retention', () => {
    test('previews the values being typed, before they are saved', async () => {
      await Conversation.create({
        sessionId: `settings-old-${Date.now()}`, company: company._id,
        lastActivity: new Date(Date.now() - 20 * DAY), messages: [{ content: 'old', sender: 'user' }]
      });

      const preview = await request(app)
        .get('/api/companies/me/retention/preview?deleteAfterDays=10&anonymizeAfterDays=5').set(as());
      expect(preview.status).toBe(200);
      expect(preview.body.impact).toEqual({ toDelete: 1, toAnonymize: 1 });
      expect(preview.body.effective.source.deleteAfterDays).toBe('company');

      // Nothing was saved.
      const saved = await request(app).get('/api/companies/me/retention').set(as());
      expect(saved.body.dataRetention.deleteAfterDays).toBeUndefined();

      const bad = await request(app).get('/api/companies/me/retention/preview?deleteAfterDays=-3').set(as());
      expect(bad.status).toBe(400);
    });
  });

  describe('routing', () => {
    test('a change is recorded', async () => {
      const response = await request(app).put('/api/companies/me/routing').set(as()).send({ autoAssign: true });
      expect(response.status).toBe(200);
      expect(await audited({ action: 'company.routing_changed', company: company._id })).toBe(true);
    });
  });

  describe('the audit log', () => {
    test('every action reads as words, including ones nobody described yet', () => {
      expect(audit.describe('operator.invited')).toBe('Invited a teammate');
      expect(audit.describe('bot.taught')).toBe('Taught the bot a better answer');
      expect(audit.describe('widget.domain_added')).toBe('Widget: domain added');
    });

    test('can be filtered by who, and exported as CSV', async () => {
      const admin = await User.findOne({ username: 'settings-admin' });
      await audit.record({
        action: 'operator.invited', company: company._id,
        actor: { id: admin._id, username: 'settings-admin', displayName: 'Sid', role: 'company_admin' },
        target: { type: 'user', label: '=HYPERLINK("evil")' }
      });

      const actors = await request(app).get('/api/admin/audit/actors').set(as());
      expect(actors.body.actors.map(actor => actor.name)).toContain('Sid');

      const byActor = await request(app).get(`/api/admin/audit?actorId=${admin._id}`).set(as());
      expect(byActor.body.entries.every(entry => String(entry.actor.id) === String(admin._id))).toBe(true);
      expect(byActor.body.total).toBeGreaterThan(0);

      // Not an id: nothing matches, rather than a server error.
      const nonsense = await request(app).get('/api/admin/audit?actorId=not-an-id').set(as());
      expect(nonsense.status).toBe(200);
      expect(nonsense.body.total).toBe(0);

      const actions = await request(app).get('/api/admin/audit/actions').set(as());
      expect(actions.body.descriptions['operator.invited']).toBe('Invited a teammate');

      const csv = await request(app).get('/api/admin/audit/export?action=operator.').set(as());
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toMatch(/"Invited a teammate"/);
      // A value a stranger typed cannot become a spreadsheet formula.
      expect(csv.text).toMatch(/"'=HYPERLINK\(""evil""\)"/);
    });
  });

  describe('webhooks', () => {
    let server;
    let base;
    let status = 500;

    beforeAll(async () => {
      process.env.ACTIONS_ALLOW_HTTP = 'true';
      safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));
      await new Promise(resolve => {
        server = http.createServer((req, res) => {
          req.resume();
          req.on('end', () => {
            res.writeHead(status);
            res.end(status === 200 ? 'ok' : 'down');
          });
        });
        server.listen(0, '127.0.0.1', () => {
          base = `http://localhost:${server.address().port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      safeHttp.__setLookupForTests(null);
      delete process.env.ACTIONS_ALLOW_HTTP;
      await new Promise(resolve => server.close(resolve));
    });

    test('a failed delivery can be sent again once the endpoint is fixed, and says which endpoint it was', async () => {
      const hook = await Webhook.create({
        company: company._id, url: `${base}/hooks`, description: 'CRM sync',
        events: ['conversation.ended'], secret: secrets.encrypt('whsec_test'), enabled: true
      });
      const failed = await WebhookDelivery.create({
        webhook: hook._id, company: company._id, event: 'conversation.ended',
        payload: { sessionId: 's1' }, status: 'failed', attempts: 5, error: 'The endpoint returned 500'
      });

      const list = await request(app).get('/api/webhooks/deliveries').set(as());
      const row = list.body.deliveries.find(delivery => String(delivery._id) === String(failed._id));
      expect(row).toMatchObject({ webhookUrl: `${base}/hooks`, webhookDescription: 'CRM sync' });

      status = 200;
      const response = await request(app)
        .post(`/api/webhooks/${hook._id}/deliveries/${failed._id}/redeliver`).set(as());
      expect(response.status).toBe(200);
      expect(response.body.result.delivered).toBe(true);

      // A new row; the failed one stays as the record of what went wrong.
      expect((await WebhookDelivery.findById(failed._id)).status).toBe('failed');
      expect(await WebhookDelivery.countDocuments({ webhook: hook._id, status: 'delivered' })).toBe(1);
      expect(await audited({ action: 'webhook.redelivered', company: company._id })).toBe(true);

      const pending = await WebhookDelivery.create({
        webhook: hook._id, company: company._id, event: 'conversation.ended', payload: {}, status: 'pending'
      });
      expect((await request(app).post(`/api/webhooks/${hook._id}/deliveries/${pending._id}/redeliver`).set(as())).status)
        .toBe(409);
    });
  });

  describe('API keys', () => {
    beforeAll(async () => {
      await Subscription.deleteMany({ company: company._id });
      await Subscription.create({ company: company._id, planId: 'professional', status: 'active' });
      usageService.invalidateSubscription(company._id);
    });

    test('can be given an expiry, which must be in the future', async () => {
      const create = expiresAt => request(app).post('/api/api-keys').set(as())
        .send({ name: 'Backfill', scopes: ['conversations:read'], expiresAt });

      expect((await create(new Date(Date.now() - DAY).toISOString())).status).toBe(400);
      expect((await create('not a date')).status).toBe(400);

      const when = new Date(Date.now() + 30 * DAY);
      const ok = await create(when.toISOString());
      expect(ok.status).toBe(201);
      expect(new Date(ok.body.apiKey.expiresAt).getTime()).toBe(when.getTime());

      expect((await create('')).status).toBe(201);
    });
  });

  describe('the connector', () => {
    test('cannot be switched on until a Check has reached it', async () => {
      const refused = await request(app).put('/api/companies/me/connector').set(as())
        .send({ url: 'https://shop.example/chatbot-connector', enabled: true });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('CONNECTOR_NOT_CHECKED');

      await request(app).put('/api/companies/me/connector').set(as())
        .send({ url: 'https://shop.example/chatbot-connector' });
      await Company.updateOne({ _id: company._id }, {
        $set: { 'connector.lastCheckedAt': new Date(), 'connector.capabilities': ['catalog.search'] }
      });

      const allowed = await request(app).put('/api/companies/me/connector').set(as()).send({ enabled: true });
      expect(allowed.status).toBe(200);
      expect(allowed.body.connector.enabled).toBe(true);

      // A new address is switched off until it is checked in turn.
      const moved = await request(app).put('/api/companies/me/connector').set(as())
        .send({ url: 'https://other.example/chatbot-connector' });
      expect(moved.body.connector.enabled).toBe(false);
    });

    test('names the SDK package that actually ships, with its guide', async () => {
      const response = await request(app).get('/api/companies/me/connector/sdk').set(as());
      expect(response.status).toBe(200);
      expect(response.body.packageName).toBe('@chatbot-platform/connector-sdk');
      expect(response.body.install).toBe('npm install @chatbot-platform/connector-sdk');
      expect(response.body.readme).toMatch(/Connector SDK/);
    });
  });
});
