/**
 * P2B: WhatsApp, Messenger and Instagram through the webhook.
 *
 * A real database, the real router and conversation lifecycle; only what the
 * model says (services/reply) and Meta's side of every HTTP call
 * (services/safe-http) are stubbed. Nothing leaves the process.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn()
}));

jest.mock('../services/safe-http', () => {
  const actual = jest.requireActual('../services/safe-http');
  return { ...actual, request: jest.fn(), fetchUrl: jest.fn() };
});

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const ChannelAccount = require('../models/channel-account');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Subscription = require('../models/subscription');
const Usage = require('../models/usage');
const User = require('../models/user');
const channels = require('../services/channels');
const replyService = require('../services/reply');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const socketManager = require('../socketManager');
const uploads = require('../services/uploads');

const APP_SECRET_A = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const APP_SECRET_B = 'eeeeeeeeffffffff0000000011111111';

const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

let counter = 0;
const nextId = prefix => `${prefix}.${Date.now()}.${(counter += 1)}`;

/** Every call made to Meta, as the stub saw it. */
const graphCalls = [];
/** Everything the operators' dashboards were told. */
const emitted = [];

function stubGraph() {
  safeHttp.request.mockImplementation(async (url, options, body) => {
    const call = {
      path: url.pathname,
      method: options.method,
      headers: options.headers,
      query: Object.fromEntries(url.searchParams),
      body: body ? JSON.parse(body) : null
    };
    graphCalls.push(call);

    const json = data => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

    if (call.method === 'GET') {
      // A WhatsApp media id resolving to a short-lived URL.
      return json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', file_size: 4, id: 'm' });
    }
    if (call.body && call.body.messaging_product === 'whatsapp') {
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out${graphCalls.length}` }] });
    }
    return json({ recipient_id: call.body && call.body.recipient && call.body.recipient.id, message_id: `mid.out${graphCalls.length}` });
  });
  safeHttp.fetchUrl.mockResolvedValue({
    statusCode: 200,
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  });
}

const sends = () => graphCalls.filter(call => call.method === 'POST' && call.body && !call.body.status && !call.body.sender_action);

function buildApp() {
  const app = express();
  // As server.js does: the webhook path stays raw, everything else is JSON.
  app.use('/api/channels/webhook', express.raw({ type: () => true, limit: '1mb' }));
  app.use(express.json());
  app.use('/api/channels', require('../routes/channels'));
  return app;
}

function whatsappPayload(phoneNumberId, messages, { name = 'Sheena Nelson', from = '16505551234' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name }, wa_id: from }],
          messages: messages.map(message => ({ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }))
        }
      }]
    }]
  };
}

const text = (body, id = nextId('wamid')) => ({ id, type: 'text', text: { body } });

describe('P2B: messaging channels through the webhook', () => {
  let app;
  let acme;
  let beta;
  let basic;
  let admin;
  let operator;
  let waA;
  let fbA;
  let igA;

  const post = (route, payload, secret, raw) => {
    const body = raw || Buffer.from(JSON.stringify(payload));
    return request(app)
      .post(`/api/channels/webhook/${route}`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body, secret))
      // A string, so the bytes signed are the bytes sent.
      .send(body.toString('utf8'));
  };

  const tokenFor = user => jwt.sign({ id: String(user._id), role: user.role }, process.env.JWT_SECRET);

  const conversationsOf = company => Conversation.find({ company: company._id }).sort({ startedAt: 1 });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    socketManager.setIo({
      to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
      in: () => ({ fetchSockets: async () => [], disconnectSockets: () => {} }),
      sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
    });

    app = buildApp();
    // The unique indexes are what keep one number in one company's hands.
    await ChannelAccount.init();

    acme = await Company.create({ name: 'P2B Acme' });
    beta = await Company.create({ name: 'P2B Beta' });
    basic = await Company.create({ name: 'P2B Basic' });
    await Subscription.create({ company: acme._id, planId: 'professional', status: 'active' });
    await Subscription.create({ company: beta._id, planId: 'enterprise', status: 'active' });
    await Subscription.create({ company: basic._id, planId: 'basic', status: 'active' });

    admin = await User.create({
      username: 'p2b-admin', email: 'admin@p2b.example', password: 'TestPassword123!',
      role: 'company_admin', company: acme._id
    });
    operator = await User.create({
      username: 'p2b-operator', email: 'operator@p2b.example', password: 'TestPassword123!',
      role: 'operator', displayName: 'Opal', company: acme._id
    });

    const account = (company, fields) => ChannelAccount.create({
      company: company._id,
      accessToken: secrets.encrypt(`token-${company.name}`),
      verifyToken: ChannelAccount.newVerifyToken(),
      ...fields
    });

    waA = await account(acme, { provider: 'whatsapp', phoneNumberId: '1000001', appSecret: secrets.encrypt(APP_SECRET_A), template: { name: 'follow_up', language: 'en_US', param: 'positional' } });
    await account(beta, { provider: 'whatsapp', phoneNumberId: '2000002', appSecret: secrets.encrypt(APP_SECRET_B) });
    fbA = await account(acme, { provider: 'messenger', pageId: '3000003', appSecret: secrets.encrypt(APP_SECRET_A) });
    igA = await account(acme, { provider: 'instagram', pageId: '3000003', igUserId: '4000004', appSecret: secrets.encrypt(APP_SECRET_A) });
    await account(basic, { provider: 'whatsapp', phoneNumberId: '5000005', appSecret: secrets.encrypt(APP_SECRET_A) });
  });

  beforeEach(async () => {
    graphCalls.length = 0;
    emitted.length = 0;
    safeHttp.request.mockReset();
    safeHttp.fetchUrl.mockReset();
    stubGraph();
    replyService.generate.mockReset();
    replyService.generate.mockResolvedValue({ text: 'It comes in red and blue.', path: 'assistant', source: 'assistant' });
    await Conversation.deleteMany({ company: { $in: [acme._id, beta._id, basic._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, beta._id, basic._id] } });
    await Usage.deleteMany({ company: { $in: [acme._id, beta._id, basic._id] } });
  });

  afterAll(async () => {
    await channels.settled();
    const companies = [acme._id, beta._id, basic._id];
    for (const id of companies) {
      await uploads.deleteCompanyFiles(id);
    }
    await Conversation.deleteMany({ company: { $in: companies } });
    await Contact.deleteMany({ company: { $in: companies } });
    await Usage.deleteMany({ company: { $in: companies } });
    await ChannelAccount.deleteMany({ company: { $in: companies } });
    await Subscription.deleteMany({ company: { $in: companies } });
    await User.deleteMany({ email: /@p2b\.example$/ });
    await Company.deleteMany({ name: /^P2B / });
    await mongoose.connection.close();
  });

  describe('the verification handshake', () => {
    test('echoes the challenge for a verify token we issued, and records it', async () => {
      const token = (await ChannelAccount.findById(waA._id).select('+verifyToken')).verifyToken;
      const response = await request(app).get('/api/channels/webhook/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' });

      expect(response.status).toBe(200);
      expect(response.text).toBe('1158201444');
      const after = await ChannelAccount.findById(waA._id).lean();
      expect(after.webhookVerifiedAt).toBeTruthy();
      expect(after.status).toBe('connected');
    });

    test('refuses a token nobody issued, or one for the other provider', async () => {
      const waToken = (await ChannelAccount.findById(waA._id).select('+verifyToken')).verifyToken;
      const unknown = await request(app).get('/api/channels/webhook/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '1' });
      expect(unknown.status).toBe(403);

      const crossed = await request(app).get('/api/channels/webhook/messenger')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': waToken, 'hub.challenge': '1' });
      expect(crossed.status).toBe(403);
    });

    test('never echoes anything but a plain challenge', async () => {
      const token = (await ChannelAccount.findById(waA._id).select('+verifyToken')).verifyToken;
      const response = await request(app).get('/api/channels/webhook/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '<script>alert(1)</script>' });
      expect(response.status).toBe(400);
    });
  });

  describe('signatures', () => {
    test('a bad signature is refused and stores nothing', async () => {
      const payload = whatsappPayload('1000001', [text('hello')]);
      const response = await post('whatsapp', payload, 'not-the-secret-at-all-0000000000');

      expect(response.status).toBe(401);
      expect(await conversationsOf(acme)).toHaveLength(0);
    });

    test('the signature is over the raw bytes: re-serialised JSON fails', async () => {
      const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[{"id":"W","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"1000001"},"messages":[{"from":"1","id":"wamid.x","timestamp":"1","type":"text","text":{"body":"caf\\u00e9"}}]}}]}]}');
      const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));

      const response = await request(app)
        .post('/api/channels/webhook/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(reserialised, APP_SECRET_A))
        .send(raw.toString('utf8'));
      expect(response.status).toBe(401);

      const good = await post('whatsapp', null, APP_SECRET_A, raw);
      expect(good.status).toBe(200);
      await channels.settled();
      const [conversation] = await conversationsOf(acme);
      expect(conversation.messages[0].content).toBe('café');
    });

    test('a webhook for an account nobody connected is acknowledged and ignored', async () => {
      // Never an error: Messenger switches off an app's webhooks after an
      // hour of them, including for the Pages that are connected.
      const response = await post('whatsapp', whatsappPayload('9999999', [text('hi')]), APP_SECRET_A);
      expect(response.status).toBe(200);
      await channels.settled();
      expect(await Conversation.countDocuments({ 'external.userId': '16505551234' })).toBe(0);
      expect(sends()).toHaveLength(0);
    });
  });

  describe('a WhatsApp message', () => {
    test('starts a conversation, announces it, and the bot answers on WhatsApp', async () => {
      const payload = whatsappPayload('1000001', [text('Does it come in another color?', 'wamid.first')]);
      const response = await post('whatsapp', payload, APP_SECRET_A);
      expect(response.status).toBe(200);
      await channels.settled();

      const [conversation] = await conversationsOf(acme);
      expect(conversation.channel).toBe('whatsapp');
      expect(conversation.sessionId).toMatch(/^whatsapp-[0-9a-f]{24}$/);
      expect(conversation.external).toMatchObject({ provider: 'whatsapp', userId: '16505551234' });
      expect(String(conversation.external.accountId)).toBe(String(waA._id));
      expect(conversation.metadata.get('name')).toBe('Sheena Nelson');
      expect(conversation.metadata.get('phone')).toBe('+16505551234');
      expect(conversation.messages.map(message => [message.sender, message.content])).toEqual([
        ['user', 'Does it come in another color?'],
        ['bot', 'It comes in red and blue.']
      ]);
      expect(conversation.messages[0].messageId).toBe('wamid.first');

      const contact = await Contact.findById(conversation.contact).lean();
      expect(contact).toMatchObject({ name: 'Sheena Nelson', phone: '+16505551234' });

      // The same reply path the widget uses, with the history it would see.
      expect(replyService.generate).toHaveBeenCalledTimes(1);
      expect(replyService.generate.mock.calls[0][0].message).toBe('Does it come in another color?');

      const [sent] = sends();
      expect(sent.path).toBe('/v26.0/1000001/messages');
      expect(sent.headers.Authorization).toBe('Bearer token-P2B Acme');
      expect(sent.query.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
      expect(sent.body).toMatchObject({
        messaging_product: 'whatsapp', to: '16505551234', type: 'text', text: { body: 'It comes in red and blue.' }
      });

      const newChat = emitted.find(entry => entry.event === 'new-chat');
      expect(newChat.room).toBe(`operators:${acme._id}`);
      expect(newChat.payload).toMatchObject({ channel: 'whatsapp', visitorName: 'Sheena Nelson' });

      const usage = await Usage.findOne({ company: acme._id }).lean();
      expect(usage.conversations).toBe(1);

      const account = await ChannelAccount.findById(waA._id).lean();
      expect(account.lastInboundAt).toBeTruthy();
    });

    test('the same message delivered twice is stored and answered once', async () => {
      const payload = whatsappPayload('1000001', [text('Once only', 'wamid.dupe')]);
      await post('whatsapp', payload, APP_SECRET_A);
      await post('whatsapp', payload, APP_SECRET_A);
      await Promise.all([post('whatsapp', payload, APP_SECRET_A), post('whatsapp', payload, APP_SECRET_A)]);
      await channels.settled();

      const conversations = await conversationsOf(acme);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].messages.filter(message => message.sender === 'user')).toHaveLength(1);
      expect(replyService.generate).toHaveBeenCalledTimes(1);
      expect(sends()).toHaveLength(1);
    });

    test('a second message joins the open conversation; after it ends, a new one starts for the same contact', async () => {
      await post('whatsapp', whatsappPayload('1000001', [text('first')]), APP_SECRET_A);
      await channels.settled();
      await post('whatsapp', whatsappPayload('1000001', [text('second')]), APP_SECRET_A);
      await channels.settled();

      let conversations = await conversationsOf(acme);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].messages.filter(message => message.sender === 'user')).toHaveLength(2);

      await Conversation.updateOne({ _id: conversations[0]._id }, { $set: { status: 'ended' } });
      await post('whatsapp', whatsappPayload('1000001', [text('back again')]), APP_SECRET_A);
      await channels.settled();

      conversations = await conversationsOf(acme);
      expect(conversations).toHaveLength(2);
      expect(String(conversations[1].contact)).toBe(String(conversations[0].contact));
      expect(await Contact.countDocuments({ company: acme._id })).toBe(1);
    });

    test('an answer the bot did not have offers a person, as a WhatsApp button', async () => {
      replyService.generate.mockResolvedValue({ text: 'I do not know that.', path: 'assistant', unanswered: true });
      await post('whatsapp', whatsappPayload('1000001', [text('What is the meaning of life?')]), APP_SECRET_A);
      await channels.settled();

      const [sent] = sends();
      expect(sent.body.type).toBe('interactive');
      expect(sent.body.interactive.type).toBe('button');
      expect(sent.body.interactive.body.text).toBe('I do not know that.');
      expect(sent.body.interactive.action.buttons).toEqual([
        { type: 'reply', reply: { id: '__handoff__', title: 'Talk to a person' } }
      ]);
    });

    test('a workflow\'s choices go as buttons, and a tap comes back as the label', async () => {
      replyService.generate.mockResolvedValueOnce({
        text: 'What can I help with?', path: 'workflow', choices: [{ label: 'Opening hours' }, { label: 'Returns' }]
      });
      await post('whatsapp', whatsappPayload('1000001', [text('hi')]), APP_SECRET_A);
      await channels.settled();
      expect(sends()[0].body.interactive.action.buttons.map(button => button.reply.id)).toEqual(['Opening hours', 'Returns']);

      await post('whatsapp', whatsappPayload('1000001', [{
        id: nextId('wamid'), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'Returns', title: 'Returns' } }
      }]), APP_SECRET_A);
      await channels.settled();
      expect(replyService.generate.mock.calls[1][0].message).toBe('Returns');
    });

    test('tapping "talk to a person" hands over, and the customer is told on WhatsApp', async () => {
      await post('whatsapp', whatsappPayload('1000001', [{
        id: nextId('wamid'), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '__handoff__', title: 'Talk to a person' } }
      }]), APP_SECRET_A);
      await channels.settled();

      const [conversation] = await conversationsOf(acme);
      expect(conversation.handoff.reason).toBe('visitor_request');
      expect(conversation.awaitingOperatorSince).toBeTruthy();
      expect(replyService.generate).not.toHaveBeenCalled();
      expect(emitted.some(entry => entry.event === 'handoff-requested')).toBe(true);

      // Nobody is online, so the website would ask for an email; here the
      // team can answer where the customer already is.
      const notices = sends().map(call => call.body.text && call.body.text.body);
      expect(notices).toContain('Nobody from the team is available right now. We will reply here as soon as someone is back.');
    });

    test('while a person holds it, the bot stays quiet', async () => {
      await post('whatsapp', whatsappPayload('1000001', [text('first')]), APP_SECRET_A);
      await channels.settled();
      const [conversation] = await conversationsOf(acme);
      await Conversation.updateOne({ _id: conversation._id }, {
        $set: { hasOperator: true, operatorId: operator._id, operatorName: 'Opal', botEnabled: false }
      });
      graphCalls.length = 0;

      await post('whatsapp', whatsappPayload('1000001', [text('are you there?')]), APP_SECRET_A);
      await channels.settled();
      expect(replyService.generate).toHaveBeenCalledTimes(1);
      expect(sends()).toHaveLength(0);
    });

    test('a photo is kept like a widget upload, and the bot does not answer a picture', async () => {
      await post('whatsapp', whatsappPayload('1000001', [{
        id: nextId('wamid'), type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'x' }
      }]), APP_SECRET_A);
      await channels.settled();

      const [conversation] = await conversationsOf(acme);
      const [message] = conversation.messages;
      expect(message.fileId).toMatch(/^[0-9a-f]{32}$/);
      expect(message.fileName).toMatch(/^image-.*\.jpg$/);
      expect(message.content).toBe(`[File uploaded: ${message.fileName}]`);
      expect(uploads.filePath(acme._id, message.fileId)).toBeTruthy();

      // The media id resolved with the token, then fetched with it.
      expect(graphCalls[0]).toMatchObject({ method: 'GET', path: '/v26.0/MEDIA1' });
      expect(safeHttp.fetchUrl).toHaveBeenCalledWith(
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        expect.objectContaining({ headers: { Authorization: 'Bearer token-P2B Acme' } })
      );
      expect(replyService.generate).not.toHaveBeenCalled();
    });

    test('a failed delivery report puts a line in the transcript, once', async () => {
      await post('whatsapp', whatsappPayload('1000001', [text('hello')]), APP_SECRET_A);
      await channels.settled();
      const [conversation] = await conversationsOf(acme);
      await Conversation.updateOne({ _id: conversation._id }, {
        $push: { messages: { content: 'Late reply', sender: 'operator', messageId: 'wamid.late' } }
      });

      const report = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'W',
          changes: [{
            field: 'messages',
            value: {
              metadata: { phone_number_id: '1000001' },
              statuses: [{
                id: 'wamid.late', status: 'failed', recipient_id: '16505551234', timestamp: '1',
                errors: [{ code: 131047, title: 'Re-engagement message' }]
              }]
            }
          }]
        }]
      };
      await post('whatsapp', report, APP_SECRET_A);
      await post('whatsapp', report, APP_SECRET_A);

      const after = await Conversation.findById(conversation._id);
      const lines = after.messages.filter(message => message.sender === 'system' && /Not delivered/.test(message.content));
      expect(lines).toHaveLength(1);
      expect(lines[0].content).toMatch(/24 hours/);
    });
  });

  describe('tenant isolation', () => {
    test('a payload naming another tenant\'s number, signed with our secret, touches nothing of theirs', async () => {
      const response = await post('whatsapp', whatsappPayload('2000002', [text('injected')]), APP_SECRET_A);
      expect(response.status).toBe(401);
      expect(await conversationsOf(beta)).toHaveLength(0);
    });

    test('in a mixed payload only the entries the signature covers are acted on', async () => {
      const mine = whatsappPayload('1000001', [text('for acme')]);
      const theirs = whatsappPayload('2000002', [text('for beta')]);
      const mixed = { ...mine, entry: [...mine.entry, ...theirs.entry] };

      const response = await post('whatsapp', mixed, APP_SECRET_A);
      expect(response.status).toBe(200);
      await channels.settled();

      expect(await conversationsOf(acme)).toHaveLength(1);
      expect(await conversationsOf(beta)).toHaveLength(0);
      expect(emitted.every(entry => !entry.room.includes(String(beta._id)))).toBe(true);
    });

    test('each tenant\'s own messages reach only their own queue', async () => {
      await post('whatsapp', whatsappPayload('2000002', [text('for beta')]), APP_SECRET_B);
      await channels.settled();
      expect(await conversationsOf(beta)).toHaveLength(1);
      expect(await conversationsOf(acme)).toHaveLength(0);
      expect(sends()[0].headers.Authorization).toBe('Bearer token-P2B Beta');
    });
  });

  describe('plans and switches', () => {
    test('a plan without the channels receives nothing, and the settings say why', async () => {
      const response = await post('whatsapp', whatsappPayload('5000005', [text('hi')]), APP_SECRET_A);
      expect(response.status).toBe(200);
      await channels.settled();
      expect(await conversationsOf(basic)).toHaveLength(0);
      const account = await ChannelAccount.findOne({ company: basic._id }).lean();
      expect(account.lastError.message).toMatch(/plan/);
    });

    test('a switched-off account is acknowledged and dropped', async () => {
      await ChannelAccount.updateOne({ _id: waA._id }, { $set: { enabled: false } });
      try {
        const response = await post('whatsapp', whatsappPayload('1000001', [text('hi')]), APP_SECRET_A);
        expect(response.status).toBe(200);
        expect(await conversationsOf(acme)).toHaveLength(0);
      } finally {
        await ChannelAccount.updateOne({ _id: waA._id }, { $set: { enabled: true } });
      }
    });
  });

  describe('Messenger and Instagram', () => {
    const pageEvent = (object, entryId, sender, message) => ({
      object,
      entry: [{
        id: entryId,
        time: Date.now(),
        messaging: [{ sender: { id: sender }, recipient: { id: entryId }, timestamp: Date.now(), message }]
      }]
    });

    test('a Messenger message is answered through the Page\'s Send API, with quick replies', async () => {
      replyService.generate.mockResolvedValue({
        text: 'Which store?', path: 'workflow', choices: [{ label: 'Downtown' }, { label: 'Airport' }]
      });
      const response = await post('messenger', pageEvent('page', '3000003', 'PSID1', { mid: nextId('mid'), text: 'hours?' }), APP_SECRET_A);
      expect(response.status).toBe(200);
      await channels.settled();

      const [conversation] = await conversationsOf(acme);
      expect(conversation.channel).toBe('messenger');
      expect(String(conversation.external.accountId)).toBe(String(fbA._id));

      const [sent] = sends();
      expect(sent.path).toBe('/v26.0/3000003/messages');
      expect(sent.body).toEqual({
        recipient: { id: 'PSID1' },
        messaging_type: 'RESPONSE',
        message: {
          text: 'Which store?',
          quick_replies: [
            { content_type: 'text', title: 'Downtown', payload: 'Downtown' },
            { content_type: 'text', title: 'Airport', payload: 'Airport' }
          ]
        }
      });
    });

    test('an Instagram message becomes an Instagram conversation, sent through the linked Page', async () => {
      await post('instagram', pageEvent('instagram', '4000004', 'IGSID1', { mid: nextId('mid'), text: 'is this in stock?' }), APP_SECRET_A);
      await channels.settled();

      const [conversation] = await conversationsOf(acme);
      expect(conversation.channel).toBe('instagram');
      expect(String(conversation.external.accountId)).toBe(String(igA._id));
      expect(sends()[0]).toMatchObject({ path: '/v26.0/3000003/messages', body: { recipient: { id: 'IGSID1' } } });
    });

    test('Messenger and Instagram events are taken at either URL', async () => {
      await post('messenger', pageEvent('instagram', '4000004', 'IGSID2', { mid: nextId('mid'), text: 'hello' }), APP_SECRET_A);
      await channels.settled();
      expect((await conversationsOf(acme))[0].channel).toBe('instagram');
    });
  });

  describe('settings', () => {
    let settingsCo;
    let settingsAdmin;

    beforeAll(async () => {
      settingsCo = await Company.create({ name: 'P2B Settings' });
      await Subscription.create({ company: settingsCo._id, planId: 'professional', status: 'active' });
      settingsAdmin = await User.create({
        username: 'p2b-settings', email: 'settings@p2b.example', password: 'TestPassword123!',
        role: 'company_admin', company: settingsCo._id
      });
    });

    afterAll(async () => {
      await ChannelAccount.deleteMany({ company: settingsCo._id });
      await Subscription.deleteMany({ company: settingsCo._id });
    });

    const as = user => ({ 'x-auth-token': tokenFor(user) });

    test('saving WhatsApp encrypts the credentials and never shows them back', async () => {
      const response = await request(app).put('/api/channels/whatsapp').set(as(settingsAdmin)).send({
        phoneNumberId: '7000007', accessToken: 'EAAG-secret-token', appSecret: APP_SECRET_B,
        template: { name: 'follow_up', language: 'en_US', param: 'named', paramName: 'first_name' }
      });

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('EAAG-secret-token');
      expect(JSON.stringify(response.body)).not.toContain(APP_SECRET_B);
      expect(response.body.whatsapp).toMatchObject({
        phoneNumberId: '7000007', hasAccessToken: true, hasAppSecret: true, status: 'pending',
        template: { name: 'follow_up', param: 'named', paramName: 'first_name' }
      });
      expect(response.body.whatsapp.verifyToken).toMatch(/^[0-9a-f]{48}$/);
      expect(response.body.webhookUrls.whatsapp).toMatch(/\/api\/channels\/webhook\/whatsapp$/);

      const stored = await ChannelAccount.findOne({ company: settingsCo._id, provider: 'whatsapp' }).select('+accessToken +appSecret').lean();
      expect(stored.accessToken).toMatch(/^enc:v1:/);
      expect(secrets.decrypt(stored.accessToken)).toBe('EAAG-secret-token');

      // Saving again without the secrets keeps them.
      const again = await request(app).put('/api/channels/whatsapp').set(as(settingsAdmin)).send({ phoneNumberId: '7000007', template: {} });
      expect(again.status).toBe(200);
      const kept = await ChannelAccount.findOne({ company: settingsCo._id, provider: 'whatsapp' }).select('+accessToken').lean();
      expect(secrets.decrypt(kept.accessToken)).toBe('EAAG-secret-token');
    });

    test('a number another company connected is refused', async () => {
      const response = await request(app).put('/api/channels/whatsapp').set(as(settingsAdmin)).send({
        phoneNumberId: '1000001', accessToken: 'x', appSecret: APP_SECRET_B
      });
      expect(response.status).toBe(409);
    });

    test('bad ids and missing credentials are refused with a reason', async () => {
      const company = await Company.create({ name: 'P2B Settings Fresh' });
      await Subscription.create({ company: company._id, planId: 'professional', status: 'active' });
      const fresh = await User.create({
        username: 'p2b-fresh', email: 'fresh@p2b.example', password: 'TestPassword123!', role: 'company_admin', company: company._id
      });
      try {
        expect((await request(app).put('/api/channels/whatsapp').set(as(fresh)).send({ phoneNumberId: '+1 555' })).status).toBe(400);
        const missing = await request(app).put('/api/channels/whatsapp').set(as(fresh)).send({ phoneNumberId: '8000008' });
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/Access token is required/);
      } finally {
        await Subscription.deleteMany({ company: company._id });
        await Company.deleteOne({ _id: company._id });
      }
    });

    test('Messenger and Instagram are saved together, sharing one verify token', async () => {
      const response = await request(app).put('/api/channels/messenger').set(as(settingsAdmin)).send({
        pageId: '7100007', igUserId: '7200007', accessToken: 'page-token', appSecret: APP_SECRET_B, humanAgentTag: true
      });
      expect(response.status).toBe(200);
      expect(response.body.messenger).toMatchObject({ pageId: '7100007', humanAgentTag: true });
      expect(response.body.instagram).toMatchObject({ pageId: '7100007', igUserId: '7200007' });
      expect(response.body.instagram.verifyToken).toBe(response.body.messenger.verifyToken);

      const dropped = await request(app).put('/api/channels/messenger').set(as(settingsAdmin)).send({ pageId: '7100007', igUserId: '' });
      expect(dropped.body.instagram).toBeNull();
    });

    test('operators cannot see or change the settings', async () => {
      expect((await request(app).get('/api/channels/settings').set(as(operator))).status).toBe(403);
      expect((await request(app).put('/api/channels/whatsapp').set(as(operator)).send({})).status).toBe(403);
    });

    test('a plan without the channels says so, and cannot connect one', async () => {
      const basicAdmin = await User.create({
        username: 'p2b-basic', email: 'basic@p2b.example', password: 'TestPassword123!', role: 'company_admin', company: basic._id
      });
      const read = await request(app).get('/api/channels/settings').set(as(basicAdmin));
      expect(read.status).toBe(200);
      expect(read.body.allowed).toBe(false);

      const save = await request(app).put('/api/channels/whatsapp').set(as(basicAdmin)).send({
        phoneNumberId: '5000005', accessToken: 'x', appSecret: APP_SECRET_A
      });
      expect(save.status).toBe(402);
      expect(save.body.code).toBe('FEATURE_NOT_IN_PLAN');
    });

    test('the test message goes through the send path, to the number given', async () => {
      const response = await request(app).post('/api/channels/whatsapp/test').set(as(settingsAdmin)).send({ to: '+44 7700 900123' });
      expect(response.status).toBe(200);
      expect(response.body.to).toBe('+447700900123');
      expect(sends()[0]).toMatchObject({ path: '/v26.0/7000007/messages', body: { to: '447700900123', type: 'text' } });
    });

    test('the test message explains the 24-hour rule when WhatsApp refuses it', async () => {
      safeHttp.request.mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: JSON.stringify({ error: { message: '(#131047) Re-engagement message', code: 131047 } })
      });
      const response = await request(app).post('/api/channels/whatsapp/test').set(as(settingsAdmin)).send({ to: '+447700900123' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/last 24 hours/);
    });
  });

  describe('after 24 hours', () => {
    const stale = async () => {
      await post('whatsapp', whatsappPayload('1000001', [text('hello')]), APP_SECRET_A);
      await channels.settled();
      const [conversation] = await conversationsOf(acme);
      await Conversation.updateOne({ _id: conversation._id }, {
        $set: { 'external.lastInboundAt': new Date(Date.now() - 30 * 60 * 60 * 1000) }
      });
      graphCalls.length = 0;
      return conversation;
    };

    test('the composer is told only the template may be sent', async () => {
      const conversation = await stale();
      const response = await request(app)
        .get(`/api/channels/conversations/${conversation.sessionId}/window`)
        .set('x-auth-token', tokenFor(operator));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ provider: 'whatsapp', mode: 'template', template: 'follow_up' });
    });

    test('sending the template uses the customer\'s name and is recorded as the operator\'s', async () => {
      const conversation = await stale();
      const response = await request(app)
        .post(`/api/channels/conversations/${conversation.sessionId}/template`)
        .set('x-auth-token', tokenFor(operator));
      expect(response.status).toBe(200);

      expect(sends()[0].body).toMatchObject({
        to: '16505551234',
        type: 'template',
        template: {
          name: 'follow_up',
          language: { code: 'en_US' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sheena Nelson' }] }]
        }
      });

      const after = await Conversation.findById(conversation._id);
      const last = after.messages[after.messages.length - 1];
      expect(last).toMatchObject({ sender: 'operator', operatorName: 'Opal' });
      expect(last.content).toMatch(/follow_up/);
      expect(last.messageId).toMatch(/^wamid\./);
    });

    test('another company\'s operator cannot see or use it', async () => {
      const conversation = await stale();
      const outsider = await User.create({
        username: 'p2b-outsider', email: 'outsider@p2b.example', password: 'TestPassword123!', role: 'operator', company: beta._id
      });
      const window = await request(app)
        .get(`/api/channels/conversations/${conversation.sessionId}/window`)
        .set('x-auth-token', tokenFor(outsider));
      expect(window.status).toBe(404);
      const send = await request(app)
        .post(`/api/channels/conversations/${conversation.sessionId}/template`)
        .set('x-auth-token', tokenFor(outsider));
      expect(send.status).toBe(404);
      expect(sends()).toHaveLength(0);
    });

    test('admin\'s token is fine too', async () => {
      const conversation = await stale();
      const response = await request(app)
        .get(`/api/channels/conversations/${conversation.sessionId}/window`)
        .set('x-auth-token', tokenFor(admin));
      expect(response.status).toBe(200);
    });
  });
});
