/**
 * The REST fallback follows the socket's rules.
 *
 * A client that cannot hold a socket open gets the same conversation as one
 * that can: created on the first message and announced then, handed to the
 * team rather than apologised at, offered a person when the bot does not know,
 * and given back a history without the operators' transcript events in it.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const replyService = require('../services/reply');
const webhooks = require('../services/webhooks');
const socketManager = require('../socketManager');

const buildApp = sessionId => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { sessionId };
    next();
  });
  app.use('/api/chat', require('../routes/chat'));
  return app;
};

describe('WS1: the REST fallback', () => {
  let acme;
  const fresh = () => `ws1-rest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    acme = await Company.create({ name: 'Rest WS1 Acme' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    replyService.generate.mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' });
  });

  afterAll(async () => {
    await Conversation.deleteMany({ sessionId: /^ws1-rest-/ });
    await Contact.deleteMany({ company: acme._id });
    await Company.deleteMany({ name: /^Rest WS1/ });
  });

  test('the first message starts the conversation: announced to operators, with the webhook', async () => {
    const dispatch = jest.spyOn(webhooks, 'dispatch');
    const emitted = jest.spyOn(socketManager, 'emitToOperators').mockReturnValue(true);
    const sessionId = fresh();

    const response = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'Do you deliver on Sundays?', widgetKey: acme.widgetKey });

    expect(response.status).toBe(200);
    expect(emitted).toHaveBeenCalledWith(String(acme._id), 'new-chat', expect.objectContaining({
      sessionId, channel: 'chat', preview: 'Do you deliver on Sundays?'
    }));
    expect(dispatch.mock.calls.filter(([, event]) => event === 'conversation.started')).toHaveLength(1);
    expect(response.body.message).toMatchObject({ path: 'assistant', canRate: true });

    const conversation = await Conversation.findOne({ sessionId });
    expect(conversation.contact).toBeTruthy();
  });

  test('a request sent twice with the same id is stored and answered once', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);
    const first = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey, clientMessageId: 'r-1' });

    const again = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', sessionToken: first.body.sessionToken, clientMessageId: 'r-1' });

    expect(again.body).toMatchObject({ success: true, duplicate: true });
    expect((await Conversation.findOne({ sessionId })).messages.filter(m => m.sender === 'user')).toHaveLength(1);
    expect(replyService.generate).toHaveBeenCalledTimes(1);
  });

  test('asking for a person in words hands over instead of answering', async () => {
    const response = await request(buildApp(fresh()))
      .post('/api/chat/message')
      .send({ message: 'I want to speak to a human', widgetKey: acme.widgetKey });

    expect(response.body.handoff).toMatchObject({ reason: 'visitor_request' });
    expect(replyService.generate).not.toHaveBeenCalled();
  });

  test('an answer the bot did not have offers a person and is stored as unanswered', async () => {
    replyService.generate.mockResolvedValueOnce({
      text: 'I do not have that information.', source: 'assistant', path: 'assistant', unanswered: true
    });
    const sessionId = fresh();

    const response = await request(buildApp(sessionId))
      .post('/api/chat/message')
      .send({ message: 'Do you ship to Mars?', widgetKey: acme.widgetKey });

    expect(response.body.message).toMatchObject({ unanswered: true, canRate: false });
    expect(response.body.message.choices).toEqual([expect.objectContaining({ action: 'handoff' })]);
    expect((await Conversation.findOne({ sessionId }).lean()).messages.at(-1).unanswered).toBe(true);
  });

  test('history leaves out transcript events and says how each answer was made', async () => {
    const sessionId = fresh();
    const app = buildApp(sessionId);
    const first = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hello', widgetKey: acme.widgetKey, clientMessageId: 'h-1' });
    await Conversation.updateOne({ sessionId }, {
      $push: { messages: { content: 'Ada joined', sender: 'system', path: 'system' } }
    });

    const history = await request(app).get('/api/chat/history').query({ sessionToken: first.body.sessionToken });

    expect(history.body.messages.map(m => m.sender)).toEqual(['user', 'bot']);
    expect(history.body.messages[0].clientMessageId).toBe('h-1');
    expect(history.body.messages[1]).toMatchObject({ path: 'assistant', canRate: true });
  });
});
