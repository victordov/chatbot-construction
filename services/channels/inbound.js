/**
 * A webhook from Meta, turned into messages in the inbox and answers from the
 * bot.
 *
 * In two halves, because Meta wants a 200 within a few seconds and a model
 * reply can take longer. The first half - check the signature, store each
 * message, tell the operators - is done before answering, so a failure there
 * is a 500 and Meta delivers again. The second half - the bot's reply, a
 * hand-over, a drafted suggestion - runs after, the way the widget's replies
 * run alongside the next message rather than in front of it.
 *
 * Meta retries, and sometimes delivers twice anyway. Every message carries
 * the provider's own id (`wamid…`, `mid…`), which is stored on it, so the
 * second delivery of a message finds it already there and changes nothing.
 */

const ChannelAccount = require('../../models/channel-account');
const Conversation = require('../../models/conversation');
const channels = require('./index');
const outbound = require('./outbound');
const graph = require('./graph');
const whatsapp = require('./whatsapp');
const messenger = require('./messenger');
const lifecycle = require('../conversation-lifecycle');
const usageService = require('../usage');
const uploads = require('../uploads');
const secrets = require('../secrets');
const sessionToken = require('../session-token');
const socketManager = require('../../socketManager');
const { notice, wantsAPerson, HANDOFF_VALUE } = require('../visitor-notices');
const { logger } = require('../logging');

/** Which field of an account a webhook's id is matched against. */
const KEY_FIELD = { whatsapp: 'phoneNumberId', messenger: 'pageId', instagram: 'igUserId' };

/** File extensions by type, so a stored image is recognised as one. */
const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv'
};

const MEDIA_LABELS = {
  image: 'Image',
  document: 'Document',
  video: 'Video',
  audio: 'Voice message',
  sticker: 'Sticker'
};

/** How long a file may take to fetch while Meta waits for its 200. */
const MEDIA_TIMEOUT_MS = 8000;

/** Replies still being written, so tests can wait for them. */
const followUps = new Set();

function track(promise) {
  followUps.add(promise);
  promise.finally(() => followUps.delete(promise));
  return promise;
}

/** Resolves once every reply under way, and everything it sent, is done. */
async function settled() {
  while (followUps.size > 0) {
    await Promise.allSettled([...followUps]);
  }
  await outbound.drained();
}

/**
 * One customer's messages are stored one at a time, in the order they came:
 * the first creates the conversation, and two at once would each create one.
 */
const receiving = new Map();

function serially(key, task) {
  const previous = receiving.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  receiving.set(key, run);
  run.catch(() => {}).finally(() => {
    if (receiving.get(key) === run) {
      receiving.delete(key);
    }
  });
  return run;
}

/** The operator side of the lifecycle's `emit`, for one company. */
function operatorsOf(companyId) {
  return (event, payload) => socketManager.emitToOperators(companyId, event, payload);
}

/** Whether the bot's most recent message was an "I don't know". */
function lastBotMessageUnanswered(conversation) {
  const messages = conversation.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].sender === 'bot') {
      return Boolean(messages[i].unanswered);
    }
    if (messages[i].sender === 'operator') {
      return false;
    }
  }
  return false;
}

/** What to show for a file that could not be kept. */
function mediaPlaceholder(media, reason) {
  const label = MEDIA_LABELS[media.kind] || 'Attachment';
  const name = media.fileName ? `: ${media.fileName}` : '';
  const link = media.url ? ` ${media.url}` : '';
  return `[${label}${name}]${link}${reason ? ` (not kept: ${reason})` : ''}`;
}

/** A name for a file the customer did not name, with the extension its type has. */
function fileNameFor(media, mimeType, timestamp) {
  if (media.fileName) {
    return uploads.cleanFileName(media.fileName);
  }
  const fromUrl = media.url ? decodeURIComponent(new URL(media.url).pathname.split('/').pop() || '') : '';
  if (fromUrl && /\.[a-z0-9]{2,5}$/i.test(fromUrl)) {
    return uploads.cleanFileName(fromUrl);
  }
  const stamp = timestamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${media.kind || 'file'}-${stamp}${EXTENSIONS[mimeType] || ''}`;
}

/**
 * Keep a file the customer sent, the way a file sent from the widget is kept,
 * so the operator downloads it from the inbox like any other. The providers'
 * own links expire within minutes (WhatsApp) or days (Messenger).
 *
 * @returns {Promise<{fileId?: string, fileName?: string, size?: number,
 *                    reason?: string}>}
 */
async function keepMedia(account, event) {
  const media = event.media;
  const companyId = account.company;

  if (media.kind === 'audio' || media.kind === 'video') {
    // Not on the upload allowlist, so not worth downloading to refuse.
    return { reason: 'voice and video are not kept here; open the app to play it' };
  }
  if (!(await usageService.hasFeature(companyId, 'fileUploads'))) {
    return { reason: 'files are not included in this plan' };
  }

  const credentials = channels.credentialsFor(account);
  if (!credentials) {
    return { reason: 'the channel credentials could not be read' };
  }

  try {
    const adapter = channels.adapterFor(event.provider);
    const file = await adapter.fetchMedia(account, credentials, media, {
      maxBytes: uploads.MAX_FILE_BYTES,
      timeoutMs: MEDIA_TIMEOUT_MS
    });
    const mimeType = String(file.mimeType || media.mimeType || '').split(';')[0].trim().toLowerCase();

    if (!uploads.ALLOWED_MIME_TYPES.has(mimeType)) {
      return { reason: `files of type ${mimeType || 'unknown'} are not accepted` };
    }

    const fileId = await uploads.storeFile(companyId, file.buffer);
    return { fileId, fileName: fileNameFor(media, mimeType, event.timestamp), size: file.buffer.length };
  } catch (error) {
    logger.warn('Could not fetch a file a customer sent', {
      provider: event.provider,
      error: error.message
    });
    return { reason: error.tooLarge || /more data/.test(error.message) ? 'it is larger than this inbox accepts' : 'it could not be downloaded' };
  }
}

/** Tell somebody we cannot take their conversation, as the widget would. */
function tellUnavailable(account, event) {
  const stand = {
    sessionId: `${event.provider}:${event.userId}`,
    company: account.company,
    channel: event.provider,
    external: { userId: event.userId, lastInboundAt: event.timestamp }
  };
  const unavailable = notice('unavailable');
  return outbound.enqueue(stand.sessionId, () =>
    outbound.deliver(stand, account, 'operator-requested', { ...unavailable }));
}

/**
 * The customer's open conversation, or a new one.
 *
 * A conversation that has ended stays ended: a customer writing again a week
 * later is a new conversation, metered and announced as one, as they would
 * be on the website.
 *
 * @returns {Promise<{conversation?: object, created?: boolean, refused?: boolean}>}
 */
async function openConversationFor(account, event) {
  const scope = {
    company: account.company,
    'external.provider': event.provider,
    'external.userId': event.userId
  };

  const open = await Conversation.findOne({ ...scope, status: 'active' }).sort({ lastActivity: -1 });
  if (open) {
    return { conversation: open, created: false };
  }

  const previous = await Conversation.findOne({ ...scope, contact: { $ne: null } })
    .sort({ startedAt: -1 })
    .select('contact')
    .lean();

  const result = await lifecycle.createConversation({
    sessionId: channels.newSessionId(event.provider),
    companyId: account.company,
    domain: channels.LABELS[event.provider],
    // Never resumed from a browser. A token nobody holds keeps the widget's
    // resume path closed to it, as it is to every conversation with a token.
    sessionTokenHash: sessionToken.hash(sessionToken.issue()),
    identity: {
      name: event.profileName,
      phone: event.provider === 'whatsapp' ? event.phone : undefined
    },
    channel: event.provider,
    external: {
      provider: event.provider,
      accountId: account._id,
      userId: event.userId,
      lastInboundAt: event.timestamp
    },
    contactId: previous ? previous.contact : undefined
  });

  if (result.duplicate) {
    // Another instance started this customer's conversation a moment ago
    // (the unique index on open app conversations); add to that one.
    const winner = await Conversation.findOne({ ...scope, status: 'active' }).sort({ lastActivity: -1 });
    if (winner) {
      return { conversation: winner, created: false };
    }
  }
  if (result.refused || !result.conversation) {
    return { refused: true };
  }
  return { conversation: result.conversation, created: true };
}

/**
 * The second half: what the bot, or the team, does about a message. Mirrors
 * the widget's `user-message` handler (websockets.js).
 */
async function respond(conversation, account, event, stored) {
  const emit = outbound.customerEmit(conversation, account);

  try {
    if (event.choice === HANDOFF_VALUE) {
      const reason = lastBotMessageUnanswered(conversation) ? 'bot_unanswered' : 'visitor_request';
      await lifecycle.handOver(conversation, reason, { emit });
      return;
    }

    if (conversation.hasOperator) {
      // A person has it: draft them a reply rather than answering.
      await lifecycle.offerSuggestion(conversation, stored, {
        toUser: (userId, name, payload) => socketManager.emitToUser(userId, name, payload)
      });
      return;
    }

    if (event.note || !event.text) {
      // A location, a voice note, a picture without a word: kept for the
      // team, and nothing the bot could sensibly answer.
      return;
    }

    if (wantsAPerson(event.text)) {
      const reason = lastBotMessageUnanswered(conversation) ? 'bot_unanswered' : 'visitor_request';
      await lifecycle.handOver(conversation, reason, { emit });
      return;
    }

    if (conversation.botEnabled !== false) {
      await lifecycle.answerAutomatically(conversation, event.text, { emit });
    }
  } catch (error) {
    logger.error('Could not answer a messaging-app message', {
      provider: event.provider,
      conversation: conversation.sessionId,
      error: error.message
    });
  }
}

/**
 * The first half for one message: store it and tell the operators.
 *
 * @returns {Promise<{duplicate?: boolean, skipped?: boolean,
 *                    followUp?: Function}>}
 */
async function store(account, event) {
  const companyId = account.company;

  const seen = await Conversation.exists({
    company: companyId,
    'external.provider': event.provider,
    'external.userId': event.userId,
    'messages.messageId': event.messageId
  });
  if (seen) {
    logger.info('Message already received; ignoring the repeat delivery', {
      provider: event.provider,
      messageId: event.messageId
    });
    return { duplicate: true };
  }

  const opened = await openConversationFor(account, event);
  if (opened.refused) {
    return { skipped: true, followUp: () => tellUnavailable(account, event) };
  }

  const { conversation, created } = opened;
  const now = new Date();
  // The provider's clock says when they wrote; one from the future is not
  // believed, because the reply window is counted from it.
  const sentAt = event.timestamp && event.timestamp.getTime() <= now.getTime() ? event.timestamp : now;

  if (!conversation.metadata) {
    conversation.metadata = new Map();
  }
  if (event.profileName && !conversation.metadata.get('name')) {
    conversation.metadata.set('name', String(event.profileName).slice(0, 200));
  }
  if (event.phone && !conversation.metadata.get('phone')) {
    conversation.metadata.set('phone', event.phone);
  }

  let file = null;
  if (event.media) {
    file = await keepMedia(account, event);
  }

  const kept = file && file.fileId;
  const content = event.text ||
    (kept ? `[File uploaded: ${file.fileName}]` : (event.media ? mediaPlaceholder(event.media, file && file.reason) : ''));

  conversation.messages.push({
    content: content || '(empty message)',
    sender: 'user',
    messageId: event.messageId,
    userName: lifecycle.visitorName(conversation) || undefined,
    fileId: kept ? file.fileId : undefined,
    fileName: kept ? file.fileName : undefined,
    timestamp: sentAt
  });
  const stored = conversation.messages[conversation.messages.length - 1];

  if (!conversation.external) {
    conversation.external = {};
  }
  const previousInbound = conversation.external.lastInboundAt ? new Date(conversation.external.lastInboundAt) : null;
  if (!previousInbound || previousInbound < sentAt) {
    conversation.external.lastInboundAt = sentAt;
  }
  conversation.lastActivity = now;
  await conversation.save();

  usageService.record(companyId, kept
    ? { messages: 1, filesUploaded: 1, fileBytes: file.size }
    : { messages: 1 });

  const toOperators = operatorsOf(companyId);
  toOperators('new-message', {
    sessionId: conversation.sessionId,
    channel: event.provider,
    message: stored.content,
    sender: 'user',
    messageId: String(stored._id),
    userName: stored.userName,
    fileId: stored.fileId,
    fileName: stored.fileId ? stored.fileName : undefined,
    fileUrl: stored.fileId ? uploads.downloadPath(stored.fileId) : undefined,
    timestamp: now
  });
  lifecycle.announceMessages(conversation, [stored], { operators: toOperators });

  if (created) {
    await lifecycle.announceStart(conversation, {
      preview: stored.content,
      emit: { visitor: () => {}, operators: toOperators }
    });
  }

  return {
    conversation,
    created,
    followUp: () => respond(conversation, account, event, stored)
  };
}

/**
 * A WhatsApp delivery report. Only a failure matters to anybody: the send
 * was accepted, but WhatsApp could not deliver it - most often because the
 * 24-hour window had closed by the time it tried.
 */
async function noteStatus(account, event) {
  if (event.status !== 'failed' || !event.userId) {
    return;
  }

  const conversation = await Conversation.findOne({
    company: account.company,
    'external.provider': event.provider,
    'external.userId': event.userId,
    'messages.messageId': event.messageId
  });
  if (!conversation) {
    return;
  }

  const marker = `failed:${event.messageId}`;
  if (conversation.messages.some(message => message.messageId === marker)) {
    return;
  }

  const reason = event.error
    ? graph.describe(new graph.GraphError({ message: event.error.message, code: event.error.code }))
    : 'no reason was given';

  const line = lifecycle.addSystemLine(conversation, `Not delivered on ${channels.LABELS[event.provider]}: ${reason}`);
  line.messageId = marker;
  await conversation.save();

  lifecycle.announceMessages(conversation, [line], { operators: operatorsOf(account.company) });
}

/** Accounts a webhook names, with their secrets. */
async function accountsFor(keys) {
  const found = await Promise.all(keys.map(({ provider, key }) =>
    ChannelAccount.findOne({ provider, [KEY_FIELD[provider]]: key })
      .select('+accessToken +appSecret')
      .lean()));
  return found.filter(Boolean);
}

/**
 * Handle one webhook delivery.
 *
 * Every account the payload names has its own app secret, and an event is
 * only acted on when the signature checks out under the secret of the account
 * it is for. A payload naming another tenant's number, signed with somebody
 * else's secret, touches nothing of theirs.
 *
 * @param {string} route `whatsapp`, `messenger` or `instagram` - which URL it came to
 * @param {Buffer} raw the body exactly as received
 * @param {string} signature the `X-Hub-Signature-256` header
 * @returns {Promise<{status: number, body: object}>}
 */
async function receiveWebhook(route, raw, signature) {
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }

  // Messenger and Instagram share an app and often one callback URL, so
  // either of their URLs takes either object.
  const adapter = route === 'whatsapp' ? whatsapp : messenger;
  const keys = adapter.accountKeys(payload);
  if (keys.length === 0) {
    // Nothing here is for a channel we run (a field we did not subscribe
    // to, say). Acknowledged, so it is not delivered again.
    return { status: 200, body: { received: true } };
  }

  const accounts = await accountsFor(keys);
  if (accounts.length === 0) {
    // Nothing to check the signature against, and nothing to do. Answered
    // 200 all the same: a Meta app can serve Pages or numbers nobody has
    // connected here, and Messenger switches off an app's webhooks after an
    // hour of failures - which would silence the ones that are connected.
    logger.warn('Webhook for an account nobody has connected', { route, keys: keys.map(entry => entry.key) });
    return { status: 200, body: { received: true } };
  }

  const verified = new Map();
  accounts.forEach(account => {
    if (channels.verifySignature(raw, signature, secrets.decrypt(account.appSecret))) {
      verified.set(`${account.provider}:${channels.adapterFor(account.provider).keyOf(account)}`, account);
    }
  });

  if (verified.size === 0) {
    logger.warn('Rejected a channel webhook with a bad signature', { route });
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  const events = adapter.parse(payload).filter(event => verified.has(`${event.provider}:${event.key}`));
  const allowed = new Map();
  const heardFrom = new Set();

  for (const event of events) {
    const account = verified.get(`${event.provider}:${event.key}`);

    if (account.enabled === false) {
      // Switched off by the tenant: acknowledged and dropped.
      continue;
    }

    if (event.kind === 'status') {
      await noteStatus(account, event);
      continue;
    }

    const companyKey = String(account.company);
    if (!allowed.has(companyKey)) {
      allowed.set(companyKey, await channels.channelsAllowed(account.company));
    }
    if (!allowed.get(companyKey)) {
      channels.noteError(account, new Error('Your plan does not include messaging channels, so messages are not being received'));
      continue;
    }

    heardFrom.add(account);
    const result = await serially(`${account._id}:${event.userId}`, () => store(account, event));
    if (result && result.followUp) {
      track(Promise.resolve().then(result.followUp));
    }
  }

  // Proof the connection works, for the settings screen.
  heardFrom.forEach(account => {
    const now = new Date();
    ChannelAccount.updateOne({ _id: account._id }, { $set: { lastInboundAt: now } }).catch(() => {});
    ChannelAccount.updateOne({ _id: account._id, status: 'pending' }, { $set: { status: 'connected' } }).catch(() => {});
  });

  return { status: 200, body: { received: true } };
}

module.exports = {
  receiveWebhook,
  settled,
  // Exported for tests.
  store,
  mediaPlaceholder,
  openConversationFor
};
