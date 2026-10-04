/**
 * Email as a conversation channel.
 *
 * Most support teams get more email than chat, and until now this product
 * could only answer a widget. Email conversations land in the same queue, are
 * answered from the same composer, and belong to the same Contact — the only
 * difference is delivery.
 *
 * Two hard parts, both handled here:
 *
 *   threading  an inbound reply has to find the conversation it belongs to,
 *              across mail clients that quote, rewrite subjects and mangle
 *              headers.
 *   trust      the inbound webhook is a public URL. Without authentication
 *              anyone who found it could inject messages into a tenant's queue
 *              or impersonate their customers.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const contactService = require('./contacts');
const usageService = require('./usage');
const { logger } = require('./logging');

/**
 * Normalise the wildly different shapes providers post to a webhook.
 *
 * SendGrid, Mailgun and Postmark each invent their own field names; a generic
 * shape covers anything else, including a tenant's own relay.
 *
 * @returns {{from: string, to: string, subject: string, text: string,
 *            messageId: string, inReplyTo: string, references: string[]}|null}
 */
function normaliseInbound(provider, body = {}) {
  const pick = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

  let raw;

  switch (provider) {
  case 'sendgrid':
    raw = {
      from: body.from,
      to: body.to,
      subject: body.subject,
      text: pick(body.text, body.html),
      headers: body.headers
    };
    break;

  case 'mailgun':
    raw = {
      from: pick(body.sender, body.from, body['From']),
      to: pick(body.recipient, body.to, body['To']),
      subject: pick(body.subject, body['Subject']),
      text: pick(body['body-plain'], body['stripped-text'], body['body-html']),
      messageId: body['Message-Id'],
      inReplyTo: body['In-Reply-To'],
      references: body['References']
    };
    break;

  case 'postmark':
    raw = {
      from: body.From,
      to: body.To,
      subject: body.Subject,
      text: pick(body.TextBody, body.StrippedTextReply, body.HtmlBody),
      messageId: body.MessageID,
      inReplyTo: body.Headers &&
        (body.Headers.find(h => h.Name === 'In-Reply-To') || {}).Value,
      references: body.Headers &&
        (body.Headers.find(h => h.Name === 'References') || {}).Value
    };
    break;

  default:
    raw = {
      from: body.from,
      to: body.to,
      subject: body.subject,
      text: pick(body.text, body.body, body.html),
      messageId: pick(body.messageId, body['message-id']),
      inReplyTo: pick(body.inReplyTo, body['in-reply-to']),
      references: body.references
    };
  }

  // SendGrid delivers headers as one blob; pull out what threading needs.
  if (!raw.messageId && typeof raw.headers === 'string') {
    raw.messageId = (raw.headers.match(/^Message-ID:\s*(.+)$/im) || [])[1];
    raw.inReplyTo = (raw.headers.match(/^In-Reply-To:\s*(.+)$/im) || [])[1];
    raw.references = (raw.headers.match(/^References:\s*(.+)$/im) || [])[1];
  }

  const from = extractAddress(raw.from);

  if (!from) {
    // Without a sender there is nobody to reply to and no contact to attach.
    return null;
  }

  return {
    from,
    to: extractAddress(raw.to),
    subject: String(raw.subject || '(no subject)').slice(0, 500),
    text: cleanBody(raw.text),
    messageId: normaliseMessageId(raw.messageId),
    inReplyTo: normaliseMessageId(raw.inReplyTo),
    references: parseReferences(raw.references)
  };
}

/**
 * `Jordan Blake <jordan@example.com>` -> `jordan@example.com`
 */
function extractAddress(value) {
  if (!value) {
    return null;
  }
  const text = String(value);
  const angled = text.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : text).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

/** Message-IDs appear with and without angle brackets depending on the source. */
function normaliseMessageId(value) {
  if (!value) {
    return null;
  }
  return String(value).trim().replace(/^<|>$/g, '') || null;
}

function parseReferences(value) {
  if (!value) {
    return [];
  }
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return (text.match(/<([^>]+)>/g) || []).map(normaliseMessageId).filter(Boolean);
}

/**
 * Strip the quoted history a mail client appends.
 *
 * Without this every reply carries the whole thread again, so an operator
 * reads the same text five times and the model's context fills with echoes.
 */
function cleanBody(text) {
  if (!text) {
    return '';
  }

  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex(line =>
    /^\s*>/.test(line) ||
    /^\s*On .+ wrote:\s*$/.test(line) ||
    /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
    /^_{10,}$/.test(line) ||
    /^From:\s.+@/i.test(line)
  );

  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

/**
 * Authenticate a provider webhook.
 *
 * The URL is public, so this is what stops a stranger putting messages in a
 * tenant's queue. Compared in constant time because it is a secret.
 */
function verifyInboundSecret(provided, expected) {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Find the conversation an inbound email belongs to.
 *
 * Tried in order of reliability:
 *   1. In-Reply-To / References against Message-IDs we have seen — exact
 *   2. an open email thread with the same person and subject — good enough
 *   3. nothing, so it starts a new conversation
 */
async function findThread(companyId, parsed) {
  const candidateIds = [parsed.inReplyTo, ...parsed.references].filter(Boolean);

  if (candidateIds.length > 0) {
    const byHeader = await Conversation.findOne({
      company: companyId,
      'email.messageIds': { $in: candidateIds }
    });

    if (byHeader) {
      return byHeader;
    }
  }

  // Some clients drop the headers entirely on a forwarded or re-sent reply.
  // Falling back to sender plus normalised subject reunites those, and is
  // scoped to open threads so an old closed one is not reopened by accident.
  const normalisedSubject = parsed.subject.replace(/^((re|fwd?|aw|tr)\s*:\s*)+/i, '').trim();

  if (normalisedSubject) {
    return Conversation.findOne({
      company: companyId,
      channel: 'email',
      status: 'active',
      'email.from': parsed.from,
      'email.subject': new RegExp(`${escapeRegExp(normalisedSubject)}$`, 'i')
    }).sort({ lastActivity: -1 });
  }

  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn an inbound email into a message on a conversation.
 *
 * @returns {Promise<{conversation: object, created: boolean,
 *                    duplicate?: boolean}|null>} `duplicate` when this
 *          Message-ID had already been received, in which case nothing was
 *          appended
 */
async function receive(companyId, parsed) {
  if (!companyId || !parsed) {
    return null;
  }

  // Providers retry a webhook that answered 5xx, and some retry a 2xx they
  // did not see in time. Without this the same email lands twice, and the
  // operator answers a question the customer asked once. The Message-ID is
  // the provider's own identity for the message, so it is what makes a retry
  // recognisable as one.
  if (parsed.messageId) {
    const seen = await Conversation.findOne({
      company: companyId,
      'email.messageIds': parsed.messageId
    });

    if (seen) {
      logger.info('Inbound email already received; ignoring retry', {
        companyId: String(companyId),
        conversation: seen.sessionId,
        messageId: parsed.messageId
      });
      return { conversation: seen, created: false, duplicate: true };
    }
  }

  let conversation = await findThread(companyId, parsed);
  const created = !conversation;

  if (!conversation) {
    conversation = new Conversation({
      // Email threads have no browser session, so one is synthesised. Keeping
      // sessionId required means every conversation is addressable the same
      // way regardless of channel.
      sessionId: `email-${crypto.randomBytes(12).toString('hex')}`,
      company: companyId,
      channel: 'email',
      domain: parsed.from.split('@')[1],
      email: {
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        messageIds: []
      },
      messages: []
    });

    usageService.record(companyId, { conversations: 1 });
  } else if (conversation.status === 'ended') {
    // A reply to a closed thread reopens it rather than vanishing.
    conversation.status = 'active';
    conversation.endedAt = null;
  }

  if (parsed.messageId && !conversation.email.messageIds.includes(parsed.messageId)) {
    conversation.email.messageIds.push(parsed.messageId);
  }

  conversation.messages.push({
    content: parsed.text || '(empty message)',
    sender: 'user',
    emailMessageId: parsed.messageId,
    timestamp: new Date()
  });

  conversation.lastActivity = new Date();

  // The sender address is a claimed identity, not a verified one: anyone can
  // put any address in a From header without SPF/DKIM enforcement upstream.
  const contact = await contactService.resolve({
    companyId,
    sessionId: conversation.sessionId,
    email: parsed.from
  });

  if (contact) {
    await contactService.linkConversation(contact, conversation);
  }

  await conversation.save();
  usageService.record(companyId, { messages: 1 });

  logger.info('Inbound email received', {
    companyId: String(companyId),
    conversation: conversation.sessionId,
    newThread: created
  });

  return { conversation, created };
}

/**
 * Build the transport a company sends from.
 *
 * Falls back to the platform's own SMTP settings, so a tenant can use the
 * channel before configuring their own relay.
 */
function buildTransport() {
  if (!process.env.EMAIL_HOST) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    secure: String(process.env.EMAIL_SECURE) === 'true',
    auth: process.env.EMAIL_USER
      ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      : undefined
  });
}

/**
 * Send an operator's reply out by email, keeping the thread intact.
 *
 * @returns {Promise<{sent: boolean, messageId?: string, reason?: string}>}
 */
async function sendReply(conversation, body, operatorName) {
  if (!conversation || conversation.channel !== 'email') {
    return { sent: false, reason: 'not an email conversation' };
  }

  const company = await Company.findById(conversation.company)
    .select('name emailChannel')
    .lean();

  const settings = company?.emailChannel || {};

  if (!settings.enabled) {
    return { sent: false, reason: 'email channel is not enabled for this company' };
  }

  const transport = buildTransport();
  if (!transport) {
    // Surfaced rather than swallowed: an operator must know their reply did
    // not go out.
    logger.error('Cannot send email reply: no SMTP configured');
    return { sent: false, reason: 'no SMTP transport configured' };
  }

  // Our own Message-ID, recorded so the customer's reply threads back to us.
  const messageId = `<${crypto.randomBytes(16).toString('hex')}@${
    (settings.fromAddress || 'localhost').split('@')[1] || 'localhost'}>`;

  const inReplyTo = conversation.email.lastMessageId ||
    conversation.email.messageIds[conversation.email.messageIds.length - 1];

  const subject = /^re:/i.test(conversation.email.subject || '')
    ? conversation.email.subject
    : `Re: ${conversation.email.subject || '(no subject)'}`;

  const text = settings.signature ? `${body}\n\n--\n${settings.signature}` : body;

  try {
    await transport.sendMail({
      from: `"${settings.fromName || company.name}" <${settings.fromAddress || settings.inboundAddress}>`,
      to: conversation.email.from,
      replyTo: settings.inboundAddress,
      subject,
      text,
      messageId,
      inReplyTo: inReplyTo ? `<${inReplyTo}>` : undefined,
      // Both headers, because clients differ over which they honour.
      references: conversation.email.messageIds.map(id => `<${id}>`).join(' ') || undefined,
      headers: { 'X-Operator': operatorName || 'Support' }
    });

    const bare = normaliseMessageId(messageId);
    conversation.email.messageIds.push(bare);
    conversation.email.lastMessageId = bare;

    return { sent: true, messageId: bare };
  } catch (error) {
    logger.error('Failed to send email reply', { error: error.message });
    return { sent: false, reason: error.message };
  }
}

module.exports = {
  normaliseInbound,
  receive,
  sendReply,
  findThread,
  verifyInboundSecret,
  // The workflow notify node sends through the same transport, so the two
  // channels cannot drift apart in configuration.
  buildTransport,
  // Exported for tests: these carry most of the risk.
  extractAddress,
  cleanBody,
  parseReferences,
  normaliseMessageId
};
