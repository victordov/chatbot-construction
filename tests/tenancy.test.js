/**
 * Multi-tenant isolation.
 *
 * These cover the invariants that were violated before: one company's staff
 * being able to read, delete or otherwise act on another company's data, and
 * plain operators being able to manage accounts.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/operations', require('../routes/operations'));
  app.use('/api/gdpr', require('../routes/gdpr'));
  return app;
};

describe('Multi-tenant isolation', () => {
  let app;
  let acme;
  let globex;
  let acmeAdminToken;
  let acmeOperatorToken;
  let globexAdminToken;
  let acmeConversation;

  const login = async (username) => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' });
    return response.body.token;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = buildApp();

    acme = await Company.create({ name: 'Acme Tenancy', allowedDomains: ['https://acme.test'] });
    globex = await Company.create({ name: 'Globex Tenancy', allowedDomains: ['https://globex.test'] });

    await User.create({
      username: 'acme-admin', email: 'acme-admin@test.example',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    await User.create({
      username: 'acme-operator', email: 'acme-op@test.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    await User.create({
      username: 'globex-admin', email: 'globex-admin@test.example',
      password: 'TestPassword123!', role: 'company_admin', company: globex._id
    });

    acmeConversation = await Conversation.create({
      sessionId: 'tenancy-acme-session',
      company: acme._id,
      domain: 'https://acme.test',
      messages: [{ content: 'Acme private message', sender: 'user' }]
    });

    acmeAdminToken = await login('acme-admin');
    acmeOperatorToken = await login('acme-operator');
    globexAdminToken = await login('globex-admin');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^tenancy-/ });
    await User.deleteMany({ email: /@test\.example$/ });
    await Company.deleteMany({ name: /Tenancy$/ });
  });

  describe('conversation access', () => {
    test('a company sees only its own conversations', async () => {
      const response = await request(app)
        .get('/api/admin/chat-history')
        .set('x-auth-token', globexAdminToken);

      expect(response.status).toBe(200);
      const sessionIds = response.body.history.map(c => c.sessionId);
      expect(sessionIds).not.toContain('tenancy-acme-session');
    });

    test('reading another company conversation by id returns 404, not the data', async () => {
      const response = await request(app)
        .get('/api/admin/chat/tenancy-acme-session')
        .set('x-auth-token', globexAdminToken);

      // 404 rather than 403: a 403 would confirm the session id exists.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Acme private message');
    });

    test('deleting another company conversation is refused and the data survives', async () => {
      const response = await request(app)
        .delete('/api/admin/chat/tenancy-acme-session')
        .set('x-auth-token', globexAdminToken);

      expect(response.status).toBe(404);
      expect(await Conversation.findById(acmeConversation._id)).not.toBeNull();
    });

    test('a company can read its own conversation', async () => {
      const response = await request(app)
        .get('/api/admin/chat/tenancy-acme-session')
        .set('x-auth-token', acmeAdminToken);

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe('tenancy-acme-session');
    });
  });

  describe('operator account management', () => {
    test('a plain operator cannot create accounts', async () => {
      const response = await request(app)
        .post('/api/admin/operators')
        .set('x-auth-token', acmeOperatorToken)
        .send({
          username: 'escalated', email: 'escalated@test.example',
          password: 'TestPassword123!', confirmPassword: 'TestPassword123!'
        });

      expect(response.status).toBe(403);
      expect(await User.findOne({ username: 'escalated' })).toBeNull();
    });

    test('a plain operator cannot reset a password', async () => {
      const target = await User.findOne({ username: 'acme-operator' });

      const response = await request(app)
        .post(`/api/admin/operators/${target._id}/reset-password`)
        .set('x-auth-token', acmeOperatorToken)
        .send({ password: 'NewPassword123!', confirmPassword: 'NewPassword123!' });

      expect(response.status).toBe(403);
    });

    test('an admin cannot reset a password for another company', async () => {
      const target = await User.findOne({ username: 'acme-operator' });

      const response = await request(app)
        .post(`/api/admin/operators/${target._id}/reset-password`)
        .set('x-auth-token', globexAdminToken)
        .send({ password: 'NewPassword123!', confirmPassword: 'NewPassword123!' });

      expect(response.status).toBe(403);

      // The original password must still work.
      expect(await login('acme-operator')).toBeTruthy();
    });

    test('an admin can reset a password within their own company', async () => {
      const target = await User.findOne({ username: 'acme-operator' });

      const response = await request(app)
        .post(`/api/admin/operators/${target._id}/reset-password`)
        .set('x-auth-token', acmeAdminToken)
        .send({ password: 'RotatedPassword123!', confirmPassword: 'RotatedPassword123!' });

      expect(response.status).toBe(200);
    });
  });

  describe('privileged operations', () => {
    test('a company admin cannot restore a backup', async () => {
      const response = await request(app)
        .post('/api/operations/backups/restore')
        .set('x-auth-token', acmeAdminToken)
        .send({ timestamp: '2020-01-01' });

      expect(response.status).toBe(403);
    });

    test('a plain operator cannot deploy a widget version', async () => {
      const response = await request(app)
        .post('/api/operations/widget/deploy')
        .set('x-auth-token', acmeOperatorToken)
        .send({ version: '1.0.0' });

      expect(response.status).toBe(403);
    });

    test('a plain operator cannot export another user\'s data', async () => {
      const response = await request(app)
        .get('/api/gdpr/user-data/someone')
        .set('x-auth-token', acmeOperatorToken);

      expect(response.status).toBe(403);
    });
  });

  describe('analytics', () => {
    test('analytics resolves for a company-scoped user', async () => {
      // This threw a ReferenceError for every non-superadmin because
      // routes/admin.js used mongoose without importing it.
      const response = await request(app)
        .get('/api/admin/analytics')
        .set('x-auth-token', acmeAdminToken);

      expect(response.status).toBe(200);
      expect(response.body.conversationMetrics).toBeDefined();
      expect(Array.isArray(response.body.topSources)).toBe(true);
    });

    test('counts only include the caller\'s own company', async () => {
      const response = await request(app)
        .get('/api/admin/analytics')
        .set('x-auth-token', globexAdminToken);

      expect(response.status).toBe(200);
      expect(response.body.totalChatsToday).toBe(0);
    });
  });

  describe('search input handling', () => {
    test('a regex metacharacter search is treated literally', async () => {
      // Unescaped, `.*` would match every conversation in the collection.
      const response = await request(app)
        .get('/api/admin/chat-history')
        .query({ search: '.*' })
        .set('x-auth-token', acmeAdminToken);

      expect(response.status).toBe(200);
      expect(response.body.history).toHaveLength(0);
    });
  });
});
