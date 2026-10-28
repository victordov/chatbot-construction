/**
 * The team: invitations, seats, and what deactivating or removing someone
 * actually does.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const Workflow = require('../models/workflow');
const AuditLog = require('../models/audit-log');
const RateLimitCounter = require('../models/rate-limit-counter');
const AlertService = require('../services/alerting');
const usageService = require('../services/usage');
const socketManager = require('../socketManager');

const PASSWORD = 'TestPassword123!';

/**
 * Most audit entries are written without holding up the response, so the
 * test waits briefly for one. With `returnEntry`, the entry itself.
 */
async function audited(query, returnEntry = false) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = await AuditLog.findOne(query).lean();
    if (entry) {
      return returnEntry ? entry : true;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return returnEntry ? null : false;
}

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/companies', require('../routes/company'));
  return app;
};

describe('Team', () => {
  let app;
  let acme;
  let adminToken;
  let rootToken;
  let sendMail;
  let disconnectUser;

  const login = async (username, password = PASSWORD) => (await request(app)
    .post('/api/auth/login')
    .send({ username, password })).body.token;

  const as = token => ({ 'x-auth-token': token });

  const invite = (body, token = adminToken) => request(app)
    .post('/api/admin/operators/invite')
    .set(as(token))
    .send(body);

  /** The token in the last invitation sent. */
  const lastInviteToken = () => {
    const mail = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
    return mail.text.match(/\/admin\/invite\.html\?token=([a-f0-9]+)/)[1];
  };

  const setPlan = async (planId, companyId = acme._id) => {
    await Subscription.deleteMany({ company: companyId });
    await Subscription.create({ company: companyId, planId, status: 'active' });
    usageService.invalidateSubscription(companyId);
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'Team Acme' });
    await User.create({
      username: 'team-admin', email: 'admin@team.example', password: PASSWORD,
      role: 'company_admin', company: acme._id, displayName: 'Ada Admin'
    });
    await User.create({
      username: 'team-root', email: 'root@team.example', password: PASSWORD, role: 'superadmin'
    });

    adminToken = await login('team-admin');
    rootToken = await login('team-root');
  });

  beforeEach(async () => {
    sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
    disconnectUser = jest.fn();
    socketManager.disconnectUser = disconnectUser;
    await RateLimitCounter.deleteMany({ _id: /^acct-link:/ });
    await setPlan('professional');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete socketManager.disconnectUser;
  });

  afterAll(async () => {
    const companies = await Company.find({ name: /^Team / }).select('_id').lean();
    const ids = companies.map(company => company._id);
    await Promise.all([
      User.deleteMany({ $or: [{ email: /@team\.example$/ }, { company: { $in: ids } }] }),
      Conversation.deleteMany({ company: { $in: ids } }),
      Workflow.deleteMany({ company: { $in: ids } }),
      Subscription.deleteMany({ company: { $in: ids } }),
      AuditLog.deleteMany({ company: { $in: ids } }),
      Company.deleteMany({ _id: { $in: ids } })
    ]);
  });

  describe('invitations', () => {
    test('an invited person chooses their own password and is signed in', async () => {
      const response = await invite({ email: 'Ivy@Team.example', name: 'Ivy' });

      expect(response.status).toBe(201);
      expect(response.body.inviteSent).toBe(true);
      expect(response.body.inviteLink).toBeUndefined();
      expect(response.body.operator).toMatchObject({ email: 'ivy@team.example', role: 'operator', invitePending: true });

      const mail = sendMail.mock.calls[0][0];
      expect(mail.to).toBe('ivy@team.example');
      expect(mail.subject).toMatch(/Ada Admin invited you/);
      const token = lastInviteToken();

      // Nobody can sign in to it yet, and the reason is said plainly.
      const early = await request(app).post('/api/auth/login').send({ username: 'ivy@team.example', password: 'anything' });
      expect(early.status).toBe(403);
      expect(early.body.code).toBe('INVITE_PENDING');

      const details = await request(app).get(`/api/auth/invite/${token}`);
      expect(details.status).toBe(200);
      expect(details.body).toMatchObject({
        email: 'ivy@team.example', companyName: 'Team Acme', invitedBy: 'Ada Admin', role: 'operator'
      });

      const short = await request(app).post('/api/auth/accept-invite').send({ token, password: 'short' });
      expect(short.status).toBe(400);

      const accepted = await request(app).post('/api/auth/accept-invite')
        .send({ token, password: 'IvysOwnPassword1', displayName: 'Ivy Ives' });
      expect(accepted.status).toBe(200);
      expect(accepted.body.token).toBeTruthy();
      expect(accepted.body.user.displayName).toBe('Ivy Ives');

      const ivy = await User.findOne({ email: 'ivy@team.example' });
      expect(ivy.invitePending).toBe(false);
      // Opening the link proved the address.
      expect(ivy.emailVerifiedAt).toBeInstanceOf(Date);
      expect(await login('ivy@team.example', 'IvysOwnPassword1')).toBeTruthy();

      // The link works once.
      expect((await request(app).post('/api/auth/accept-invite').send({ token, password: 'AnotherOne123' })).status).toBe(400);
      expect((await request(app).get(`/api/auth/invite/${token}`)).status).toBe(404);

      expect(await audited({ action: 'operator.invited', company: acme._id })).toBe(true);
      expect(await audited({ action: 'user.invite_accepted', company: acme._id })).toBe(true);
    });

    test('an address that already has an account cannot be invited', async () => {
      const response = await invite({ email: 'admin@team.example' });
      expect(response.status).toBe(409);
    });

    test('an expired link does not work', async () => {
      await invite({ email: 'late@team.example' });
      const token = lastInviteToken();
      await User.updateOne({ email: 'late@team.example' }, { $set: { inviteExpires: new Date(Date.now() - 1000) } });

      expect((await request(app).get(`/api/auth/invite/${token}`)).status).toBe(404);
      expect((await request(app).post('/api/auth/accept-invite').send({ token, password: PASSWORD })).status).toBe(400);
    });

    test('resending makes a new link and retires the old one; withdrawing deletes the account', async () => {
      const created = await invite({ email: 'rex@team.example' });
      const id = created.body.operator._id;
      const first = lastInviteToken();

      const resent = await request(app).post(`/api/admin/operators/${id}/resend-invite`).set(as(adminToken));
      expect(resent.status).toBe(200);
      const second = lastInviteToken();
      expect(second).not.toBe(first);
      expect((await request(app).get(`/api/auth/invite/${first}`)).status).toBe(404);
      expect((await request(app).get(`/api/auth/invite/${second}`)).status).toBe(200);

      const withdrawn = await request(app).delete(`/api/admin/operators/${id}/invite`).set(as(adminToken));
      expect(withdrawn.status).toBe(200);
      expect(await User.exists({ email: 'rex@team.example' })).toBeNull();
      expect((await request(app).get(`/api/auth/invite/${second}`)).status).toBe(404);
    });

    test('without email, the admin gets the link to pass on', async () => {
      AlertService.createSmtpTransport.mockReturnValue(null);
      const response = await invite({ email: 'nomail@team.example' });
      expect(response.status).toBe(201);
      expect(response.body.inviteSent).toBe(false);
      expect(response.body.inviteLink).toMatch(/\/admin\/invite\.html\?token=[a-f0-9]+$/);
    });
  });

  describe('seats', () => {
    beforeEach(async () => {
      await User.deleteMany({ company: acme._id, role: 'operator' });
    });

    test('operators are seats, invited ones included; admins are not', async () => {
      await setPlan('basic'); // one seat

      expect(await usageService.currentValue(acme._id, 'operators')).toBe(0);

      expect((await invite({ email: 'seat-one@team.example' })).status).toBe(201);
      expect(await usageService.currentValue(acme._id, 'operators')).toBe(1);

      const second = await invite({ email: 'seat-two@team.example' });
      expect(second.status).toBe(402);
      expect(second.body.code).toBe('PLAN_LIMIT_REACHED');

      // Another admin runs the account and takes no seat.
      const coAdmin = await invite({ email: 'co-admin@team.example', role: 'company_admin' });
      expect(coAdmin.status).toBe(201);
      expect(await usageService.currentValue(acme._id, 'operators')).toBe(1);

      // The same with a password set by the admin.
      const withPassword = await request(app).post('/api/admin/operators').set(as(adminToken)).send({
        email: 'co-admin-2@team.example', displayName: 'Co Two', role: 'company_admin',
        password: PASSWORD, confirmPassword: PASSWORD
      });
      expect(withPassword.status).toBe(201);
      expect(withPassword.body.operator.role).toBe('company_admin');

      await User.deleteMany({ email: /^co-admin/ });
    });

    test('a role the screen cannot give is refused', async () => {
      const response = await invite({ email: 'boss@team.example', role: 'superadmin' });
      expect(response.status).toBe(400);
    });

    test('only live workflows count against the plan', async () => {
      const admin = await User.findOne({ username: 'team-admin' });
      await Workflow.create([
        { name: 'Draft', company: acme._id, status: 'draft', nodes: [], edges: [], createdBy: admin._id },
        { name: 'Live', company: acme._id, status: 'published', publishedAt: new Date(), nodes: [], edges: [], createdBy: admin._id }
      ]);
      expect(await usageService.currentValue(acme._id, 'workflows')).toBe(1);
    });
  });

  describe('deactivating and removing', () => {
    let olly;
    let ollyToken;

    beforeEach(async () => {
      await User.deleteMany({ username: 'team-olly' });
      olly = await User.create({
        username: 'team-olly', email: 'olly@team.example', password: PASSWORD,
        role: 'operator', company: acme._id, displayName: 'Olly'
      });
      ollyToken = await login('team-olly');
    });

    test('deactivating signs them out, disconnects them and returns their chats to the queue', async () => {
      await Conversation.create({
        sessionId: `team-held-${Date.now()}`, company: acme._id, status: 'active',
        hasOperator: true, operatorId: olly._id, operatorName: 'Olly', botEnabled: false,
        messages: [{ content: 'Is my order coming?', sender: 'user' }]
      });

      const response = await request(app).patch(`/api/admin/operators/${olly._id}`).set(as(adminToken))
        .send({ isActive: false });
      expect(response.status).toBe(200);
      expect(response.body.chatsReturnedToQueue).toBe(1);

      expect((await request(app).get('/api/admin/chat-history').set(as(ollyToken))).status).toBe(401);
      expect(disconnectUser).toHaveBeenCalledWith(olly._id, 'account_disabled');

      const held = await Conversation.findOne({ company: acme._id, sessionId: /^team-held-/ });
      expect(held.hasOperator).toBe(false);
      expect(held.operatorId).toBeNull();
      expect(held.awaitingOperatorSince).toBeInstanceOf(Date);
      expect(held.botEnabled).toBe(true);

      const entry = await audited({ action: 'operator.deactivated', 'target.id': String(olly._id) }, true);
      expect(entry.details.chatsReturnedToQueue).toBe(1);
    });

    test('nobody can deactivate themselves', async () => {
      const admin = await User.findOne({ username: 'team-admin' });
      const root = await User.findOne({ username: 'team-root' });

      // A company admin cannot manage a fellow admin, themselves included.
      const self = await request(app).patch(`/api/admin/operators/${admin._id}`).set(as(adminToken))
        .send({ isActive: false });
      expect(self.status).toBe(403);

      const rootSelf = await request(app).patch(`/api/admin/operators/${root._id}`).set(as(rootToken))
        .send({ isActive: false });
      expect(rootSelf.status).toBe(400);
      expect((await User.findById(root._id)).isActive).toBe(true);
    });

    test('removing keeps the history but not the person', async () => {
      const response = await request(app).delete(`/api/admin/operators/${olly._id}`).set(as(adminToken));
      expect(response.status).toBe(200);
      expect(response.body.removed).toBe('account');

      const removed = await User.findById(olly._id);
      expect(removed.isActive).toBe(false);
      expect(removed.deletedAt).toBeInstanceOf(Date);
      expect(removed.displayName).toBe('Removed user');
      expect(removed.email).not.toBe('olly@team.example');
      expect((await request(app).get('/api/admin/chat-history').set(as(ollyToken))).status).toBe(401);

      // Gone from the team, and the address can be invited again.
      const list = await request(app).get('/api/admin/all-operators').set(as(adminToken));
      expect(list.body.operators.map(person => String(person._id))).not.toContain(String(olly._id));
      expect((await invite({ email: 'olly@team.example' })).status).toBe(201);
      await User.deleteMany({ email: 'olly@team.example' });

      expect(await audited({ action: 'operator.deleted', 'target.id': String(olly._id) })).toBe(true);
    });

    test('a per-person chat limit, or the team setting', async () => {
      const put = maxConcurrentChats => request(app).put(`/api/admin/operators/${olly._id}`).set(as(adminToken))
        .send({ email: 'olly@team.example', displayName: 'Olly', maxConcurrentChats });

      expect((await put(4)).status).toBe(200);
      expect((await User.findById(olly._id)).maxConcurrentChats).toBe(4);
      expect((await put(25)).status).toBe(400);
      expect((await put(null)).status).toBe(200);
      expect((await User.findById(olly._id)).maxConcurrentChats).toBeNull();
      // Editing the name alone does not wipe the other one.
      expect((await User.findById(olly._id)).username).toBe('team-olly');
    });

    test('an admin setting a password is recorded, and ends their sessions', async () => {
      const response = await request(app).post(`/api/admin/operators/${olly._id}/reset-password`).set(as(adminToken))
        .send({ password: 'BrandNewPass1', confirmPassword: 'BrandNewPass1' });
      expect(response.status).toBe(200);
      expect((await request(app).get('/api/admin/chat-history').set(as(ollyToken))).status).toBe(401);
      expect(disconnectUser).toHaveBeenCalledWith(olly._id, 'password_changed');
      expect(await audited({ action: 'operator.password_reset', 'target.id': String(olly._id) })).toBe(true);
    });

    test('signing out everywhere closes their sockets too', async () => {
      const response = await request(app).post('/api/auth/logout-everywhere').set(as(ollyToken));
      expect(response.status).toBe(200);
      expect(disconnectUser).toHaveBeenCalledWith(olly._id, 'signed_out');
    });

    test('the team list is for admins, and shows invitations', async () => {
      expect((await request(app).get('/api/admin/all-operators').set(as(ollyToken))).status).toBe(403);
      await invite({ email: 'pending@team.example' });

      const list = await request(app).get('/api/admin/all-operators').set(as(adminToken));
      const pending = list.body.operators.find(person => person.email === 'pending@team.example');
      expect(pending.invitePending).toBe(true);
      expect(pending.company.name).toBe('Team Acme');
      expect(list.body.operators.find(person => person.username === 'team-admin').isSelf).toBe(true);
    });

    test('nobody is online without sockets', async () => {
      const response = await request(app).get('/api/admin/operators/online').set(as(adminToken));
      expect(response.status).toBe(200);
      expect(response.body.online).toEqual([]);
    });
  });

  describe('companies, for a superadmin', () => {
    test('creating one needs its first admin\'s address, invites them, and returns no password', async () => {
      const missing = await request(app).post('/api/companies').set(as(rootToken)).send({ name: 'Team Newco' });
      expect(missing.status).toBe(400);
      expect(await Company.exists({ name: 'Team Newco' })).toBeNull();

      const created = await request(app).post('/api/companies').set(as(rootToken))
        .send({ name: 'Team Newco', adminEmail: 'boss@team.example', adminName: 'Bea Boss' });
      expect(created.status).toBe(201);
      expect(created.body.admin).toMatchObject({ email: 'boss@team.example', invitePending: true });
      expect(created.body.admin.password).toBeUndefined();
      expect(JSON.stringify(created.body)).not.toMatch(/"password"/);
      expect(created.body.inviteSent).toBe(true);

      const company = await Company.findOne({ name: 'Team Newco' });
      expect(company.createdVia).toBe('superadmin');
      expect(await User.exists({ email: /^admin@teamnewco/ })).toBeNull();
      const boss = await User.findOne({ email: 'boss@team.example' });
      expect(boss.role).toBe('company_admin');
      expect(boss.invitePending).toBe(true);
      expect(await audited({ action: 'company.created', company: company._id })).toBe(true);
    });

    test('the list says plan, status, where it came from, and whether the widget was ever seen', async () => {
      await Company.updateOne({ _id: acme._id }, { $set: { widgetSeen: { at: new Date(), origin: 'https://acme.example' } } });

      const response = await request(app).get('/api/companies?q=team%20acme').set(as(rootToken));
      expect(response.status).toBe(200);
      expect(response.body.companies).toHaveLength(1);
      expect(response.body.companies[0]).toMatchObject({
        name: 'Team Acme', planId: 'professional', status: 'active', createdVia: 'superadmin', installed: true
      });
    });

    test('switching a company off disconnects its people and is recorded', async () => {
      const company = await Company.create({ name: 'Team Offco' });
      const person = await User.create({
        username: 'team-offco-op', email: 'offco@team.example', password: PASSWORD, role: 'operator', company: company._id
      });

      const response = await request(app).put(`/api/companies/${company._id}`).set(as(rootToken)).send({ isActive: false });
      expect(response.status).toBe(200);
      expect(disconnectUser).toHaveBeenCalledWith(person._id, 'company_inactive');
      expect(await audited({ action: 'company.deactivated', company: company._id })).toBe(true);

      const back = await request(app).put(`/api/companies/${company._id}`).set(as(rootToken)).send({ isActive: true });
      expect(back.status).toBe(200);
      expect(await audited({ action: 'company.activated', company: company._id })).toBe(true);
    });
  });
});
