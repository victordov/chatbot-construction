/**
 * Tags and auto-assignment.
 *
 * The assignment tests are mostly about what happens when the answer is "not
 * this person": at capacity, not accepting, offline, already taken. Those are
 * the cases that decide whether a queue distributes work or quietly dumps it
 * all on whoever reconnected first.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const assignment = require('../services/assignment');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/companies', require('../routes/company'));
  return app;
};

describe('Assignment and tags', () => {
  let app;
  let acme;
  let rival;
  let alice;
  let bob;
  let carol;
  let adminUser;
  let aliceToken;
  let adminToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({
      name: 'Assign Acme',
      routing: { autoAssign: true, maxConcurrent: 3 }
    });
    rival = await Company.create({ name: 'Assign Rival' });

    alice = await User.create({
      username: 'assign-alice', email: 'alice@assign.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Alice Anderson', company: acme._id
    });
    bob = await User.create({
      username: 'assign-bob', email: 'bob@assign.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Bob Brown', company: acme._id
    });
    carol = await User.create({
      username: 'assign-carol', email: 'carol@assign.example',
      password: 'TestPassword123!', role: 'operator',
      displayName: 'Carol Clark', company: acme._id
    });
    adminUser = await User.create({
      username: 'assign-admin', email: 'admin@assign.example',
      password: 'TestPassword123!', role: 'company_admin',
      displayName: 'Dana Diaz', company: acme._id
    });

    aliceToken = await login('assign-alice');
    adminToken = await login('assign-admin');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@assign\.example$/ });
    await Company.deleteMany({ name: /^Assign / });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.updateMany(
      { email: /@assign\.example$/ },
      { acceptingChats: true, maxConcurrentChats: null }
    );
    await Company.findByIdAndUpdate(acme._id, {
      routing: { autoAssign: true, maxConcurrent: 3, assignOnStart: false }
    });
  });

  /** Stand in for the socket layer, which is not running in these tests. */
  const pretendOnline = operators => {
    const sockets = new Map();
    const room = new Set();

    operators.forEach((operator, index) => {
      const socketId = `socket-${index}`;
      room.add(socketId);
      sockets.set(socketId, {
        user: {
          id: String(operator._id),
          username: operator.username,
          displayName: operator.displayName
        }
      });
    });

    const socketManager = require('../socketManager');
    jest.spyOn(socketManager, 'getIo').mockReturnValue({
      sockets: {
        adapter: { rooms: new Map([[socketManager.operatorRoom(acme._id), room]]) },
        sockets
      }
    });
  };

  const conversation = async (overrides = {}) => Conversation.create({
    sessionId: overrides.sessionId || `assign-${Math.random().toString(36).slice(2)}`,
    company: acme._id,
    messages: [{ content: 'hello', sender: 'user' }],
    ...overrides
  });

  /** Give an operator `count` open conversations. */
  const loadUp = async (operator, count) => {
    for (let i = 0; i < count; i += 1) {
      await conversation({
        operatorId: operator._id,
        operatorName: operator.displayName,
        hasOperator: true,
        status: 'active',
        assignment: { method: 'auto', at: new Date(Date.now() - 60000) }
      });
    }
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('picking someone', () => {
    test('nobody online means nobody is picked', async () => {
      pretendOnline([]);
      expect(await assignment.pickOperator(acme._id)).toBeNull();
    });

    test('the only person online gets it', async () => {
      pretendOnline([alice]);
      const picked = await assignment.pickOperator(acme._id);

      expect(picked.displayName).toBe('Alice Anderson');
    });

    test('the least loaded goes first, not the next in the list', async () => {
      // The reason this is not strict round-robin: handing the next
      // conversation to whoever is "next" ignores the three they are already
      // holding.
      pretendOnline([alice, bob]);
      await loadUp(alice, 2);

      const picked = await assignment.pickOperator(acme._id);
      expect(picked.displayName).toBe('Bob Brown');
    });

    test('equal load falls back to whoever has waited longest', async () => {
      pretendOnline([alice, bob]);

      await conversation({
        operatorId: alice._id, operatorName: 'Alice Anderson', hasOperator: true,
        assignment: { method: 'auto', at: new Date(Date.now() - 1000) }
      });
      await conversation({
        operatorId: bob._id, operatorName: 'Bob Brown', hasOperator: true,
        assignment: { method: 'auto', at: new Date(Date.now() - 60 * 60 * 1000) }
      });

      const picked = await assignment.pickOperator(acme._id);
      expect(picked.displayName).toBe('Bob Brown');
    });

    test('somebody at capacity is skipped', async () => {
      pretendOnline([alice, bob]);
      await loadUp(alice, 3);
      await loadUp(bob, 3);

      // Both at the company cap of 3. Assigning anyway would only hide the
      // fact that the team is under water.
      expect(await assignment.pickOperator(acme._id)).toBeNull();
    });

    test('a personal cap overrides the company one', async () => {
      pretendOnline([alice, bob]);
      await User.findByIdAndUpdate(alice._id, { maxConcurrentChats: 1 });
      await loadUp(alice, 1);

      const picked = await assignment.pickOperator(acme._id);
      expect(picked.displayName).toBe('Bob Brown');
    });

    test('somebody not accepting chats is skipped even with no load', async () => {
      // Connected is not the same as available: finishing a hard conversation,
      // or five minutes from leaving.
      pretendOnline([alice, bob]);
      await User.findByIdAndUpdate(alice._id, { acceptingChats: false });

      const picked = await assignment.pickOperator(acme._id);
      expect(picked.displayName).toBe('Bob Brown');
    });

    test('a deactivated account is skipped', async () => {
      pretendOnline([alice, bob]);
      await User.findByIdAndUpdate(alice._id, { isActive: false });

      const picked = await assignment.pickOperator(acme._id);
      expect(picked.displayName).toBe('Bob Brown');

      await User.findByIdAndUpdate(alice._id, { isActive: true });
    });

    test('someone who predates the availability fields is still available', async () => {
      // Mongoose defaults apply on write, not on read, so a user created before
      // `acceptingChats` existed has no value for it. Matching on `true`
      // excluded every one of them, and auto-assignment on an existing account
      // would have found nobody, forever.
      await User.collection.updateOne(
        { _id: alice._id },
        { $unset: { acceptingChats: '', isActive: '' } }
      );

      pretendOnline([alice]);
      const picked = await assignment.pickOperator(acme._id);

      expect(picked).not.toBeNull();
      expect(picked.displayName).toBe('Alice Anderson');

      await User.collection.updateOne(
        { _id: alice._id },
        { $set: { acceptingChats: true, isActive: true } }
      );
    });

    test('an excluded operator is not picked', async () => {
      // Used when reassigning away from someone.
      pretendOnline([alice, bob]);

      const picked = await assignment.pickOperator(acme._id, { exclude: [alice._id] });
      expect(picked.displayName).toBe('Bob Brown');
    });

    test('two tabs is one operator, not two', async () => {
      const socketManager = require('../socketManager');
      const room = new Set(['s1', 's2']);
      jest.spyOn(socketManager, 'getIo').mockReturnValue({
        sockets: {
          adapter: { rooms: new Map([[socketManager.operatorRoom(acme._id), room]]) },
          sockets: new Map([
            ['s1', { user: { id: String(alice._id), displayName: 'Alice Anderson' } }],
            ['s2', { user: { id: String(alice._id), displayName: 'Alice Anderson' } }]
          ])
        }
      });

      expect(assignment.connectedOperators(acme._id)).toHaveLength(1);
    });

    test('the order is stable when everything ties', async () => {
      // Without a final tie-break, two conversations arriving in the same
      // millisecond could both be handed to whoever the database listed first.
      pretendOnline([alice, bob, carol]);

      const picks = await Promise.all([
        assignment.pickOperator(acme._id),
        assignment.pickOperator(acme._id)
      ]);

      expect(picks[0].id).toBe(picks[1].id);
    });
  });

  describe('assigning', () => {
    test('a conversation is handed over and stamped', async () => {
      const chat = await conversation();
      const result = await assignment.assign(
        chat, { id: alice._id, displayName: 'Alice Anderson' }, 'auto'
      );

      expect(result.assigned).toBe(true);

      const reloaded = await Conversation.findById(chat._id);
      expect(reloaded.operatorName).toBe('Alice Anderson');
      expect(reloaded.hasOperator).toBe(true);
      expect(reloaded.assignment.method).toBe('auto');
    });

    test('the first claim stands', async () => {
      // Two operators holding one conversation is worse than none holding it.
      const chat = await conversation();
      await assignment.assign(chat, { id: alice._id, displayName: 'Alice Anderson' });

      const second = await assignment.assign(chat, { id: bob._id, displayName: 'Bob Brown' });

      expect(second.assigned).toBe(false);
      expect((await Conversation.findById(chat._id)).operatorName).toBe('Alice Anderson');
    });

    test('auto-assignment does nothing when the company has not asked for it', async () => {
      pretendOnline([alice]);
      await Company.findByIdAndUpdate(acme._id, { 'routing.autoAssign': false });

      const result = await assignment.autoAssign(await conversation());

      expect(result.assigned).toBe(false);
      expect(result.reason).toMatch(/off/);
    });

    test('nobody available leaves it in the queue rather than failing', async () => {
      pretendOnline([]);
      const result = await assignment.autoAssign(await conversation());

      expect(result.assigned).toBe(false);
      expect(result.reason).toMatch(/nobody available/);
    });

    test('a routing failure never takes the conversation with it', async () => {
      // The conversation staying unassigned is exactly where it would have been
      // without this feature; an exception here would lose the message.
      const socketManager = require('../socketManager');
      jest.spyOn(socketManager, 'getIo').mockImplementation(() => {
        throw new Error('sockets are down');
      });

      await expect(assignment.autoAssign(await conversation()))
        .resolves.toMatchObject({ assigned: false });
    });

    test('load is counted from the conversations, not held in memory', async () => {
      // So a restart does not reset everyone to zero and flood whoever
      // reconnects first.
      await loadUp(alice, 2);
      await conversation({
        operatorId: alice._id, operatorName: 'Alice Anderson', status: 'ended'
      });

      const load = await assignment.currentLoad(acme._id);
      expect(load.get(String(alice._id))).toBe(2);
    });
  });

  describe('claiming by hand', () => {
    test('an operator can take an unassigned conversation', async () => {
      await conversation({ sessionId: 'assign-claim' });

      const response = await request(app)
        .post('/api/admin/chat/assign-claim/claim')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      expect(response.body.operatorName).toBe('Alice Anderson');
    });

    test('taking one somebody else holds is refused with their name', async () => {
      await conversation({
        sessionId: 'assign-taken',
        operatorId: bob._id, operatorName: 'Bob Brown', hasOperator: true
      });

      const response = await request(app)
        .post('/api/admin/chat/assign-taken/claim')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/Bob Brown/);
    });

    test('claiming one you already hold is not an error', async () => {
      await conversation({
        sessionId: 'assign-mine',
        operatorId: alice._id, operatorName: 'Alice Anderson', hasOperator: true
      });

      const response = await request(app)
        .post('/api/admin/chat/assign-mine/claim')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
    });
  });

  describe('tags', () => {
    test('tags are normalised on the way in', async () => {
      await conversation({ sessionId: 'assign-tags' });

      const response = await request(app)
        .put('/api/admin/chat/assign-tags/tags')
        .set('x-auth-token', aliceToken)
        .send({ tags: ['  Billing ', 'BILLING', 'bug report', ''] });

      // Casing folded so "billing" and "Billing" cannot both exist, spaces
      // hyphenated, blanks dropped, duplicates collapsed.
      expect(response.body.tags).toEqual(['billing', 'bug-report']);
    });

    test('tags are replaced wholesale, so removing works', async () => {
      await conversation({ sessionId: 'assign-retag', tags: ['billing', 'urgent'] });

      const response = await request(app)
        .put('/api/admin/chat/assign-retag/tags')
        .set('x-auth-token', aliceToken)
        .send({ tags: ['billing'] });

      expect(response.body.tags).toEqual(['billing']);
    });

    test('the tag list is capped', async () => {
      const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
      expect(assignment.normaliseTags(many)).toHaveLength(20);
    });

    test('an overlong tag is dropped rather than truncated into nonsense', async () => {
      expect(assignment.normaliseTags(['x'.repeat(80), 'fine'])).toEqual(['fine']);
    });

    test('suggestions come back most used first', async () => {
      await conversation({ tags: ['billing', 'urgent'] });
      await conversation({ tags: ['billing'] });
      await conversation({ tags: ['billing', 'urgent'] });

      const response = await request(app)
        .get('/api/admin/tags')
        .set('x-auth-token', aliceToken);

      expect(response.body.tags[0]).toEqual({ tag: 'billing', count: 3 });
      expect(response.body.tags[1]).toEqual({ tag: 'urgent', count: 2 });
    });

    test('another company\'s tags are not suggested', async () => {
      await Conversation.create({
        sessionId: 'assign-rival-tagged', company: rival._id,
        messages: [{ content: 'hi', sender: 'user' }],
        tags: ['their-secret-project']
      });

      const response = await request(app)
        .get('/api/admin/tags')
        .set('x-auth-token', aliceToken);

      expect(JSON.stringify(response.body)).not.toContain('their-secret-project');
    });
  });

  describe('availability', () => {
    test('an operator can stop taking new conversations', async () => {
      const response = await request(app)
        .put('/api/admin/me/availability')
        .set('x-auth-token', aliceToken)
        .send({ acceptingChats: false });

      expect(response.body.acceptingChats).toBe(false);
    });

    test('a personal limit is validated', async () => {
      const response = await request(app)
        .put('/api/admin/me/availability')
        .set('x-auth-token', aliceToken)
        .send({ maxConcurrentChats: 99 });

      expect(response.status).toBe(400);
    });

    test('null clears the personal limit', async () => {
      await request(app)
        .put('/api/admin/me/availability')
        .set('x-auth-token', aliceToken)
        .send({ maxConcurrentChats: 5 });

      const response = await request(app)
        .put('/api/admin/me/availability')
        .set('x-auth-token', aliceToken)
        .send({ maxConcurrentChats: null });

      expect(response.body.maxConcurrentChats).toBeNull();
    });
  });

  describe('routing settings', () => {
    test('an admin can turn auto-assignment on', async () => {
      const response = await request(app)
        .put('/api/companies/me/routing')
        .set('x-auth-token', adminToken)
        .send({ autoAssign: true, maxConcurrent: 5 });

      expect(response.status).toBe(200);
      expect(response.body.routing).toMatchObject({ autoAssign: true, maxConcurrent: 5 });
    });

    test('an absurd limit is refused rather than clamped silently', async () => {
      const response = await request(app)
        .put('/api/companies/me/routing')
        .set('x-auth-token', adminToken)
        .send({ maxConcurrent: 100 });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/between 1 and 20/);
    });

    test('an operator cannot change the company\'s routing', async () => {
      const response = await request(app)
        .put('/api/companies/me/routing')
        .set('x-auth-token', aliceToken)
        .send({ autoAssign: false });

      expect(response.status).toBe(403);
      expect(adminUser.role).toBe('company_admin');
    });
  });
});
