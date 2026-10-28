/**
 * Sending to a customer on WhatsApp, Messenger or Instagram.
 *
 * The rest of the product talks to a visitor through events the widget
 * understands - `bot-message`, `operator-joined`, `chat-ended` - and this is
 * where those become messages on the customer's app. The bot, hand-overs and
 * notices therefore behave as they do on the website without any of that code
 * knowing which app the customer is on.
 *
 * Everything to one conversation goes out in order, one message at a time:
 * the providers deliver in the order they are called, and "Someone will be
 * with you shortly" arriving before the bot's "I'm passing you on" reads as
 * nonsense.
 */

const mongoose = require('mongoose');

const Conversation = require('../../models/conversation');
const channels = require('./index');
const graph = require('./graph');
const lifecycle = require('../conversation-lifecycle');
const usageService = require('../usage');
const socketManager = require('../../socketManager');
const { notice, HANDOFF_VALUE } = require('../visitor-notices');
const { logger } = require('../logging');

/** Events from the widget's vocabulary that mean something to a customer here. */
const NOTICE_EVENTS = new Set(['operator-requested', 'operator-joined', 'operator-left', 'chat-ended']);
const RELAYED_EVENTS = new Set(['bot-message', 'message-read', ...NOTICE_EVENTS]);

/**
 * Notices that say something untrue off the website. "Leave your email
 * address" makes no sense to somebody on WhatsApp: the team can answer them
 * where they are.
 */
const CHANNEL_NOTICES = {
  queued_offline: () => 'Nobody from the team is available right now. We will reply here as soon as someone is back.'
};

/** The tail of what is being sent to each conversation. */
const queues = new Map();
/** Everything in flight, so tests (and a graceful shutdown) can wait for it. */
const inFlight = new Set();

/**
 * Run `task` after everything already queued for this conversation. Never
 * rejects: a failed send is logged and reported where it happened.
 */
function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(task).catch(error => {
    logger.error('Could not send to a messaging-app customer', { conversation: key, error: error.message });
    return { sent: false, reason: error.message };
  });
  queues.set(key, run);
  inFlight.add(run);
  run.finally(() => {
    inFlight.delete(run);
    if (queues.get(key) === run) {
      queues.delete(key);
    }
  });
  return run;
}

/** Resolves once nothing is being sent. */
async function drained() {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function isHandoffChoice(choice) {
  return Boolean(choice) && (choice.action === 'handoff' || choice.value === HANDOFF_VALUE || choice.id === HANDOFF_VALUE);
}

/**
 * A reply's choices as buttons: a label to show and an id that comes back
 * when it is tapped. The widget sends a tapped choice's label as the visitor's
 * message, so the id is the label - the provider shortens what it shows, and
 * the full label is what the workflow is listening for.
 */
function choicesFrom(choices) {
  const seen = new Set();
  return (Array.isArray(choices) ? choices : [])
    .map(choice => {
      if (isHandoffChoice(choice)) {
        return { id: HANDOFF_VALUE, label: choice.label || notice('handoff_offer').message };
      }
      const label = typeof choice === 'string'
        ? choice
        : String(choice && (choice.label !== undefined ? choice.label : choice.value) || '');
      return { id: label, label };
    })
    .filter(choice => choice.label.trim() && !seen.has(choice.id) && seen.add(choice.id));
}

/** A time slot as a person reads it, in the server's locale. */
function slotLabel(item) {
  if (item.label) {
    return item.label;
  }
  const date = new Date(item.startsAt);
  return Number.isNaN(date.getTime()) ? String(item.startsAt || '') : date.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  });
}

/**
 * The text of a bot message with its cards written out: a messaging app has
 * no product cards, but a name, a price and a link say the same. Time slots
 * offered as choices are already buttons and are not listed twice.
 */
function composeText(text, cards, choices) {
  const items = cards && Array.isArray(cards.items) ? cards.items.slice(0, 8) : [];
  if (items.length === 0 || (cards.type === 'Slot' && choices.length > 0)) {
    return text;
  }

  const lines = items.map(item => {
    if (cards.type === 'Slot') {
      return `• ${slotLabel(item)}`;
    }
    const head = [item.title, item.price].filter(Boolean).join(' – ');
    return item.url ? `• ${head}\n  ${item.url}` : `• ${head}`;
  });
  return [text, lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * Send text (and choices) to the customer of a conversation.
 *
 * @returns {Promise<{sent: boolean, ids?: string[], reason?: string}>}
 */
async function sendReply(conversation, account, reply, options = {}) {
  const credentials = channels.credentialsFor(account);
  if (!credentials) {
    return {
      sent: false,
      reason: 'the channel\'s token or app secret could not be read; an admin needs to enter them again under Channels'
    };
  }

  const adapter = channels.adapterFor(conversation.channel);
  try {
    const result = await adapter.send(account, credentials, conversation.external.userId, reply, options);
    return { sent: true, ids: result.ids || [] };
  } catch (error) {
    channels.noteError(account, error);
    logger.warn('A messaging-app send was refused', {
      provider: conversation.channel,
      conversation: conversation.sessionId,
      code: error.code,
      error: error.message
    });
    return { sent: false, reason: graph.describe(error), error };
  }
}

/**
 * A line in the transcript saying a bot reply did not reach the customer, so
 * the team finds out from the inbox rather than from the customer.
 */
async function recordUndelivered(conversation, text) {
  const line = {
    _id: new mongoose.Types.ObjectId(),
    content: text,
    sender: 'system',
    path: 'system',
    timestamp: new Date()
  };
  try {
    await Conversation.updateOne({ _id: conversation._id }, { $push: { messages: line } });
    lifecycle.announceMessages(conversation, [line], {
      operators: (event, payload) => socketManager.emitToOperators(conversation.company, event, payload)
    });
  } catch (error) {
    logger.warn('Could not record an undelivered message', { error: error.message });
  }
}

/**
 * One widget event, as the customer's app receives it.
 *
 * Only while the 24-hour window is open: these are all automatic - the bot,
 * or a notice - and the providers allow nothing automatic after it, not even
 * with the Human Agent tag, which is for a person's own words.
 */
async function deliver(conversation, account, event, payload = {}) {
  if (!account || !conversation.external || !conversation.external.userId) {
    return { sent: false, reason: 'not connected' };
  }

  if (event === 'message-read') {
    if (payload.reader !== 'operator') {
      return { sent: false };
    }
    const credentials = channels.credentialsFor(account);
    const adapter = channels.adapterFor(conversation.channel);
    // WhatsApp marks one message by its id; ours are not WhatsApp's.
    const messageId = typeof payload.messageId === 'string' && payload.messageId.startsWith('wamid.')
      ? payload.messageId
      : null;
    if (!credentials || (conversation.channel === 'whatsapp' && !messageId)) {
      return { sent: false };
    }
    try {
      await adapter.markRead(account, credentials, messageId, conversation.external.userId);
      return { sent: true };
    } catch (error) {
      // A read receipt is a courtesy; failing one is not worth anybody's time.
      logger.debug('Could not mark a message read', { error: error.message });
      return { sent: false };
    }
  }

  const window = channels.windowFor(conversation, account);
  if (window.mode !== 'open') {
    logger.info('Not sending an automatic message outside the reply window', {
      conversation: conversation.sessionId,
      event
    });
    return { sent: false, reason: window.reason };
  }

  if (event === 'bot-message') {
    const choices = choicesFrom(payload.choices);
    const text = composeText(String(payload.text || ''), payload.cards, choices);
    if (!text.trim()) {
      return { sent: false };
    }
    const result = await sendReply(conversation, account, { text, choices });
    if (!result.sent) {
      await recordUndelivered(conversation,
        `The bot's reply did not reach the customer on ${channels.LABELS[conversation.channel]}: ${result.reason}`);
    }
    return result;
  }

  if (NOTICE_EVENTS.has(event)) {
    const special = payload.code && CHANNEL_NOTICES[payload.code];
    const text = special ? special(payload.params || {}) : payload.message;
    if (!text) {
      return { sent: false };
    }
    return sendReply(conversation, account, { text });
  }

  return { sent: false };
}

/** The account a conversation was received on, with its secrets. */
function accountOf(conversation) {
  return channels.findAccount(conversation.company, conversation.channel, { secrets: true });
}

/**
 * The `emit` the conversation lifecycle talks through, for a messaging-app
 * conversation: the customer's side goes out on their app, the operators'
 * side to the dashboard as for any other conversation.
 *
 * @param {object} conversation
 * @param {object} account the ChannelAccount, with secrets
 */
function customerEmit(conversation, account) {
  return {
    visitor: (event, payload) => {
      if (RELAYED_EVENTS.has(event)) {
        enqueue(conversation.sessionId, () => deliver(conversation, account, event, payload));
      }
    },
    operators: (event, payload) => socketManager.emitToOperators(conversation.company, event, payload)
  };
}

/**
 * What the socket layer sends a visitor's room, for a conversation whose
 * visitor is on a messaging app instead: an operator joining, leaving, ending
 * it, or reading what they wrote. Fire and forget.
 */
function toCustomer(sessionId, event, payload) {
  if (!RELAYED_EVENTS.has(event) || event === 'bot-message') {
    // A bot message to a channel customer is sent where it is made, with the
    // account already in hand (customerEmit); nothing else sends one.
    return Promise.resolve({ sent: false });
  }

  return enqueue(sessionId, async () => {
    const conversation = await Conversation.findOne({ sessionId })
      .select('sessionId company channel external status')
      .lean();
    if (!conversation || !channels.isMessagingChannel(conversation.channel)) {
      return { sent: false };
    }
    return deliver(conversation, await accountOf(conversation), event, payload);
  });
}

/**
 * Send an operator's reply, before it is stored, so a refusal can be shown to
 * the operator rather than leaving a message in the transcript that never
 * arrived.
 *
 * @returns {Promise<{sent: boolean, messageId?: string, reason?: string,
 *                    window?: boolean}>} `window` when the provider's rules,
 *          not a failure, are why it was not sent
 */
async function sendOperatorReply(conversation, text) {
  const account = await accountOf(conversation);
  const window = channels.windowFor(conversation, account);

  if (window.mode === 'template' || window.mode === 'closed') {
    return { sent: false, reason: window.reason, window: true };
  }

  const options = window.mode === 'human_agent' ? { tag: 'HUMAN_AGENT' } : {};
  const result = await enqueue(conversation.sessionId, () => sendReply(conversation, account, { text }, options));

  return result.sent
    ? { sent: true, messageId: result.ids && result.ids[0] ? result.ids[0] : undefined }
    : { sent: false, reason: result.reason };
}

/** Who the customer is, for a template's greeting. */
async function customerName(conversation) {
  const named = lifecycle.visitorName(conversation);
  if (named) {
    return named;
  }
  if (conversation.contact) {
    const Contact = require('../../models/contact');
    const contact = await Contact.findById(conversation.contact).select('name').lean();
    if (contact && contact.name) {
      return contact.name;
    }
  }
  return 'there';
}

/**
 * Send the tenant's approved WhatsApp template - the one way back to a
 * customer more than 24 hours after they last wrote - and record it in the
 * conversation as the operator's.
 *
 * @param {object} conversation a mongoose document
 * @param {{id: string, displayName?: string, username?: string}} operator
 * @returns {Promise<{sent: boolean, reason?: string, messageId?: string}>}
 */
async function sendTemplate(conversation, operator) {
  if (conversation.channel !== 'whatsapp') {
    return { sent: false, reason: 'Templates are only for WhatsApp conversations' };
  }

  const account = await accountOf(conversation);
  if (!account || account.enabled === false) {
    return { sent: false, reason: 'WhatsApp is not connected any more' };
  }
  const template = account.template || {};
  if (!template.name) {
    return { sent: false, reason: 'No template is set up. An admin can add one under Channels → WhatsApp.' };
  }
  const credentials = channels.credentialsFor(account);
  if (!credentials) {
    return { sent: false, reason: 'the channel\'s token or app secret could not be read; an admin needs to enter them again' };
  }

  const name = await customerName(conversation);
  const adapter = channels.adapterFor('whatsapp');

  const result = await enqueue(conversation.sessionId, async () => {
    try {
      const sent = await adapter.sendTemplate(account, credentials, conversation.external.userId, template, name);
      return { sent: true, ids: sent.ids };
    } catch (error) {
      channels.noteError(account, error);
      return { sent: false, reason: graph.describe(error) };
    }
  });

  if (!result.sent) {
    return result;
  }

  const now = new Date();
  const operatorName = operator.displayName || operator.username || 'Operator';
  conversation.messages.push({
    content: template.param === 'none'
      ? `Sent the WhatsApp template "${template.name}"`
      : `Sent the WhatsApp template "${template.name}" (to ${name})`,
    sender: 'operator',
    operatorId: operator.id,
    operatorName,
    messageId: result.ids && result.ids[0] ? result.ids[0] : undefined,
    timestamp: now
  });
  const stored = conversation.messages[conversation.messages.length - 1];

  conversation.operatorEverJoined = true;
  if (!conversation.firstOperatorReplyAt) {
    conversation.firstOperatorReplyAt = now;
  }
  conversation.lastActivity = now;
  await conversation.save();

  usageService.record(conversation.company, { operatorMessages: 1, messages: 1 });

  socketManager.emitToOperators(conversation.company, 'new-message', {
    sessionId: conversation.sessionId,
    message: stored.content,
    sender: 'operator',
    messageId: String(stored._id),
    operatorId: String(operator.id),
    operatorName,
    timestamp: now
  });
  lifecycle.announceMessages(conversation, [stored], {
    operators: (event, payload) => socketManager.emitToOperators(conversation.company, event, payload)
  });

  return { sent: true, messageId: String(stored._id) };
}

/**
 * "Send a test message to my number": the path a reply takes, to a number of
 * the admin's choosing, so a wrong token or phone number id shows up now
 * rather than on a customer's first message.
 */
async function sendTest(companyId, to) {
  const account = await channels.findAccount(companyId, 'whatsapp', { secrets: true });
  if (!account) {
    return { sent: false, reason: 'WhatsApp is not set up yet' };
  }
  const credentials = channels.credentialsFor(account);
  if (!credentials) {
    return { sent: false, reason: 'the token or app secret could not be read; enter them again and save' };
  }

  const number = String(to || '').replace(/[^\d]/g, '');
  if (number.length < 7 || number.length > 15) {
    return { sent: false, reason: 'enter the number in international format, with the country code' };
  }

  try {
    const result = await channels.adapterFor('whatsapp').send(account, credentials, number, {
      text: 'This is a test message from your support inbox. If you can read it, replies from the inbox will reach your customers on WhatsApp.'
    });
    return { sent: true, to: `+${number}`, messageId: result.ids[0] };
  } catch (error) {
    channels.noteError(account, error);
    const outsideWindow = error.code === 131047 || error.code === 131026;
    return {
      sent: false,
      reason: outsideWindow
        ? 'WhatsApp only delivers a free-form message to someone who wrote to this number in the last 24 hours. Send any message to your business number from that phone first, then try again.'
        : graph.describe(error)
    };
  }
}

module.exports = {
  CHANNEL_NOTICES,
  customerEmit,
  toCustomer,
  sendOperatorReply,
  sendTemplate,
  sendTest,
  enqueue,
  drained,
  deliver,
  // Exported for tests.
  choicesFrom,
  composeText
};
