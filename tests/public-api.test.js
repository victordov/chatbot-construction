/**
 * The public read API.
 *
 * A tenant could be told what happened by webhooks but could not pull their
 * own data — for a backfill, or into a warehouse. This covers the pulling, and
 * mostly covers the ways it could go wrong: a key that reads a neighbour's
 * data, a key that outlives its usefulness, a scope that turns out to be
 * decorative, and paging that quietly skips rows while somebody syncs.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const ApiKey = require('../models/api-key');
const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Task = require('../models/task');
const Subscription = require('../models/subscription');
const apiKeyService = require('../services/api-keys');
const usageService = require('../services/usage');
const RateLimitCounter = require('../models/rate-limit-counter');

describe('Public read API', () => {
  let app;
  let acme;
  let globex;
  let acmeKey;
  let globexKey;
  let adminToken;

  const get = (path, key) => request(app).get(path).set('Authorization', `Bearer ${key}`);

  const onPlan = async (company, planId) => {
    await Subscription.findOneAndUpdate(
      { company: company._id },
      { planId, status: 'active' },
      { upsert: true }
    );
    usageService.invalidateSubscription(company._id);
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/api-keys', require('../routes/api-keys'));
    app.use('/api/v1', require('../routes/public-api'));

    acme = await Company.create({ name: 'Acme API' });
    globex = await Company.create({ name: 'Globex API' });

    // `apiAccess` is a professional feature; without it every request is a 402.
    await onPlan(acme, 'professional');
    await onPlan(globex, 'professional');

    await User.create({
      username: 'api-admin', email: 'admin@api.example',
      password: 'TestPassword123!', role: 'company_admin', displayName: 'Ada', company: acme._id
    });

    adminToken = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'api-admin', password: 'TestPassword123!' })).body.token;

    acmeKey = (await apiKeyService.create({
      companyId: acme._id,
      name: 'Warehouse sync',
      scopes: ['conversations:read', 'contacts:read', 'tasks:read'],
      createdBy: 'Ada'
    })).key;

    globexKey = (await apiKeyService.create({
      companyId: globex._id,
      name: 'Globex sync',
      scopes: ['conversations:read'],
      createdBy: 'Gus'
    })).key;

    await Conversation.create({
      sessionId: 'api-acme-1', company: acme._id, status: 'ended',
      tags: ['refund'],
      lastActivity: new Date('2026-01-05'),
      messages: [{ content: 'where is my order', sender: 'user' }, { content: 'on its way', sender: 'bot' }]
    });
    await Conversation.create({
      sessionId: 'api-globex-1', company: globex._id,
      lastActivity: new Date('2026-01-06'),
      messages: [{ content: 'a globex secret', sender: 'user' }]
    });
    await Contact.create({ company: acme._id, name: 'Bea', email: 'bea@example.com', identityLevel: 'claimed' });
    await Task.create({
      title: 'API task', description: 'x', dueDate: new Date(),
      company: acme._id, createdBy: new mongoose.Types.ObjectId()
    });
  });

  afterEach(async () => {
    // Only this API's buckets. Clearing the whole collection would reset the
    // counters of any suite running beside this one, which is a flake nobody
    // enjoys tracking down.
    await RateLimitCounter.deleteMany({ _id: /^papi:/ });
  });

  afterAll(async () => {
    await ApiKey.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await Conversation.deleteMany({ sessionId: /^api-/ });
    await Contact.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await Task.deleteMany({ title: /^API task/ });
    await Subscription.deleteMany({ company: { $in: [acme._id, globex._id] } });
    await User.deleteMany({ email: /@api\.example$/ });
    await Company.deleteMany({ name: /API$/ });
    await mongoose.connection.close();
  });

  describe('the key', () => {
    it('is stored only as a hash, so a database dump is not a set of credentials', async () => {
      const stored = await ApiKey.findOne({ name: 'Warehouse sync' }).select('+hash').lean();

      expect(stored.hash).not.toContain(acmeKey);
      expect(JSON.stringify(stored)).not.toContain(acmeKey.slice(11));
      // Enough to name the key in a listing, not enough to use it.
      expect(acmeKey.startsWith(stored.prefix)).toBe(true);
    });

    it('says who it is and what it can do', async () => {
      const response = await get('/api/v1/me', acmeKey);

      expect(response.status).toBe(200);
      expect(response.body.key.name).toBe('Warehouse sync');
      expect(response.body.company).toBe(String(acme._id));
    });

    it('refuses a request with no key', async () => {
      expect((await request(app).get('/api/v1/conversations')).status).toBe(401);
    });

    it('refuses a key that was never issued', async () => {
      expect((await get('/api/v1/conversations', 'ck_madeup')).status).toBe(401);
    });

    it('refuses a revoked key, and says nothing about why', async () => {
      const { record, key } = await apiKeyService.create({
        companyId: acme._id, name: 'Temporary', scopes: ['conversations:read']
      });

      expect((await get('/api/v1/conversations', key)).status).toBe(200);

      await apiKeyService.revoke(acme._id, record._id, 'Ada');

      const after = await get('/api/v1/conversations', key);
      expect(after.status).toBe(401);
      // The same answer as an unknown key: telling somebody holding a stolen
      // key which kind they hold is information they can use.
      expect(after.body.code).toBe('API_KEY_INVALID');
    });

    it('refuses an expired key', async () => {
      const { key } = await apiKeyService.create({
        companyId: acme._id,
        name: 'Expired',
        scopes: ['conversations:read'],
        expiresAt: new Date(Date.now() - 1000)
      });

      expect((await get('/api/v1/conversations', key)).status).toBe(401);
    });

    it('stops working when the plan no longer includes API access', async () => {
      await onPlan(acme, 'basic');

      const response = await get('/api/v1/conversations', acmeKey);
      expect(response.status).toBe(402);
      expect(response.body.code).toBe('FEATURE_NOT_IN_PLAN');

      await onPlan(acme, 'professional');
    });
  });

  describe('scopes', () => {
    it('refuses a resource the key was not given', async () => {
      const response = await get('/api/v1/conversations', globexKey);
      expect(response.status).toBe(200);

      // The same key, a resource it has no scope for.
      const contacts = await get('/api/v1/contacts', globexKey);
      expect(contacts.status).toBe(403);
      expect(contacts.body.required).toBe('contacts:read');
    });
  });

  describe('tenancy', () => {
    it('returns only the key\'s own company', async () => {
      const response = await get('/api/v1/conversations', acmeKey);

      const sessionIds = response.body.data.map(row => row.sessionId);
      expect(sessionIds).toContain('api-acme-1');
      expect(sessionIds).not.toContain('api-globex-1');
    });

    it('404s a neighbour\'s conversation asked for by name', async () => {
      const response = await get('/api/v1/conversations/api-globex-1', acmeKey);

      expect(response.status).toBe(404);
    });
  });

  describe('reading', () => {
    it('returns a conversation with its transcript', async () => {
      const response = await get('/api/v1/conversations/api-acme-1', acmeKey);

      expect(response.status).toBe(200);
      expect(response.body.messageCount).toBe(2);
      expect(response.body.messages.map(m => m.content)).toEqual(['where is my order', 'on its way']);
    });

    it('hands out a shaped record rather than the stored document', async () => {
      const response = await get('/api/v1/conversations/api-acme-1', acmeKey);

      // Whatever a future migration adds to the model does not become part of
      // the API by accident.
      expect(response.body.company).toBeUndefined();
      expect(response.body.__v).toBeUndefined();
      expect(Object.keys(response.body)).toEqual(expect.arrayContaining(['sessionId', 'status', 'tags']));
    });

    it('filters by status, tag and date', async () => {
      const byTag = await get('/api/v1/conversations?tag=refund', acmeKey);
      expect(byTag.body.data).toHaveLength(1);

      const byStatus = await get('/api/v1/conversations?status=active', acmeKey);
      expect(byStatus.body.data).toHaveLength(0);

      const since = await get('/api/v1/conversations?since=2026-06-01', acmeKey);
      expect(since.body.data).toHaveLength(0);
    });

    it('rejects a date it cannot read rather than ignoring it', async () => {
      const response = await get('/api/v1/conversations?since=whenever', acmeKey);

      // Silently returning everything would give somebody a warehouse full of
      // the wrong rows and no reason to look.
      expect(response.status).toBe(400);
    });

    it('reads contacts and tasks under their own scopes', async () => {
      expect((await get('/api/v1/contacts', acmeKey)).body.data[0].email).toBe('bea@example.com');
      expect((await get('/api/v1/tasks', acmeKey)).body.data[0].title).toBe('API task');
    });

    it('says a conversation has been anonymised rather than leaving "[removed]" to explain itself', async () => {
      const conversation = await Conversation.create({
        sessionId: 'api-anonymised', company: acme._id,
        messages: [{ content: 'personal', sender: 'user' }]
      });
      await conversation.anonymize();

      const response = await get('/api/v1/conversations/api-anonymised', acmeKey);

      expect(response.body.anonymizedAt).not.toBeNull();
      expect(response.body.messages[0].content).toBe('[removed]');
    });
  });

  describe('paging', () => {
    beforeAll(async () => {
      for (let i = 0; i < 5; i += 1) {
        await Conversation.create({
          sessionId: `api-page-${i}`, company: acme._id, messages: []
        });
      }
    });

    it('pages with a cursor that survives new rows arriving mid-sync', async () => {
      const first = await get('/api/v1/conversations?limit=2', acmeKey);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      // A conversation starting between two pages is exactly what page numbers
      // get wrong: an offset would shift and a row would be skipped.
      await Conversation.create({ sessionId: 'api-page-new', company: acme._id, messages: [] });

      const second = await get(`/api/v1/conversations?limit=2&cursor=${first.body.nextCursor}`, acmeKey);
      const firstIds = first.body.data.map(row => row.id);
      const secondIds = second.body.data.map(row => row.id);

      expect(secondIds.some(id => firstIds.includes(id))).toBe(false);
    });

    it('caps the page size, so one request cannot ask for everything', async () => {
      const response = await get('/api/v1/conversations?limit=5000', acmeKey);

      expect(response.body.data.length).toBeLessThanOrEqual(100);
    });

    it('rejects a cursor that is not one of ours', async () => {
      expect((await get('/api/v1/conversations?cursor=nonsense', acmeKey)).status).toBe(400);
    });

    it('reaches the end without a cursor to follow', async () => {
      const response = await get('/api/v1/conversations?limit=100', acmeKey);

      expect(response.body.hasMore).toBe(false);
      expect(response.body.nextCursor).toBeNull();
    });
  });

  describe('managing keys', () => {
    it('shows the key once and never again', async () => {
      const created = await request(app)
        .post('/api/api-keys')
        .set('x-auth-token', adminToken)
        .send({ name: 'Reporting', scopes: ['conversations:read'] });

      expect(created.status).toBe(201);
      expect(created.body.key).toMatch(/^ck_/);
      expect(created.body.warning).toMatch(/cannot be shown again/);

      const listed = await request(app).get('/api/api-keys').set('x-auth-token', adminToken);
      const row = listed.body.keys.find(key => key.name === 'Reporting');

      expect(row.prefix).toBe(created.body.key.slice(0, 11));
      expect(JSON.stringify(listed.body)).not.toContain(created.body.key);
    });

    it('refuses a scope that does not exist rather than issuing a key that does nothing', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('x-auth-token', adminToken)
        .send({ name: 'Typo', scopes: ['conversations:write'] });

      expect(response.status).toBe(400);
    });

    it('refuses a key with no scopes at all', async () => {
      const response = await request(app)
        .post('/api/api-keys')
        .set('x-auth-token', adminToken)
        .send({ name: 'Useless', scopes: [] });

      expect(response.status).toBe(400);
    });

    it('keeps a revoked key in the list, because that is the record of it', async () => {
      const created = await request(app)
        .post('/api/api-keys')
        .set('x-auth-token', adminToken)
        .send({ name: 'Short lived', scopes: ['tasks:read'] });

      await request(app)
        .delete(`/api/api-keys/${created.body.apiKey.id}`)
        .set('x-auth-token', adminToken);

      const listed = await request(app).get('/api/api-keys').set('x-auth-token', adminToken);
      const row = listed.body.keys.find(key => key.id === created.body.apiKey.id);

      expect(row.active).toBe(false);
      expect(row.revokedAt).toBeTruthy();
    });

    it('is closed to an operator, who could otherwise mint themselves an export', async () => {
      await User.create({
        username: 'api-operator', email: 'op@api.example',
        password: 'TestPassword123!', role: 'operator', company: acme._id
      });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'api-operator', password: 'TestPassword123!' });

      const response = await request(app)
        .post('/api/api-keys')
        .set('x-auth-token', login.body.token)
        .send({ name: 'Mine', scopes: ['conversations:read'] });

      expect(response.status).toBe(403);
    });

    it('cannot revoke another company\'s key', async () => {
      const other = await apiKeyService.create({
        companyId: globex._id, name: 'Globex only', scopes: ['conversations:read']
      });

      const response = await request(app)
        .delete(`/api/api-keys/${other.record._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(404);
      expect((await ApiKey.findById(other.record._id)).revokedAt).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('counts against the key, not the address', async () => {
      const { key } = await apiKeyService.create({
        companyId: acme._id, name: 'Busy', scopes: ['conversations:read']
      });

      // Both keys share an address; one is not the other's allowance.
      const busy = await get('/api/v1/conversations', key);
      const other = await get('/api/v1/conversations', acmeKey);

      expect(busy.headers['ratelimit-remaining']).toBe(other.headers['ratelimit-remaining']);
    });
  });
});
