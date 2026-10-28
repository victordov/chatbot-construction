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

  if (created) {
    // The same event a chat fires when it starts, so a tenant's CRM hears
    // about every new conversation whichever door it came through.
    require('./webhooks').dispatch(companyId, 'conversation.started', {
      sessionId: conversation.sessionId,
      channel: 'email',
      domain: conversation.domain || null,
      contactId: conversation.contact ? String(conversation.contact) : null,
      startedAt: conversation.startedAt
    });
  }

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

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A display name that cannot break out of its quotes or start a new header. */
function displayName(value) {
  return String(value || '').replace(/["\\\r\n<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Who an outbound email is from, and where replies go.
 *
 * Mail used to go out `From:` the tenant's own address through our SMTP
 * server. Unless the tenant had added us to their SPF record and DKIM, that
 * is exactly what a forged email looks like, and their customers' providers
 * treated it so: junk at best, rejected under DMARC at worst. So it now goes
 * out from the platform's verified address under the tenant's name -
 * "Acme Support (via Helpdesk)" - with `Reply-To` set to the tenant's support
 * address, which is where the customer's answer should land anyway.
 *
 * A deployment that has verified its tenants' domains can set
 * EMAIL_ALLOW_TENANT_FROM=true to send from the tenant's address as before.
 *
 * @returns {{from: string, address: string, replyTo: string|undefined}|null}
 *          null when there is no address to send from at all
 */
function senderFor(company, settings = {}) {
  const replyAs = displayName(settings.fromName || (company && company.name) || 'Support');
  const supportAddress = [settings.inboundAddress, settings.fromAddress]
    .find(value => value && EMAIL_ADDRESS.test(value));

  if (String(process.env.EMAIL_ALLOW_TENANT_FROM) === 'true' && supportAddress) {
    const own = settings.fromAddress && EMAIL_ADDRESS.test(settings.fromAddress)
      ? settings.fromAddress
      : supportAddress;
    return {
      from: `"${replyAs}" <${own}>`,
      address: own,
      replyTo: settings.inboundAddress || undefined
    };
  }

  const platformAddress = [process.env.EMAIL_FROM, process.env.EMAIL_USER]
    .find(value => value && EMAIL_ADDRESS.test(value));

  if (!platformAddress) {
    return null;
  }

  const via = displayName(process.env.PRODUCT_NAME || 'Support Desk');

  return {
    from: `"${replyAs} (via ${via})" <${platformAddress}>`,
    address: platformAddress,
    replyTo: supportAddress
  };
}

/** A Message-ID on the domain the mail is sent from, so it threads back to us. */
function newMessageId(fromAddress) {
  const domain = String(fromAddress || '').split('@')[1] || 'localhost';
  return `<${crypto.randomBytes(16).toString('hex')}@${domain}>`;
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

  const sender = senderFor(company, settings);
  if (!sender) {
    logger.error('Cannot send email reply: no sender address (set EMAIL_FROM)');
    return { sent: false, reason: 'no sender address configured (set EMAIL_FROM)' };
  }

  // Our own Message-ID, recorded so the customer's reply threads back to us.
  const messageId = newMessageId(sender.address);

  const inReplyTo = conversation.email.lastMessageId ||
    conversation.email.messageIds[conversation.email.messageIds.length - 1];

  const subject = /^re:/i.test(conversation.email.subject || '')
    ? conversation.email.subject
    : `Re: ${conversation.email.subject || '(no subject)'}`;

  const text = settings.signature ? `${body}\n\n--\n${settings.signature}` : body;

  try {
    await transport.sendMail({
      from: sender.from,
      to: conversation.email.from,
      replyTo: sender.replyTo,
      subject,
      text,
      messageId,
      inReplyTo: inReplyTo ? `<${inReplyTo}>` : undefined,
      // Both headers, because clients differ over which they honour.
      references: conversation.email.messageIds.map(id => `<${id}>`).join(' ') || undefined,
      headers: { 'X-Operator': displayName(operatorName) || 'Support' }
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

/**
 * The visitor's email address, from the best source there is.
 *
 * In order: the address they left for a follow-up, the one they typed into
 * the pre-chat form, the sender of an email thread, and the contact record.
 *
 * @returns {Promise<string|null>}
 */
async function visitorEmail(conversation) {
  if (!conversation) {
    return null;
  }

  const candidates = [];

  if (conversation.followUp && conversation.followUp.email) {
    candidates.push(conversation.followUp.email);
  }

  const metadata = conversation.metadata;
  if (metadata) {
    candidates.push(typeof metadata.get === 'function' ? metadata.get('email') : metadata.email);
  }

  if (conversation.channel === 'email' && conversation.email && conversation.email.from) {
    candidates.push(conversation.email.from);
  }

  const found = candidates.find(value => value && EMAIL_ADDRESS.test(String(value).trim()));
  if (found) {
    return String(found).trim().toLowerCase();
  }

  if (conversation.contact) {
    try {
      const Contact = require('../models/contact');
      const contact = await Contact.findById(conversation.contact).select('email').lean();
      if (contact && contact.email && EMAIL_ADDRESS.test(contact.email)) {
        return contact.email.toLowerCase();
      }
    } catch (error) {
      logger.warn('Could not read the contact for an email address', { error: error.message });
    }
  }

  return null;
}

/** "> " in front of every line, for quoting what somebody wrote. */
function quote(text, limit = 300) {
  const value = String(text || '').trim();
  const clipped = value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  return clipped.split('\n').map(line => `> ${line}`).join('\n');
}

/**
 * Answer, by email, a visitor who has left the chat.
 *
 * Most people do not keep a support tab open while somebody looks into their
 * question. Without this an operator's careful answer sat in a transcript the
 * visitor would only see if they happened to come back to the same browser.
 *
 * Works whether or not the tenant has switched on the inbound email channel:
 * this is outbound only, through the platform's transport, under the tenant's
 * name (see `senderFor`). Replies go to the tenant's support address when
 * they have one; when a reply to an earlier follow-up does come back through
 * the inbound channel it threads onto this conversation, because the
 * Message-IDs sent are recorded on it.
 *
 * On success the message is added to the conversation as the operator's,
 * with a transcript line saying where it went, and the conversation is saved.
 *
 * @param {object} conversation a mongoose document (a plain object is
 *        reloaded)
 * @param {string} text what the operator wrote
 * @param {{id?: string, _id?: string, displayName?: string, username?: string}} operatorUser
 * @returns {Promise<{sent: boolean, to?: string, reason?: string,
 *                    messageId?: string}>}
 */
async function sendFollowUp(conversation, text, operatorUser = {}) {
  const body = String(text || '').trim();

  if (!conversation || !body) {
    return { sent: false, reason: 'nothing to send' };
  }

  let doc = conversation;
  if (typeof doc.save !== 'function') {
    doc = await Conversation.findById(conversation._id);
    if (!doc) {
      return { sent: false, reason: 'conversation not found' };
    }
  }

  const to = await visitorEmail(doc);
  if (!to) {
    return { sent: false, reason: 'there is no email address for this visitor' };
  }

  const transport = buildTransport();
  if (!transport) {
    logger.error('Cannot send a follow-up: no outbound email configured');
    return { sent: false, reason: 'outbound email is not configured on this server (EMAIL_HOST)' };
  }

  const company = await Company.findById(doc.company).select('name emailChannel').lean();
  const settings = (company && company.emailChannel) || {};
  const sender = senderFor(company, settings);

  if (!sender) {
    return { sent: false, reason: 'no sender address is configured on this server (EMAIL_FROM)' };
  }

  const companyName = (company && company.name) || 'us';
  const operatorName = operatorUser.displayName || operatorUser.username || 'Support';

  if (!doc.email) {
    doc.email = {};
  }
  if (!doc.email.subject) {
    doc.email.subject = `Your conversation with ${companyName}`;
  }

  const messageIds = (doc.email.messageIds || []).filter(Boolean);
  const lastQuestion = [...(doc.messages || [])].reverse().find(message => message.sender === 'user');

  // The answer on top, the question it answers quoted underneath - the shape
  // of every email reply, so it reads as one rather than as a notification.
  const parts = [body];
  if (settings.signature) {
    parts.push(`--\n${settings.signature}`);
  }
  if (lastQuestion && lastQuestion.content) {
    parts.push(`You asked:\n${quote(lastQuestion.content)}`);
  }
  if (!sender.replyTo) {
    // Nowhere for a reply to go. Say so, rather than let them write into a
    // mailbox nobody reads.
    parts.push(doc.domain
      ? `Replies to this email are not read. To continue, chat with us again at ${doc.domain}.`
      : 'Replies to this email are not read. To continue, chat with us again on our website.');
  }

  const messageId = newMessageId(sender.address);

  try {
    await transport.sendMail({
      from: sender.from,
      to,
      replyTo: sender.replyTo,
      subject: messageIds.length ? `Re: ${doc.email.subject}` : doc.email.subject,
      text: parts.join('\n\n'),
      messageId,
      inReplyTo: messageIds.length ? `<${messageIds[messageIds.length - 1]}>` : undefined,
      references: messageIds.map(id => `<${id}>`).join(' ') || undefined,
      headers: { 'X-Operator': displayName(operatorName) || 'Support' }
    });
  } catch (error) {
    logger.error('Failed to send a follow-up email', { sessionId: doc.sessionId, error: error.message });
    return { sent: false, reason: error.message };
  }

  const bare = normaliseMessageId(messageId);
  const now = new Date();
  const operatorId = operatorUser.id || operatorUser._id;

  doc.email.messageIds = [...messageIds, bare];
  doc.email.lastMessageId = bare;

  doc.followUp = {
    email: (doc.followUp && doc.followUp.email) || to,
    requestedAt: doc.followUp ? doc.followUp.requestedAt : undefined,
    lastSentAt: now
  };

  doc.messages.push({
    content: body,
    sender: 'operator',
    operatorId: operatorId || undefined,
    operatorName,
    emailMessageId: bare,
    timestamp: now
  });
  const reply = doc.messages[doc.messages.length - 1];

  const lifecycle = require('./conversation-lifecycle');
  const line = lifecycle.addSystemLine(doc, `Sent by email to ${to}`);

  if (!doc.firstOperatorReplyAt) {
    doc.firstOperatorReplyAt = now;
  }
  doc.operatorEverJoined = true;
  doc.lastActivity = now;
  await doc.save();

  usageService.record(doc.company, { operatorMessages: 1, messages: 1 });

  const socketManager = require('../socketManager');
  lifecycle.announceMessages(doc, [reply, line], {
    operators: (event, payload) => socketManager.emitToOperators(doc.company, event, payload)
  });

  logger.info('Follow-up sent by email', { sessionId: doc.sessionId, operator: operatorName });

  return { sent: true, to, messageId: bare, replyId: String(reply._id) };
}

/**
 * Send a test email to somebody, through exactly the path replies take.
 *
 * So an admin finds out the server cannot send mail, or that it lands in
 * spam, before a customer's answer does.
 *
 * @returns {Promise<{sent: boolean, to?: string, from?: string,
 *                    replyTo?: string, reason?: string}>}
 */
async function sendTest(companyId, to) {
  if (!to || !EMAIL_ADDRESS.test(String(to))) {
    return { sent: false, reason: 'your account has no valid email address to send to' };
  }

  const transport = buildTransport();
  if (!transport) {
    return { sent: false, reason: 'outbound email is not configured on this server (EMAIL_HOST)' };
  }

  const company = await Company.findById(companyId).select('name emailChannel').lean();
  const settings = (company && company.emailChannel) || {};
  const sender = senderFor(company, settings);

  if (!sender) {
    return { sent: false, reason: 'no sender address is configured on this server (EMAIL_FROM)' };
  }

  try {
    await transport.sendMail({
      from: sender.from,
      to,
      replyTo: sender.replyTo,
      subject: 'Test email from your support desk',
      messageId: newMessageId(sender.address),
      text: [
        'This is a test of the email your customers receive when the team replies to them.',
        `It was sent from ${sender.address}${sender.replyTo ? `, and replies go to ${sender.replyTo}` : ''}.`,
        'If it arrived in your spam folder, the sending domain\'s SPF and DKIM records need attention before customers rely on it.'
      ].join('\n\n')
    });
  } catch (error) {
    logger.error('Test email failed', { companyId: String(companyId), error: error.message });
    return { sent: false, reason: error.message };
  }

  return { sent: true, to, from: sender.address, replyTo: sender.replyTo };
}

module.exports = {
  normaliseInbound,
  receive,
  sendReply,
  sendFollowUp,
  sendTest,
  senderFor,
  visitorEmail,
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
