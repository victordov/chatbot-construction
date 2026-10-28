/**
 * The operator inbox, server side: the queue's triage fields, transfers that
 * need somebody to be there, closing with an outcome, deleting and exporting
 * the history, and the small things around a conversation (notes,
 * availability, the customer's details).
 */

const fs = require('fs');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Notification = require('../models/notification');
const AuditLog = require('../models/audit-log');
const uploads = require('../services/uploads');
const socketManager = require('../socketManager');
const assignmentService = require('../services/assignment');

/** Audit entries and notifications are written after the response goes. */
const eventually = async (find, timeout = 3000) => {
  const until = Date.now() + timeout;
  let found = await find();
  while (!found && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 50));
    found = await find();
  }
  return found;
};

describe('Operator inbox (server)', () => {
  let app;
  let acme;
  let rival;
  let admin;
  let alice;
  let bob;
  let adminToken;
  let aliceToken;
  let bobToken;
  let rivalToken;
  let emitted;
  let presence;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  /** A socket layer that records what was sent where. */
  const fakeIo = () => ({
    to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
  });

  const sent = event => emitted.filter(entry => entry.event === event);

  /** Who the presence check sees as connected. */
  const online = (...users) => {
    presence.mockReturnValue(users.map(user => ({
      id: String(user._id), username: user.username, displayName: user.username
    })));
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/admin', require('../routes/admin'));

    acme = await Company.create({ name: 'WS2 Inbox Acme' });
    rival = await Company.create({ name: 'WS2 Inbox Rival' });

    admin = await User.create({
      username: 'ws2-inbox-admin', email: 'admin@ws2inbox.example', displayName: 'Ada Admin',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    alice = await User.create({
      username: 'ws2-inbox-alice', email: 'alice@ws2inbox.example', displayName: 'Alice',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    bob = await User.create({
      username: 'ws2-inbox-bob', email: 'bob@ws2inbox.example', displayName: 'Bob',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    await User.create({
      username: 'ws2-inbox-rival', email: 'rival@ws2inbox.example',
      password: 'TestPassword123!', role: 'company_admin', company: rival._id
    });

    adminToken = await login('ws2-inbox-admin');
    aliceToken = await login('ws2-inbox-alice');
    bobToken = await login('ws2-inbox-bob');
    rivalToken = await login('ws2-inbox-rival');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Notification.deleteMany({ userId: { $in: [admin._id, alice._id, bob._id] } });
    await User.deleteMany({ email: /@ws2inbox\.example$/ });
    await Company.deleteMany({ name: /^WS2 Inbox / });
    await uploads.deleteCompanyFiles(acme._id);
  });

  beforeEach(async () => {
    emitted = [];
    socketManager.setIo(fakeIo());
    presence = jest.spyOn(assignmentService, 'connectedOperators').mockReturnValue([]);
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.updateMany({ email: /@ws2inbox\.example$/ }, { acceptingChats: true });
  });

  afterEach(() => presence.mockRestore());

  describe('the queue', () => {
    test('rows carry what triage needs, and the message count is real', async () => {
      const waitingSince = new Date(Date.now() - 4 * 60 * 1000);
      await Conversation.create({
        sessionId: 'ws2-queue-waiting',
        company: acme._id,
        domain: 'https://acme.test',
        metadata: { name: 'Bea', email: 'bea@example.com' },
        awaitingOperatorSince: waitingSince,
        handoff: { reason: 'bot_unanswered', requestedAt: waitingSince },
        messages: [
          { content: 'Where is my order?', sender: 'user' },
          { content: 'I am not sure.', sender: 'bot' },
          { content: 'The visitor asked for a person', sender: 'system' },
          { content: 'Hello?', sender: 'user' }
        ]
      });

      const response = await request(app)
        .get('/api/admin/active-chats')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      const row = response.body.chats.find(chat => chat.sessionId === 'ws2-queue-waiting');
      expect(row).toMatchObject({
        visitorName: 'Bea',
        email: 'bea@example.com',
        domain: 'https://acme.test',
        channel: 'chat',
        // Three things were said; the system line is not one of them.
        messageCount: 3,
        handoff: { reason: 'bot_unanswered' },
        operatorId: null,
        assignedToMe: false
      });
      expect(new Date(row.waitingSince).getTime()).toBe(waitingSince.getTime());
      expect(row.lastMessage).toMatchObject({ sender: 'user', content: 'Hello?' });
      expect(row.startedAt).toBeTruthy();
      expect(row.lastActivity).toBeTruthy();
    });

    test('the preview is cut to 140 characters', async () => {
      await Conversation.create({
        sessionId: 'ws2-queue-long',
        company: acme._id,
        messages: [{ content: 'x'.repeat(500), sender: 'user' }]
      });

      const response = await request(app).get('/api/admin/active-chats').set('x-auth-token', aliceToken);
      const row = response.body.chats.find(chat => chat.sessionId === 'ws2-queue-long');
      expect(row.lastMessage.content).toHaveLength(140);
    });

    test('marks the rows the caller holds', async () => {
      await Conversation.create({
        sessionId: 'ws2-queue-mine', company: acme._id, operatorId: alice._id, operatorName: 'Alice',
        hasOperator: true, messages: [{ content: 'hi', sender: 'user' }]
      });

      const asAlice = await request(app).get('/api/admin/active-chats').set('x-auth-token', aliceToken);
      const asBob = await request(app).get('/api/admin/active-chats').set('x-auth-token', bobToken);

      expect(asAlice.body.chats[0]).toMatchObject({ assignedToMe: true, operatorName: 'Alice' });
      expect(asBob.body.chats[0].assignedToMe).toBe(false);
    });

    test('leaves out rows nobody engaged in', async () => {
      await Conversation.create({ sessionId: 'ws2-queue-empty', company: acme._id, messages: [] });
      await Conversation.create({
        sessionId: 'ws2-queue-greeting-only', company: acme._id,
        messages: [{ content: 'Hi! How can I help?', sender: 'bot' }]
      });
      await Conversation.create({
        sessionId: 'ws2-queue-email', company: acme._id, channel: 'email', messages: []
      });
      await Conversation.create({
        sessionId: 'ws2-queue-form', company: acme._id, metadata: { name: 'Cy' }, messages: []
      });

      const response = await request(app).get('/api/admin/active-chats').set('x-auth-token', aliceToken);
      const ids = response.body.chats.map(chat => chat.sessionId);

      expect(ids).not.toContain('ws2-queue-empty');
      expect(ids).not.toContain('ws2-queue-greeting-only');
      expect(ids).toEqual(expect.arrayContaining(['ws2-queue-email', 'ws2-queue-form']));
    });

    test('puts the longest wait first, then the most recent activity', async () => {
      const now = Date.now();
      await Conversation.create([
        {
          sessionId: 'ws2-order-recent', company: acme._id, lastActivity: new Date(now),
          messages: [{ content: 'a', sender: 'user' }]
        },
        {
          sessionId: 'ws2-order-wait-short', company: acme._id, lastActivity: new Date(now - 1000),
          awaitingOperatorSince: new Date(now - 60 * 1000), messages: [{ content: 'b', sender: 'user' }]
        },
        {
          sessionId: 'ws2-order-wait-long', company: acme._id, lastActivity: new Date(now - 2000),
          awaitingOperatorSince: new Date(now - 10 * 60 * 1000), messages: [{ content: 'c', sender: 'user' }]
        },
        {
          sessionId: 'ws2-order-old', company: acme._id, lastActivity: new Date(now - 50000),
          messages: [{ content: 'd', sender: 'user' }]
        }
      ]);

      const response = await request(app).get('/api/admin/active-chats').set('x-auth-token', aliceToken);
      expect(response.body.chats.map(chat => chat.sessionId)).toEqual([
        'ws2-order-wait-long', 'ws2-order-wait-short', 'ws2-order-recent', 'ws2-order-old'
      ]);
    });

    test('never shows another company\'s queue', async () => {
      await Conversation.create({
        sessionId: 'ws2-queue-acme-only', company: acme._id, messages: [{ content: 'x', sender: 'user' }]
      });
      const response = await request(app).get('/api/admin/active-chats').set('x-auth-token', rivalToken);
      expect(response.body.chats.map(chat => chat.sessionId)).not.toContain('ws2-queue-acme-only');
    });
  });

  describe('one conversation', () => {
    test('says what the dashboard may offer in it', async () => {
      await Conversation.create({
        sessionId: 'ws2-chat-features', company: acme._id, operatorId: alice._id,
        metadata: { email: 'dee@example.com' }, messages: [{ content: 'x', sender: 'user' }]
      });

      const response = await request(app).get('/api/admin/chat/ws2-chat-features').set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      expect(typeof response.body.features.aiSuggestions).toBe('boolean');
      expect(typeof response.body.features.fileUploads).toBe('boolean');
      expect(response.body.heldByMe).toBe(true);
      expect(response.body.visitorOnline).toBe(false);
      expect(response.body.followUpEmail).toBe('dee@example.com');
    });
  });

  describe('transfer', () => {
    beforeEach(async () => {
      await Conversation.create({
        sessionId: 'ws2-transfer', company: acme._id, operatorId: alice._id, operatorName: 'Alice',
        hasOperator: true, botEnabled: false, messages: [{ content: 'hello', sender: 'user' }]
      });
    });

    test('refuses a colleague who is not online, and changes nothing', async () => {
      online(alice);

      const response = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: String(bob._id) });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/not online/);
      const conversation = await Conversation.findOne({ sessionId: 'ws2-transfer' });
      expect(String(conversation.operatorId)).toBe(String(alice._id));
      expect(conversation.botEnabled).toBe(false);
      expect(conversation.notes).toHaveLength(0);
    });

    test('refuses a colleague who is not taking conversations', async () => {
      online(alice, bob);
      await User.findByIdAndUpdate(bob._id, { acceptingChats: false });

      const response = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: String(bob._id) });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/not taking new conversations/);
    });

    test('hands it over, tells the colleague, and records it in the transcript', async () => {
      online(alice, bob);

      const response = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: String(bob._id), note: 'Refund approved' });

      expect(response.status).toBe(200);
      const conversation = await Conversation.findOne({ sessionId: 'ws2-transfer' });
      expect(String(conversation.operatorId)).toBe(String(bob._id));
      expect(conversation.messages.at(-1)).toMatchObject({ sender: 'system' });
      expect(conversation.messages.at(-1).content).toMatch(/transferred the conversation to Bob/);

      const notification = await eventually(() => Notification.findOne({ userId: bob._id, type: 'chat_transferred' }));
      expect(notification).not.toBeNull();
      expect(notification.sessionId).toBe('ws2-transfer');
      expect(notification.link).toBe('?section=active-chats&chat=ws2-transfer');
      expect(sent('chat-transferred-to-you')[0].room).toBe(`user:${bob._id}`);
      expect(sent('conversation-message')[0].payload.message.sender).toBe('system');
    });

    test('an admin can hand a company admin a chat', async () => {
      online(admin);
      await Conversation.updateOne({ sessionId: 'ws2-transfer' }, { $set: { operatorId: null, hasOperator: false } });

      const response = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', aliceToken)
        .send({ operatorId: String(admin._id) });

      expect(response.status).toBe(200);
    });

    test('a colleague cannot move a chat somebody else holds', async () => {
      online(alice, bob, admin);

      const response = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', bobToken)
        .send({ operatorId: String(admin._id) });

      expect(response.status).toBe(409);
      expect(response.body.heldBy).toMatchObject({ name: 'Alice' });
    });

    test('an admin can, but only by saying so', async () => {
      online(alice, bob, admin);

      const refused = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', adminToken)
        .send({ operatorId: String(bob._id) });
      const forced = await request(app)
        .post('/api/admin/chat/ws2-transfer/transfer')
        .set('x-auth-token', adminToken)
        .send({ operatorId: String(bob._id), force: true });

      expect(refused.status).toBe(409);
      expect(forced.status).toBe(200);
    });

    test('the pick-list has admins and operators, with presence', async () => {
      online(bob);

      const response = await request(app)
        .get('/api/admin/chat/ws2-transfer/transfer-targets')
        .set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      const byName = Object.fromEntries(response.body.operators.map(person => [person.username, person]));
      expect(byName['ws2-inbox-alice']).toBeUndefined();
      expect(byName['ws2-inbox-bob']).toMatchObject({ online: true, accepting: true, role: 'operator' });
      expect(byName['ws2-inbox-admin']).toMatchObject({ online: false, role: 'company_admin' });
      // Who can take it now comes first.
      expect(response.body.operators[0].username).toBe('ws2-inbox-bob');
    });
  });

  describe('ending', () => {
    beforeEach(async () => {
      await Conversation.create({
        sessionId: 'ws2-end', company: acme._id, operatorId: alice._id, operatorName: 'Alice',
        hasOperator: true, messages: [{ content: 'thanks', sender: 'user' }]
      });
    });

    test('stores the outcome and tells the queue', async () => {
      const response = await request(app)
        .post('/api/admin/chat/ws2-end/end')
        .set('x-auth-token', aliceToken)
        .send({ outcome: { status: 'resolved', note: 'Sent the tracking link' } });

      expect(response.status).toBe(200);
      const conversation = await Conversation.findOne({ sessionId: 'ws2-end' });
      expect(conversation.status).toBe('ended');
      expect(conversation.outcome).toMatchObject({ status: 'resolved', note: 'Sent the tracking link' });
      expect(String(conversation.outcome.by)).toBe(String(alice._id));
      expect(sent('chat-ended').map(entry => entry.room)).toEqual(
        expect.arrayContaining(['ws2-end', `operators:${acme._id}`]));
      expect(sent('chat-ended').find(entry => entry.room === 'ws2-end').payload.code).toBe('chat_ended');
    });

    test('refuses an outcome that is not one', async () => {
      const response = await request(app)
        .post('/api/admin/chat/ws2-end/end')
        .set('x-auth-token', aliceToken)
        .send({ outcome: { status: 'great' } });

      expect(response.status).toBe(400);
    });

    test('a colleague cannot end it; an admin can when they say so', async () => {
      const colleague = await request(app).post('/api/admin/chat/ws2-end/end').set('x-auth-token', bobToken).send({});
      const forced = await request(app).post('/api/admin/chat/ws2-end/end').set('x-auth-token', adminToken).send({ force: true });

      expect(colleague.status).toBe(409);
      expect(forced.status).toBe(200);
    });
  });

  describe('deleting', () => {
    test('is for admins only', async () => {
      await Conversation.create({
        sessionId: 'ws2-delete-gate', company: acme._id, messages: [{ content: 'x', sender: 'user' }]
      });

      const response = await request(app).delete('/api/admin/chat/ws2-delete-gate').set('x-auth-token', aliceToken);

      expect(response.status).toBe(403);
      expect(await Conversation.findOne({ sessionId: 'ws2-delete-gate' })).not.toBeNull();
    });

    test('removes the files, tells the operators and is audited', async () => {
      const fileId = await uploads.storeFile(acme._id, Buffer.from('%PDF-1.4 test'));
      const onDisk = uploads.filePath(acme._id, fileId);
      await Conversation.create({
        sessionId: 'ws2-delete-files', company: acme._id,
        messages: [{ content: 'form.pdf', sender: 'user', fileId, fileName: 'form.pdf' }]
      });
      expect(fs.existsSync(onDisk)).toBe(true);

      const response = await request(app).delete('/api/admin/chat/ws2-delete-files').set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.filesDeleted).toBe(1);
      expect(fs.existsSync(onDisk)).toBe(false);
      expect(await Conversation.findOne({ sessionId: 'ws2-delete-files' })).toBeNull();
      expect(sent('conversation-deleted')[0].payload).toEqual({ sessionId: 'ws2-delete-files' });
      expect(await eventually(() => AuditLog.findOne({ action: 'conversation.deleted', 'target.id': 'ws2-delete-files' })))
        .not.toBeNull();
    });
  });

  describe('history', () => {
    beforeEach(async () => {
      const contact = await Contact.create({ company: acme._id, name: 'Erin Example', email: 'erin@example.com' });
      await Conversation.create([
        {
          sessionId: 'ws2-history-bot', company: acme._id, status: 'ended', channel: 'chat',
          rating: { score: 5 }, tags: ['billing'],
          messages: [{ content: 'What are your hours?', sender: 'user' }, { content: '9 to 5', sender: 'bot' }]
        },
        {
          sessionId: 'ws2-history-person', company: acme._id, status: 'ended', operatorEverJoined: true,
          rating: { score: 1 }, outcome: { status: 'unresolved' }, contact: contact._id,
          messages: [
            { content: 'Refund please', sender: 'user' },
            { content: 'Looking now', sender: 'operator', operatorName: 'Alice' }
          ]
        },
        {
          sessionId: 'ws2-history-email', company: acme._id, channel: 'email',
          email: { from: 'fred@example.com', subject: 'Invoice' },
          messages: [{ content: 'Invoice question', sender: 'user' }]
        },
        { sessionId: 'ws2-history-empty', company: acme._id, messages: [] }
      ]);
    });

    const history = query => request(app)
      .get('/api/admin/chat-history')
      .query(query)
      .set('x-auth-token', aliceToken)
      .then(response => response.body.history.map(row => row.sessionId));

    test('shows who handled it, the rating and the outcome, and leaves out empty rows', async () => {
      const response = await request(app).get('/api/admin/chat-history').set('x-auth-token', aliceToken);
      const rows = Object.fromEntries(response.body.history.map(row => [row.sessionId, row]));

      expect(rows['ws2-history-empty']).toBeUndefined();
      expect(rows['ws2-history-bot']).toMatchObject({ handledBy: 'bot', rating: 5, messageCount: 2 });
      expect(rows['ws2-history-person']).toMatchObject({
        handledBy: 'person', operators: ['Alice'], rating: 1, outcome: 'unresolved'
      });
    });

    test('search finds a name on the person, an address and a tag', async () => {
      expect(await history({ search: 'Erin' })).toEqual(['ws2-history-person']);
      expect(await history({ search: 'fred@example' })).toEqual(['ws2-history-email']);
      expect(await history({ search: 'billing' })).toEqual(['ws2-history-bot']);
    });

    test('filters combine', async () => {
      expect(await history({ handledBy: 'bot', channel: 'chat' })).toEqual(['ws2-history-bot']);
      expect(await history({ rating: 'low' })).toEqual(['ws2-history-person']);
      expect((await history({ rating: 'none' })).sort()).toEqual(['ws2-history-email']);
      expect(await history({ outcome: 'unresolved' })).toEqual(['ws2-history-person']);
      expect(await history({ channel: 'email' })).toEqual(['ws2-history-email']);
      expect(await history({ tag: 'billing', status: 'ended' })).toEqual(['ws2-history-bot']);
      expect(await history({ handledBy: 'person', search: 'hours' })).toEqual([]);
    });
  });

  describe('export', () => {
    beforeEach(async () => {
      await Conversation.create([
        {
          sessionId: 'ws2-export-formula', company: acme._id, status: 'ended',
          metadata: { name: '=HYPERLINK("https://evil.example","x")', email: 'mallory@example.com' },
          outcome: { status: 'spam' }, rating: { score: 2 },
          messages: [{ content: '+1 call me', sender: 'user' }]
        },
        {
          sessionId: 'ws2-export-other', company: acme._id, status: 'active',
          metadata: { name: 'Gail' }, messages: [{ content: 'hi', sender: 'user' }]
        }
      ]);
    });

    test('is for admins only', async () => {
      const response = await request(app).get('/api/admin/export?type=conversations').set('x-auth-token', aliceToken);
      expect(response.status).toBe(403);
    });

    test('neutralises formulas, has the new columns, honours the filters and is audited', async () => {
      const response = await request(app)
        .get('/api/admin/export')
        .query({ type: 'conversations', status: 'ended' })
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      const csv = response.text;
      expect(csv).toContain('"Handled By"');
      expect(csv).toContain('"Outcome"');
      expect(csv).toContain('"Rating"');
      expect(csv).toContain('"\'=HYPERLINK(""https://evil.example"",""x"")"');
      expect(csv).not.toMatch(/(^|,)"=/m);
      expect(csv).toContain('"Spam"');
      expect(csv).not.toContain('ws2-export-other');

      const entry = await eventually(() => AuditLog.findOne({ action: 'conversations.exported', company: acme._id }));
      expect(entry).not.toBeNull();
      expect(entry.details.get ? entry.details.get('rows') : entry.details.rows).toBe(1);
    });
  });

  describe('notes', () => {
    beforeEach(async () => {
      await Conversation.create({
        sessionId: 'ws2-notes', company: acme._id, messages: [{ content: 'x', sender: 'user' }]
      });
    });

    test('a new note comes back, and goes out, with its id', async () => {
      const response = await request(app)
        .post('/api/admin/chat/ws2-notes/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Called them' });

      expect(response.status).toBe(201);
      expect(response.body.note._id).toMatch(/^[a-f0-9]{24}$/);
      expect(sent('conversation-note')[0].payload.note._id).toBe(response.body.note._id);
    });

    test('a deletion is broadcast', async () => {
      const { body } = await request(app)
        .post('/api/admin/chat/ws2-notes/notes')
        .set('x-auth-token', aliceToken)
        .send({ body: 'Temporary' });

      await request(app)
        .delete(`/api/admin/chat/ws2-notes/notes/${body.note._id}`)
        .set('x-auth-token', aliceToken)
        .expect(200);

      expect(sent('conversation-note-deleted')[0].payload).toEqual({
        sessionId: 'ws2-notes', noteId: body.note._id
      });
    });
  });

  describe('availability', () => {
    test('can be read back', async () => {
      await User.findByIdAndUpdate(alice._id, { acceptingChats: false, maxConcurrentChats: 4 });

      const response = await request(app).get('/api/admin/me/availability').set('x-auth-token', aliceToken);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ acceptingChats: false, maxConcurrentChats: 4 });
      await User.findByIdAndUpdate(alice._id, { acceptingChats: true, $unset: { maxConcurrentChats: 1 } });
    });
  });

  describe('the customer\'s details', () => {
    test('an edit reaches the person in People too', async () => {
      const contact = await Contact.create({ company: acme._id, name: 'Old Name', sessionIds: ['ws2-details'] });
      await Conversation.create({
        sessionId: 'ws2-details', company: acme._id, contact: contact._id,
        messages: [{ content: 'x', sender: 'user' }]
      });

      const response = await request(app)
        .post('/api/admin/chat/ws2-details/contact-info')
        .set('x-auth-token', aliceToken)
        .send({ name: 'New Name', email: 'new@example.com', phone: '+44 20 7946 0000' });

      expect(response.status).toBe(200);
      const stored = await Contact.findById(contact._id);
      expect(stored).toMatchObject({ name: 'New Name', email: 'new@example.com', identityLevel: 'claimed' });
      expect(sent('user-details-updated')[0].payload).toMatchObject({ sessionId: 'ws2-details', name: 'New Name' });
    });

    test('a bad address is refused with a message saying so', async () => {
      await Conversation.create({
        sessionId: 'ws2-details-bad', company: acme._id, messages: [{ content: 'x', sender: 'user' }]
      });

      const response = await request(app)
        .post('/api/admin/chat/ws2-details-bad/contact-info')
        .set('x-auth-token', aliceToken)
        .send({ email: 'not-an-address' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/email address/);
    });
  });

  describe('replying by email', () => {
    const emailChannel = require('../services/email-channel');
    // The email channel's own sendFollowUp (another workstream's) is put back
    // after each test; these only check what the route does with an answer.
    const original = emailChannel.sendFollowUp;

    beforeEach(async () => {
      await Conversation.create({
        sessionId: 'ws2-follow-up', company: acme._id, status: 'ended',
        followUp: { email: 'hal@example.com' }, messages: [{ content: 'x', sender: 'user' }]
      });
    });

    afterEach(() => {
      if (original) {
        emailChannel.sendFollowUp = original;
      } else {
        delete emailChannel.sendFollowUp;
      }
    });

    test('hands the reply to the email channel', async () => {
      emailChannel.sendFollowUp = jest.fn().mockResolvedValue({ sent: true, to: 'hal@example.com' });

      const response = await request(app)
        .post('/api/admin/chat/ws2-follow-up/follow-up')
        .set('x-auth-token', aliceToken)
        .send({ message: 'Your refund went through.' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ sent: true, to: 'hal@example.com' });
      const [conversation, text, user] = emailChannel.sendFollowUp.mock.calls[0];
      expect(conversation.sessionId).toBe('ws2-follow-up');
      expect(text).toBe('Your refund went through.');
      expect(String(user.id)).toBe(String(alice._id));
    });

    test('says why when it could not be sent', async () => {
      emailChannel.sendFollowUp = jest.fn().mockResolvedValue({ sent: false, reason: 'No email address' });

      const response = await request(app)
        .post('/api/admin/chat/ws2-follow-up/follow-up')
        .set('x-auth-token', aliceToken)
        .send({ message: 'Hello' });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe('No email address');
    });

    test('refuses an empty reply', async () => {
      emailChannel.sendFollowUp = jest.fn();
      const response = await request(app)
        .post('/api/admin/chat/ws2-follow-up/follow-up')
        .set('x-auth-token', aliceToken)
        .send({ message: '  ' });

      expect(response.status).toBe(400);
      expect(emailChannel.sendFollowUp).not.toHaveBeenCalled();
    });
  });
});
