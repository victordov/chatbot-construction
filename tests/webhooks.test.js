/**
 * Outbound webhooks.
 *
 * Three things decide whether this is usable or merely present: a receiver can
 * prove a delivery is ours and not a replay, a failing endpoint is retried and
 * then given up on, and every attempt leaves evidence. The tests are mostly
 * about those, plus the thing that would be a security hole — a webhook is a
 * URL a tenant typed, and our server fetches it.
 */

const crypto = require('crypto');
const http = require('http');
const dns = require('dns');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Webhook = require('../models/webhook');
const WebhookDelivery = require('../models/webhook-delivery');
const webhooks = require('../services/webhooks');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/webhooks', require('../routes/webhooks'));
  return app;
};

describe('Webhooks', () => {
  let app;
  let acme;
  let rival;
  let dana;
  let rex;
  let alice;
  let danaToken;
  let rexToken;
  let aliceToken;

  let server;
  let base;
  let received;
  let respondWith;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    process.env.SECRETS_KEY = 'test-secrets-key-for-the-suite';
    secrets.resetForTests();

    acme = await Company.create({ name: 'Hook Acme' });
    rival = await Company.create({ name: 'Hook Rival' });

    dana = await User.create({
      username: 'hook-dana', email: 'dana@hook.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Dana Diaz', company: acme._id
    });
    rex = await User.create({
      username: 'hook-rex', email: 'rex@hook.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Rex Rivera', company: rival._id
    });
    alice = await User.create({
      username: 'hook-alice', email: 'alice@hook.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Alice Anderson', company: acme._id
    });

    danaToken = await login('hook-dana');
    rexToken = await login('hook-rex');
    aliceToken = await login('hook-alice');

    // A receiver on loopback, which the address guard exists to block — so the
    // guard is replaced here rather than weakened, the same way the workflow
    // action tests do it.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          received = {
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8')
          };
          const reply = respondWith || { status: 200, body: 'ok' };
          if (reply.hang) {
            return;
          }
          res.writeHead(reply.status);
          res.end(reply.body);
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

    await WebhookDelivery.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Webhook.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@hook\.example$/ });
    await Company.deleteMany({ name: /^Hook / });
  });

  beforeEach(async () => {
    await WebhookDelivery.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Webhook.deleteMany({ company: { $in: [acme._id, rival._id] } });
    respondWith = { status: 200, body: 'ok' };
    received = null;
  });

  /** An endpoint pointed at the test receiver. */
  const makeHook = async (overrides = {}) => {
    const secret = webhooks.generateSecret();
    const hook = await Webhook.create({
      company: acme._id,
      url: `${base}/hook`,
      events: ['conversation.ended'],
      secret: secrets.encrypt(secret),
      ...overrides
    });
    return { hook: hook.toObject(), secret };
  };

  const waitFor = async (check, timeout = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = await check();
      if (result) {
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  };

  describe('signing', () => {
    test('the signature covers the timestamp as well as the body', () => {
      // Signing the body alone lets anyone who captured one delivery replay it
      // forever. With the timestamp inside the signed material, a receiver
      // that rejects old timestamps is actually protected.
      const signature = webhooks.sign('{"a":1}', 'whsec_test', 1700000000);

      const expected = crypto
        .createHmac('sha256', 'whsec_test')
        .update('1700000000.{"a":1}')
        .digest('hex');

      expect(signature).toBe(`t=1700000000,v1=${expected}`);
    });

    test('a changed timestamp invalidates the signature', () => {
      const original = webhooks.sign('{"a":1}', 'whsec_test', 1700000000);
      const shifted = webhooks.sign('{"a":1}', 'whsec_test', 1700000001);

      expect(original).not.toBe(shifted);
    });

    test('a changed body invalidates the signature', () => {
      expect(webhooks.sign('{"a":1}', 'whsec_test', 1700000000))
        .not.toBe(webhooks.sign('{"a":2}', 'whsec_test', 1700000000));
    });

    test('a receiver can verify a real delivery', async () => {
      const { hook, secret } = await makeHook();
      await webhooks.attempt(hook, await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: { sessionId: 'abc' }, status: 'pending'
      }));

      const header = received.headers['x-webhook-signature'];
      const [timePart, signaturePart] = header.split(',');
      const timestamp = timePart.replace('t=', '');
      const signature = signaturePart.replace('v1=', '');

      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${received.body}`)
        .digest('hex');

      expect(signature).toBe(expected);
    });

    test('an unsigned delivery has no signature header at all', async () => {
      // Absent rather than empty, so a receiver cannot mistake an unsigned
      // delivery for a verified one.
      const hook = (await Webhook.create({
        company: acme._id, url: `${base}/hook`, events: ['conversation.ended']
      })).toObject();

      await webhooks.attempt(hook, await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      }));

      expect(received.headers['x-webhook-signature']).toBeUndefined();
    });

    test('generated secrets are distinct and obviously secrets', () => {
      const first = webhooks.generateSecret();
      expect(first).toMatch(/^whsec_[a-f0-9]{48}$/);
      expect(first).not.toBe(webhooks.generateSecret());
    });
  });

  describe('delivering', () => {
    test('a subscribed endpoint receives the event', async () => {
      await makeHook();
      await webhooks.dispatch(acme._id, 'conversation.ended', { sessionId: 'abc' });

      const delivered = await waitFor(async () =>
        (await WebhookDelivery.findOne({ company: acme._id }))?.status === 'delivered');

      expect(delivered).toBe(true);
      expect(JSON.parse(received.body)).toMatchObject({
        event: 'conversation.ended',
        data: { sessionId: 'abc' }
      });
      expect(received.headers['x-webhook-event']).toBe('conversation.ended');
    });

    test('an endpoint not subscribed to the event gets nothing', async () => {
      await makeHook({ events: ['contact.created'] });
      const deliveries = await webhooks.dispatch(acme._id, 'conversation.ended', {});

      expect(deliveries).toHaveLength(0);
    });

    test('a disabled endpoint gets nothing', async () => {
      await makeHook({ enabled: false });
      expect(await webhooks.dispatch(acme._id, 'conversation.ended', {})).toHaveLength(0);
    });

    test('another company\'s endpoint never receives our events', async () => {
      await Webhook.create({
        company: rival._id, url: `${base}/hook`, events: ['conversation.ended']
      });

      const deliveries = await webhooks.dispatch(acme._id, 'conversation.ended', {});
      expect(deliveries).toHaveLength(0);
    });

    test('an unknown event is refused rather than sent to everyone', async () => {
      await makeHook();
      expect(await webhooks.dispatch(acme._id, 'not.an.event', {})).toHaveLength(0);
    });

    test('dispatch never throws, whatever happens', async () => {
      // A conversation must not fail because a tenant's endpoint is unhappy.
      await expect(webhooks.dispatch(null, 'conversation.ended', {})).resolves.toEqual([]);
    });
  });

  describe('retrying', () => {
    test('a 500 is retried with a delay', async () => {
      respondWith = { status: 500, body: 'boom' };
      const { hook } = await makeHook();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      });
      await webhooks.attempt(hook, delivery);

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.status).toBe('pending');
      expect(stored.attempts).toBe(1);
      expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(stored.responseStatus).toBe(500);
    });

    test('a 400 is not retried, because retrying will not fix it', async () => {
      respondWith = { status: 400, body: 'bad request' };
      const { hook } = await makeHook();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      });
      await webhooks.attempt(hook, delivery);

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.status).toBe('failed');
      expect(stored.nextAttemptAt).toBeNull();
    });

    test('a 429 is retried, because it means try later', async () => {
      respondWith = { status: 429, body: 'slow down' };
      const { hook } = await makeHook();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      });
      await webhooks.attempt(hook, delivery);

      expect((await WebhookDelivery.findById(delivery._id)).status).toBe('pending');
    });

    test('it gives up after the attempt limit', async () => {
      respondWith = { status: 500, body: 'boom' };
      const { hook } = await makeHook();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending', attempts: webhooks.MAX_ATTEMPTS - 1
      });
      await webhooks.attempt(hook, delivery);

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(webhooks.MAX_ATTEMPTS);
    });

    test('the sweep picks up what is due and skips what is not', async () => {
      const { hook } = await makeHook();

      const due = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: { which: 'due' }, status: 'pending',
        nextAttemptAt: new Date(Date.now() - 1000)
      });
      const later = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: { which: 'later' }, status: 'pending',
        nextAttemptAt: new Date(Date.now() + 60000)
      });

      const result = await webhooks.processPending();

      expect(result.attempted).toBe(1);
      expect((await WebhookDelivery.findById(due._id)).status).toBe('delivered');
      expect((await WebhookDelivery.findById(later._id)).status).toBe('pending');
    });

    test('a delivery whose endpoint was deleted is failed, not retried forever', async () => {
      const { hook } = await makeHook();
      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending', nextAttemptAt: new Date(Date.now() - 1000)
      });

      await Webhook.deleteOne({ _id: hook._id });
      await webhooks.processPending();

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.status).toBe('failed');
      expect(stored.error).toMatch(/deleted/);
    });

    test('retries survive a restart, because they are rows and not timers', async () => {
      // The property that matters: a deploy is exactly when endpoints are most
      // likely to be failing, and in-memory retries would be lost then.
      respondWith = { status: 500, body: 'boom' };
      const { hook } = await makeHook();

      await webhooks.dispatch(acme._id, 'conversation.ended', {});
      await waitFor(async () => (await WebhookDelivery.findOne({ company: acme._id }))?.attempts >= 1);

      const stored = await WebhookDelivery.findOne({ company: acme._id });
      expect(stored.status).toBe('pending');
      expect(stored.nextAttemptAt).toBeInstanceOf(Date);
    });
  });

  describe('giving up on a dead endpoint', () => {
    test('sustained failure switches it off with a reason', async () => {
      respondWith = { status: 500, body: 'boom' };
      const { hook } = await makeHook({
        consecutiveFailures: webhooks.FAILURES_BEFORE_DISABLE - 1
      });

      await webhooks.attempt(hook, await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      }));

      const stored = await Webhook.findById(hook._id);
      expect(stored.enabled).toBe(false);
      expect(stored.disabledReason).toMatch(/in a row/);
    });

    test('a success clears the failure count', async () => {
      const { hook } = await makeHook({ consecutiveFailures: 5 });

      await webhooks.attempt(hook, await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      }));

      const stored = await Webhook.findById(hook._id);
      expect(stored.consecutiveFailures).toBe(0);
      expect(stored.lastSuccessAt).toBeInstanceOf(Date);
    });
  });

  describe('where an endpoint may point', () => {
    test.each([
      ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
      ['https://127.0.0.1/hook', 'loopback'],
      ['https://192.168.1.10/hook', 'a private address'],
      ['file:///etc/passwd', 'a file URL'],
      ['not-a-url', 'nonsense']
    ])('%s is refused (%s)', async url => {
      // A webhook is a URL a tenant typed and our server fetches. Without this
      // it is an SSRF hole with a friendlier name.
      const response = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url, events: ['conversation.ended'] });

      expect(response.status).toBe(400);
    });

    test('a URL that became invalid fails without retrying', async () => {
      // Not retryable: it will be just as blocked in an hour.
      const hook = (await Webhook.create({
        company: acme._id, url: 'https://169.254.169.254/hook', events: ['conversation.ended']
      })).toObject();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      });
      await webhooks.attempt(hook, delivery);

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.status).toBe('failed');
      expect(stored.nextAttemptAt).toBeNull();
    });
  });

  describe('managing endpoints', () => {
    test('the secret is returned exactly once, when it is created', async () => {
      const created = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url: 'https://example.com/hook', events: ['conversation.ended'] });

      expect(created.status).toBe(201);
      expect(created.body.secret).toMatch(/^whsec_/);

      const listed = await request(app).get('/api/webhooks').set('x-auth-token', danaToken);

      expect(listed.body.webhooks[0].hasSecret).toBe(true);
      expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    });

    test('the stored secret is encrypted at rest', async () => {
      const created = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url: 'https://example.com/hook', events: ['conversation.ended'] });

      const stored = await Webhook.findById(created.body.webhook._id).select('+secret');

      expect(stored.secret).not.toContain(created.body.secret);
      expect(secrets.decrypt(stored.secret)).toBe(created.body.secret);
    });

    test('an endpoint with no events is refused', async () => {
      const response = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url: 'https://example.com/hook', events: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/at least one event/);
    });

    test('an unknown event is refused, so a typo is not silence', async () => {
      const response = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url: 'https://example.com/hook', events: ['conversaton.ended'] });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Unknown event/);
    });

    test('rotating replaces the secret and says what that breaks', async () => {
      const created = await request(app)
        .post('/api/webhooks')
        .set('x-auth-token', danaToken)
        .send({ url: 'https://example.com/hook', events: ['conversation.ended'] });

      const rotated = await request(app)
        .post(`/api/webhooks/${created.body.webhook._id}/rotate-secret`)
        .set('x-auth-token', danaToken);

      expect(rotated.body.secret).not.toBe(created.body.secret);
      expect(rotated.body.secretNotice).toMatch(/no longer verify/);
    });

    test('re-enabling clears the failure history', async () => {
      // Otherwise an endpoint switched off automatically is switched off again
      // on its next failure, however long ago the previous nineteen were.
      const { hook } = await makeHook({
        enabled: false, consecutiveFailures: 20, disabledReason: 'dead'
      });

      const response = await request(app)
        .put(`/api/webhooks/${hook._id}`)
        .set('x-auth-token', danaToken)
        .send({ enabled: true });

      expect(response.body.webhook.consecutiveFailures).toBe(0);
      expect(response.body.webhook.disabledReason).toBeUndefined();
    });

    test('another company\'s endpoint is not reachable by id', async () => {
      const { hook } = await makeHook();

      const response = await request(app)
        .put(`/api/webhooks/${hook._id}`)
        .set('x-auth-token', rexToken)
        .send({ enabled: false });

      expect(response.status).toBe(404);
      expect(rex.company).not.toEqual(acme._id);
    });

    test('an operator cannot manage endpoints', async () => {
      const response = await request(app).get('/api/webhooks').set('x-auth-token', aliceToken);
      expect(response.status).toBe(403);
      expect(alice.role).toBe('operator');
    });

    test('deleting takes the delivery log with it', async () => {
      const { hook } = await makeHook();
      await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'delivered'
      });

      await request(app).delete(`/api/webhooks/${hook._id}`).set('x-auth-token', danaToken);

      expect(await WebhookDelivery.countDocuments({ webhook: hook._id })).toBe(0);
    });

    test('a test delivery is clearly marked as one', async () => {
      const { hook } = await makeHook();

      const response = await request(app)
        .post(`/api/webhooks/${hook._id}/test`)
        .set('x-auth-token', danaToken);

      expect(response.body.result.delivered).toBe(true);
      expect(JSON.parse(received.body).data.test).toBe(true);
    });
  });

  describe('the delivery log', () => {
    test('it records what was sent and what came back', async () => {
      respondWith = { status: 503, body: 'unavailable' };
      await makeHook();
      await webhooks.dispatch(acme._id, 'conversation.ended', { sessionId: 'abc' });

      await waitFor(async () => (await WebhookDelivery.findOne({ company: acme._id }))?.attempts >= 1);

      const response = await request(app)
        .get('/api/webhooks/deliveries')
        .set('x-auth-token', danaToken);

      expect(response.body.deliveries[0]).toMatchObject({
        event: 'conversation.ended',
        responseStatus: 503,
        payload: { sessionId: 'abc' }
      });
      expect(response.body.deliveries[0].responseBody).toBe('unavailable');
    });

    test('a huge response body is truncated rather than stored whole', async () => {
      respondWith = { status: 500, body: 'x'.repeat(50000) };
      const { hook } = await makeHook();

      const delivery = await WebhookDelivery.create({
        webhook: hook._id, company: acme._id, event: 'conversation.ended',
        payload: {}, status: 'pending'
      });
      await webhooks.attempt(hook, delivery);

      const stored = await WebhookDelivery.findById(delivery._id);
      expect(stored.responseBody.length).toBeLessThanOrEqual(2000);
    });

    test('another company\'s deliveries are not listed', async () => {
      await WebhookDelivery.create({
        webhook: new mongoose.Types.ObjectId(), company: rival._id,
        event: 'conversation.ended', payload: { secret: 'theirs' }, status: 'delivered'
      });

      const response = await request(app)
        .get('/api/webhooks/deliveries')
        .set('x-auth-token', danaToken);

      expect(JSON.stringify(response.body)).not.toContain('theirs');
    });

    test('the log has a retention window rather than growing forever', () => {
      expect(WebhookDelivery.RETENTION_DAYS).toBeGreaterThan(0);
    });
  });
});
