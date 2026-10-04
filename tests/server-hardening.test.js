/**
 * The two rules server.js enforces at the edge: who gets CORS credentials,
 * and who gets to read /metrics.
 *
 * Both are tested against a bare express app that mounts the exported
 * middleware, so the rules are exercised without a listening socket,
 * a session store, or production mode for the whole process.
 */

// Booting server.js binds a port and opens the database. A port nothing else
// is using, set before the config module reads it.
process.env.PORT = String(40000 + Math.floor(Math.random() * 20000));
process.env.METRICS_TOKEN = 'metrics-token-for-tests';

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const tenantService = require('../services/tenant');
const { server, corsPolicy, metricsGuard } = require('../server');

const corsApp = () => {
  const app = express();
  app.use(corsPolicy);
  app.get('/api/thing', (req, res) => res.json({ ok: true }));
  app.post('/api/thing', (req, res) => res.json({ ok: true }));
  return app;
};

const metricsApp = guard => {
  const app = express();
  app.get('/metrics', guard, (req, res) => res.send('# HELP up 1'));
  return app;
};

describe('server hardening', () => {
  let company;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({
      name: 'Hardening Widgets Ltd',
      allowedDomains: ['https://registered.example']
    });
    tenantService.invalidate();
  });

  afterAll(async () => {
    await Company.deleteMany({ name: 'Hardening Widgets Ltd' });
    tenantService.invalidate();
    await new Promise(resolve => server.close(resolve));
  });

  describe('CORS', () => {
    test('a registered origin is allowed and may send credentials', async () => {
      const response = await request(corsApp())
        .get('/api/thing')
        .set('Origin', 'https://registered.example');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://registered.example');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    test('an unregistered origin with a valid widget key is allowed, without credentials', async () => {
      // The key is in the page source of every site that embeds the widget.
      // It says which tenant the page belongs to; it says nothing about
      // whether the page should be trusted with a signed-in user's cookies.
      const response = await request(corsApp())
        .get('/api/thing')
        .query({ key: company.widgetKey })
        .set('Origin', 'https://some-blog.example');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://some-blog.example');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    test('the preflight for a key-only origin does not offer credentials either', async () => {
      const response = await request(corsApp())
        .options('/api/thing')
        .query({ key: company.widgetKey })
        .set('Origin', 'https://some-blog.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    test('an unregistered origin with a made-up key is refused', async () => {
      const response = await request(corsApp())
        .get('/api/thing')
        .query({ key: 'wk_not_a_real_key' })
        .set('Origin', 'https://some-blog.example');

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('a key that is not a string does not open the door', async () => {
      const response = await request(corsApp())
        .get('/api/thing?key[$gt]=')
        .set('Origin', 'https://some-blog.example');

      expect(response.status).toBe(403);
    });
  });

  describe('/metrics', () => {
    test('with a token configured, refuses a scrape that does not present it', async () => {
      const app = metricsApp(metricsGuard({ token: 'secret-scrape-token', isProduction: false }));

      expect((await request(app).get('/metrics')).status).toBe(401);
      expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong')).status).toBe(401);
      expect((await request(app).get('/metrics').set('Authorization', 'Bearer secret-scrape-tokenX')).status).toBe(401);
    });

    test('with a token configured, serves a scrape that presents it', async () => {
      const app = metricsApp(metricsGuard({ token: 'secret-scrape-token', isProduction: true }));

      const response = await request(app).get('/metrics').set('Authorization', 'Bearer secret-scrape-token');
      expect(response.status).toBe(200);
      expect(response.text).toContain('# HELP');
    });

    test('in production without a token, the endpoint does not exist', async () => {
      const app = metricsApp(metricsGuard({ token: null, isProduction: true }));

      expect((await request(app).get('/metrics')).status).toBe(404);
    });

    test('in development without a token, the endpoint is open', async () => {
      const app = metricsApp(metricsGuard({ token: null, isProduction: false }));

      expect((await request(app).get('/metrics')).status).toBe(200);
    });

    test('the running app mounts the guard in front of the real endpoint', async () => {
      const { app } = require('../server');

      expect((await request(app).get('/metrics')).status).toBe(401);
      const response = await request(app).get('/metrics').set('Authorization', 'Bearer metrics-token-for-tests');
      expect(response.status).toBe(200);
      expect(response.text).toContain('http_request_duration');
    });

    test('/health and /ready stay public', async () => {
      const { app } = require('../server');

      expect((await request(app).get('/health')).status).toBe(200);
      expect([200, 503]).toContain((await request(app).get('/ready')).status);
    });
  });
});
