/**
 * Self-serve sign-up, confirming the address, and the ways into and out of
 * an account: email or username, Google, a pending invitation, a company
 * that has been switched off.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');

const User = require('../models/user');
const Company = require('../models/company');
const Subscription = require('../models/subscription');
const AuditLog = require('../models/audit-log');
const RateLimitCounter = require('../models/rate-limit-counter');
const AlertService = require('../services/alerting');
const welcomeCrawl = require('../services/welcome-crawl');

const PASSWORD = 'TestPassword123!';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/companies', require('../routes/company'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
};

describe('Sign-up and sign-in', () => {
  let app;
  let sendMail;
  let crawlStart;

  const signup = (body = {}) => request(app).post('/api/auth/signup').send({
    email: `owner-${Math.random().toString(36).slice(2, 8)}@signup.example`,
    password: PASSWORD,
    companyName: 'Signup Bloom Dental',
    ...body
  });

  const login = (username, password = PASSWORD) => request(app)
    .post('/api/auth/login')
    .send({ username, password });

  /** The link in the last confirmation email sent. */
  const lastLink = () => {
    const mail = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
    return mail.text.match(/\/api\/auth\/verify-email\?token=([a-f0-9]+)/);
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
  });

  beforeEach(async () => {
    sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(AlertService, 'createSmtpTransport').mockReturnValue({ sendMail });
    crawlStart = jest.spyOn(welcomeCrawl, 'start').mockResolvedValue({ pages: 0 });
    await RateLimitCounter.deleteMany({ _id: /^(signup|acct-link|verify-resend):/ });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SIGNUP_ENABLED;
  });

  afterAll(async () => {
    const companies = await Company.find({ name: /^Signup / }).select('_id').lean();
    const ids = companies.map(company => company._id);
    await Promise.all([
      User.deleteMany({ email: /@signup\.example$/ }),
      Subscription.deleteMany({ company: { $in: ids } }),
      AuditLog.deleteMany({ company: { $in: ids } }),
      Company.deleteMany({ _id: { $in: ids } })
    ]);
  });

  describe('starting a trial', () => {
    test('creates the company, its admin and a trial, and signs them in', async () => {
      const response = await signup({ email: 'Dana@Signup.example', website: 'bloomdental.example', name: 'Dana' });

      expect(response.status).toBe(201);
      expect(response.body.token).toBeTruthy();
      expect(response.body.user).toMatchObject({
        email: 'dana@signup.example',
        role: 'company_admin',
        displayName: 'Dana',
        emailVerified: false,
        verificationRequired: true
      });

      const user = await User.findOne({ email: 'dana@signup.example' }).select('+emailVerifyTokenHash');
      expect(user.username).toBe('dana');
      expect(user.emailVerifyTokenHash).toBeTruthy();

      const company = await Company.findById(user.company);
      expect(company.createdVia).toBe('signup');
      expect(company.website).toBe('https://bloomdental.example/');

      // The trial clock starts now, not whenever the plan is first read.
      const subscription = await Subscription.findOne({ company: company._id });
      expect(subscription.status).toBe('trialing');
      expect(subscription.trialEndsAt.getTime()).toBeGreaterThan(Date.now());

      // Signed straight in: the token works.
      const verify = await request(app).get('/api/auth/verify').set('x-auth-token', response.body.token);
      expect(verify.status).toBe(200);
      expect(verify.body.user.company.createdVia).toBe('signup');

      // The address is confirmed by email, and the website read in the background.
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0].to).toBe('dana@signup.example');
      expect(lastLink()).not.toBeNull();
      expect(crawlStart).toHaveBeenCalledWith(company._id, 'https://bloomdental.example/');

      const entry = await AuditLog.findOne({ action: 'company.signed_up', company: company._id });
      expect(entry).not.toBeNull();
    });

    test('without a website, nothing is crawled', async () => {
      const response = await signup({ companyName: 'Signup No Site' });
      expect(response.status).toBe(201);
      expect(response.body.crawling).toBe(false);
      expect(crawlStart).not.toHaveBeenCalled();
    });

    test('an address that already has an account is refused, and leaves nothing behind', async () => {
      await signup({ email: 'taken@signup.example', companyName: 'Signup Taken One' });
      const before = await Company.countDocuments({ name: /^Signup / });

      const response = await signup({ email: 'TAKEN@signup.example', companyName: 'Signup Taken Two' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('EMAIL_TAKEN');
      expect(await Company.countDocuments({ name: /^Signup / })).toBe(before);
    });

    test('a company name somebody already has becomes "<name> 2", without saying whose it is', async () => {
      await signup({ companyName: 'Signup Twin Co' });
      const second = await signup({ companyName: 'Signup Twin Co' });

      expect(second.status).toBe(201);
      expect(second.body.user.company.name).toBe('Signup Twin Co 2');
    });

    test.each([
      [{ email: 'not-an-address' }, /valid email/],
      [{ password: 'short' }, /8 characters/],
      [{ companyName: 'x' }, /company/],
      [{ website: 'not a website' }, /website/]
    ])('refuses %j', async (body, message) => {
      const response = await signup(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(message);
    });

    test('can be switched off', async () => {
      process.env.SIGNUP_ENABLED = 'false';
      const response = await signup({ companyName: 'Signup Closed' });
      expect(response.status).toBe(404);
      expect(await Company.exists({ name: 'Signup Closed' })).toBeNull();

      const config = await request(app).get('/api/auth/config');
      expect(config.body.signupEnabled).toBe(false);
    });

    test('says when SMTP is missing, and still signs them up', async () => {
      AlertService.createSmtpTransport.mockReturnValue(null);
      const response = await signup({ companyName: 'Signup No Mail' });
      expect(response.status).toBe(201);
      expect(response.body.verificationEmailSent).toBe(false);
    });
  });

  describe('confirming the address', () => {
    test('the emailed link confirms it once, and goes to the dashboard', async () => {
      const response = await signup({ companyName: 'Signup Verify Co' });
      const token = lastLink()[1];

      const first = await request(app).get(`/api/auth/verify-email?token=${token}`);
      expect(first.status).toBe(302);
      expect(first.headers.location).toBe('/admin/?verified=ok');

      const user = await User.findById(response.body.user.id);
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);

      const again = await request(app).get(`/api/auth/verify-email?token=${token}&format=json`);
      expect(again.status).toBe(400);
      expect(again.body.verified).toBe(false);

      const verify = await request(app).get('/api/auth/verify').set('x-auth-token', response.body.token);
      expect(verify.body.user.verificationRequired).toBe(false);
    });

    test('resending makes a new link and retires the old one', async () => {
      const response = await signup({ companyName: 'Signup Resend Co' });
      const oldToken = lastLink()[1];

      const resend = await request(app)
        .post('/api/auth/resend-verification')
        .set('x-auth-token', response.body.token);
      expect(resend.status).toBe(200);
      expect(resend.body.sent).toBe(true);
      const newToken = lastLink()[1];
      expect(newToken).not.toBe(oldToken);

      expect((await request(app).get(`/api/auth/verify-email?token=${oldToken}&format=json`)).status).toBe(400);
      expect((await request(app).get(`/api/auth/verify-email?token=${newToken}&format=json`)).status).toBe(200);

      const done = await request(app).post('/api/auth/resend-verification').set('x-auth-token', response.body.token);
      expect(done.status).toBe(409);
    });

    test('websites cannot be added to the widget until it is confirmed', async () => {
      const response = await signup({ companyName: 'Signup Domains Co' });
      const put = () => request(app)
        .put('/api/companies/me/widget')
        .set('x-auth-token', response.body.token)
        .send({ allowedDomains: ['https://bloom.example'] });

      const refused = await put();
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');

      // Other widget settings are still editable meanwhile.
      const colour = await request(app)
        .put('/api/companies/me/widget')
        .set('x-auth-token', response.body.token)
        .send({ widgetSettings: { primaryColor: '#123456' } });
      expect(colour.status).toBe(200);

      await request(app).get(`/api/auth/verify-email?token=${lastLink()[1]}`);
      const allowed = await put();
      expect(allowed.status).toBe(200);
      expect(allowed.body.allowedDomains).toEqual(['https://bloom.example']);
    });
  });

  describe('signing in', () => {
    beforeAll(async () => {
      await User.create({
        username: 'signin-sam', email: 'sam@signup.example', password: PASSWORD,
        role: 'superadmin', displayName: 'Sam'
      });
    });

    test('with the email address as well as the username', async () => {
      expect((await login('signin-sam')).status).toBe(200);
      expect((await login('SAM@signup.example')).status).toBe(200);
      expect((await login('sam@signup.example', 'wrong-password')).status).toBe(401);
    });

    test('a reset link says how long a superadmin\'s password must be', async () => {
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ username: 'signin-sam' }, {
        $set: {
          passwordResetTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          passwordResetExpires: new Date(Date.now() + 60000)
        }
      });

      const info = await request(app).get(`/api/auth/reset-info?token=${token}`);
      expect(info.status).toBe(200);
      expect(info.body).toEqual({ valid: true, minLength: 12 });

      const bad = await request(app).get('/api/auth/reset-info?token=nope');
      expect(bad.status).toBe(400);
    });

    test('the product\'s name comes from PRODUCT_NAME', async () => {
      process.env.PRODUCT_NAME = 'Bloom Help';
      try {
        const config = await request(app).get('/api/auth/config');
        expect(config.body.productName).toBe('Bloom Help');
      } finally {
        delete process.env.PRODUCT_NAME;
      }
      expect((await request(app).get('/api/auth/config')).body.productName).toBe('Support Desk');
    });

    test('a person changes their own name and timezone', async () => {
      const token = (await login('signin-sam')).body.token;

      const saved = await request(app).put('/api/auth/me').set('x-auth-token', token)
        .send({ displayName: 'Samantha', timezone: 'Europe/Bucharest' });
      expect(saved.status).toBe(200);
      expect(saved.body.user).toMatchObject({ displayName: 'Samantha', timezone: 'Europe/Bucharest' });

      const bad = await request(app).put('/api/auth/me').set('x-auth-token', token).send({ timezone: 'Mars/Olympus' });
      expect(bad.status).toBe(400);

      const empty = await request(app).put('/api/auth/me').set('x-auth-token', token).send({ displayName: '  ' });
      expect(empty.status).toBe(400);
    });
  });

  describe('a switched-off company', () => {
    let company;
    let token;

    beforeAll(async () => {
      company = await Company.create({ name: 'Signup Lockout Co' });
      await User.create({
        username: 'lockout-ola', email: 'ola@signup.example', password: PASSWORD,
        role: 'operator', company: company._id
      });
    });

    test('refuses sign-in, and every token its people already hold, saying why', async () => {
      token = (await login('lockout-ola')).body.token;
      expect((await request(app).get('/api/admin/chat-history').set('x-auth-token', token)).status).toBe(200);

      await Company.updateOne({ _id: company._id }, { $set: { isActive: false } });

      const call = await request(app).get('/api/admin/chat-history').set('x-auth-token', token);
      expect(call.status).toBe(401);
      expect(call.headers['x-auth-reason']).toBe('company_inactive');
      expect(call.body.code).toBe('COMPANY_DEACTIVATED');

      const verify = await request(app).get('/api/auth/verify').set('x-auth-token', token);
      expect(verify.status).toBe(401);
      expect(verify.headers['x-auth-reason']).toBe('company_inactive');

      const again = await login('lockout-ola');
      expect(again.status).toBe(403);
      expect(again.body.code).toBe('COMPANY_DEACTIVATED');
    });

    test('lets them back in when it is switched on again', async () => {
      await Company.updateOne({ _id: company._id }, { $set: { isActive: true } });
      expect((await request(app).get('/api/admin/chat-history').set('x-auth-token', token)).status).toBe(200);
    });

    test('caches the status briefly for the socket layer, and forgets it on request', async () => {
      const { companyActive, forgetCompanyStatus } = require('../middleware/auth');
      expect(await companyActive(company._id)).toBe(true);

      await Company.updateOne({ _id: company._id }, { $set: { isActive: false } });
      expect(await companyActive(company._id)).toBe(true);

      forgetCompanyStatus(company._id);
      expect(await companyActive(company._id)).toBe(false);

      await Company.updateOne({ _id: company._id }, { $set: { isActive: true } });
      forgetCompanyStatus(company._id);
    });
  });

  describe('Google sign-in', () => {
    beforeAll(async () => {
      await User.create({
        username: 'google-gina', email: 'gina@signup.example', password: PASSWORD,
        role: 'superadmin', displayName: 'Gina'
      });
    });

    afterEach(() => {
      delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
      delete process.env.GOOGLE_SIGNIN_CLIENT_SECRET;
    });

    const configure = () => {
      process.env.GOOGLE_SIGNIN_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
      process.env.GOOGLE_SIGNIN_CLIENT_SECRET = 'test-google-secret';
    };

    /** Start the flow, returning the signed state and this browser's cookie. */
    const start = async () => {
      const response = await request(app).get('/api/auth/google/start?next=/admin/%3Fsection%3Dtasks');
      expect(response.status).toBe(302);
      const location = new URL(response.headers.location);
      expect(location.hostname).toBe('accounts.google.com');
      return { state: location.searchParams.get('state'), cookie: response.headers['set-cookie'][0].split(';')[0] };
    };

    const googleSays = email => {
      jest.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({ tokens: { id_token: 'id' } });
      jest.spyOn(google.auth.OAuth2.prototype, 'verifyIdToken').mockResolvedValue({
        getPayload: () => ({ email, email_verified: true })
      });
    };

    test('is not offered until it is configured', async () => {
      expect((await request(app).get('/api/auth/google/start')).status).toBe(404);
      expect((await request(app).get('/api/auth/config')).body.googleSignIn).toBe(false);
    });

    test('signs in an existing account with that address, and returns to where they were', async () => {
      configure();
      googleSays('GINA@signup.example');
      const { state, cookie } = await start();

      const callback = await request(app)
        .get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`)
        .set('Cookie', cookie);

      expect(callback.status).toBe(302);
      const [path, fragment] = callback.headers.location.split('#');
      expect(path).toBe(`/admin/login.html?next=${encodeURIComponent('/admin/?section=tasks')}`);
      const token = fragment.replace(/^token=/, '');
      expect((await request(app).get('/api/auth/verify').set('x-auth-token', token)).body.user.email)
        .toBe('gina@signup.example');
    });

    test('creates nobody: an unknown address goes back to sign-in with a reason', async () => {
      configure();
      googleSays('stranger@signup.example');
      const { state, cookie } = await start();

      const callback = await request(app)
        .get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`)
        .set('Cookie', cookie);

      expect(callback.headers.location).toBe('/admin/login.html?google=no_account');
      expect(await User.exists({ email: 'stranger@signup.example' })).toBeNull();
    });

    test('refuses a callback started in another browser', async () => {
      configure();
      googleSays('gina@signup.example');
      const { state } = await start();

      const callback = await request(app).get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(callback.headers.location).toBe('/admin/login.html?google=expired');
    });
  });
});
