/**
 * Rate limiting.
 *
 * The old suite asserted that a single request through a limiter returned 200,
 * which is true of no rate limiter at all. These cover the two properties the
 * limiters actually have to have: a limit that blocks, and a count that is
 * shared between processes rather than per process.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const RateLimitCounter = require('../models/rate-limit-counter');
const MongoRateLimitStore = require('../services/rate-limit-store');
const { buildLimiter, tenantKey, addressKey, authLimiter } = require('../middleware/rateLimiter');
const Company = require('../models/company');
const Subscription = require('../models/subscription');

const secret = process.env.JWT_SECRET;

/** A limiter with its own prefix, so suites cannot collide. */
const limiterApp = (options) => {
  const app = express();
  app.use(express.json());
  app.get('/thing', buildLimiter(options), (req, res) => res.send('ok'));
  app.post('/thing', buildLimiter(options), (req, res) => res.send('ok'));
  return app;
};

const tokenFor = (userId, companyId, role = 'company_admin') =>
  jwt.sign({ id: String(userId), username: 'someone', role, company: companyId ? String(companyId) : null }, secret);

describe('Rate limiting', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
  });

  afterEach(async () => {
    await RateLimitCounter.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('the limit', () => {
    it('blocks once the allowance is spent, and says so as JSON', async () => {
      const app = limiterApp({ prefix: 'test-block', windowMs: 60000, limit: 3, message: 'Slow down.' });

      for (let i = 0; i < 3; i += 1) {
        expect((await request(app).get('/thing')).statusCode).toBe(200);
      }

      const blocked = await request(app).get('/thing');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.body).toEqual({ error: 'Slow down.' });
    });

    it('reports the allowance in RateLimit headers', async () => {
      const app = limiterApp({ prefix: 'test-headers', windowMs: 60000, limit: 5, message: 'no' });

      const response = await request(app).get('/thing');
      expect(response.headers['ratelimit-limit']).toBe('5');
      expect(response.headers['ratelimit-remaining']).toBe('4');
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });

  describe('the store', () => {
    it('is shared, so a second process continues one count rather than starting another', async () => {
      const options = { prefix: 'test-shared', windowMs: 60000, limit: 3, message: 'no' };

      // Two apps, each with their own limiter and store instance: the shape a
      // second replica has. In-memory counting would give each of them three.
      const instanceA = limiterApp(options);
      const instanceB = limiterApp(options);

      expect((await request(instanceA).get('/thing')).statusCode).toBe(200);
      expect((await request(instanceB).get('/thing')).statusCode).toBe(200);
      expect((await request(instanceA).get('/thing')).statusCode).toBe(200);

      expect((await request(instanceB).get('/thing')).statusCode).toBe(429);
    });

    it('counts each limiter separately, so chat traffic cannot exhaust the login allowance', async () => {
      const one = limiterApp({ prefix: 'test-a', windowMs: 60000, limit: 1, message: 'no' });
      const two = limiterApp({ prefix: 'test-b', windowMs: 60000, limit: 1, message: 'no' });

      expect((await request(one).get('/thing')).statusCode).toBe(200);
      expect((await request(one).get('/thing')).statusCode).toBe(429);
      expect((await request(two).get('/thing')).statusCode).toBe(200);
    });

    it('starts a new window rather than carrying the old count forward', async () => {
      const store = new MongoRateLimitStore({ prefix: 'test-window', windowMs: 1000 });

      const first = await store.increment('someone');
      expect(first.totalHits).toBe(1);

      // Rather than waiting out a window, ask for the count as the next window
      // sees it: the bucket is part of the document id.
      const realNow = Date.now;
      Date.now = () => realNow() + 1500;
      try {
        const next = await store.increment('someone');
        expect(next.totalHits).toBe(1);
      } finally {
        Date.now = realNow;
      }
    });

    it('keeps counting in memory when MongoDB is unreachable, rather than failing the request', async () => {
      const store = new MongoRateLimitStore({
        prefix: 'test-degraded',
        windowMs: 60000,
        isConnected: () => false
      });

      expect((await store.increment('k')).totalHits).toBe(1);
      expect((await store.increment('k')).totalHits).toBe(2);

      // Nothing was written, so the shared count is untouched.
      expect(await RateLimitCounter.countDocuments({ _id: /^test-degraded:/ })).toBe(0);
    });
  });

  describe('the key', () => {
    it('is the tenant and user for a signed request, not the address', () => {
      const key = tenantKey({
        headers: { 'x-auth-token': tokenFor('user1', 'company1') },
        ip: '203.0.113.5'
      });

      expect(key).toBe('c:company1:u:user1');
    });

    it('ignores a token that is not signed by us, so a bucket cannot be invented', () => {
      const forged = jwt.sign({ id: 'user1', company: 'company1' }, 'not-our-secret');
      const key = tenantKey({ headers: { 'x-auth-token': forged }, ip: '203.0.113.5' });

      expect(key).toBe('t:anon:ip:203.0.113.5');
    });

    it('separates tenants behind one address, but keeps the address in the key', () => {
      const acme = tenantKey({ headers: { 'x-widget-key': 'wk_acme' }, ip: '198.51.100.7', query: {} });
      const globex = tenantKey({ headers: { 'x-widget-key': 'wk_globex' }, ip: '198.51.100.7', query: {} });

      expect(acme).not.toBe(globex);
      // A widget key is public, so it must never be the whole key: anyone
      // could otherwise mint a fresh bucket per request.
      expect(acme).toContain('198.51.100.7');
    });

    it('gives two signed-in colleagues behind one office address their own allowance', () => {
      const address = '198.51.100.7';
      const bea = tenantKey({ headers: { 'x-auth-token': tokenFor('bea', 'acme') }, ip: address });
      const sam = tenantKey({ headers: { 'x-auth-token': tokenFor('sam', 'acme') }, ip: address });

      expect(bea).not.toBe(sam);
    });

    it('collapses IPv6 to a /64, which is what one host is given', () => {
      const first = addressKey({ ip: '2001:db8:1234:5678:1:2:3:4' });
      const second = addressKey({ ip: '2001:db8:1234:5678:9:9:9:9' });

      expect(first).toBe(second);
      expect(addressKey({ ip: '2001:db8:1234:9999::1' })).not.toBe(first);
    });

    it('reads the address through Express, so a proxied client is not one bucket', () => {
      expect(addressKey({ ip: '::ffff:203.0.113.9' })).toBe('203.0.113.9');
    });
  });

  describe('the plan', () => {
    let company;

    beforeAll(async () => {
      company = await Company.create({ name: `Rate Ltd ${Date.now()}` });
    });

    afterAll(async () => {
      await Subscription.deleteMany({ company: company._id });
      await Company.deleteOne({ _id: company._id });
    });

    it('gives a paying tenant more than the anonymous allowance', async () => {
      await Subscription.findOneAndUpdate(
        { company: company._id },
        { planId: 'professional', status: 'active' },
        { upsert: true, new: true }
      );

      const { apiLimiter } = require('../middleware/rateLimiter');
      const app = express();
      app.use(express.json());
      app.get('/api/thing', apiLimiter, (req, res) => res.send('ok'));

      const token = tokenFor(new mongoose.Types.ObjectId(), company._id);
      const response = await request(app).get('/api/thing').set('x-auth-token', token);

      // professional is 600/minute; the anonymous default is 100.
      expect(response.statusCode).toBe(200);
      expect(response.headers['ratelimit-limit']).toBe('600');
    });

    it('does not throttle a superadmin, who may be fixing the incident', async () => {
      const app = express();
      const limiter = buildLimiter({ prefix: 'test-super', windowMs: 60000, limit: 1, message: 'no' });
      app.get('/api/thing', limiter, (req, res) => res.send('ok'));

      const token = tokenFor(new mongoose.Types.ObjectId(), null, 'superadmin');

      for (let i = 0; i < 5; i += 1) {
        const response = await request(app).get('/api/thing').set('x-auth-token', token);
        expect(response.statusCode).toBe(200);
        // Skipped outright rather than counted, so there is nothing to report.
        expect(response.headers['ratelimit-limit']).toBeUndefined();
      }
    });
  });

  describe('login', () => {
    const app = () => {
      const inner = express();
      inner.use(express.json());
      inner.post('/login', authLimiter, (req, res) => {
        if (req.body.password === 'right') {
          return res.json({ ok: true });
        }
        return res.status(401).json({ error: 'nope' });
      });
      return inner;
    };

    it('counts failures per account, so one address cannot spray many accounts unseen', async () => {
      const server = app();

      for (let i = 0; i < 10; i += 1) {
        expect((await request(server).post('/login').send({ username: 'bea', password: 'wrong' })).statusCode).toBe(401);
      }

      const blocked = await request(server).post('/login').send({ username: 'bea', password: 'wrong' });
      expect(blocked.statusCode).toBe(429);

      // A different account from the same address still has its own allowance.
      const other = await request(server).post('/login').send({ username: 'sam', password: 'wrong' });
      expect(other.statusCode).toBe(401);
    });

    it('does not count a successful sign-in against somebody', async () => {
      const server = app();

      for (let i = 0; i < 15; i += 1) {
        const response = await request(server).post('/login').send({ username: 'ok-user', password: 'right' });
        expect(response.statusCode).toBe(200);
      }
    });
  });
});
