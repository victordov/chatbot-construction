/**
 * The parts of a conversation's life that both entry points share.
 *
 * A visitor reaches us over the socket (websockets.js) or, when a socket is
 * not possible, over the REST fallback (routes/chat.js). Both have to start a
 * conversation the same way, hand over to a person the same way and record a
 * bot's reply the same way, or the REST path quietly stops behaving like the
 * product. What differs is only how a message reaches the visitor, so every
 * function here that talks takes an `emit` with two methods:
 *
 *   emit.visitor(event, payload)    the visitor's widget
 *   emit.operators(event, payload)  the tenant's operators and superadmins
 */

const Conversation = require('../models/conversation');
const Company = require('../models/company');
const usageService = require('./usage');
const contactService = require('./contacts');
const assignmentService = require('./assignment');
const availability = require('./availability');
const webhooks = require('./webhooks');
const emailChannel = require('./email-channel');
const push = require('./push');
const { getResponseTemplateService } = require('./responseTemplates');
const { notice, fillPlaceholders, handoffChoice } = require('./visitor-notices');
const { logger } = require('./logging');

/** Bot answers a visitor may rate. Hand-over lines and apologies are not answers. */
const RATEABLE_PATHS = new Set(['assistant', 'canned', 'workflow']);

/** How a bot reply can have been made, as models/conversation.js stores it. */
const REPLY_PATHS = new Set(['workflow', 'canned', 'assistant', 'fallback', 'handoff']);

/** How long a preview of a message is, wherever one is shown. */
const PREVIEW_LENGTH = 140;

/** What the transcript says when a conversation is handed to the team, by reason. */
const HANDOFF_LINES = {
  visitor_request: 'Asked for a person',
  bot_unanswered: 'The bot could not answer and handed this to the team',
  model_error: 'The bot could not reply (the AI model failed) and handed this to the team',
  quota: 'AI replies for this month are used up; handed to the team',
  workflow: 'The workflow handed this to the team',
  offline_message: 'Left a message while nobody was available'
};

function preview(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH - 1)}…` : value;
}

function companyOf(conversation) {
  return conversation && conversation.company ? String(conversation.company) : null;
}

/** The name the visitor gave, if they gave one. */
function visitorName(conversation) {
  const metadata = conversation && conversation.metadata;
  if (!metadata) {
    return '';
  }
  const name = typeof metadata.get === 'function' ? metadata.get('name') : metadata.name;
  return name ? String(name) : '';
}

/** The last thing the visitor said, for a preview. */
function lastVisitorMessage(conversation) {
  const messages = (conversation && conversation.messages) || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].sender === 'user') {
      return messages[i];
    }
  }
  return null;
}

/**
 * Whether the visitor may rate this message.
 *
 * Only a bot answer: not a hand-over line, not an apology, and not "I don't
 * know" - there is nothing to rate in an answer that was not given, and the
 * unanswered flag already records it.
 */
function canRate(message) {
  return Boolean(message) && message.sender === 'bot' &&
    RATEABLE_PATHS.has(message.path) && !message.unanswered;
}

/**
 * A stored message as the operators' screens receive it.
 *
 * The same shape for every sender, so the dashboard can render a colleague's
 * reply, a bot answer and a transcript event from one event.
 */
function messageForOperators(message) {
  return {
    _id: message._id ? String(message._id) : undefined,
    sender: message.sender,
    content: message.content,
    operatorName: message.operatorName || undefined,
    operatorId: message.operatorId ? String(message.operatorId) : undefined,
    timestamp: message.timestamp || new Date(),
    path: message.path || undefined,
    sources: message.sources && message.sources.length ? message.sources : undefined,
    fileId: message.fileId || undefined,
    fileName: message.fileId ? message.fileName : undefined,
    unanswered: message.unanswered ? true : undefined
  };
}

/**
 * Tell the tenant's operators about messages that have just been stored.
 *
 * Every persisted message goes out this way - the visitor's, the bot's, an
 * operator's and a transcript event - so a colleague with the same
 * conversation open sees what everyone else sees. Operator replies used to
 * reach nobody but the visitor.
 */
function announceMessages(conversation, messages, emit) {
  if (!emit || typeof emit.operators !== 'function') {
    return;
  }

  (messages || []).filter(Boolean).forEach(message => {
    emit.operators('conversation-message', {
      sessionId: conversation.sessionId,
      message: messageForOperators(message)
    });
  });
}

/**
 * Add a transcript event to a conversation, unsaved.
 *
 * System lines are for operators: "asked for a person", "Ada joined". They
 * are never replayed to the visitor and never put in front of the model.
 *
 * @returns {object} the stored message
 */
function addSystemLine(conversation, text) {
  conversation.messages.push({
    content: text,
    sender: 'system',
    path: 'system',
    timestamp: new Date()
  });
  return conversation.messages[conversation.messages.length - 1];
}

/**
 * Keep the visitor's consent on the conversation, the first time it arrives.
 *
 * Where a tenant asks visitors to agree before chatting, the record that they
 * did - when, and to what words - is something the tenant has to be able to
 * show later. The widget sends `true` or `{given, at, text}` with the events
 * that can start a conversation. Stored in metadata, which the retention
 * sweep keeps for exactly this reason (models/conversation.js). Unsaved.
 *
 * @returns {boolean} whether anything was recorded
 */
function recordConsent(conversation, consent) {
  const given = consent === true || consent === 'true' ||
    Boolean(consent && typeof consent === 'object' && consent.given === true);
  if (!given) {
    return false;
  }

  if (!conversation.metadata) {
    conversation.metadata = new Map();
  }
  if (conversation.metadata.get('consent') === 'true') {
    return false;
  }

  const claimed = consent && consent.at ? new Date(consent.at) : null;
  // The visitor's clock says when they ticked the box; ours says when we
  // heard. A time from the future is not believed.
  const at = claimed && !Number.isNaN(claimed.getTime()) && claimed.getTime() <= Date.now() ? claimed : new Date();

  conversation.metadata.set('consent', 'true');
  conversation.metadata.set('consentAt', at.toISOString());
  if (consent && typeof consent.text === 'string' && consent.text.trim()) {
    conversation.metadata.set('consentText', consent.text.trim().slice(0, 300));
  }
  return true;
}

/**
 * The conversation as the model may see it: no transcript events, newest
 * `limit` messages, in the role/content shape the reply service takes.
 */
function modelHistory(messages, limit = 10) {
  return (messages || [])
    .filter(message => message.sender !== 'system')
    .slice(-limit)
    .map(message => ({
      role: message.sender === 'user' ? 'user' : 'assistant',
      content: message.content
    }));
}

/**
 * Start a conversation, once there is something to start it for.
 *
 * A conversation used to be created when a page with the widget loaded, so
 * every visit was billed as a conversation, made a contact, fired a webhook
 * and sat in the queue empty. It is now created when the visitor first does
 * something - writes, fills in the form, asks for a person, uploads a file or
 * leaves their email - and only then metered and announced.
 *
 * The plan is checked before anything is written: a conversation the plan
 * does not allow must not exist, or it would be counted next month too.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string|null} input.companyId
 * @param {string} [input.domain] the page origin the visitor is on
 * @param {string} [input.sessionTokenHash] hash of the token the visitor holds
 * @param {object} [input.identity] {externalId, userHash, userJwt, email, name, phone}
 * @param {string} [input.channel] a messaging app; web chat when absent
 * @param {object} [input.external] who it is with there (models/conversation.js)
 * @param {string} [input.contactId] the contact a returning messaging-app
 *        customer already is, to join rather than resolve afresh
 * @returns {Promise<{conversation?: object, created?: boolean,
 *                    refused?: boolean, duplicate?: boolean}>}
 *          `duplicate` when another connection created it a moment earlier
 */
async function createConversation({
  sessionId, companyId, domain, sessionTokenHash, identity = {}, channel, external, contactId
}) {
  const quota = await usageService.check(companyId, 'conversationsPerMonth');

  if (!quota.allowed) {
    logger.warn('Conversation refused by plan', {
      companyId: companyId ? String(companyId) : null,
      reason: quota.reason
    });
    usageService.recordLimitHit(companyId);
    return { refused: true, quota };
  }

  const conversation = new Conversation({
    sessionId,
    sessionTokenHash: sessionTokenHash || undefined,
    company: companyId || undefined,
    domain: domain || undefined,
    ...(channel ? { channel } : {}),
    ...(external ? { external } : {}),
    messages: []
  });

  try {
    await conversation.save();
  } catch (error) {
    if (error && error.code === 11000) {
      // Two tabs of the same browser engaging at once. The other one won;
      // the caller checks the token against what it stored.
      return { duplicate: true };
    }
    throw error;
  }

  // Metered once, after the write succeeded, so a long conversation counts
  // as one and a lost race counts as none.
  usageService.record(companyId, { conversations: 1 });

  // The person behind the session. Identity claims are only trusted when the
  // tenant signed them; see services/contacts.js. Only now, so a page view
  // that never became a conversation never became a contact either.
  if (companyId) {
    // A WhatsApp number or Messenger id is the same person every time, so a
    // customer writing again rejoins the contact they already are rather than
    // becoming a new one with each conversation.
    const contact = (contactId && await rejoinContact(companyId, contactId, sessionId)) ||
      await contactService.resolve({
        companyId,
        sessionId,
        externalId: identity.externalId,
        userHash: identity.userHash,
        userJwt: identity.userJwt,
        email: identity.email,
        name: identity.name,
        phone: identity.phone
      });

    if (contact) {
      await contactService.linkConversation(contact, conversation);
      await conversation.save();
    }
  }

  return { conversation, created: true };
}

/** A contact of this company, with this session added to it; null if gone. */
async function rejoinContact(companyId, contactId, sessionId) {
  try {
    const Contact = require('../models/contact');
    return await Contact.findOneAndUpdate(
      { _id: contactId, company: companyId },
      { $addToSet: { sessionIds: sessionId }, $set: { lastSeenAt: new Date() } },
      { new: true }
    );
  } catch (error) {
    logger.warn('Could not rejoin a returning customer to their contact', { error: error.message });
    return null;
  }
}

/**
 * Tell everyone a conversation has started, and route it if the tenant
 * routes on start.
 *
 * Called once the first message is stored, so operators get a preview of
 * what the visitor actually said rather than an empty row.
 */
async function announceStart(conversation, { preview: firstWords, emit } = {}) {
  const companyId = companyOf(conversation);

  if (emit && typeof emit.operators === 'function') {
    emit.operators('new-chat', {
      sessionId: conversation.sessionId,
      channel: conversation.channel || 'chat',
      visitorName: visitorName(conversation) || undefined,
      domain: conversation.domain || undefined,
      preview: preview(firstWords),
      createdAt: conversation.startedAt || new Date()
    });
  }

  // Operators away from the dashboard hear about it on their phones. Not
  // awaited, and it never throws.
  push.conversationEvent('new-chat', conversation, { name: visitorName(conversation), preview: preview(firstWords) });

  // Not awaited: a tenant's endpoint must not slow a conversation down.
  webhooks.dispatch(companyId, 'conversation.started', {
    sessionId: conversation.sessionId,
    channel: conversation.channel || 'chat',
    domain: conversation.domain || null,
    contactId: conversation.contact ? String(conversation.contact) : null,
    startedAt: conversation.startedAt
  });

  // Some teams run no bot at all, and for them a conversation that sits
  // unassigned until somebody notices it is the whole problem.
  if (companyId) {
    try {
      const company = await Company.findById(companyId).select('routing').lean();
      if (company?.routing?.autoAssign && company.routing.assignOnStart) {
        await assignmentService.autoAssign(conversation);
      }
    } catch (error) {
      logger.error('Assign-on-start failed', { sessionId: conversation.sessionId, error: error.message });
    }
  }
}

/**
 * What a reply result means for the caller.
 *
 * Read defensively: `failed`, `unanswered` and `metered` are the reply
 * service's to set, and a result without them is treated by its text - no
 * text is a failure, whatever else it says.
 *
 * @returns {{failed: boolean, unanswered: boolean, metered: boolean,
 *            path: string, text: string|null}}
 */
function replyOutcome(reply) {
  const text = reply && typeof reply.text === 'string' && reply.text.trim() ? reply.text : null;
  const failed = !reply || reply.failed === true || text === null;
  let path = failed ? 'fallback' : String(reply.path || reply.source || 'assistant');
  if (!REPLY_PATHS.has(path)) {
    // Stored on the message, where the schema allows only these; anything
    // else would fail the save and lose the reply.
    path = reply && reply.source === 'workflow' ? 'workflow' : 'assistant';
  }
  const unanswered = !failed && reply.unanswered === true;

  // A model wrote the visible text: the assistant, or a workflow's model
  // node. Not a canned reply, not a fixed workflow message, not a failure.
  let metered = false;
  if (!failed) {
    metered = typeof reply.metered === 'boolean'
      ? reply.metered
      : (path === 'assistant' || path === 'workflow');
  }

  return { failed, unanswered, metered, path, text };
}

/**
 * A tenant's canned reply for a fixed slot, or null; never throws.
 *
 * `{name}` and `{company}` are filled in for the conversation it is going
 * to, the same as for canned replies the assistant sends.
 */
async function cannedText(companyId, role, conversation) {
  if (!companyId) {
    return null;
  }
  try {
    const text = await getResponseTemplateService().getByRole(companyId, role);
    if (!text || !/\{(name|company)\}/i.test(text)) {
      return text;
    }
    const company = await Company.findById(companyId).select('name').lean();
    return fillPlaceholders(text, {
      name: visitorName(conversation),
      company: company ? company.name : ''
    });
  } catch (error) {
    logger.warn('Could not read a canned reply', { role, error: error.message });
    return null;
  }
}

/**
 * Whether a person could pick this up now: inside the tenant's hours, with
 * somebody connected and taking chats. The widget's own "can reach" flag is
 * the same answer (services/availability.js).
 */
async function reachability(companyId) {
  if (!companyId) {
    return { canReach: false, open: true, operatorsOnline: 0 };
  }

  try {
    const status = await availability.status(companyId);
    return {
      canReach: Boolean(status.canReachOperator),
      open: status.open !== false,
      operatorsOnline: status.operatorsOnline || 0
    };
  } catch (error) {
    logger.warn('Could not check who is available', { companyId, error: error.message });
    return { canReach: false, open: true, operatorsOnline: 0 };
  }
}

/**
 * Hand a conversation to the team.
 *
 * Every way a conversation reaches a person comes through here: the visitor
 * asking, the bot failing, the plan's replies running out, a workflow's
 * handoff step. They used to differ - a failure apologised and stopped, a
 * spent allowance said "unavailable" and stopped - and each stop was a
 * visitor left with nowhere to go.
 *
 * In order: the bot says it is passing them on (the tenant's own handoff
 * reply if they wrote one); the conversation is marked as waiting, with why;
 * operators are told; somebody is assigned if anyone can take it; and the
 * visitor hears which of three things happened - somebody has it, somebody
 * will, or nobody can right now and they can leave an email instead.
 *
 * A conversation already waiting is not announced twice: a visitor who keeps
 * writing while the bot cannot answer gets told where they stand each time,
 * but operators get one alert, not one per message.
 *
 * @param {object} conversation a mongoose document; saved here
 * @param {string} reason one of the handoff reasons in models/conversation.js
 * @param {object} options
 * @param {{visitor: Function, operators: Function}} options.emit
 * @param {boolean} [options.line=true] whether the bot says something first
 * @returns {Promise<{reason: string, assigned: boolean, operatorName?: string,
 *                    queued: boolean, offline: boolean, line: object|null,
 *                    notice: object}>}
 */
async function handOver(conversation, reason, { emit, line = true } = {}) {
  const companyId = companyOf(conversation);
  const sessionId = conversation.sessionId;
  const now = new Date();
  const outcome = { reason, assigned: false, queued: false, offline: false, line: null, notice: null };

  if (conversation.operatorId) {
    // Somebody already has it; there is nothing to hand over.
    outcome.assigned = true;
    outcome.operatorName = conversation.operatorName;
    outcome.notice = notice('operator_joined', { operatorName: conversation.operatorName });
    emit.visitor('operator-requested', {
      queued: false,
      connected: true,
      operatorName: conversation.operatorName,
      ...outcome.notice
    });
    return outcome;
  }

  const waiting = Boolean(conversation.awaitingOperatorSince) &&
    Boolean(conversation.handoff && conversation.handoff.reason);
  const stored = [];

  if (line && !waiting) {
    const canned = await cannedText(companyId, 'handoff', conversation);
    let said = null;

    if (canned) {
      said = { text: canned };
    } else if (reason === 'model_error') {
      const failedNotice = notice('reply_failed');
      said = { text: failedNotice.message, ...failedNotice };
    }

    if (said) {
      conversation.messages.push({ content: said.text, sender: 'bot', path: 'handoff', timestamp: now });
      const message = conversation.messages[conversation.messages.length - 1];
      stored.push(message);
      outcome.line = { ...said, id: String(message._id), path: 'handoff' };
    }
  }

  if (!waiting) {
    conversation.handoff = {
      requestedAt: now,
      reason,
      summary: handoverSummary(conversation)
    };
    conversation.awaitingOperatorSince = conversation.awaitingOperatorSince || now;
    stored.push(addSystemLine(conversation, HANDOFF_LINES[reason] || 'Handed to the team'));
  }

  conversation.lastActivity = now;
  await conversation.save();

  announceMessages(conversation, stored, emit);

  if (outcome.line) {
    emit.visitor('bot-message', {
      id: outcome.line.id,
      text: outcome.line.text,
      path: 'handoff',
      canRate: false,
      sources: [],
      ...(outcome.line.code ? { code: outcome.line.code, params: outcome.line.params, message: outcome.line.message } : {}),
      timestamp: now
    });
  }

  if (!waiting) {
    // `operator-requested` is the older event the dashboard already shows;
    // `handoff-requested` carries enough to triage from the alert itself.
    emit.operators('operator-requested', { sessionId, reason, timestamp: now });
    emit.operators('handoff-requested', {
      sessionId,
      visitorName: visitorName(conversation) || undefined,
      reason: conversation.handoff.reason,
      requestedAt: conversation.handoff.requestedAt,
      preview: preview(lastVisitorMessage(conversation)?.content)
    });
    // And to the phones of those taking chats: nobody being at the desk is
    // when this matters most. Not awaited; never throws.
    push.conversationEvent('handoff', conversation, {
      name: visitorName(conversation),
      preview: preview(lastVisitorMessage(conversation)?.content)
    });
  }

  const reach = await reachability(companyId);

  if (reach.canReach) {
    const result = await assignmentService.autoAssign(conversation);

    if (result.assigned) {
      // The bot steps aside only once a person actually has it. Switching it
      // off on the request alone left visitors nobody claimed with no one
      // answering at all.
      conversation.botEnabled = false;
      await conversation.save();
      outcome.assigned = true;
      outcome.operatorName = result.operator.displayName;
    }
  }

  if (outcome.assigned) {
    outcome.notice = notice('operator_joined', { operatorName: outcome.operatorName });
    emit.visitor('operator-requested', {
      queued: false, connected: true, operatorName: outcome.operatorName, ...outcome.notice
    });
  } else if (reach.canReach) {
    outcome.queued = true;
    outcome.notice = notice('queued');
    emit.visitor('operator-requested', { queued: true, connected: false, operatorName: null, ...outcome.notice });
  } else {
    // Closed, or nobody at the desk. Promising "someone will be with you
    // shortly" here is how a visitor ends up waiting for a reply that never
    // comes; an email address turns it into one that does.
    outcome.queued = true;
    outcome.offline = true;
    outcome.notice = notice('queued_offline');
    emit.visitor('operator-requested', {
      queued: true, connected: false, offline: true, operatorName: null, ...outcome.notice
    });

    if (!(conversation.followUp && conversation.followUp.email)) {
      emit.visitor('followup-request', {
        sessionId,
        reason: conversation.handoff ? conversation.handoff.reason : reason,
        // Offered so the widget can prefill it; it is the visitor's own.
        email: (await emailChannel.visitorEmail(conversation)) || undefined
      });
    }
  }

  return outcome;
}

/**
 * Store a bot message and send it to the visitor.
 *
 * Every bot line goes through here, so each one is saved with how it was
 * produced (`path`), what it cited and whether it was an answer at all -
 * which is what the transcript, the unanswered-questions list and the
 * thumbs under an answer are built from.
 *
 * @returns {Promise<object>} the stored message
 */
async function sendBotMessage(conversation, { text, path, sources = [], unanswered = false, choices, cards }, emit) {
  const now = new Date();
  const clientId = 'bot_' + Date.now();

  conversation.messages.push({
    content: text,
    sender: 'bot',
    messageId: clientId,
    path,
    sources: sources.length ? sources : undefined,
    unanswered: unanswered || undefined,
    timestamp: now
  });
  const stored = conversation.messages[conversation.messages.length - 1];
  conversation.lastActivity = now;
  await conversation.save();

  emit.visitor('bot-message', {
    id: stored && stored._id ? stored._id.toString() : 'temp-id',
    clientId,
    text,
    path,
    canRate: canRate(stored),
    unanswered: unanswered || undefined,
    // Quick replies, when the workflow offered a set of choices. The widget
    // renders them as buttons; a visitor tapping one is unambiguous in a way
    // that typing never is.
    choices: choices && choices.length ? choices : undefined,
    // Products or appointment times for the widget to render.
    cards: cards || undefined,
    // Always an array, so the widget can test its length without a guard.
    sources,
    timestamp: now
  });

  announceMessages(conversation, [stored], emit);

  return stored;
}

/**
 * The bot's turn.
 *
 * The published workflow answers if the tenant has one, otherwise the
 * assistant. The widget's socket and the messaging channels (WhatsApp,
 * Messenger, Instagram) both come through here, so a customer gets the same
 * bot whichever door they used; only `emit.visitor` differs.
 *
 * There is no dead end out of here. The plan is checked first and the model
 * is not called when it says no - the conversation goes to the team instead.
 * A reply that could not be produced goes to the team too, never as an error
 * message. And an answer the bot did not have is offered on to a person.
 *
 * @param {object} conversation a mongoose document; saved here
 * @param {string} message what the visitor wrote
 * @param {object} options
 * @param {{visitor: Function, operators: Function}} options.emit
 * @param {Function} [options.typing] told `true` while the reply is written
 * @param {string} [options.companyId] the tenant, when the conversation has none
 */
async function answerAutomatically(conversation, message, { emit, typing = () => {}, companyId: tenant } = {}) {
  const sessionId = conversation.sessionId;
  const companyId = tenant || companyOf(conversation);

  const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
  if (!quota.allowed) {
    logger.warn('Automated reply refused by plan; handing over', {
      companyId: companyId ? String(companyId) : null,
      reason: quota.reason
    });
    usageService.recordLimitHit(companyId);
    await handOver(conversation, 'quota', { emit });
    return;
  }

  const messageHistory = modelHistory(conversation.messages, 10);

  typing(true);

  // Required here rather than at the top: the reply service pulls in the
  // model and workflow runtime, which nothing else in this module needs.
  const replyService = require('./reply');

  let reply;
  try {
    reply = await replyService.generate({
      conversation,
      message,
      history: messageHistory
    });
  } catch (error) {
    logger.error('Failed to generate a reply', { sessionId, error: error.message });
    reply = { failed: true };
  }

  typing(false);

  const outcome = replyOutcome(reply);

  if (outcome.failed) {
    // The workflow state the reply service may have touched is saved with
    // the handover.
    await handOver(conversation, 'model_error', { emit });
    return;
  }

  let text = outcome.text;
  let path = outcome.path;
  const sources = Array.isArray(reply.sources) ? reply.sources : [];
  const choices = Array.isArray(reply.choices) ? [...reply.choices] : [];

  if (outcome.unanswered) {
    // The tenant's own words for "I don't know", when they wrote some.
    const fallback = await cannedText(companyId, 'fallback', conversation);
    if (fallback) {
      text = fallback;
      path = 'fallback';
    }
    if (!conversation.operatorId) {
      choices.push(handoffChoice());
    }
  }

  const stored = await sendBotMessage(conversation, {
    text,
    path,
    sources: outcome.unanswered ? [] : sources,
    unanswered: outcome.unanswered,
    choices,
    cards: reply.cards
  }, emit);

  // The older event the dashboard listens for; `conversation-message` above
  // carries the same message with more about it.
  emit.operators('new-message', {
    sessionId,
    message: text,
    sender: 'bot',
    messageId: stored._id ? String(stored._id) : undefined,
    sources,
    path,
    unanswered: outcome.unanswered || undefined,
    timestamp: new Date()
  });

  // Metered when a model wrote the visible text - the assistant, or a
  // workflow's model node. A canned reply or a fixed workflow message did
  // not use one, and metering it as one would overcharge the tenant.
  usageService.record(companyId, outcome.metered
    ? { aiResponses: 1, messages: 1 }
    : { messages: 1 });

  // A workflow node can ask for a person. Honour it here rather than leaving
  // the escalation as a sentence the visitor has to act on.
  if (reply.escalate && reply.escalate.enabled !== false) {
    await handOver(conversation, 'workflow', { emit, line: false });
  }
}

/**
 * Draft a reply for the operator holding a conversation.
 *
 * The draft goes to one person rather than to every operator of the tenant:
 * it is a suggestion for the person answering, not an announcement.
 *
 * A suggestion is a model call, so it is metered as one and only offered on
 * plans that include the feature. One that could not be drafted is reported
 * as `{error: true}` with no text: an error sentence in the suggestion slot
 * was one click on "Use" from going to the customer.
 *
 * @param {object} conversation
 * @param {object} targetMessage the visitor's message to answer
 * @param {object} options
 * @param {Function} options.toUser (userId, event, payload) delivers to one person
 * @param {string} [options.to] who gets it; the holding operator by default
 * @param {string} [options.companyId] the tenant, when the conversation has none
 */
async function offerSuggestion(conversation, targetMessage, { to, companyId: tenant, toUser } = {}) {
  if (!conversation || !targetMessage || conversation.suggestionsEnabled === false) {
    return;
  }

  const recipientId = to || conversation.operatorId;
  if (!recipientId) {
    // Nobody holding it means nobody to draft for.
    return;
  }

  const companyId = tenant || companyOf(conversation);

  if (!(await usageService.hasFeature(companyId, 'aiSuggestions'))) {
    return;
  }

  const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
  if (!quota.allowed) {
    logger.warn('Operator suggestion refused by plan', {
      companyId: companyId ? String(companyId) : null,
      reason: quota.reason
    });
    usageService.recordLimitHit(companyId);
    return;
  }

  const history = modelHistory(conversation.messages, 10);
  const userMessageId = targetMessage._id ? targetMessage._id.toString() : undefined;
  const AIService = require('./ai');

  let suggestion = null;
  let failed = false;
  try {
    const aiService = await AIService.forCompany(companyId);
    suggestion = await aiService.generateOperatorSuggestion(targetMessage.content, history);
    failed = aiService.lastFailed === true;
  } catch (error) {
    logger.error('Could not draft a suggestion', { sessionId: conversation.sessionId, error: error.message });
    failed = true;
  }

  if (failed || typeof suggestion !== 'string' || !suggestion.trim()) {
    toUser(recipientId, 'operator-suggestion', {
      sessionId: conversation.sessionId,
      userMessageId,
      error: true,
      timestamp: new Date()
    });
    return;
  }

  usageService.record(companyId, { aiResponses: 1 });

  toUser(recipientId, 'operator-suggestion', {
    sessionId: conversation.sessionId,
    userMessageId,
    userMessage: targetMessage.content,
    suggestion,
    timestamp: new Date()
  });
}

/**
 * What the person picking this up needs first: what the visitor asked, in
 * their own words, the last few messages joined and trimmed. Plain text
 * rather than a model's summary, so it is there even when the model is the
 * reason for the handover, and it says nothing the visitor did not.
 */
function handoverSummary(conversation) {
  const asked = (conversation.messages || [])
    .filter(message => message.sender === 'user' && message.content)
    .slice(-3)
    .map(message => String(message.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!asked.length) {
    return undefined;
  }
  const text = `Asked: ${asked.join(' / ')}`;
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

module.exports = {
  handoverSummary,
  HANDOFF_LINES,
  PREVIEW_LENGTH,
  preview,
  visitorName,
  lastVisitorMessage,
  canRate,
  messageForOperators,
  announceMessages,
  addSystemLine,
  recordConsent,
  modelHistory,
  createConversation,
  announceStart,
  replyOutcome,
  cannedText,
  reachability,
  handOver,
  sendBotMessage,
  answerAutomatically,
  offerSuggestion
};
