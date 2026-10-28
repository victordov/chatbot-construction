/**
 * P2B: an operator answering a WhatsApp, Messenger or Instagram conversation
 * from the same composer as web chat.
 *
 * The real socket server (tests/ws1-socket-harness.js); Meta's API is the
 * stubbed services/safe-http, so every send is seen and none leaves.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockImplementation(async () => ({
    lastFailed: false,
    generateOperatorSuggestion: async () => 'A drafted reply'
  }))
}));

jest.mock('../services/safe-http', () => {
  const actual = jest.requireActual('../services/safe-http');
  return { ...actual, request: jest.fn(), fetchUrl: jest.fn() };
});

const mongoose = require('mongoose');
const { createHarness, waitFor, pause } = require('./ws1-socket-harness');

const ChannelAccount = require('../models/channel-account');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const channels = require('../services/channels');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');

const HOUR = 60 * 60 * 1000;
const graphCalls = [];

function stubGraph() {
  safeHttp.request.mockImplementation(async (url, options, body) => {
    const call = { path: url.pathname, method: options.method, body: body ? JSON.parse(body) : null };
    graphCalls.push(call);
    const data = call.body && call.body.messaging_product === 'whatsapp'
      ? { messages: [{ id: `wamid.op${graphCalls.length}` }] }
      : { recipient_id: 'x', message_id: `mid.op${graphCalls.length}` };
    return { statusCode: 200, headers: {}, body: JSON.stringify(data) };
  });
}

/** What reached the customer, as text. */
const sentTexts = () => graphCalls
  .filter(call => call.method === 'POST' && call.body && call.body.text)
  .map(call => (typeof call.body.text === 'string' ? call.body.text : call.body.text.body));

const sentMessengerTexts = () => graphCalls
  .filter(call => call.body && call.body.message)
  .map(call => call.body.message.text);

let counter = 0;

describe('P2B: answering messaging-app conversations from the inbox', () => {
  const harness = createHarness();
  let company;
  let opal;
  let whatsappAccount;
  let messengerAccount;

  const conversation = async (channel, { hoursAgo = 1, ...extra } = {}) => Conversation.create({
    sessionId: `${channel}-p2bsocket${Date.now()}${(counter += 1)}`,
    company: company._id,
    channel,
    domain: channel,
    external: {
      provider: channel,
      accountId: channel === 'whatsapp' ? whatsappAccount._id : messengerAccount._id,
      userId: channel === 'whatsapp' ? '447700900123' : 'PSID-SOCKET',
      lastInboundAt: new Date(Date.now() - hoursAgo * HOUR)
    },
    metadata: { name: 'Sam Customer' },
    messages: [{ content: 'Where is my order?', sender: 'user', messageId: 'wamid.inbound1' }],
    ...extra
  });

  const operatorSocket = async () => harness.connectOperatorInRoom(opal);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    company = await Company.create({ name: 'P2B Socket Co', routing: { autoAssign: false } });
    await Subscription.create({ company: company._id, planId: 'professional', status: 'active' });
    opal = await User.create({
      username: 'p2b-socket-opal', email: 'opal@p2b-socket.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Opal', company: company._id
    });

    whatsappAccount = await ChannelAccount.create({
      company: company._id, provider: 'whatsapp', phoneNumberId: '6100001',
      accessToken: secrets.encrypt('wa-token'), appSecret: secrets.encrypt('aaaaaaaabbbbbbbbccccccccdddddddd'),
      verifyToken: ChannelAccount.newVerifyToken(), template: { name: 'follow_up' }
    });
    messengerAccount = await ChannelAccount.create({
      company: company._id, provider: 'messenger', pageId: '6200002',
      accessToken: secrets.encrypt('page-token'), appSecret: secrets.encrypt('aaaaaaaabbbbbbbbccccccccdddddddd'),
      verifyToken: ChannelAccount.newVerifyToken(), humanAgentTag: true
    });

    await harness.start();
  });

  beforeEach(() => {
    graphCalls.length = 0;
    safeHttp.request.mockReset();
    stubGraph();
  });

  afterEach(async () => {
    await channels.settled();
    harness.closeAll();
    await pause(40);
  });

  afterAll(async () => {
    await harness.stop();
    await Conversation.deleteMany({ company: company._id });
    await ChannelAccount.deleteMany({ company: company._id });
    await Subscription.deleteMany({ company: company._id });
    await User.deleteMany({ email: /@p2b-socket\.example$/ });
    await Company.deleteMany({ name: /^P2B Socket/ });
    await mongoose.connection.close();
  });

  test('a reply within 24 hours goes out on WhatsApp and is stored with WhatsApp\'s id', async () => {
    const chat = await conversation('whatsapp');
    const socket = await operatorSocket();
    const seen = waitFor(socket, 'conversation-message');

    socket.emit('operator-message', { sessionId: chat.sessionId, message: 'It ships tomorrow.' });
    const event = await seen;
    await channels.settled();

    expect(event.message).toMatchObject({ sender: 'operator', content: 'It ships tomorrow.', operatorName: 'Opal' });
    const send = graphCalls.find(call => call.body && call.body.type === 'text');
    expect(send).toMatchObject({
      path: '/v26.0/6100001/messages',
      body: { to: '447700900123', text: { body: 'It ships tomorrow.' } }
    });

    const after = await Conversation.findById(chat._id);
    const stored = after.messages.find(message => message.sender === 'operator');
    expect(stored.messageId).toMatch(/^wamid\.op/);
    expect(after.firstOperatorReplyAt).toBeTruthy();

    // Answering is reading: WhatsApp gets its blue ticks on their message.
    expect(graphCalls.some(call => call.body && call.body.status === 'read' && call.body.message_id === 'wamid.inbound1')).toBe(true);
  });

  test('after 24 hours free text is refused with the reason, and nothing is stored or sent', async () => {
    const chat = await conversation('whatsapp', { hoursAgo: 30 });
    const socket = await operatorSocket();
    const error = waitFor(socket, 'error');

    socket.emit('operator-message', { sessionId: chat.sessionId, message: 'Are you still there?' });
    const refusal = await error;

    expect(refusal.message).toMatch(/only allows an approved template/);
    expect(refusal.message).toMatch(/follow_up/);
    expect(graphCalls).toHaveLength(0);
    const after = await Conversation.findById(chat._id);
    expect(after.messages.filter(message => message.sender === 'operator')).toHaveLength(0);
  });

  test('a visitor email is never used instead: the customer is on WhatsApp', async () => {
    const chat = await conversation('whatsapp', { metadata: { name: 'Sam', email: 'sam@example.com' } });
    const socket = await operatorSocket();
    let emailed = false;
    socket.on('operator-message-emailed', () => {
      emailed = true;
    });
    const seen = waitFor(socket, 'conversation-message');

    socket.emit('operator-message', { sessionId: chat.sessionId, message: 'Hello on WhatsApp' });
    await seen;
    await channels.settled();

    expect(emailed).toBe(false);
    expect(sentTexts()).toContain('Hello on WhatsApp');
  });

  test('Messenger after 24 hours uses the Human Agent tag, when the app has it', async () => {
    const chat = await conversation('messenger', { hoursAgo: 30 });
    const socket = await operatorSocket();
    const seen = waitFor(socket, 'conversation-message');

    socket.emit('operator-message', { sessionId: chat.sessionId, message: 'Following up on your order' });
    await seen;
    await channels.settled();

    const send = graphCalls.find(call => call.body && call.body.message);
    expect(send).toMatchObject({
      path: '/v26.0/6200002/messages',
      body: {
        recipient: { id: 'PSID-SOCKET' },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
        message: { text: 'Following up on your order' }
      }
    });
  });

  test('a refused send is reported to the operator like a failed email, and recorded for the settings', async () => {
    const chat = await conversation('whatsapp');
    safeHttp.request.mockResolvedValueOnce({
      statusCode: 401,
      headers: {},
      body: JSON.stringify({ error: { message: 'Error validating access token', code: 190 } })
    });
    const socket = await operatorSocket();
    const error = waitFor(socket, 'error');

    socket.emit('operator-message', { sessionId: chat.sessionId, message: 'This will not arrive' });
    const refusal = await error;

    expect(refusal.message).toMatch(/^Could not send that message: the access token is no longer valid/);
    const after = await Conversation.findById(chat._id);
    expect(after.messages.filter(message => message.sender === 'operator')).toHaveLength(0);

    const account = await ChannelAccount.findById(whatsappAccount._id).lean();
    expect(account.status).toBe('error');
    expect(account.lastError.message).toMatch(/access token/);
    await ChannelAccount.updateOne({ _id: whatsappAccount._id }, { $set: { status: 'connected' }, $unset: { lastError: 1 } });
  });

  test('joining and ending are told to the customer as the widget would show them, with no rating form', async () => {
    const chat = await conversation('whatsapp');
    const socket = await operatorSocket();

    socket.emit('operator-takeover', { sessionId: chat.sessionId });
    await waitFor(socket, 'operator-joined');
    await channels.settled();
    expect(sentTexts()).toContain('Opal has joined the conversation.');

    socket.emit('end-chat', { sessionId: chat.sessionId, outcome: { status: 'resolved' } });
    await waitFor(socket, 'chat-ended');
    await channels.settled();
    expect(sentTexts()).toContain('This conversation has been ended.');

    const after = await Conversation.findById(chat._id).lean();
    expect(after.status).toBe('ended');
    expect(after.ratingRequestedAt).toBeFalsy();
  });

  test('nothing automatic is sent once the window has closed', async () => {
    const chat = await conversation('whatsapp', { hoursAgo: 30 });
    const socket = await operatorSocket();

    socket.emit('operator-takeover', { sessionId: chat.sessionId });
    await waitFor(socket, 'operator-joined');
    await channels.settled();
    expect(graphCalls).toHaveLength(0);
  });

  test('Messenger notices go to the Page\'s Send API', async () => {
    const chat = await conversation('messenger');
    const socket = await operatorSocket();

    socket.emit('operator-takeover', { sessionId: chat.sessionId });
    await waitFor(socket, 'operator-joined');
    await channels.settled();
    expect(sentMessengerTexts()).toContain('Opal has joined the conversation.');
  });

  test('a browser cannot resume a messaging-app conversation by its session id', async () => {
    const chat = await conversation('whatsapp');
    const visitor = await harness.connectVisitor();
    const outcome = await harness.resume(visitor, chat.sessionId);
    expect(outcome.rejected).toBe(true);
  });

  test('web chat is unchanged: a widget visitor is answered on the socket, nothing goes to Meta', async () => {
    const { socket } = await harness.startVisitor('p2b-web', company.widgetKey);
    const reply = waitFor(socket, 'bot-message');
    harness.say(socket, 'hello');
    expect((await reply).text).toBe('A reply from the bot');
    await channels.settled();
    expect(graphCalls).toHaveLength(0);
  });
});
