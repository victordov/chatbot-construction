/**
 * Answering by email, and sending email that arrives.
 *
 * Two problems, one fix each. Replies used to go out `From:` the tenant's own
 * address through our server, which their customers' providers rightly treat
 * as forged. And a chat visitor who had left never saw the operator's answer.
 * Now mail goes out from the platform's address under the tenant's name with
 * `Reply-To` their support address, and an answer to somebody who has gone
 * is sent to the email they gave.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({ generateOperatorSuggestion: jest.fn().mockResolvedValue('draft') })
}));

const mockSendMail = jest.fn().mockResolvedValue({});
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail }))
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { createHarness, waitFor, pause, eventually } = require('./ws1-socket-harness');
const emailChannel = require('../services/email-channel');
const Company = require('../models/company');
const User = require('../models/user');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const AuditLog = require('../models/audit-log');

const ENV = ['EMAIL_HOST', 'EMAIL_FROM', 'EMAIL_USER', 'EMAIL_ALLOW_TENANT_FROM', 'PRODUCT_NAME'];

describe('WS1: email that arrives', () => {
  const harness = createHarness();
  const saved = {};
  let acme;
  let bare;
  let admin;
  let operator;
  let app;

  const adminToken = () => jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET);

  const chat = (overrides = {}) => Conversation.create({
    sessionId: `ws1-mail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    company: acme._id,
    domain: 'https://acme-mail.test',
    messages: [
      { content: 'Can you check whether my order 1234 has shipped?', sender: 'user' },
      { content: 'Let me find out.', sender: 'bot', path: 'assistant' }
    ],
    followUp: { email: 'jo@example.com', requestedAt: new Date() },
    ...overrides
  });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    ENV.forEach(key => {
      saved[key] = process.env[key];
    });
    process.env.EMAIL_HOST = 'smtp.platform.test';
    process.env.EMAIL_FROM = 'replies@platform.test';
    process.env.PRODUCT_NAME = 'Helpdesk';
    delete process.env.EMAIL_ALLOW_TENANT_FROM;

    acme = await Company.create({
      name: 'Acme WS1 Mail',
      emailChannel: {
        enabled: true,
        inboundAddress: 'support@acme-mail.test',
        fromName: 'Acme Support',
        fromAddress: 'hello@acme-mail.test',
        signature: 'Acme Support · acme-mail.test'
      }
    });
    // A tenant that never set up email at all.
    bare = await Company.create({ name: 'Bare WS1 Mail' });

    admin = await User.create({
      username: 'mail-ws1-admin', email: 'admin@mail-ws1.example', password: 'TestPassword123!',
      role: 'company_admin', displayName: 'Dana', company: acme._id
    });
    operator = await User.create({
      username: 'mail-ws1-op', email: 'op@mail-ws1.example', password: 'TestPassword123!',
      role: 'operator', displayName: 'Ada', company: acme._id
    });

    app = express();
    app.use(express.json());
    app.use('/api/companies', require('../routes/company'));
    app.use('/api/email', require('../routes/email'));

    await harness.start();
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({});
  });

  afterEach(async () => {
    harness.closeAll();
    await pause(20);
  });

  afterAll(async () => {
    await harness.stop();
    ENV.forEach(key => {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    });
    await Conversation.deleteMany({ company: { $in: [acme._id, bare._id] } });
    await Conversation.deleteMany({ sessionId: /^ws1-/ });
    await Contact.deleteMany({ company: { $in: [acme._id, bare._id] } });
    await AuditLog.deleteMany({ company: acme._id });
    await User.deleteMany({ email: /@mail-ws1\.example$/ });
    await Company.deleteMany({ name: /WS1 Mail$/ });
    await mongoose.connection.close();
  });

  describe('sendFollowUp', () => {
    it('sends from the platform under the tenant\'s name, with replies going to the tenant', async () => {
      const conversation = await chat();

      const result = await emailChannel.sendFollowUp(conversation, 'It shipped this morning.', {
        id: operator._id, displayName: 'Ada'
      });

      expect(result).toMatchObject({ sent: true, to: 'jo@example.com' });
      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.from).toBe('"Acme Support (via Helpdesk)" <replies@platform.test>');
      expect(mail.replyTo).toBe('support@acme-mail.test');
      expect(mail.to).toBe('jo@example.com');
      expect(mail.subject).toBe('Your conversation with Acme WS1 Mail');
      expect(mail.messageId).toMatch(/@platform\.test>$/);
      // The answer, the signature, then the question it answers.
      expect(mail.text).toMatch(/^It shipped this morning\.\n\n--\nAcme Support/);
      expect(mail.text).toContain('> Can you check whether my order 1234 has shipped?');
    });

    it('records the message as the operator\'s, says where it went, and threads the next one', async () => {
      const conversation = await chat();

      await emailChannel.sendFollowUp(conversation, 'It shipped this morning.', { id: operator._id, displayName: 'Ada' });
      await emailChannel.sendFollowUp(conversation, 'Tracking: ABC123.', { id: operator._id, displayName: 'Ada' });

      const stored = await Conversation.findById(conversation._id).lean();
      expect(stored.messages.slice(2).map(m => [m.sender, m.content])).toEqual([
        ['operator', 'It shipped this morning.'],
        ['system', 'Sent by email to jo@example.com'],
        ['operator', 'Tracking: ABC123.'],
        ['system', 'Sent by email to jo@example.com']
      ]);
      expect(String(stored.messages[2].operatorId)).toBe(String(operator._id));
      expect(stored.followUp.lastSentAt).toBeInstanceOf(Date);
      expect(stored.firstOperatorReplyAt).toBeInstanceOf(Date);
      expect(stored.email.messageIds).toHaveLength(2);

      const second = mockSendMail.mock.calls[1][0];
      expect(second.subject).toBe('Re: Your conversation with Acme WS1 Mail');
      expect(second.inReplyTo).toBe(`<${stored.email.messageIds[0]}>`);
    });

    it('a customer\'s reply to it lands back on the same conversation', async () => {
      const conversation = await chat();
      await emailChannel.sendFollowUp(conversation, 'It shipped.', { id: operator._id, displayName: 'Ada' });
      const sentId = (await Conversation.findById(conversation._id).lean()).email.messageIds[0];

      const result = await emailChannel.receive(acme._id, {
        from: 'jo@example.com', to: 'support@acme-mail.test', subject: 'Re: Your conversation',
        text: 'Thank you!', messageId: 'reply-1@example.com', inReplyTo: sentId, references: []
      });

      expect(String(result.conversation._id)).toBe(String(conversation._id));
      expect(result.created).toBe(false);
    });

    it('sends from the tenant\'s own address where the deployment allows it', async () => {
      process.env.EMAIL_ALLOW_TENANT_FROM = 'true';
      try {
        await emailChannel.sendFollowUp(await chat(), 'Hello again.', { displayName: 'Ada' });
        expect(mockSendMail.mock.calls[0][0].from).toBe('"Acme Support" <hello@acme-mail.test>');
      } finally {
        delete process.env.EMAIL_ALLOW_TENANT_FROM;
      }
    });

    it('works for a tenant that never set up the email channel, and says replies are not read', async () => {
      const conversation = await chat({ company: bare._id });

      const result = await emailChannel.sendFollowUp(conversation, 'We have an answer.', { displayName: 'Ada' });

      expect(result.sent).toBe(true);
      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.from).toBe('"Bare WS1 Mail (via Helpdesk)" <replies@platform.test>');
      expect(mail.replyTo).toBeUndefined();
      expect(mail.text).toContain('Replies to this email are not read. To continue, chat with us again at https://acme-mail.test.');
    });

    it('finds the address the visitor typed into the pre-chat form when they left none', async () => {
      const conversation = await chat({ followUp: undefined, metadata: { email: 'Form@Example.com' } });

      expect(await emailChannel.sendFollowUp(conversation, 'Hi', { displayName: 'Ada' }))
        .toMatchObject({ sent: true, to: 'form@example.com' });
    });

    it('accepts a plain object and loads the conversation itself', async () => {
      const conversation = await chat();

      expect(await emailChannel.sendFollowUp(conversation.toObject(), 'Hi', { displayName: 'Ada' }))
        .toMatchObject({ sent: true });
    });

    it('says why when there is nobody to send to', async () => {
      const conversation = await chat({ followUp: undefined });

      const result = await emailChannel.sendFollowUp(conversation, 'Hi', { displayName: 'Ada' });

      expect(result).toEqual({ sent: false, reason: 'there is no email address for this visitor' });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('says why when the server cannot send mail, and changes nothing', async () => {
      const conversation = await chat();
      delete process.env.EMAIL_HOST;
      try {
        const result = await emailChannel.sendFollowUp(conversation, 'Hi', { displayName: 'Ada' });
        expect(result.sent).toBe(false);
        expect(result.reason).toMatch(/EMAIL_HOST/);
      } finally {
        process.env.EMAIL_HOST = 'smtp.platform.test';
      }
      expect((await Conversation.findById(conversation._id)).messages).toHaveLength(2);
    });

    it('says why when the provider refuses it', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('550 relay denied'));

      expect(await emailChannel.sendFollowUp(await chat(), 'Hi', { displayName: 'Ada' }))
        .toEqual({ sent: false, reason: '550 relay denied' });
    });
  });

  describe('replies on an email thread', () => {
    it('go out from the platform with Reply-To the support address', async () => {
      const { conversation } = await emailChannel.receive(acme._id, {
        from: 'sam@example.com', to: 'support@acme-mail.test', subject: 'Refund',
        text: 'Where is my refund?', messageId: 'in-1@example.com', references: []
      });

      const result = await emailChannel.sendReply(conversation, 'On its way.', 'Ada');

      expect(result.sent).toBe(true);
      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.from).toBe('"Acme Support (via Helpdesk)" <replies@platform.test>');
      expect(mail.replyTo).toBe('support@acme-mail.test');
      expect(mail.inReplyTo).toBe('<in-1@example.com>');
    });
  });

  describe('an operator answering a visitor who has left', () => {
    it('emails the answer to the address they left, and tells the operator', async () => {
      const conversation = await chat();
      const op = await harness.connectOperator(operator);

      op.emit('operator-message', { sessionId: conversation.sessionId, message: 'It shipped this morning.' });

      expect(await waitFor(op, 'operator-message-emailed')).toMatchObject({
        sessionId: conversation.sessionId, to: 'jo@example.com'
      });
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('does not email a visitor who is still in the chat', async () => {
      const visitor = await harness.startVisitor('still-here', acme.widgetKey);
      harness.say(visitor.socket, 'hello');
      await waitFor(visitor.socket, 'bot-message');
      await Conversation.updateOne({ sessionId: visitor.sessionId }, { $set: { 'followUp.email': 'jo@example.com' } });

      const op = await harness.connectOperator(operator);
      op.emit('operator-message', { sessionId: visitor.sessionId, message: 'Here now.' });

      expect((await waitFor(visitor.socket, 'operator-message')).text).toBe('Here now.');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('keeps the answer in the conversation, and warns the operator, when the email fails', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('mailbox full'));
      const conversation = await chat();
      const op = await harness.connectOperator(operator);

      op.emit('operator-message', { sessionId: conversation.sessionId, message: 'Saved for later.' });

      expect((await waitFor(op, 'error')).message).toMatch(/could not be sent: mailbox full/);
      const stored = await eventually(async () => {
        const found = await Conversation.findById(conversation._id).lean();
        return found.messages.some(m => m.sender === 'operator') ? found : null;
      });
      expect(stored.messages.at(-1)).toMatchObject({ sender: 'operator', content: 'Saved for later.' });
    });
  });

  describe('the settings screen', () => {
    it('shows where to post, the header option, when mail last arrived and who replies come from', async () => {
      const inbound = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic`)
        .set('X-Inbound-Secret', (await Company.findById(acme._id).select('+emailChannel.inboundSecret')).emailChannel.inboundSecret)
        .send({ from: 'pat@example.com', to: 'support@acme-mail.test', subject: 'Hi', text: 'Testing' });
      expect(inbound.status).toBe(200);

      const response = await request(app).get('/api/companies/me/email').set('x-auth-token', adminToken());

      expect(response.status).toBe(200);
      expect(response.body.inboundUrlBase).toMatch(new RegExp(`/api/email/inbound/${acme._id}/generic$`));
      expect(response.body.inboundSecret).toMatch(/^[0-9a-f]+$/);
      expect(response.body.inboundUrl).toBe(`${response.body.inboundUrlBase}?secret=${response.body.inboundSecret}`);
      expect(new Date(response.body.lastInboundAt).getTime()).toBeGreaterThan(Date.now() - 60000);
      expect(response.body.sender).toEqual({
        from: '"Acme Support (via Helpdesk)" <replies@platform.test>',
        replyTo: 'support@acme-mail.test'
      });
    });

    it('records who changed the settings, and from what to what', async () => {
      const response = await request(app)
        .put('/api/companies/me/email')
        .set('x-auth-token', adminToken())
        .send({ enabled: true, inboundAddress: 'help@acme-mail.test', fromName: 'Acme Help', fromAddress: '', signature: '' });

      expect(response.status).toBe(200);
      const entry = await eventually(() => AuditLog.findOne({ company: acme._id, action: 'email.settings_updated' }).lean());
      expect(entry.details.from.inboundAddress).toBe('support@acme-mail.test');
      expect(entry.details.to).toMatchObject({ inboundAddress: 'help@acme-mail.test', fromName: 'Acme Help' });
      expect(JSON.stringify(entry)).not.toMatch(/inboundSecret/);

      await Company.updateOne({ _id: acme._id }, {
        $set: {
          'emailChannel.inboundAddress': 'support@acme-mail.test',
          'emailChannel.fromName': 'Acme Support',
          'emailChannel.fromAddress': 'hello@acme-mail.test'
        }
      });
    });

    it('sends a test email to the signed-in admin through the path replies take', async () => {
      const response = await request(app).post('/api/companies/me/email/test').set('x-auth-token', adminToken());

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ sent: true, to: 'admin@mail-ws1.example', from: 'replies@platform.test' });
      expect(mockSendMail.mock.calls[0][0]).toMatchObject({
        to: 'admin@mail-ws1.example',
        from: '"Acme Support (via Helpdesk)" <replies@platform.test>'
      });
    });

    it('says why a test email could not be sent', async () => {
      delete process.env.EMAIL_HOST;
      try {
        const response = await request(app).post('/api/companies/me/email/test').set('x-auth-token', adminToken());
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/EMAIL_HOST/);
      } finally {
        process.env.EMAIL_HOST = 'smtp.platform.test';
      }
    });

    it('is for admins only', async () => {
      const token = jwt.sign({ id: String(operator._id) }, process.env.JWT_SECRET);
      expect((await request(app).post('/api/companies/me/email/test').set('x-auth-token', token)).status).toBe(403);
    });
  });
});
