/**
 * A file can be the first thing a visitor sends.
 *
 * Conversations are created when the visitor first does something, and the
 * upload route used to require one to exist already - so a visitor whose
 * first act was attaching a screenshot got a 404. An upload that presents the
 * token the widget was given now starts the conversation under that token;
 * one that presents nothing still gets nothing.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Usage = require('../models/usage');
const sessionToken = require('../services/session-token');
const socketManager = require('../socketManager');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/upload', require('../routes/upload'));
  return app;
};

describe('WS1: an upload as the first thing a visitor does', () => {
  let app;
  let acme;
  const fresh = () => `ws1-upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const send = (fields) => {
    let req = request(app).post('/api/upload');
    Object.entries(fields).forEach(([key, value]) => {
      req = req.field(key, value);
    });
    return req.attach('file', Buffer.from('a screenshot, honestly'), { filename: 'shot.txt', contentType: 'text/plain' });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    acme = await Company.create({ name: 'Upload WS1 Acme' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^ws1-upload-/ });
    await Contact.deleteMany({ company: acme._id });
    await Usage.deleteMany({ company: acme._id });
    await Company.deleteMany({ name: /^Upload WS1/ });
  });

  test('starts the conversation under the visitor\'s token, metered and announced', async () => {
    const emitted = jest.spyOn(socketManager, 'emitToOperators').mockReturnValue(true);
    const sessionId = fresh();
    const token = sessionToken.issue();

    const response = await send({ sessionId, sessionToken: token, widgetKey: acme.widgetKey });

    expect(response.status).toBe(200);
    const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
    expect(conversation.sessionTokenHash).toBe(sessionToken.hash(token));
    expect(String(conversation.company)).toBe(String(acme._id));
    expect(conversation.messages[0]).toMatchObject({ sender: 'user', fileName: 'shot.txt' });

    const events = emitted.mock.calls.map(([, event]) => event);
    expect(events).toEqual(expect.arrayContaining(['conversation-message', 'new-chat']));

    const usage = await Usage.findOne({ company: acme._id, period: Usage.currentPeriod() }).lean();
    expect(usage.conversations).toBe(1);
  });

  test('a second file goes on the same conversation, and needs the same token', async () => {
    const sessionId = fresh();
    const token = sessionToken.issue();
    await send({ sessionId, sessionToken: token, widgetKey: acme.widgetKey });

    expect((await send({ sessionId, sessionToken: token })).status).toBe(200);
    expect((await send({ sessionId, sessionToken: sessionToken.issue() })).status).toBe(403);
    expect(await Conversation.countDocuments({ sessionId })).toBe(1);
  });

  test('without a token, or with something that is not one, nothing is created', async () => {
    const sessionId = fresh();

    expect((await send({ sessionId, widgetKey: acme.widgetKey })).status).toBe(404);
    expect((await send({ sessionId, sessionToken: 'guessable', widgetKey: acme.widgetKey })).status).toBe(404);
    expect(await Conversation.findOne({ sessionId })).toBeNull();
  });
});
