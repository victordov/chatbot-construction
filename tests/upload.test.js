/**
 * Chat file uploads.
 *
 * The widget's attachment button posted to /api/upload, which did not exist.
 * These tests cover the route that now backs it, and in particular the
 * properties that make an unauthenticated upload endpoint safe.
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/upload', require('../routes/upload'));
  return app;
};

describe('File uploads', () => {
  let app;
  let owner;
  let other;
  let ownerToken;
  let otherToken;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    owner = await Company.create({ name: 'Upload Owner Co' });
    other = await Company.create({ name: 'Upload Other Co' });

    await User.create({
      username: 'upload-owner', email: 'owner@upload.example',
      password: 'TestPassword123!', role: 'company_admin', company: owner._id
    });
    await User.create({
      username: 'upload-other', email: 'other@upload.example',
      password: 'TestPassword123!', role: 'company_admin', company: other._id
    });

    await Conversation.create({ sessionId: 'upload-session', company: owner._id, messages: [] });

    const login = async username => (await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' })).body.token;

    ownerToken = await login('upload-owner');
    otherToken = await login('upload-other');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^upload-/ });
    await User.deleteMany({ email: /@upload\.example$/ });
    await Company.deleteMany({ name: /^Upload / });
    fs.rmSync(path.join(__dirname, '..', 'uploads'), { recursive: true, force: true });
  });

  const uploadNote = () => request(app)
    .post('/api/upload')
    .field('sessionId', 'upload-session')
    .attach('file', Buffer.from('confidential attachment'), {
      filename: 'note.txt', contentType: 'text/plain'
    });

  test('stores an allowed file against the conversation', async () => {
    const response = await uploadNote();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.fileId).toMatch(/^[a-f0-9]{32}$/);

    const conversation = await Conversation.findOne({ sessionId: 'upload-session' });
    const message = conversation.messages.find(m => m.fileId === response.body.fileId);
    expect(message).toBeDefined();
    expect(message.fileName).toBe('note.txt');
  });

  test('refuses a type that could execute on this origin', async () => {
    const response = await request(app)
      .post('/api/upload')
      .field('sessionId', 'upload-session')
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.html', contentType: 'text/html'
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test('refuses an upload for a session with no conversation', async () => {
    const response = await request(app)
      .post('/api/upload')
      .field('sessionId', 'no-such-session')
      .attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(response.status).toBe(404);
  });

  describe('download', () => {
    let fileId;

    beforeAll(async () => {
      fileId = (await uploadNote()).body.fileId;
    });

    test('requires authentication', async () => {
      const response = await request(app).get(`/api/upload/${fileId}`);
      expect(response.status).toBe(401);
    });

    test('another company cannot read the file', async () => {
      const response = await request(app)
        .get(`/api/upload/${fileId}`)
        .set('x-auth-token', otherToken);

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('confidential attachment');
    });

    test('the owning company can read the file, as an attachment', async () => {
      const response = await request(app)
        .get(`/api/upload/${fileId}`)
        .set('x-auth-token', ownerToken)
        // The response is served as octet-stream, so supertest hands it back
        // as a Buffer in `body` rather than parsing it into `text`.
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('confidential attachment');
      // Never inline: an uploaded file must not render on this origin.
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-type']).toContain('application/octet-stream');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    test('a traversal-shaped id is rejected before touching the filesystem', async () => {
      const response = await request(app)
        .get('/api/upload/..%2f..%2fserver.js')
        .set('x-auth-token', ownerToken);

      expect(response.status).toBe(400);
    });
  });
});
