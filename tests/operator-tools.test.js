/**
 * Operator tools: internal notes, transfer, and availability.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const availability = require('../services/availability');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
};

describe('Operator tools', () => {
  let app;
  let acme;
  let rival;
  let alice;
  let bob;
  let outsider;
  let aliceToken;
  let bobToken;
  let outsiderToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'OpTools Acme' });
    rival = await Company.create({ name: 'OpTools Rival' });

    alice = await User.create({
      username: 'optools-alice', email: 'alice@optools.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    bob = await User.create({
      username: 'optools-bob', email: 'bob@optools.example',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    outsider = await User.create({
      username: 'optools-outsider', email: 'outsider@optools.example',
      password: 'TestPassword123!', role: 'operator', company: rival._id
    });

    aliceToken = await login('optools-alice');
    bobToken = await login('optools-bob');
    outsiderToken = await login('optools-outsider');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@optools\.example$/ });
    await Company.deleteMany({ name: /^OpTools / });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Conversation.create({
      sessionId: 'optools-session',
      company: acme._id,
      messages: [{ content: 'hello', sender: 'user' }]
    });
  });

  describe('internal notes', () => {
    test('a note is signed with the author\'s display name', async () => {
      // The auth middleware did not put displayName on req.user, so every
      // record attributed to "displayName || username" silently fell back to
      // the username: a note by Bea Baker was signed "admin".
      await User.findByIdAndUpdate(alice._id, { displayName: 'Alice Anderson' });
      const token = await login('optools-alice');

      const response = await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', token)
        .send({ body: 'Signed note.' });

      expect(response.body.note.authorName).toBe('Alice Anderson');
      await User.findByIdAndUpdate(alice._id, { $unset: { displayName: 1 } });
    });

    test('an operator can add a note', async () => {
      const response = await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Customer already refunded on the phone.' });

      expect(response.status).toBe(201);
      expect(response.body.note.authorName).toBeTruthy();

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });
      expect(conversation.notes).toHaveLength(1);
    });

    test('notes never appear in the message transcript', async () => {
      // The whole point: a note must not be something the visitor can receive.
      await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Do not offer a discount.' });

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });
      const transcript = conversation.messages.map(m => m.content).join(' ');
      expect(transcript).not.toContain('Do not offer a discount');
    });

    test('an empty note is refused', async () => {
      const response = await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: '   ' });

      expect(response.status).toBe(400);
    });

    test('another company cannot read or write notes', async () => {
      const response = await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', outsiderToken)
        .send({ body: 'snooping' });

      expect(response.status).toBe(404);
    });

    test('an operator cannot delete a colleague\'s note', async () => {
      const created = await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Alice wrote this.' });

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });
      const noteId = conversation.notes[0]._id;

      const response = await request(app)
        .delete(`/api/admin/chat/optools-session/notes/${noteId}`)
        .set('x-auth-token', bobToken);

      expect(created.status).toBe(201);
      expect(response.status).toBe(403);
    });

    test('an operator can delete their own note', async () => {
      await request(app)
        .post('/api/admin/chat/optools-session/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Mine to remove.' });

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });
      const noteId = conversation.notes[0]._id;

      const response = await request(app)
        .delete(`/api/admin/chat/optools-session/notes/${noteId}`)
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      expect((await Conversation.findOne({ sessionId: 'optools-session' })).notes).toHaveLength(0);
    });
  });

  describe('transfer', () => {
    test('hands the conversation to a colleague', async () => {
      const response = await request(app)
        .post('/api/admin/chat/optools-session/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: bob._id.toString(), note: 'Needs a manager.' });

      expect(response.status).toBe(200);

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });
      expect(conversation.operatorId.toString()).toBe(bob._id.toString());
      expect(conversation.hasOperator).toBe(true);
    });

    test('records who handed it over, and why', async () => {
      await request(app)
        .post('/api/admin/chat/optools-session/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: bob._id.toString(), note: 'Needs a manager.' });

      const conversation = await Conversation.findOne({ sessionId: 'optools-session' });

      expect(conversation.transferredFrom.operatorId.toString()).toBe(alice._id.toString());
      // A system note so the history explains itself later.
      const systemNote = conversation.notes.find(note => note.system);
      expect(systemNote.body).toContain('Needs a manager.');
    });

    test('refuses a transfer to another company', async () => {
      // Otherwise a conversation would be handed to someone outside the tenant.
      const response = await request(app)
        .post('/api/admin/chat/optools-session/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: outsider._id.toString() });

      expect(response.status).toBe(403);
    });

    test('refuses a transfer to yourself', async () => {
      const response = await request(app)
        .post('/api/admin/chat/optools-session/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: alice._id.toString() });

      expect(response.status).toBe(400);
    });

    test('refuses a transfer to a deactivated operator', async () => {
      await User.findByIdAndUpdate(bob._id, { isActive: false });

      const response = await request(app)
        .post('/api/admin/chat/optools-session/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: bob._id.toString() });

      expect(response.status).toBe(404);
      await User.findByIdAndUpdate(bob._id, { isActive: true });
    });
  });

  describe('availability', () => {
    afterEach(() => availability.invalidate());

    test('a company with no schedule is always open', async () => {
      const status = await availability.isWithinBusinessHours(acme._id);
      expect(status.open).toBe(true);
      expect(status.enabled).toBe(false);
    });

    test('is closed on a day marked closed', async () => {
      const today = availability.weekdayIn('UTC');
      await Company.findByIdAndUpdate(acme._id, {
        businessHours: {
          enabled: true, timezone: 'UTC',
          days: [{ day: today, closed: true }],
          offlineMessage: 'Back tomorrow.'
        }
      });
      availability.invalidate();

      const status = await availability.isWithinBusinessHours(acme._id);
      expect(status.open).toBe(false);
      expect(status.offlineMessage).toBe('Back tomorrow.');
    });

    test('is open inside the configured window', async () => {
      const today = availability.weekdayIn('UTC');
      const now = availability.minutesNowIn('UTC');

      await Company.findByIdAndUpdate(acme._id, {
        businessHours: {
          enabled: true, timezone: 'UTC',
          days: [{ day: today, closed: false, opensAt: Math.max(0, now - 60), closesAt: Math.min(1440, now + 60) }]
        }
      });
      availability.invalidate();

      expect((await availability.isWithinBusinessHours(acme._id)).open).toBe(true);
    });

    test('is closed outside the configured window', async () => {
      const today = availability.weekdayIn('UTC');
      const now = availability.minutesNowIn('UTC');

      // A window entirely in the past today.
      const opensAt = Math.max(0, now - 120);
      const closesAt = Math.max(1, now - 60);

      await Company.findByIdAndUpdate(acme._id, {
        businessHours: {
          enabled: true, timezone: 'UTC',
          days: [{ day: today, closed: false, opensAt, closesAt }]
        }
      });
      availability.invalidate();

      expect((await availability.isWithinBusinessHours(acme._id)).open).toBe(false);
    });

    test('an unknown timezone falls back rather than throwing', () => {
      expect(() => availability.minutesNowIn('Not/AZone')).not.toThrow();
      expect(typeof availability.minutesNowIn('Not/AZone')).toBe('number');
    });

    test('reports no operators online when sockets are not running', () => {
      expect(availability.operatorsOnline(acme._id)).toBe(0);
    });

    test('counts people, not tabs, and only those taking chats', async () => {
      // "3 operators online" when one person has three tabs open is the same
      // broken promise as saying there are any when there are none.
      const socketManager = require('../socketManager');
      const room = new Set(['s1', 's2', 's3', 's4']);
      const spy = jest.spyOn(socketManager, 'getIo').mockReturnValue({
        sockets: {
          adapter: { rooms: new Map([[socketManager.operatorRoom(acme._id), room]]) },
          sockets: new Map([
            ['s1', { user: { id: String(alice._id) } }],
            ['s2', { user: { id: String(alice._id) } }],
            ['s3', { user: { id: String(bob._id) } }],
            // A socket with no user - a visitor that somehow got in - does
            // not count.
            ['s4', { user: { role: 'user' } }]
          ])
        }
      });

      // Earlier tests leave a closed schedule behind; this one is about people.
      await Company.findByIdAndUpdate(acme._id, { businessHours: { enabled: false } });
      availability.invalidate();

      try {
        expect(availability.operatorsOnline(acme._id)).toBe(2);

        await User.findByIdAndUpdate(bob._id, { acceptingChats: false });
        const status = await availability.status(acme._id);
        expect(status.operatorsOnline).toBe(1);
        expect(status.canReachOperator).toBe(true);

        await User.findByIdAndUpdate(alice._id, { acceptingChats: false });
        expect((await availability.status(acme._id)).canReachOperator).toBe(false);
      } finally {
        spy.mockRestore();
        await User.updateMany({ _id: { $in: [alice._id, bob._id] } }, { acceptingChats: true });
      }
    });

    test('never promises a person when nobody could pick up', async () => {
      const status = await availability.status(acme._id);
      expect(status.canReachOperator).toBe(false);
    });
  });
});
