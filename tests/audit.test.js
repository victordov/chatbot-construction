/**
 * The audit log.
 *
 * Two things have to hold, or the log is worse than not having one: it must not
 * leak across tenants, and it must not become the most sensitive collection in
 * the database by recording the secrets it describes.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const AuditLog = require('../models/audit-log');
const audit = require('../services/audit');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
};

describe('Audit log', () => {
  let app;
  let acme;
  let rival;
  let dana;
  let rivalAdmin;
  let alice;
  let root;
  let danaToken;
  let rivalToken;
  let aliceToken;
  let rootToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'Audit Acme' });
    rival = await Company.create({ name: 'Audit Rival' });

    dana = await User.create({
      username: 'audit-dana', email: 'dana@audit.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Dana Diaz', company: acme._id
    });
    rivalAdmin = await User.create({
      username: 'audit-rival', email: 'rival@audit.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Rex Rivera', company: rival._id
    });
    alice = await User.create({
      username: 'audit-alice', email: 'alice@audit.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Alice Anderson', company: acme._id
    });
    root = await User.create({
      username: 'audit-root', email: 'root@audit.example',
      password: 'TestPassword123!', role: 'superadmin',
      displayName: 'Root'
    });

    danaToken = await login('audit-dana');
    rivalToken = await login('audit-rival');
    aliceToken = await login('audit-alice');
    rootToken = await login('audit-root');
  });

  afterAll(async () => {
    await AuditLog.deleteMany({ company: { $in: [acme._id, rival._id, null] } });
    await User.deleteMany({ email: /@audit\.example$/ });
    await Company.deleteMany({ name: /^Audit / });
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
  });

  describe('redaction', () => {
    test.each([
      'password', 'token', 'secret', 'apiKey', 'identitySecret',
      'inboundSecret', 'authorization', 'userHash'
    ])('%s never reaches the log', async field => {
      const clean = audit.sanitise({ [field]: 'super-secret-value', safe: 'yes' });

      expect(clean[field]).toBe('[redacted]');
      expect(JSON.stringify(clean)).not.toContain('super-secret-value');
      expect(clean.safe).toBe('yes');
    });

    test('redaction reaches nested values', async () => {
      const clean = audit.sanitise({ auth: { type: 'bearer', value: 'sk-live-999' } });
      expect(JSON.stringify(clean)).not.toContain('sk-live-999');
    });

    test('a long value is truncated rather than stored whole', async () => {
      // The log is not a place for a document, and a transcript pasted into a
      // details field would make it one.
      const clean = audit.sanitise({ note: 'x'.repeat(5000) });
      expect(clean.note.length).toBeLessThanOrEqual(501);
    });

    test('deeply nested structures stop rather than recursing forever', async () => {
      let deep = { value: 'end' };
      for (let i = 0; i < 20; i += 1) {
        deep = { nested: deep };
      }
      expect(() => audit.sanitise(deep)).not.toThrow();
    });
  });

  describe('recording', () => {
    test('an entry keeps the actor by value, not by reference', async () => {
      // The point of an audit trail is to survive the account being renamed or
      // deleted, so the name is copied rather than joined at read time.
      await audit.record({
        action: 'test.happened',
        company: acme._id,
        actor: { id: alice._id, username: 'audit-alice', displayName: 'Alice Anderson', role: 'operator' }
      });

      const [entry] = await AuditLog.find({ action: 'test.happened' });
      expect(entry.actor.displayName).toBe('Alice Anderson');
    });

    test('a write failure never throws at the caller', async () => {
      // A logging outage must not break the thing being logged.
      const spy = jest.spyOn(AuditLog, 'create').mockRejectedValue(new Error('mongo is down'));

      await expect(audit.record({ action: 'test.failing' })).resolves.toBeNull();

      spy.mockRestore();
    });

    test('an entry with no action is ignored', async () => {
      expect(await audit.record({ company: acme._id })).toBeNull();
    });
  });

  describe('what gets recorded', () => {
    test('a successful sign-in', async () => {
      await login('audit-dana');

      const entries = await AuditLog.find({ action: 'auth.login', outcome: 'success' });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(e => e.actor.username === 'audit-dana')).toBe(true);
    });

    test('a failed sign-in against a real account, without the password', async () => {
      await request(app).post('/api/auth/login')
        .send({ username: 'audit-dana', password: 'WrongPassword!' });

      const [entry] = await AuditLog.find({ action: 'auth.login', outcome: 'failure' });

      expect(entry.actor.username).toBe('audit-dana');
      expect(entry.details.reason).toBe('wrong password');
      expect(JSON.stringify(entry)).not.toContain('WrongPassword');
    });

    test('a sign-in attempt against a username that does not exist', async () => {
      await request(app).post('/api/auth/login')
        .send({ username: 'nobody-at-all', password: 'x' });

      const [entry] = await AuditLog.find({ action: 'auth.login', outcome: 'failure' });

      // No company, because there is no account to attribute it to.
      expect(entry.company).toBeNull();
      expect(entry.details.username).toBe('nobody-at-all');
    });
  });

  describe('reading it', () => {
    beforeEach(async () => {
      await AuditLog.create([
        { company: acme._id, action: 'operator.deactivated', actor: { username: 'audit-dana' }, at: new Date() },
        { company: acme._id, action: 'plan.changed', actor: { username: 'audit-root' }, at: new Date(Date.now() - 86400000) },
        { company: rival._id, action: 'operator.deactivated', actor: { username: 'audit-rival' }, at: new Date() },
        { company: null, action: 'superadmin.created', actor: { username: 'audit-root' }, at: new Date() }
      ]);
    });

    test('an admin sees their own company only', async () => {
      const response = await request(app)
        .get('/api/admin/audit')
        .set('x-auth-token', danaToken);

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.entries.every(e => String(e.company) === String(acme._id))).toBe(true);
    });

    test('another company\'s history is not reachable', async () => {
      const response = await request(app)
        .get('/api/admin/audit')
        .set('x-auth-token', rivalToken);

      expect(response.body.entries).toHaveLength(1);
      expect(response.body.entries[0].actor.username).toBe('audit-rival');
    });

    test('platform-level entries are for superadmins only', async () => {
      // A tenant has no business seeing that a superadmin account was created.
      const tenant = await request(app).get('/api/admin/audit').set('x-auth-token', danaToken);
      expect(tenant.body.entries.some(e => e.action === 'superadmin.created')).toBe(false);

      const platform = await request(app).get('/api/admin/audit').set('x-auth-token', rootToken);
      expect(platform.body.entries.some(e => e.action === 'superadmin.created')).toBe(true);
    });

    test('an operator cannot read the log at all', async () => {
      const response = await request(app)
        .get('/api/admin/audit')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(403);
    });

    test('entries come back newest first', async () => {
      const response = await request(app)
        .get('/api/admin/audit')
        .set('x-auth-token', danaToken);

      expect(response.body.entries[0].action).toBe('operator.deactivated');
    });

    test('filtering by action prefix finds a family of events', async () => {
      const response = await request(app)
        .get('/api/admin/audit?action=operator.')
        .set('x-auth-token', danaToken);

      expect(response.body.entries).toHaveLength(1);
      expect(response.body.entries[0].action).toBe('operator.deactivated');
    });

    test('filtering by a date range', async () => {
      const response = await request(app)
        .get(`/api/admin/audit?since=${new Date(Date.now() - 3600000).toISOString()}`)
        .set('x-auth-token', danaToken);

      expect(response.body.entries).toHaveLength(1);
      expect(response.body.entries[0].action).toBe('operator.deactivated');
    });

    test('the page size is capped', async () => {
      const response = await request(app)
        .get('/api/admin/audit?limit=100000')
        .set('x-auth-token', danaToken);

      expect(response.body.limit).toBe(200);
    });

    test('the action list is scoped to the company too', async () => {
      const response = await request(app)
        .get('/api/admin/audit/actions')
        .set('x-auth-token', danaToken);

      expect(response.body.actions).toEqual(['operator.deactivated', 'plan.changed']);
      expect(response.body.actions).not.toContain('superadmin.created');
    });
  });

  describe('it cannot be rewritten', () => {
    test('there is no route that edits or deletes an entry', async () => {
      // The property that makes this evidence rather than a diary.
      const routes = require('../routes/admin').stack
        .filter(layer => layer.route && /audit/.test(layer.route.path))
        .flatMap(layer => Object.keys(layer.route.methods));

      expect(routes.every(method => method === 'get')).toBe(true);
    });

    test('the model has a retention window rather than growing forever', () => {
      // An audit log kept forever becomes a liability of its own.
      expect(AuditLog.RETENTION_DAYS).toBeGreaterThan(0);
    });
  });
});
