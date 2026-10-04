/**
 * Email as a conversation channel.
 *
 * The risky parts are threading (a reply must find its conversation across
 * mail clients that mangle headers) and trust (the inbound webhook is a public
 * URL).
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const emailChannel = require('../services/email-channel');

const buildApp = () => {
  const app = express();
  app.use('/api/email', require('../routes/email'));
  return app;
};

describe('Email channel', () => {
  let app;
  let acme;
  let secret;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({
      name: 'Email Acme',
      emailChannel: { enabled: true, inboundAddress: 'support@acme.example' }
    });

    const withSecret = await Company.findById(acme._id).select('+emailChannel.inboundSecret');
    secret = withSecret.emailChannel.inboundSecret;
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: acme._id });
    await Contact.deleteMany({ company: acme._id });
    await Company.deleteMany({ name: /^Email / });
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ company: acme._id });
    await Contact.deleteMany({ company: acme._id });
  });

  describe('parsing', () => {
    test('extracts an address from a display-name form', () => {
      expect(emailChannel.extractAddress('Jordan Blake <jordan@example.com>'))
        .toBe('jordan@example.com');
      expect(emailChannel.extractAddress('plain@example.com')).toBe('plain@example.com');
      expect(emailChannel.extractAddress('not an address')).toBeNull();
    });

    test('strips quoted history so a thread does not repeat itself', () => {
      const body = [
        'Thanks, that worked.',
        '',
        'On Tue, 5 Aug 2026 at 10:00, Support wrote:',
        '> Have you tried restarting?',
        '> Support team'
      ].join('\n');

      expect(emailChannel.cleanBody(body)).toBe('Thanks, that worked.');
    });

    test('strips an Outlook-style original message block', () => {
      const body = 'My reply\n\n-----Original Message-----\nFrom: support@acme.example';
      expect(emailChannel.cleanBody(body)).toBe('My reply');
    });

    test('normalises Message-IDs with and without brackets', () => {
      expect(emailChannel.normaliseMessageId('<abc@example.com>')).toBe('abc@example.com');
      expect(emailChannel.normaliseMessageId('abc@example.com')).toBe('abc@example.com');
    });

    test('parses a References chain', () => {
      expect(emailChannel.parseReferences('<one@x.com> <two@x.com>'))
        .toEqual(['one@x.com', 'two@x.com']);
    });

    test.each(['sendgrid', 'mailgun', 'postmark', 'generic'])(
      'understands a %s payload', provider => {
        const payloads = {
          sendgrid: { from: 'a@x.com', to: 'support@acme.example', subject: 'Help', text: 'hi' },
          mailgun: { sender: 'a@x.com', recipient: 'support@acme.example', subject: 'Help', 'body-plain': 'hi' },
          postmark: { From: 'a@x.com', To: 'support@acme.example', Subject: 'Help', TextBody: 'hi' },
          generic: { from: 'a@x.com', to: 'support@acme.example', subject: 'Help', text: 'hi' }
        };

        const parsed = emailChannel.normaliseInbound(provider, payloads[provider]);
        expect(parsed.from).toBe('a@x.com');
        expect(parsed.subject).toBe('Help');
        expect(parsed.text).toBe('hi');
      });

    test('refuses a payload with no usable sender', () => {
      expect(emailChannel.normaliseInbound('generic', { subject: 'x', text: 'y' })).toBeNull();
    });
  });

  describe('threading', () => {
    const inbound = (overrides = {}) => ({
      from: 'jordan@example.com',
      to: 'support@acme.example',
      subject: 'Order 1234',
      text: 'Where is my order?',
      messageId: 'msg-1@example.com',
      inReplyTo: null,
      references: [],
      ...overrides
    });

    test('a first email starts a conversation on the email channel', async () => {
      const { conversation, created } = await emailChannel.receive(acme._id, inbound());

      expect(created).toBe(true);
      expect(conversation.channel).toBe('email');
      expect(conversation.messages).toHaveLength(1);
    });

    test('a reply threads onto the same conversation via In-Reply-To', async () => {
      const first = await emailChannel.receive(acme._id, inbound());

      const second = await emailChannel.receive(acme._id, inbound({
        messageId: 'msg-2@example.com',
        inReplyTo: 'msg-1@example.com',
        text: 'Any update?'
      }));

      expect(second.created).toBe(false);
      expect(second.conversation._id.toString()).toBe(first.conversation._id.toString());
      expect(second.conversation.messages).toHaveLength(2);
    });

    test('threads via the References chain when In-Reply-To is missing', async () => {
      await emailChannel.receive(acme._id, inbound());

      const second = await emailChannel.receive(acme._id, inbound({
        messageId: 'msg-3@example.com',
        references: ['msg-1@example.com'],
        text: 'Still waiting'
      }));

      expect(second.created).toBe(false);
    });

    test('falls back to sender and subject when a client drops the headers', async () => {
      await emailChannel.receive(acme._id, inbound());

      // Some clients strip threading headers on a forwarded reply.
      const second = await emailChannel.receive(acme._id, inbound({
        messageId: 'msg-4@example.com',
        subject: 'Re: Order 1234',
        text: 'Bumping this'
      }));

      expect(second.created).toBe(false);
    });

    test('a provider retry of the same Message-ID is not appended twice', async () => {
      // Providers retry a webhook that answered 5xx. Before this the same
      // email landed twice and the operator answered a question the customer
      // asked once.
      const first = await emailChannel.receive(acme._id, inbound());
      const retry = await emailChannel.receive(acme._id, inbound());

      expect(retry.duplicate).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.conversation._id.toString()).toBe(first.conversation._id.toString());
      expect((await Conversation.findById(first.conversation._id)).messages).toHaveLength(1);
    });

    test('a retried reply is recognised even though it would thread by header', async () => {
      await emailChannel.receive(acme._id, inbound());
      const reply = inbound({ messageId: 'msg-2@example.com', inReplyTo: 'msg-1@example.com', text: 'Any update?' });

      await emailChannel.receive(acme._id, reply);
      const retry = await emailChannel.receive(acme._id, reply);

      expect(retry.duplicate).toBe(true);
      expect(retry.conversation.messages).toHaveLength(2);
    });

    test('a different subject from the same person starts a new thread', async () => {
      await emailChannel.receive(acme._id, inbound());

      const other = await emailChannel.receive(acme._id, inbound({
        messageId: 'msg-5@example.com',
        subject: 'A completely different question'
      }));

      expect(other.created).toBe(true);
    });

    test('replying to a closed thread reopens it', async () => {
      const first = await emailChannel.receive(acme._id, inbound());
      first.conversation.status = 'ended';
      await first.conversation.save();

      const reply = await emailChannel.receive(acme._id, inbound({
        messageId: 'msg-6@example.com',
        inReplyTo: 'msg-1@example.com'
      }));

      expect(reply.conversation.status).toBe('active');
    });

    test('the sender becomes a contact, self-reported rather than verified', async () => {
      // A From header is trivially forged, so it can never mean verified.
      const { conversation } = await emailChannel.receive(acme._id, inbound());

      const contact = await Contact.findById(conversation.contact);
      expect(contact.email).toBe('jordan@example.com');
      expect(contact.identityLevel).toBe('claimed');
    });
  });

  describe('inbound webhook', () => {
    const payload = {
      from: 'jordan@example.com',
      to: 'support@acme.example',
      subject: 'Help please',
      text: 'My order is late'
    };

    test('accepts a request with the right secret', async () => {
      const response = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic?secret=${secret}`)
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.accepted).toBe(true);
    });

    test('rejects a request with no secret', async () => {
      // The endpoint is a public URL; without this anyone could inject
      // messages into a tenant's queue.
      const response = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic`)
        .send(payload);

      expect(response.status).toBe(401);
      expect(await Conversation.countDocuments({ company: acme._id })).toBe(0);
    });

    test('rejects a request with the wrong secret', async () => {
      const response = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic?secret=wrong`)
        .send(payload);

      expect(response.status).toBe(401);
    });

    test('accepts the secret in a header', async () => {
      const response = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic`)
        .set('x-inbound-secret', secret)
        .send(payload);

      expect(response.status).toBe(200);
    });

    test('an unknown company looks the same as a disabled channel', async () => {
      // So the endpoint cannot be used to enumerate tenants.
      const unknown = new mongoose.Types.ObjectId();
      const response = await request(app)
        .post(`/api/email/inbound/${unknown}/generic?secret=${secret}`)
        .send(payload);

      expect(response.status).toBe(404);
    });

    test('a company with the channel disabled is refused', async () => {
      const off = await Company.create({ name: 'Email Disabled Co' });

      const response = await request(app)
        .post(`/api/email/inbound/${off._id}/generic?secret=${secret}`)
        .send(payload);

      expect(response.status).toBe(404);
      await Company.deleteOne({ _id: off._id });
    });

    test('an unparseable message is acknowledged, not retried forever', async () => {
      // Providers retry 5xx indefinitely, and this will never parse.
      const response = await request(app)
        .post(`/api/email/inbound/${acme._id}/generic?secret=${secret}`)
        .send({ subject: 'no sender' });

      expect(response.status).toBe(202);
      expect(response.body.accepted).toBe(false);
    });
  });

  describe('outbound', () => {
    test('refuses to send on a chat conversation', async () => {
      const chat = await Conversation.create({
        sessionId: 'chat-1', company: acme._id, channel: 'chat', messages: []
      });

      const result = await emailChannel.sendReply(chat, 'hello', 'Bea');
      expect(result.sent).toBe(false);
    });

    test('reports a missing transport rather than silently dropping a reply', async () => {
      // An operator must know their reply did not go out.
      const { conversation } = await emailChannel.receive(acme._id, {
        from: 'jordan@example.com', to: 'support@acme.example',
        subject: 'Hi', text: 'hello', messageId: 'm@x.com', references: []
      });

      const previous = process.env.EMAIL_HOST;
      delete process.env.EMAIL_HOST;

      const result = await emailChannel.sendReply(conversation, 'our reply', 'Bea');
      expect(result.sent).toBe(false);
      expect(result.reason).toMatch(/SMTP/i);

      if (previous) {
        process.env.EMAIL_HOST = previous;
      }
    });
  });
});
