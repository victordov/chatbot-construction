/**
 * Sessions that end, passwords that can be changed, and the bootstrap.
 *
 * A JWT used to be good for eight hours whatever happened to the account in
 * the meantime: a password reset, a logout, a compromise noticed and acted
 * on. Every token now carries the `tokenVersion` it was issued under, and
 * every route that changes a password moves it.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('../models/user');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const RateLimitCounter = require('../models/rate-limit-counter');
const usageService = require('../services/usage');
const AlertService = require('../services/alerting');
const { loginAddressLimiter, passwordResetLimiter } = require('../middleware/rateLimiter');

const PASSWORD = 'TestPassword123!';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
};

describe('Auth hardening', () => {
  let app;
  let acme;
  let dana;
  let danaToken;

  const login = async (username, password = PASSWORD) => request(app)
    .post('/api/auth/login')
    .send({ username, password });

  const whoami = token => request(app)
    .get('/api/admin/chat-history')
    .set('x-auth-token', token);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'Hardening Acme' });

    dana = await User.create({
      username: 'hard-dana', email: 'dana@hardening.example',
      password: PASSWORD, role: 'company_admin', displayName: 'Dana', company: acme._id
    });
    await User.create({
      username: 'hard-dave', email: 'dave@hardening.example',
      password: PASSWORD, role: 'company_admin', displayName: 'Dave', company: acme._id
    });
    await User.create({
      username: 'hard-olly', email: 'olly@hardening.example',
      password: PASSWORD, role: 'operator', displayName: 'Olly', company: acme._id
    });

    danaToken = (await login('hard-dana')).body.token;
  });

  afterAll(async () => {
    await Subscription.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@hardening\.example$/ });
    await Company.deleteMany({ name: /^Hardening/ });
    await RateLimitCounter.deleteMany({ _id: /^(auth-ip|pwreset):/ });
  });

  describe('login input', () => {
    test('a non-string password is refused as a bad credential, not a server error', async () => {
      // bcrypt throws on an object; this used to be a 500 that confirmed the
      // account existed.
      const response = await login('hard-dana', { $gt: '' });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid credentials');
    });

    test('a username that is a query operator is refused', async () => {
      // `{ $gt: '' }` would match the first account in the collection.
      const response = await login({ $gt: '' });
      expect(response.status).toBe(400);
    });
  });

  describe('token versions', () => {
    test('a token carries the version it was issued under', () => {
      const claims = jwt.verify(danaToken, process.env.JWT_SECRET);
      expect(claims.tv).toBe(0);
    });

    test('a token issued under an older version is refused', async () => {
      const stale = jwt.sign(
        { id: String(dana._id), username: dana.username, role: dana.role, company: String(acme._id), tv: 0 },
        process.env.JWT_SECRET
      );
      await User.updateOne({ _id: dana._id }, { $inc: { tokenVersion: 1 } });

      try {
        expect((await whoami(stale)).status).toBe(401);
      } finally {
        await User.updateOne({ _id: dana._id }, { $inc: { tokenVersion: -1 } });
      }
      expect((await whoami(stale)).status).toBe(200);
    });

    test('a token with no version at all is treated as version 0', async () => {
      const legacy = jwt.sign(
        { id: String(dana._id), username: dana.username, role: dana.role, company: String(acme._id) },
        process.env.JWT_SECRET
      );
      expect((await whoami(legacy)).status).toBe(200);
    });

    test('signing out ends this session only', async () => {
      const token = (await login('hard-olly')).body.token;
      const other = (await login('hard-olly')).body.token;

      const response = await request(app).post('/api/auth/logout').set('x-auth-token', token);
      expect(response.status).toBe(200);
      expect(response.body.everywhere).toBe(false);

      expect((await whoami(token)).status).toBe(401);
      // The other browser carries on.
      expect((await whoami(other)).status).toBe(200);
    });

    test('signing out everywhere ends every session, including the one that asked', async () => {
      const token = (await login('hard-olly')).body.token;
      const other = (await login('hard-olly')).body.token;

      const response = await request(app).post('/api/auth/logout-everywhere').set('x-auth-token', token);
      expect(response.status).toBe(200);
      expect(response.body.everywhere).toBe(true);

      expect((await whoami(token)).status).toBe(401);
      expect((await whoami(other)).status).toBe(401);
      // Signing in again works, and the new token is current.
      expect((await whoami((await login('hard-olly')).body.token)).status).toBe(200);
    });

    test('a token from before tokens had ids is signed out everywhere, as before', async () => {
      const olly = await User.findOne({ username: 'hard-olly' });
      const legacy = jwt.sign(
        { id: String(olly._id), username: olly.username, role: olly.role, company: String(acme._id), tv: olly.tokenVersion },
        process.env.JWT_SECRET
      );
      const other = (await login('hard-olly')).body.token;

      const response = await request(app).post('/api/auth/logout').set('x-auth-token', legacy);
      expect(response.body.everywhere).toBe(true);
      expect((await whoami(other)).status).toBe(401);
    });
  });

  describe('changing a password', () => {
    test('requires the current password', async () => {
      const token = (await login('hard-olly')).body.token;

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('x-auth-token', token)
        .send({ currentPassword: 'not-it-at-all', newPassword: 'AnotherPassword456!' });

      expect(response.status).toBe(401);
      expect((await login('hard-olly')).status).toBe(200);
    });

    test('refuses a short new password', async () => {
      const token = (await login('hard-olly')).body.token;

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('x-auth-token', token)
        .send({ currentPassword: PASSWORD, newPassword: 'short' });

      expect(response.status).toBe(400);
    });

    test('rotates the token: the old one dies, the returned one works', async () => {
      const before = (await login('hard-olly')).body.token;

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('x-auth-token', before)
        .send({ currentPassword: PASSWORD, newPassword: 'RotatedPassword789!' });

      expect(response.status).toBe(200);
      expect(typeof response.body.token).toBe('string');

      expect((await whoami(before)).status).toBe(401);
      expect((await whoami(response.body.token)).status).toBe(200);

      // The old password no longer signs in; the new one does.
      expect((await login('hard-olly')).status).toBe(401);
      expect((await login('hard-olly', 'RotatedPassword789!')).status).toBe(200);

      // Put it back for the tests that follow.
      await request(app)
        .post('/api/auth/change-password')
        .set('x-auth-token', response.body.token)
        .send({ currentPassword: 'RotatedPassword789!', newPassword: PASSWORD });
    });
  });

  describe('forgotten passwords', () => {
    let sendMail;

    beforeEach(() => {
      sendMail = jest.fn().mockResolvedValue({});
      jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** Wait for the un-awaited email send to land. */
    const emailSent = async () => {
      for (let i = 0; i < 50 && sendMail.mock.calls.length === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return sendMail.mock.calls[0] && sendMail.mock.calls[0][0];
    };

    test('answers the same whether or not the address exists', async () => {
      const known = await request(app).post('/api/auth/forgot-password').send({ email: 'olly@hardening.example' });
      const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@hardening.example' });

      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toEqual(unknown.body);
    });

    test('emails a link that resets the password once, within the hour', async () => {
      process.env.PUBLIC_URL = 'https://chat.example.test';
      try {
        await request(app).post('/api/auth/forgot-password').send({ email: 'Olly@Hardening.example' });
      } finally {
        delete process.env.PUBLIC_URL;
      }

      const mail = await emailSent();
      expect(mail).toBeDefined();
      expect(mail.to).toBe('olly@hardening.example');

      const match = mail.text.match(/https:\/\/chat\.example\.test\/admin\/login\.html\?reset=([a-f0-9]+)/);
      expect(match).not.toBeNull();
      const token = match[1];

      // Only a hash is stored, and it is not selected by default.
      const stored = await User.findOne({ username: 'hard-olly' }).select('+passwordResetTokenHash +passwordResetExpires');
      expect(stored.passwordResetTokenHash).toBeDefined();
      expect(stored.passwordResetTokenHash).not.toBe(token);
      expect(stored.passwordResetExpires.getTime()).toBeGreaterThan(Date.now());
      expect(stored.passwordResetExpires.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
      expect((await User.findOne({ username: 'hard-olly' })).passwordResetTokenHash).toBeUndefined();

      const sessionBefore = (await login('hard-olly')).body.token;

      const weak = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'short' });
      expect(weak.status).toBe(400);

      const reset = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'ResetPassword321!' });
      expect(reset.status).toBe(200);

      expect((await login('hard-olly', 'ResetPassword321!')).status).toBe(200);
      expect((await login('hard-olly')).status).toBe(401);
      // Sessions opened under the old password are over.
      expect((await whoami(sessionBefore)).status).toBe(401);

      // The token is spent.
      const again = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'YetAnother654!' });
      expect(again.status).toBe(400);

      const fresh = (await login('hard-olly', 'ResetPassword321!')).body.token;
      await request(app)
        .post('/api/auth/change-password')
        .set('x-auth-token', fresh)
        .send({ currentPassword: 'ResetPassword321!', newPassword: PASSWORD });
    });

    test('refuses an expired link', async () => {
      await request(app).post('/api/auth/forgot-password').send({ email: 'olly@hardening.example' });
      const mail = await emailSent();
      const token = mail.text.match(/reset=([a-f0-9]+)/)[1];

      await User.updateOne({ username: 'hard-olly' }, { passwordResetExpires: new Date(Date.now() - 1000) });

      const response = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'ResetPassword321!' });
      expect(response.status).toBe(400);
      expect((await login('hard-olly')).status).toBe(200);
    });

    test('refuses a made-up token', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'a'.repeat(64), newPassword: 'ResetPassword321!' });
      expect(response.status).toBe(400);
    });

    test('says so in the log, not to the caller, when SMTP is not configured', async () => {
      AlertService.createSmtpTransport.mockReturnValue(null);
      const response = await request(app).post('/api/auth/forgot-password').send({ email: 'olly@hardening.example' });
      expect(response.status).toBe(200);
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe('the bootstrap superadmin', () => {
    test('never accepts the old default password', async () => {
      const response = await request(app)
        .post('/api/auth/create-superadmin')
        .send({ username: 'root', email: 'root@hardening.example', password: 'Admin123!' });

      expect(response.status).toBe(400);
      expect(await User.findOne({ username: 'root' })).toBeNull();
    });

    test('requires twelve characters', async () => {
      const response = await request(app)
        .post('/api/auth/create-superadmin')
        .send({ username: 'root', email: 'root@hardening.example', password: 'Short12345!' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/12 characters/);
    });
  });

  describe('managing admins', () => {
    test('a company admin cannot edit a fellow admin', async () => {
      const dave = await User.findOne({ username: 'hard-dave' });

      const response = await request(app)
        .put(`/api/admin/operators/${dave._id}`)
        .set('x-auth-token', danaToken)
        .send({ username: 'hard-dave', email: 'hijacked@hardening.example' });

      expect(response.status).toBe(403);
      expect((await User.findById(dave._id)).email).toBe('dave@hardening.example');
    });

    test('a company admin can still edit an operator, but only known fields', async () => {
      const olly = await User.findOne({ username: 'hard-olly' });

      const smuggled = await request(app)
        .put(`/api/admin/operators/${olly._id}`)
        .set('x-auth-token', danaToken)
        .send({ username: 'hard-olly', email: 'olly@hardening.example', password: 'Sneaky12345!' });
      expect(smuggled.status).toBe(400);

      const badEmail = await request(app)
        .put(`/api/admin/operators/${olly._id}`)
        .set('x-auth-token', danaToken)
        .send({ username: 'hard-olly', email: 'not-an-address' });
      expect(badEmail.status).toBe(400);

      const fine = await request(app)
        .put(`/api/admin/operators/${olly._id}`)
        .set('x-auth-token', danaToken)
        .send({ username: 'hard-olly', email: 'olly@hardening.example', displayName: 'Oliver' });
      expect(fine.status).toBe(200);
      expect((await User.findById(olly._id)).displayName).toBe('Oliver');
    });

    test('a company admin resetting an operator password ends that operator\'s sessions', async () => {
      const olly = await User.findOne({ username: 'hard-olly' });
      const session = (await login('hard-olly')).body.token;

      const response = await request(app)
        .post(`/api/admin/operators/${olly._id}/reset-password`)
        .set('x-auth-token', danaToken)
        .send({ password: PASSWORD, confirmPassword: PASSWORD });

      expect(response.status).toBe(200);
      expect((await whoami(session)).status).toBe(401);
    });
  });

  describe('seats', () => {
    afterEach(async () => {
      await Subscription.deleteMany({ company: acme._id });
      usageService.invalidateSubscription(acme._id);
      await User.deleteMany({ username: /^hard-seat/ });
    });

    test('registering an operator past the plan\'s seats is refused', async () => {
      const subscription = await Subscription.forCompany(acme._id);
      subscription.planId = 'basic'; // 1 seat; Dana, Dave and Olly already hold three
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .post('/api/auth/register')
        .set('x-auth-token', danaToken)
        .send({
          username: 'hard-seat-1', email: 'seat1@hardening.example', password: PASSWORD,
          role: 'operator', companyId: String(acme._id)
        });

      expect(response.status).toBe(402);
      expect(response.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(await User.findOne({ username: 'hard-seat-1' })).toBeNull();
    });

    test('reactivating an operator takes a seat too', async () => {
      const parked = await User.create({
        username: 'hard-seat-parked', email: 'parked@hardening.example',
        password: PASSWORD, role: 'operator', company: acme._id, isActive: false
      });

      const subscription = await Subscription.forCompany(acme._id);
      subscription.planId = 'basic';
      subscription.status = 'active';
      await subscription.save();
      usageService.invalidateSubscription(acme._id);

      const response = await request(app)
        .patch(`/api/admin/operators/${parked._id}`)
        .set('x-auth-token', danaToken)
        .send({ isActive: true });

      expect(response.status).toBe(402);
      expect((await User.findById(parked._id)).isActive).toBe(false);
    });
  });

  describe('the per-address login ceiling', () => {
    const limited = () => {
      const inner = express();
      inner.use(express.json());
      inner.post('/login', loginAddressLimiter, (req, res) => {
        if (req.body.password === 'right') {
          return res.json({ ok: true });
        }
        return res.status(401).json({ error: 'nope' });
      });
      return inner;
    };

    beforeEach(async () => {
      await RateLimitCounter.deleteMany({ _id: /^auth-ip:/ });
    });

    test('one address spraying one password across many accounts runs out of tries', async () => {
      const server = limited();

      // Fifty different usernames: the per-account limiter never sees more
      // than one failure for any of them.
      for (let i = 0; i < 50; i += 1) {
        const response = await request(server).post('/login').send({ username: `spray-${i}`, password: 'Winter2024!' });
        expect(response.status).toBe(401);
      }

      const blocked = await request(server).post('/login').send({ username: 'spray-51', password: 'Winter2024!' });
      expect(blocked.status).toBe(429);
    });

    test('does not count successful sign-ins', async () => {
      const server = limited();
      for (let i = 0; i < 55; i += 1) {
        expect((await request(server).post('/login').send({ username: `ok-${i}`, password: 'right' })).status).toBe(200);
      }
    });
  });

  describe('the password reset limiter', () => {
    beforeEach(async () => {
      await RateLimitCounter.deleteMany({ _id: /^pwreset:/ });
    });

    test('counts every request, since the endpoint never fails from outside', async () => {
      const inner = express();
      inner.use(express.json());
      inner.post('/forgot', passwordResetLimiter, (req, res) => res.json({ message: 'maybe' }));

      for (let i = 0; i < 5; i += 1) {
        expect((await request(inner).post('/forgot').send({ email: 'x@y.z' })).status).toBe(200);
      }
      expect((await request(inner).post('/forgot').send({ email: 'x@y.z' })).status).toBe(429);
    });
  });
});
