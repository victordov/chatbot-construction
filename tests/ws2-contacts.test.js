/**
 * People: export, merge, duplicates, tags and the timeline.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const User = require('../models/user');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Task = require('../models/task');
const AuditLog = require('../models/audit-log');

/** Audit entries are written after the response goes. */
const eventually = async (find, timeout = 3000) => {
  const until = Date.now() + timeout;
  let found = await find();
  while (!found && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50));
    found = await find();
  }
  return found;
};

describe('People (WS2)', () => {
  let app;
  let acme;
  let rival;
  let adminToken;
  let operatorToken;
  let rivalToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/contacts', require('../routes/contacts'));

    acme = await Company.create({ name: 'WS2 People Acme' });
    rival = await Company.create({ name: 'WS2 People Rival' });

    await User.create({
      username: 'ws2-people-admin', email: 'admin@ws2people.example',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    await User.create({
      username: 'ws2-people-op', email: 'op@ws2people.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    await User.create({
      username: 'ws2-people-rival', email: 'rival@ws2people.example',
      password: 'TestPassword123!', role: 'company_admin', company: rival._id
    });

    adminToken = await login('ws2-people-admin');
    operatorToken = await login('ws2-people-op');
    rivalToken = await login('ws2-people-rival');
  });

  afterAll(async () => {
    await Task.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@ws2people\.example$/ });
    await Company.deleteMany({ name: /^WS2 People / });
  });

  beforeEach(async () => {
    await Task.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
  });

  describe('export', () => {
    test('is for admins only', async () => {
      const response = await request(app).get('/api/contacts/export').set('x-auth-token', operatorToken);
      expect(response.status).toBe(403);
    });

    test('escapes formulas, honours the filter, stays in the company and is audited', async () => {
      await Contact.create([
        { company: acme._id, name: '@SUM(1+1)', email: 'formula@example.com', tags: ['vip'] },
        { company: acme._id, name: 'Plain Person', email: 'plain@example.com' },
        { company: rival._id, name: 'Rival Person', email: 'rival@example.com', tags: ['vip'] }
      ]);

      const response = await request(app)
        .get('/api/contacts/export?tag=vip')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.text).toContain('"\'@SUM(1+1)"');
      expect(response.text).not.toContain('Plain Person');
      expect(response.text).not.toContain('Rival Person');
      expect(await eventually(() => AuditLog.findOne({ action: 'contacts.exported', company: acme._id }))).not.toBeNull();
    });
  });

  describe('merge', () => {
    test('is audited', async () => {
      const [target, source] = await Contact.create([
        { company: acme._id, name: 'Keep Me', email: 'keep@example.com' },
        { company: acme._id, name: 'Fold Me', email: 'fold@example.com' }
      ]);

      const response = await request(app)
        .post(`/api/contacts/${target._id}/merge`)
        .set('x-auth-token', operatorToken)
        .send({ sourceId: String(source._id) });

      expect(response.status).toBe(200);
      expect(await Contact.findById(source._id)).toBeNull();
      const entry = await eventually(() => AuditLog.findOne({ action: 'contact.merged', 'target.id': String(target._id) }));
      expect(entry).not.toBeNull();
    });
  });

  describe('editing', () => {
    test('says when somebody else has the same address', async () => {
      const [first, second] = await Contact.create([
        { company: acme._id, name: 'First', email: 'same@example.com' },
        { company: acme._id, name: 'Second' }
      ]);

      const response = await request(app)
        .put(`/api/contacts/${second._id}`)
        .set('x-auth-token', operatorToken)
        .send({ email: 'same@example.com' });

      expect(response.status).toBe(200);
      expect(response.body.duplicates).toEqual([
        expect.objectContaining({ _id: String(first._id), name: 'First' })
      ]);
    });
  });

  describe('tags', () => {
    test('lists the company\'s tags with counts', async () => {
      await Contact.create([
        { company: acme._id, tags: ['vip', 'churn-risk'] },
        { company: acme._id, tags: ['vip'] },
        { company: rival._id, tags: ['rival-only'] }
      ]);

      const response = await request(app).get('/api/contacts/tags').set('x-auth-token', operatorToken);

      expect(response.body.tags).toEqual([
        { tag: 'vip', count: 2 },
        { tag: 'churn-risk', count: 1 }
      ]);
    });

    test('another company sees its own only', async () => {
      await Contact.create({ company: acme._id, tags: ['acme-only'] });
      const response = await request(app).get('/api/contacts/tags').set('x-auth-token', rivalToken);
      expect(response.body.tags.map(entry => entry.tag)).not.toContain('acme-only');
    });
  });

  describe('timeline', () => {
    test('has conversations, tasks and ratings, newest first', async () => {
      const contact = await Contact.create({ company: acme._id, name: 'Tim', email: 'tim@example.com' });
      const conversation = await Conversation.create({
        sessionId: 'ws2-people-timeline', company: acme._id, contact: contact._id,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        rating: { score: 4, ratedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        messages: [
          { content: 'Hello', sender: 'user' },
          { content: 'Transferred to Bea', sender: 'system' }
        ]
      });
      await Task.create({
        title: 'Call Tim', description: 'x', dueDate: new Date(), company: acme._id,
        conversationId: conversation._id
      });

      const response = await request(app).get(`/api/contacts/${contact._id}`).set('x-auth-token', operatorToken);

      expect(response.status).toBe(200);
      expect(response.body.timeline.map(entry => entry.type)).toEqual(['task', 'rating', 'conversation']);
      const entry = response.body.timeline.find(item => item.type === 'conversation');
      // The system line is neither counted nor the summary.
      expect(entry).toMatchObject({ messageCount: 1, summary: 'Hello' });
      expect(response.body.conversations[0]).toMatchObject({ sessionId: 'ws2-people-timeline', ratingScore: 4 });
    });
  });
});
