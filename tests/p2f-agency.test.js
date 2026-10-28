/**
 * Agencies: their clients, working in a client's dashboard, and their brand.
 *
 * The acting-as token is the part with teeth: it lets one company's admin
 * into another company. So most of what is here checks its edges - it opens
 * that one client and nothing else, cannot touch billing, ends on time and
 * when the client leaves the agency, and leaves a trail in the client's own
 * audit log. Mail is captured, never sent.
 */

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const Company = require('../models/company');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const AuditLog = require('../models/audit-log');
const AlertService = require('../services/alerting');
const usageService = require('../services/usage');
const usageAlerts = require('../services/usage-alerts');
const accountEmail = require('../services/account-email');
const Usage = require('../models/usage');
const eventually = require('./eventually');

const PASSWORD = 'TestPassword123!';

describe('P2F: agencies, white-label and working as a client', () => {
  let app;
  let agency;
  let rival;
  let agencyToken;
  let rivalToken;
  let rootToken;
  let agencyAdmin;
  let sendMail;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: PASSWORD })).body.token;

  const tokenFromMail = call => {
    const match = String(call[0].text).match(/invite\.html\?token=([a-f0-9]+)/);
    return match ? match[1] : null;
  };

  async function addClient(name, email, extra = {}) {
    return request(app).post('/api/agency/clients')
      .set('x-auth-token', agencyToken)
      .send({ name, adminEmail: email, ...extra });
  }

  async function openClient(clientId) {
    return request(app).post(`/api/agency/clients/${clientId}/open`).set('x-auth-token', agencyToken);
  }

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/agency', require('../routes/agency'));
    app.use('/api/billing', require('../routes/billing'));
    app.use('/api/companies', require('../routes/company'));

    agency = await Company.create({ name: 'P2F Brightside Agency', agency: { isAgency: false } });
    rival = await Company.create({ name: 'P2F Rival Dental' });
    await Subscription.create({ company: agency._id, planId: 'agency', status: 'active' });

    agencyAdmin = await User.create({
      username: 'p2f-agency-admin', email: 'dana@p2f-agency.example', password: PASSWORD,
      role: 'company_admin', company: agency._id, displayName: 'Dana'
    });
    await User.create([
      { username: 'p2f-agency-op', email: 'op@p2f-agency.example', password: PASSWORD, role: 'operator', company: agency._id },
      { username: 'p2f-rival-admin', email: 'rival@p2f-agency.example', password: PASSWORD, role: 'company_admin', company: rival._id },
      { username: 'p2f-root', email: 'root@p2f-agency.example', password: PASSWORD, role: 'superadmin' }
    ]);

    agencyToken = await login('p2f-agency-admin');
    rivalToken = await login('p2f-rival-admin');
    rootToken = await login('p2f-root');
  });

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const companies = await Company.find({ name: /^P2F / }).select('_id').lean();
    const ids = companies.map(row => row._id);
    await Promise.all([
      User.deleteMany({ $or: [{ email: /@p2f-agency\.example$/ }, { company: { $in: ids } }] }),
      Subscription.deleteMany({ company: { $in: ids } }),
      Usage.deleteMany({ company: { $in: ids } }),
      AuditLog.deleteMany({ company: { $in: ids } }),
      Company.deleteMany({ _id: { $in: ids } })
    ]);
  });

  describe('becoming an agency', () => {
    test('only a superadmin makes a company an agency', async () => {
      const refused = await request(app).patch(`/api/agency/companies/${agency._id}`)
        .set('x-auth-token', agencyToken).send({ isAgency: true });
      expect(refused.status).toBe(403);

      const notYet = await request(app).get('/api/agency/clients').set('x-auth-token', agencyToken);
      expect(notYet.status).toBe(403);
      expect(notYet.body.code).toBe('NOT_AGENCY');

      const made = await request(app).patch(`/api/agency/companies/${agency._id}`)
        .set('x-auth-token', rootToken).send({ isAgency: true, clientLimit: 3 });
      expect(made.status).toBe(200);
      expect(made.body.company).toMatchObject({ isAgency: true, clientLimit: 3 });

      const entry = await eventually(() => AuditLog.findOne({ company: agency._id, action: 'agency.enabled' }));
      expect(entry).toBeTruthy();

      // The dashboard learns it from the user record.
      const verify = await request(app).get('/api/auth/verify').set('x-auth-token', agencyToken);
      expect(verify.body.user.company.isAgency).toBe(true);
    });

    test('an operator of an agency cannot manage its clients', async () => {
      const opToken = await login('p2f-agency-op');
      const response = await request(app).get('/api/agency/clients').set('x-auth-token', opToken);
      expect(response.status).toBe(403);
    });
  });

  describe('clients and their invitations', () => {
    let client;

    test('adding a client creates the company under the agency and invites its admin', async () => {
      const response = await addClient('P2F Bloom Dental', 'owner@p2f-bloom.example', { adminName: 'Olivia' });
      expect(response.status).toBe(201);
      expect(response.body.inviteSent).toBe(true);

      client = await Company.findById(response.body.client.id);
      expect(String(client.agency.parent)).toBe(String(agency._id));

      const admin = await User.findOne({ email: 'owner@p2f-bloom.example' });
      expect(admin).toMatchObject({ role: 'company_admin', invitePending: true });
      expect(String(admin.company)).toBe(String(client._id));

      // The ordinary invitation, through the ordinary path.
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0].to).toBe('owner@p2f-bloom.example');
      expect(tokenFromMail(sendMail.mock.calls[0])).toBeTruthy();

      const subscription = await Subscription.findOne({ company: client._id });
      expect(subscription.planId).toBe('trial');

      expect(await eventually(() => AuditLog.findOne({ company: agency._id, action: 'agency.client_created' }))).toBeTruthy();
    });

    test('the agency\'s list shows each client with how it is doing', async () => {
      const response = await request(app).get('/api/agency/clients').set('x-auth-token', agencyToken);
      expect(response.status).toBe(200);
      expect(response.body.clients).toEqual([expect.objectContaining({
        name: 'P2F Bloom Dental', planId: 'trial', status: 'trialing', installed: false,
        conversationsThisMonth: 0, resolutionRate: null
      })]);

      const me = await request(app).get('/api/agency/me').set('x-auth-token', agencyToken);
      expect(me.body).toMatchObject({ clients: 1, clientLimit: 3, brandingAllowed: true });
    });

    test('a client the agency pays for goes on the agency\'s client plan', async () => {
      const response = await addClient('P2F Paid Clinic', 'paid@p2f-paid.example', { plan: 'professional' });
      expect(response.status).toBe(201);
      const subscription = await Subscription.findOne({ company: response.body.client.id });
      expect(subscription).toMatchObject({ planId: 'professional', status: 'active' });
      expect(String(subscription.managedByAgency)).toBe(String(agency._id));

      const greedy = await addClient('P2F Greedy Clinic', 'greedy@p2f-greedy.example', { plan: 'enterprise' });
      expect(greedy.status).toBe(400);
    });

    test('an agency on its trial cannot put clients on the paid plan, only on trials', async () => {
      await Subscription.updateOne({ company: agency._id }, { $set: { status: 'trialing' } });
      usageService.invalidateSubscription(agency._id);
      try {
        const response = await addClient('P2F Freeloader Clinic', 'free@p2f-free.example', { plan: 'professional' });
        expect(response.status).toBe(402);
        expect(response.body.code).toBe('AGENCY_NOT_PAYING');
        expect(await Company.exists({ name: 'P2F Freeloader Clinic' })).toBeNull();
      } finally {
        await Subscription.updateOne({ company: agency._id }, { $set: { status: 'active' } });
        usageService.invalidateSubscription(agency._id);
      }
    });

    test('the client limit holds', async () => {
      const third = await addClient('P2F Third Clinic', 'third@p2f-third.example');
      expect(third.status).toBe(201);
      const fourth = await addClient('P2F Fourth Clinic', 'fourth@p2f-fourth.example');
      expect(fourth.status).toBe(403);
      expect(fourth.body.code).toBe('CLIENT_LIMIT');
      expect(await Company.exists({ name: 'P2F Fourth Clinic' })).toBeNull();
    });

    describe('branding', () => {
      test('an agency sets its brand; https logos and real colours only', async () => {
        const bad = await request(app).put('/api/agency/branding').set('x-auth-token', agencyToken)
          .send({ productName: 'Brightside Support', logoUrl: 'http://insecure.example/logo.png' });
        expect(bad.status).toBe(400);

        const saved = await request(app).put('/api/agency/branding').set('x-auth-token', agencyToken).send({
          productName: 'Brightside Support',
          logoUrl: 'https://brightside.example/logo.png',
          primaryColor: '#ff6600',
          supportEmail: 'help@brightside.example'
        });
        expect(saved.status).toBe(200);
      });

      test('the client\'s sign-in, invitation and dashboard wear the agency\'s brand', async () => {
        const forClient = await request(app).get(`/api/auth/config?company=${client._id}`);
        expect(forClient.body).toMatchObject({
          productName: 'Brightside Support',
          branding: { logoUrl: 'https://brightside.example/logo.png', primaryColor: '#ff6600' },
          signupEnabled: false
        });

        // Not anybody else's.
        const forRival = await request(app).get(`/api/auth/config?company=${rival._id}`);
        expect(forRival.body.branding).toBeNull();
        expect(forRival.body.productName).toBe(accountEmail.productName());
        const nonsense = await request(app).get('/api/auth/config?company=not-an-id');
        expect(nonsense.body.branding).toBeNull();

        // A fresh invitation's page, and its mail.
        sendMail.mockClear();
        await User.deleteOne({ email: 'third@p2f-third.example' });
        const third = await Company.findOne({ name: 'P2F Third Clinic' });
        const { invite } = require('../services/team');
        await invite({ email: 'third@p2f-third.example', role: 'company_admin', company: third, invitedBy: { id: agencyAdmin._id, displayName: 'Dana' } });
        const token = tokenFromMail(sendMail.mock.calls[0]);
        const byInvite = await request(app).get(`/api/auth/config?invite=${token}`);
        expect(byInvite.body.productName).toBe('Brightside Support');

        // And the invitation mail itself.
        const mail = sendMail.mock.calls[0][0];
        expect(mail.subject).toMatch(/on Brightside Support$/);
        expect(mail.text).toMatch(/Brightside Support/);
        expect(mail.from).toEqual({ name: 'Brightside Support', address: expect.any(String) });
        expect(mail.replyTo).toBe('help@brightside.example');
      });

      test('verification and usage warnings to a client are branded too', async () => {
        const owner = await User.findOne({ email: 'owner@p2f-bloom.example' });
        await accountEmail.sendVerification(owner, 'abc');
        expect(sendMail.mock.calls[0][0].subject).toBe('Confirm your email for Brightside Support');

        owner.invitePending = false;
        await owner.save();
        await Usage.updateOne({ company: client._id, period: Usage.currentPeriod() }, { $set: { conversations: 90 } }, { upsert: true });
        sendMail.mockClear();
        const result = await usageAlerts.checkCompany(client._id);
        expect(result.sent).toEqual([{ meter: 'conversationsPerMonth', level: 80 }]);
        expect(sendMail.mock.calls[0][0].from).toEqual({ name: 'Brightside Support', address: expect.any(String) });
      });

      test('the brand needs the plan: off the agency plan, clients see ours again', async () => {
        await Subscription.updateOne({ company: agency._id }, { $set: { planId: 'professional' } });
        usageService.invalidateSubscription(agency._id);

        const config = await request(app).get(`/api/auth/config?company=${client._id}`);
        expect(config.body.branding).toBeNull();
        const save = await request(app).put('/api/agency/branding').set('x-auth-token', agencyToken)
          .send({ productName: 'Brightside Support' });
        expect(save.status).toBe(402);

        await Subscription.updateOne({ company: agency._id }, { $set: { planId: 'agency' } });
        usageService.invalidateSubscription(agency._id);
      });
    });

    describe('working as the client', () => {
      let actingToken;

      test('opening a client gives a one-hour token for that client', async () => {
        const response = await openClient(client._id);
        expect(response.status).toBe(200);
        actingToken = response.body.token;

        const decoded = jwt.decode(actingToken);
        expect(decoded.exp - decoded.iat).toBe(60 * 60);
        expect(decoded.actingAs).toEqual({ companyId: String(client._id), by: String(agencyAdmin._id) });

        const verify = await request(app).get('/api/auth/verify').set('x-auth-token', actingToken);
        expect(verify.status).toBe(200);
        expect(verify.body.user.company).toMatchObject({ name: 'P2F Bloom Dental', isAgency: false });
        expect(verify.body.user.actingAs).toMatchObject({ companyName: 'P2F Bloom Dental', agencyName: 'P2F Brightside Agency' });
        expect(verify.body.branding.productName).toBe('Brightside Support');
      });

      test('another agency cannot open somebody else\'s client', async () => {
        const response = await request(app).post(`/api/agency/clients/${client._id}/open`).set('x-auth-token', rivalToken);
        expect(response.status).toBe(403);
        const notTheirs = await openClient(rival._id);
        expect(notTheirs.status).toBe(404);
      });

      test('it can read and change the client', async () => {
        const read = await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', actingToken);
        expect(read.status).toBe(200);
        expect(read.body.company.name).toBe('P2F Bloom Dental');

        const write = await request(app).put(`/api/companies/${client._id}`)
          .set('x-auth-token', actingToken).send({ description: 'Set up by the agency' });
        expect(write.status).toBe(200);
        expect((await Company.findById(client._id)).description).toBe('Set up by the agency');

        const audited = await eventually(() => AuditLog.findOne({ company: client._id, action: 'company.updated' }));
        expect(audited.actor.displayName).toBe('Dana (P2F Brightside Agency)');
      });

      test('it cannot touch any other company, the agency\'s own included', async () => {
        for (const other of [rival._id, agency._id]) {
          const read = await request(app).get(`/api/companies/${other}`).set('x-auth-token', actingToken);
          expect(read.status).toBe(403);
          const write = await request(app).put(`/api/companies/${other}`)
            .set('x-auth-token', actingToken).send({ description: 'nope' });
          expect(write.status).toBe(403);
        }
        // Nor the agency's own screens.
        const clients = await request(app).get('/api/agency/clients').set('x-auth-token', actingToken);
        expect(clients.status).toBe(403);
      });

      test('it cannot change billing or delete the company', async () => {
        const checkout = await request(app).post('/api/billing/checkout')
          .set('x-auth-token', actingToken).send({ plan: 'basic' });
        expect(checkout.status).toBe(403);
        expect(checkout.body.code).toBe('ACTING_AS');

        const portal = await request(app).post('/api/billing/portal').set('x-auth-token', actingToken);
        expect(portal.status).toBe(403);

        const cap = await request(app).put('/api/billing/me/spend-cap')
          .set('x-auth-token', actingToken).send({ cap: 10 });
        expect(cap.status).toBe(403);

        const remove = await request(app).delete(`/api/companies/${client._id}`).set('x-auth-token', actingToken);
        expect(remove.status).toBe(403);
        expect(await Company.exists({ _id: client._id })).toBeTruthy();

        // Seeing the billing screen is fine; it says why it is read-only.
        const me = await request(app).get('/api/billing/me').set('x-auth-token', actingToken);
        expect(me.status).toBe(200);
        expect(me.body.actingAs).toBe(true);
      });

      test('every request is in the client\'s audit log', async () => {
        await request(app).get(`/api/companies/${client._id}/users`).set('x-auth-token', actingToken);
        const entry = await eventually(() => AuditLog.findOne({
          company: client._id, action: 'agency.acted_as', 'details.path': `/api/companies/${client._id}/users`
        }));
        expect(entry).toBeTruthy();
        expect(entry.details).toMatchObject({ method: 'GET', agency: 'P2F Brightside Agency' });
        expect(String(entry.actor.id)).toBe(String(agencyAdmin._id));
      });

      test('it expires', async () => {
        const decoded = jwt.decode(actingToken);
        const expired = jwt.sign(
          { ...decoded, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
          process.env.JWT_SECRET
        );
        const response = await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', expired);
        expect(response.status).toBe(401);
      });

      test('a token naming a client that is not the agency\'s is refused', async () => {
        const forged = jwt.sign({
          id: agencyAdmin._id, username: agencyAdmin.username, role: 'company_admin', company: rival._id,
          tv: 0, jti: crypto.randomUUID(),
          actingAs: { companyId: String(rival._id), by: String(agencyAdmin._id) }
        }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const response = await request(app).get(`/api/companies/${rival._id}`).set('x-auth-token', forged);
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('ACTING_ENDED');
      });

      test('signing out of it ends that session only', async () => {
        const fresh = (await openClient(client._id)).body.token;
        const out = await request(app).post('/api/auth/logout').set('x-auth-token', fresh);
        expect(out.status).toBe(200);
        expect((await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', fresh)).status).toBe(401);
        expect((await request(app).get('/api/agency/clients').set('x-auth-token', agencyToken)).status).toBe(200);
      });

      test('removing the client detaches it, deletes nothing, and ends the session', async () => {
        const paid = await Company.findOne({ name: 'P2F Paid Clinic' });
        const paidToken = (await openClient(paid._id)).body.token;

        const removed = await request(app).delete(`/api/agency/clients/${paid._id}`).set('x-auth-token', agencyToken);
        expect(removed.status).toBe(200);

        const after = await Company.findById(paid._id);
        expect(after).toBeTruthy();
        expect(after.agency.parent).toBeUndefined();
        expect(String(after.agency.detachedFrom)).toBe(String(agency._id));
        expect(await User.exists({ email: 'paid@p2f-paid.example' })).toBeTruthy();

        // The agency stops paying; the client gets a trial to choose its own.
        const subscription = await Subscription.findOne({ company: paid._id });
        expect(subscription).toMatchObject({ planId: 'trial', status: 'trialing' });
        expect(subscription.managedByAgency).toBeUndefined();

        const stale = await request(app).get(`/api/companies/${paid._id}`).set('x-auth-token', paidToken);
        expect(stale.status).toBe(401);

        // And the open session for the client that stayed is unaffected.
        expect((await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', actingToken)).status).toBe(200);
      });

      test('an agency that stops being one loses its way in', async () => {
        await request(app).patch(`/api/agency/companies/${agency._id}`).set('x-auth-token', rootToken).send({ isAgency: false });
        expect((await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', actingToken)).status).toBe(401);
        expect((await request(app).get(`/api/auth/config?company=${client._id}`)).body.branding).toBeNull();

        await request(app).patch(`/api/agency/companies/${agency._id}`).set('x-auth-token', rootToken).send({ isAgency: true });
        expect((await request(app).get(`/api/companies/${client._id}`).set('x-auth-token', actingToken)).status).toBe(200);
      });

      test('the socket layer gets the same scope, or a refusal', async () => {
        const { actingSocketScope } = require('../middleware/auth');
        const user = await User.findById(agencyAdmin._id).select('role company');
        const scope = await actingSocketScope(jwt.decode(actingToken), user);
        expect(scope).toEqual({ companyId: String(client._id), role: 'company_admin', acceptingChats: false, actingAs: true });

        const forRival = { ...jwt.decode(actingToken), actingAs: { companyId: String(rival._id), by: String(agencyAdmin._id) } };
        await expect(actingSocketScope(forRival, user)).rejects.toThrow(/session has ended/);
      });
    });
  });
});
