/**
 * Operators sending files.
 *
 * Visitors could attach a file and operators could not answer with one. This
 * covers the route that lets them, and the two things that make it useful:
 * the visitor hears about it over the same event as a typed reply, and can
 * actually download it with the credentials the widget holds - a session
 * token, not a cookie that a third-party context will often drop.
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const sessionToken = require('../services/session-token');
const uploads = require('../services/uploads');
const socketManager = require('../socketManager');

const VISITOR_TOKEN = 'visitor-secret-token';

describe('Operator attachments', () => {
  let app;
  let acme;
  let rival;
  let acmeToken;
  let rivalToken;
  let emitted;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const sendFile = (token, sessionId, { name = 'returns-form.pdf', type = 'application/pdf', body = '%PDF-1.4 test' } = {}) =>
    request(app)
      .post(`/api/admin/conversations/${sessionId}/files`)
      .set('x-auth-token', token)
      .attach('file', Buffer.from(body), { filename: name, contentType: type });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/admin', require('../routes/admin'));
    app.use('/api/upload', require('../routes/upload'));

    acme = await Company.create({ name: 'Attach Acme Co' });
    rival = await Company.create({ name: 'Attach Rival Co' });

    await User.create({
      username: 'attach-operator', email: 'operator@attach.example', displayName: 'Olive Operator',
      password: 'TestPassword123!', role: 'operator', company: acme._id
    });
    await User.create({
      username: 'attach-rival', email: 'rival@attach.example',
      password: 'TestPassword123!', role: 'operator', company: rival._id
    });

    await Conversation.create({
      sessionId: 'attach-session', company: acme._id, messages: [],
      sessionTokenHash: sessionToken.hash(VISITOR_TOKEN)
    });
    await Conversation.create({
      sessionId: 'attach-email-session', company: acme._id, channel: 'email', messages: []
    });

    acmeToken = await login('attach-operator');
    rivalToken = await login('attach-rival');
  });

  beforeEach(() => {
    emitted = [];
    socketManager.setIo({
      to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) })
    });
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^attach-/ });
    await User.deleteMany({ email: /@attach\.example$/ });
    await Company.deleteMany({ name: /^Attach / });
    await uploads.deleteCompanyFiles(acme._id);
    await uploads.deleteCompanyFiles(rival._id);
  });

  it('stores the file and appends an operator message', async () => {
    const response = await sendFile(acmeToken, 'attach-session');

    expect(response.status).toBe(201);
    const { message } = response.body;
    expect(message).toMatchObject({
      content: 'returns-form.pdf',
      sender: 'operator',
      operatorName: 'Olive Operator',
      fileName: 'returns-form.pdf'
    });
    expect(message.fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(message.fileUrl).toBe(`/api/upload/${message.fileId}`);

    const conversation = await Conversation.findOne({ sessionId: 'attach-session' });
    const stored = conversation.messages.find(m => m.fileId === message.fileId);
    expect(stored.sender).toBe('operator');
    expect(stored.fileName).toBe('returns-form.pdf');
    expect(String(stored.operatorId)).toBeTruthy();
  });

  it('tells the visitor and the operators with the usual events plus the file', async () => {
    const response = await sendFile(acmeToken, 'attach-session');
    const { fileId, id } = response.body.message;

    const toVisitor = emitted.find(e => e.room === 'attach-session');
    expect(toVisitor.event).toBe('operator-message');
    expect(toVisitor.payload).toMatchObject({
      id,
      text: 'returns-form.pdf',
      senderName: 'Olive Operator',
      fileId,
      fileName: 'returns-form.pdf',
      fileUrl: `/api/upload/${fileId}`
    });

    const toOperators = emitted.find(e => e.room === `operators:${acme._id}`);
    expect(toOperators.event).toBe('new-message');
    expect(toOperators.payload).toMatchObject({
      sessionId: 'attach-session',
      sender: 'operator',
      fileId,
      fileName: 'returns-form.pdf',
      fileUrl: `/api/upload/${fileId}`
    });
  });

  it('lets the visitor download it with their session token', async () => {
    const { fileId } = (await sendFile(acmeToken, 'attach-session')).body.message;

    const response = await request(app)
      .get(`/api/upload/${fileId}`)
      .query({ sessionId: 'attach-session', sessionToken: VISITOR_TOKEN });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('refuses a download with the wrong token or another session id', async () => {
    const { fileId } = (await sendFile(acmeToken, 'attach-session')).body.message;

    const wrongToken = await request(app)
      .get(`/api/upload/${fileId}`)
      .query({ sessionId: 'attach-session', sessionToken: 'guess' });
    expect(wrongToken.status).toBe(401);

    const wrongSession = await request(app)
      .get(`/api/upload/${fileId}`)
      .set('x-session-id', 'someone-else')
      .set('x-session-token', VISITOR_TOKEN);
    expect(wrongSession.status).toBe(401);
  });

  it('serves an image inline only when asked, as an image', async () => {
    const { fileId } = (await sendFile(acmeToken, 'attach-session', {
      name: 'where-to-click.png', type: 'image/png', body: 'png-bytes'
    })).body.message;

    const inline = await request(app)
      .get(`/api/upload/${fileId}`)
      .query({ sessionId: 'attach-session', sessionToken: VISITOR_TOKEN, inline: '1' });
    expect(inline.status).toBe(200);
    expect(inline.headers['content-type']).toBe('image/png');
    expect(inline.headers['content-disposition']).toContain('inline');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');

    const plain = await request(app)
      .get(`/api/upload/${fileId}`)
      .query({ sessionId: 'attach-session', sessionToken: VISITOR_TOKEN });
    expect(plain.headers['content-type']).toBe('application/octet-stream');
  });

  it('never serves a non-image inline', async () => {
    const { fileId } = (await sendFile(acmeToken, 'attach-session')).body.message;

    const response = await request(app)
      .get(`/api/upload/${fileId}`)
      .query({ sessionId: 'attach-session', sessionToken: VISITOR_TOKEN, inline: '1' });
    expect(response.headers['content-type']).toBe('application/octet-stream');
  });

  it('lets operators of the company download it, and nobody else', async () => {
    const { fileId } = (await sendFile(acmeToken, 'attach-session')).body.message;

    const own = await request(app).get(`/api/upload/${fileId}`).set('x-auth-token', acmeToken);
    expect(own.status).toBe(200);

    const other = await request(app).get(`/api/upload/${fileId}`).set('x-auth-token', rivalToken);
    expect(other.status).toBe(404);
  });

  it('does not let another company send into the conversation', async () => {
    const response = await sendFile(rivalToken, 'attach-session');
    expect(response.status).toBe(404);
    expect(emitted).toHaveLength(0);
  });

  it('holds operators to the same allowlist as visitors', async () => {
    const response = await sendFile(acmeToken, 'attach-session', {
      name: 'page.html', type: 'text/html', body: '<script>alert(1)</script>'
    });
    expect(response.status).toBe(400);
    expect(emitted).toHaveLength(0);
  });

  it('asks for a file', async () => {
    const response = await request(app)
      .post('/api/admin/conversations/attach-session/files')
      .set('x-auth-token', acmeToken);
    expect(response.status).toBe(400);
  });

  it('refuses email conversations, which cannot carry the file yet', async () => {
    const response = await sendFile(acmeToken, 'attach-email-session');
    expect(response.status).toBe(409);
  });

  it('requires a signed-in operator', async () => {
    const response = await request(app)
      .post('/api/admin/conversations/attach-session/files')
      .attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(response.status).toBe(401);
  });
});
