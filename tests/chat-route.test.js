/**
 * The REST fallback for clients that cannot hold a socket open.
 *
 * It has to enforce the same ownership rule as the socket layer: a session id
 * alone is not a credential, and a conversation that has a token demands it.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant' })
}));

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const replyService = require('../services/reply');
const sessionTokenService = require('../services/session-token');

/** The cookie session, without the cookie: every request carries a fixed id. */
const buildApp = (sessionId) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { sessionId };
    next();
  });
  app.use('/api/chat', require('../routes/chat'));
  return app;
};

describe('REST chat', () => {
  let acme;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    acme = await Company.create({ name: 'Rest Chat Acme' });
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^rest-/ });
    await Subscription.deleteMany({ company: acme._id });
    await Company.deleteMany({ name: /^Rest Chat/ });
  });

  const fresh = () => `rest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  test('the first message creates the conversation and returns its token', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);

    const response = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    expect(response.status).toBe(200);
    expect(response.body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body.message.content).toBe('A reply from the bot');

    const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
    expect(conversation.sessionTokenHash).toBe(sessionTokenService.hash(response.body.sessionToken));
  });

  test('a reply carries its sources, stores them, and history returns them', async () => {
    const sources = [{ title: 'Delivery', url: 'https://example.com/delivery' }];
    replyService.generate.mockResolvedValueOnce({ text: 'Three days.', source: 'assistant', sources });

    const sessionId = fresh();
    const app = buildApp(sessionId);
    const response = await request(app)
      .post('/api/chat/message')
      .send({ message: 'how long is delivery?', widgetKey: acme.widgetKey });

    expect(response.body.message.sources).toEqual(sources);

    const conversation = await Conversation.findOne({ sessionId }).lean();
    expect(conversation.messages.at(-1).sources).toEqual(sources);

    const history = await request(app)
      .get('/api/chat/history')
      .query({ sessionToken: response.body.sessionToken });
    expect(history.body.messages.at(-1).sources).toEqual(sources);
    expect(history.body.messages[0].sources).toBeUndefined();
  });

  test('a later message without the token is refused', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);
    await request(app).post('/api/chat/message').send({ message: 'hello', widgetKey: acme.widgetKey });

    const response = await request(app).post('/api/chat/message').send({ message: 'me again' });

    expect(response.status).toBe(403);
    expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(2);
  });

  test('a later message with the token goes through', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);
    const first = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    const response = await request(app)
      .post('/api/chat/message')
      .send({ message: 'me again', sessionToken: first.body.sessionToken });

    expect(response.status).toBe(200);
    // The token is only handed out once, when the conversation is created.
    expect(response.body.sessionToken).toBeUndefined();
    expect((await Conversation.findOne({ sessionId })).messages).toHaveLength(4);
  });

  test('history needs the token too, and carries message ids', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);
    const first = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    expect((await request(app).get('/api/chat/history')).status).toBe(403);

    const response = await request(app)
      .get('/api/chat/history')
      .query({ sessionToken: first.body.sessionToken });

    expect(response.status).toBe(200);
    expect(response.body.messages.map(m => m.sender)).toEqual(['user', 'bot']);
    response.body.messages.forEach(message => expect(message.id).toMatch(/^[0-9a-f]{24}$/));
  });

  test('a session named in the body is accepted when its token is presented', async () => {
    // The reason the REST path exists: a client that cannot hold a cookie.
    const sessionId = fresh();
    const first = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    // A different cookie session, naming the conversation explicitly.
    const response = await request(buildApp(fresh()))
      .post('/api/chat/message')
      .send({ sessionId, sessionToken: first.body.sessionToken, message: 'from another device' });

    expect(response.status).toBe(200);
    expect((await Conversation.findOne({ sessionId })).messages.map(m => m.content))
      .toContain('from another device');
  });

  test('a conversation from before tokens existed is upgraded on first contact', async () => {
    const sessionId = fresh();
    await Conversation.create({ sessionId, company: acme._id, messages: [] });
    const app = buildApp(sessionId);

    const response = await request(app).post('/api/chat/message').send({ message: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(app).post('/api/chat/message').send({ message: 'again' })).status).toBe(403);
  });

  test('a tenant over their reply allowance is handed to the team, with no model call', async () => {
    // Changed on purpose: this used to answer "unavailable" and stop there.
    const capped = await Company.create({ name: 'Rest Chat Capped' });
    await Subscription.create({
      company: capped._id, planId: 'basic', status: 'active',
      limitOverrides: { aiResponsesPerMonth: 0 }
    });

    const sessionId = fresh();
    const response = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: capped.widgetKey });

    expect(response.status).toBe(200);
    expect(response.body.handoff).toMatchObject({ reason: 'quota', offline: true, followUpRequested: true });
    expect(response.body.message).toMatchObject({ code: 'queued_offline', sender: 'bot' });
    expect(replyService.generate).not.toHaveBeenCalled();
    expect((await Conversation.findOne({ sessionId })).handoff.reason).toBe('quota');

    await Subscription.deleteMany({ company: capped._id });
    await Company.deleteOne({ _id: capped._id });
  });

  test('a failed reply hands over, never an error and never a 500', async () => {
    replyService.generate.mockRejectedValueOnce(new Error('model unavailable'));
    const sessionId = fresh();

    const response = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    expect(response.status).toBe(200);
    expect(response.body.failed).toBe(true);
    expect(response.body.handoff.reason).toBe('model_error');
    expect(response.body.message).toMatchObject({ code: 'reply_failed', path: 'handoff' });
    // The client still gets the token, or it could never come back.
    expect(response.body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a reply that came back empty is a failure too', async () => {
    // What services/ai.js now returns when the model call fails.
    replyService.generate.mockResolvedValueOnce({ text: null, source: 'assistant', path: 'fallback' });

    const response = await request(buildApp(fresh()))
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey });

    expect(response.body.failed).toBe(true);
    expect(response.body.handoff.reason).toBe('model_error');
  });

  test('a tenant that may not start a conversation gets the unavailable notice, and nothing is created', async () => {
    const lapsed = await Company.create({ name: 'Rest Chat Lapsed' });
    await Subscription.create({ company: lapsed._id, planId: 'basic', status: 'suspended' });
    const sessionId = fresh();

    const response = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: lapsed.widgetKey });

    expect(response.body.unavailable).toBe(true);
    expect(response.body.message).toMatchObject({ code: 'unavailable', sender: 'bot' });
    expect(await Conversation.findOne({ sessionId })).toBeNull();

    await Subscription.deleteMany({ company: lapsed._id });
    await Company.deleteOne({ _id: lapsed._id });
  });
});
