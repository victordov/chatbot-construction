/**
 * The joins between the October workstreams: each was built and tested on its
 * own, and these are the places where one relies on another.
 *
 * - CORS names its tenant: a widget key makes the origin check that tenant's
 *   own domains, not anybody's.
 * - A domain one tenant registered cannot be claimed by another.
 * - The first plan checks for a new tenant may race; both get the trial.
 * - "Waiting for a person" means what the inbox's Waiting filter means.
 * - A dashboard socket is refused for an invitation nobody accepted, and for
 *   a token signed out on this device.
 */

// Booting server.js binds a port and opens the database. A port nothing else
// is using, set before the config module reads it.
process.env.PORT = String(40000 + Math.floor(Math.random() * 20000));

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const RevokedToken = require('../models/revoked-token');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const analytics = require('../services/analytics');
const tenantService = require('../services/tenant');
const { server, corsPolicy } = require('../server');
const { createHarness, waitFor } = require('./ws1-socket-harness');

const corsApp = () => {
  const app = express();
  app.use(corsPolicy);
  app.get('/api/thing', (req, res) => res.json({ ok: true }));
  return app;
};

describe('integration wiring', () => {
  let alpha;
  let beta;
  let alphaAdmin;
  let api;
  let alphaToken;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    alpha = await Company.create({ name: 'Wiring Alpha', allowedDomains: ['https://alpha-shop.example'] });
    beta = await Company.create({ name: 'Wiring Beta', allowedDomains: ['https://beta-shop.example'] });
    alphaAdmin = await User.create({
      username: 'wiring-alpha-admin',
      email: 'admin@wiring-alpha.example',
      password: 'a-long-test-password-1',
      role: 'company_admin',
      company: alpha._id
    });
    tenantService.invalidate();

    api = express();
    api.use(express.json());
    api.use('/api/auth', require('../routes/auth'));
    api.use('/api/companies', require('../routes/company'));

    const login = await request(api)
      .post('/api/auth/login')
      .send({ username: 'wiring-alpha-admin', password: 'a-long-test-password-1' });
    alphaToken = login.body.token;
  });

  afterAll(async () => {
    await Company.deleteMany({ name: /^Wiring / });
    await User.deleteMany({ username: /^wiring-/ });
    await Conversation.deleteMany({ sessionId: /^wiring-/ });
    tenantService.invalidate();
    await new Promise(resolve => server.close(resolve));
  });

  describe('CORS names its tenant', () => {
    test("another tenant's registered origin gets no credentials on this tenant's key", async () => {
      const response = await request(corsApp())
        .get('/api/thing')
        .query({ key: beta.widgetKey })
        .set('Origin', 'https://alpha-shop.example');

      // Still let through for the widget's anonymous traffic - the key is
      // valid - but not trusted with cookies: the origin is not beta's.
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    test("the tenant's own origin with its own key keeps credentials", async () => {
      const response = await request(corsApp())
        .get('/api/thing')
        .query({ key: alpha.widgetKey })
        .set('Origin', 'https://alpha-shop.example');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('allowed domains', () => {
    test('a domain another tenant registered is refused, and nothing is saved', async () => {
      const response = await request(api)
        .put('/api/companies/me/widget')
        .set('x-auth-token', alphaToken)
        .send({ allowedDomains: ['https://alpha-shop.example', 'https://beta-shop.example'] });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('DOMAIN_TAKEN');
      const stored = await Company.findById(alpha._id).lean();
      expect(stored.allowedDomains).toEqual(['https://alpha-shop.example']);
    });

    test('saving the domains a tenant already has still works', async () => {
      const response = await request(api)
        .put('/api/companies/me/widget')
        .set('x-auth-token', alphaToken)
        .send({ allowedDomains: ['https://alpha-shop.example', 'https://www.alpha-shop.example'] });

      expect(response.status).toBe(200);
      const stored = await Company.findById(alpha._id).lean();
      expect(stored.allowedDomains).toEqual(['https://alpha-shop.example', 'https://www.alpha-shop.example']);
    });
  });

  test("a new tenant's first plan checks may race, and every one gets the same trial", async () => {
    const companyId = new mongoose.Types.ObjectId();

    const results = await Promise.all(Array.from({ length: 6 }, () => Subscription.forCompany(companyId)));

    expect(results.every(Boolean)).toBe(true);
    expect(new Set(results.map(subscription => String(subscription._id))).size).toBe(1);
    await Subscription.deleteMany({ company: companyId });
  });

  test('waiting for a person leaves out a chat a person answered and handed back', async () => {
    const at = new Date();
    const visitor = { content: 'I need help', sender: 'user', timestamp: at };
    await Conversation.create([
      {
        // Asked, nobody came: waiting.
        sessionId: 'wiring-asked', company: alpha._id, status: 'active',
        messages: [visitor], handoff: { requestedAt: at, reason: 'visitor_request' }
      },
      {
        // Asked, answered, handed back to the bot: not waiting.
        sessionId: 'wiring-handed-back', company: alpha._id, status: 'active',
        messages: [visitor], handoff: { requestedAt: at, reason: 'visitor_request' },
        operatorEverJoined: true, hasOperator: false
      },
      {
        // In the queue again after a transfer or a disconnect: waiting.
        sessionId: 'wiring-requeued', company: alpha._id, status: 'active',
        messages: [visitor], awaitingOperatorSince: at, operatorEverJoined: true
      }
    ]);

    const report = await analytics.overview({ company: alpha._id }, 7);

    expect(report.waitingForPerson).toBe(2);
  });

  describe('dashboard sockets', () => {
    const harness = createHarness();

    beforeAll(() => harness.start());
    afterAll(() => harness.stop());

    test('an invitation nobody accepted cannot open the dashboard socket', async () => {
      const invited = await User.create({
        username: 'wiring-invited',
        email: 'invited@wiring-alpha.example',
        password: crypto.randomBytes(24).toString('hex'),
        role: 'operator',
        company: alpha._id,
        invitePending: true
      });

      const socket = harness.connect({ auth: { token: harness.tokenFor(invited, { tv: 0 }) } });
      expect((await waitFor(socket, 'connect_error')).message).toMatch(/Authentication failed/);
    });

    test('a token signed out on this device cannot open it either', async () => {
      const jti = crypto.randomUUID();
      await RevokedToken.create({ _id: jti, user: alphaAdmin._id, expiresAt: new Date(Date.now() + 3600000) });

      const socket = harness.connect({ auth: { token: harness.tokenFor(alphaAdmin, { tv: 0, jti }) } });
      expect((await waitFor(socket, 'connect_error')).message).toMatch(/Authentication failed/);
    });

    test('the same person on another device is unaffected', async () => {
      const socket = harness.connect({ auth: { token: harness.tokenFor(alphaAdmin, { tv: 0, jti: crypto.randomUUID() }) } });
      await waitFor(socket, 'connect');
      expect(socket.connected).toBe(true);
    });
  });
});
