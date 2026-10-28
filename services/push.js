/**
 * Web Push: reaching an operator whose dashboard is not in front of them.
 *
 * Receptionists are not at a desk. The dashboard's own alerts - a toast, a
 * desktop notification, a beep - only work while it is open, so a customer
 * who asks for a person while the only operator is with a patient waits until
 * somebody happens to look. A push notification reaches the phone in their
 * pocket instead.
 *
 * Off unless the deployment has VAPID keys (scripts/generate-vapid-keys.js):
 * `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, a mailto: or
 * https: address the push services can contact about abuse. Without all
 * three, nothing here sends and the dashboard says push is not set up.
 *
 * What a notification may say is limited on purpose. It passes through the
 * browser maker's push service and lands on a lock screen, so it carries the
 * visitor's name and, only for a device whose owner turned previews on, a
 * short preview of what they wrote. Nothing else from the conversation.
 *
 * Sending never throws: a notification is a courtesy on top of something that
 * has already happened, and a push service being slow or down must not delay
 * or fail a conversation.
 */

const crypto = require('crypto');
const https = require('https');
const mongoose = require('mongoose');

const PushSubscription = require('../models/push-subscription');
const User = require('../models/user');
const Company = require('../models/company');
const RevokedToken = require('../models/revoked-token');
const availability = require('./availability');
const safeHttp = require('./safe-http');
const { logger } = require('./logging');

const NOTHING = Object.freeze({ sent: 0, removed: 0, failed: 0 });

/** How long one push service gets to accept a message. */
const SEND_TIMEOUT_MS = 10 * 1000;

/**
 * How long a push service keeps trying to deliver. A visitor waiting for a
 * person is not worth telling anyone about a day later; a usage warning is.
 */
const CONVERSATION_TTL_SECONDS = 60 * 60;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const LEVELS = new Set(['all', 'important', 'none']);

/**
 * What "Only when I'm needed" lets through - the same kinds the dashboard's
 * own setting treats as important (client/admin/notifications.js).
 */
const IMPORTANT = new Set(['handoff', 'assignment', 'transfer']);

/**
 * Stored notifications that are also pushed, as what kind of alert they are
 * and what the notification says without previews. `safe` marks a message
 * the platform wrote with nothing from a customer in it, which is shown
 * whatever the preview setting.
 */
const NOTIFICATION_PUSH = {
  chat_assigned: { kind: 'assignment', title: 'A conversation was assigned to you', urgency: 'high', safe: true },
  chat_transferred: { kind: 'transfer', title: 'A conversation was transferred to you', urgency: 'high' },
  visitor_waiting: { kind: 'handoff', title: 'A visitor is waiting for a person', urgency: 'high' },
  task_assigned: { kind: 'assignment', title: 'You have a new task' },
  low_rating: { kind: 'rating', title: 'A customer left a low rating' },
  usage_warning: { kind: 'usage', title: 'Your plan is nearly at a limit', safe: true }
};

const warned = new Set();

function warnOnce(key, message, details) {
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn(message, details);
  }
}

/** base64url without padding, the form browsers and web-push use for keys. */
function normaliseKey(value) {
  return String(value || '').trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodedLength(value) {
  try {
    return Buffer.from(normaliseKey(value), 'base64url').length;
  } catch {
    return 0;
  }
}

/**
 * The deployment's VAPID settings, or null when push is off.
 *
 * Read on every call rather than once at load, so the test suite (and a
 * deployment that sets them late) sees the current environment. Keys of the
 * wrong shape count as not set: every send would fail on them, and saying so
 * once at the start is more use than a warning per message.
 */
function settings() {
  const publicKey = normaliseKey(process.env.VAPID_PUBLIC_KEY);
  const privateKey = normaliseKey(process.env.VAPID_PRIVATE_KEY);
  let subject = String(process.env.VAPID_SUBJECT || '').trim();

  if (!publicKey && !privateKey && !subject) {
    return null;
  }

  // A bare address is what people type; the push services want a URI.
  if (subject && !/^(mailto:|https:)/i.test(subject) && subject.includes('@')) {
    subject = `mailto:${subject}`;
  }

  if (!publicKey || !privateKey || !subject) {
    warnOnce('incomplete', 'Push notifications are off: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together');
    return null;
  }

  // An uncompressed P-256 public key is 65 bytes and its private key 32.
  if (decodedLength(publicKey) !== 65 || decodedLength(privateKey) !== 32) {
    warnOnce('malformed', 'Push notifications are off: the VAPID keys are not valid. Generate a pair with scripts/generate-vapid-keys.js');
    return null;
  }

  if (!/^(mailto:|https:)/i.test(subject)) {
    warnOnce('subject', 'Push notifications are off: VAPID_SUBJECT must be a mailto: or https: address');
    return null;
  }

  return { publicKey, privateKey, subject };
}

let library;

/**
 * The web-push library, loaded on first use so a deployment that never set
 * VAPID keys does not need it installed.
 */
function webPush() {
  if (library === undefined) {
    try {
      // eslint-disable-next-line global-require
      library = require('web-push');
    } catch (error) {
      logger.error('Push notifications are off: the web-push package is not installed', { error: error.message });
      library = null;
    }
  }
  return library;
}

/** Whether this deployment can send push notifications at all. */
function isConfigured() {
  return Boolean(settings() && webPush());
}

/** The key browsers subscribe with, or null when push is off. */
function publicKey() {
  const config = settings();
  return config && webPush() ? config.publicKey : null;
}

let agent = null;

/**
 * The connection pool for push services.
 *
 * Every endpoint was handed to us by a browser - which is to say by whoever
 * controls that browser - so it is a URL somebody else chose. The lookup is
 * the same guard every other outbound request uses (services/safe-http.js):
 * an endpoint that resolves to a private address, the cloud metadata service
 * or this machine is refused at connect time.
 */
function pushAgent() {
  if (!agent) {
    agent = new https.Agent({ keepAlive: true, maxSockets: 50, lookup: safeHttp.guardedLookup });
  }
  return agent;
}

/** Whether a device's setting lets this kind of alert through. */
function wants(level, kind) {
  if (kind === 'test') {
    return true;
  }
  if (level === 'none') {
    return false;
  }
  if (level === 'important') {
    return IMPORTANT.has(kind);
  }
  return true;
}

/**
 * A push service's collapse key for a tag: a newer message with the same
 * topic replaces one not yet delivered, so a phone that was offline gets the
 * latest state of a conversation rather than every step of it. At most 32
 * URL-safe characters.
 */
function topicFor(tag) {
  return crypto.createHash('sha256').update(String(tag)).digest('base64url').slice(0, 32);
}

function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

/** What one device is sent: the preview only where its owner asked for it. */
function messageFor(subscription, payload) {
  return {
    title: payload.title,
    body: subscription.previews && payload.preview ? payload.preview : (payload.body || ''),
    url: payload.url || '/admin/',
    tag: payload.tag || undefined,
    kind: payload.kind,
    // A test is sent from the dashboard being looked at, which is exactly
    // when the service worker would otherwise keep quiet.
    always: payload.always ? true : undefined,
    timestamp: Date.now()
  };
}

/**
 * Send one payload to some devices, removing the ones that are gone.
 *
 * 404 and 410 are the push service saying the subscription no longer exists:
 * the app was uninstalled, notifications were blocked, the browser data was
 * cleared. Nothing will ever be delivered there again. Any other failure is
 * logged and the device kept, because a push service having a bad minute is
 * not a reason to forget somebody's phone.
 */
async function deliver(subscriptions, payload) {
  const config = settings();
  const lib = webPush();

  if (!config || !lib || subscriptions.length === 0) {
    return { ...NOTHING };
  }

  const options = {
    vapidDetails: config,
    TTL: payload.ttl || DEFAULT_TTL_SECONDS,
    urgency: payload.urgency || 'normal',
    agent: pushAgent(),
    timeout: SEND_TIMEOUT_MS
  };
  if (payload.tag) {
    options.topic = topicFor(payload.tag);
  }

  const outcomes = await Promise.all(subscriptions.map(async subscription => {
    try {
      await lib.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
        JSON.stringify(messageFor(subscription, payload)),
        options
      );
      return 'sent';
    } catch (error) {
      if (error && (error.statusCode === 404 || error.statusCode === 410)) {
        return 'gone';
      }
      logger.warn('A push notification was not delivered', {
        host: hostOf(subscription.endpoint),
        status: error && error.statusCode,
        error: error && error.message
      });
      return 'failed';
    }
  }));

  const idsWhere = outcome => subscriptions.filter((_, index) => outcomes[index] === outcome).map(item => item._id);
  const gone = idsWhere('gone');
  const sent = idsWhere('sent');

  try {
    if (gone.length) {
      await PushSubscription.deleteMany({ _id: { $in: gone } });
    }
    if (sent.length) {
      await PushSubscription.updateMany({ _id: { $in: sent } }, { $set: { lastSentAt: new Date() } });
    }
  } catch (error) {
    logger.warn('Could not record push deliveries', { error: error.message });
  }

  return { sent: sent.length, removed: gone.length, failed: outcomes.filter(outcome => outcome === 'failed').length };
}

/**
 * The devices of these people that may be sent this kind of alert.
 *
 * Also where devices that should no longer hear anything are dropped: one
 * subscribed under VAPID keys the deployment has since replaced, one whose
 * session was ended by "sign out everywhere" or a password change (the token
 * version moved on), and one whose own browser signed out (its token id is
 * revoked).
 *
 * @param {Array<{_id, tokenVersion}>} users
 * @param {string} kind
 * @param {object} [filter] narrows the devices, e.g. to one by id
 */
async function liveSubscriptions(users, kind, filter = {}) {
  const config = settings();
  if (!config || users.length === 0) {
    return [];
  }

  const owners = new Map(users.map(user => [String(user._id), user]));
  const subscriptions = await PushSubscription.find({ ...filter, user: { $in: [...owners.keys()] } }).lean();

  const stale = [];
  let live = subscriptions.filter(subscription => {
    const owner = owners.get(String(subscription.user));
    const keyChanged = subscription.vapidKey && normaliseKey(subscription.vapidKey) !== config.publicKey;
    const signedOutEverywhere = (subscription.tokenVersion || 0) !== ((owner && owner.tokenVersion) || 0);
    if (keyChanged || signedOutEverywhere) {
      stale.push(subscription._id);
      return false;
    }
    return true;
  });

  const tokenIds = live.map(subscription => subscription.jti).filter(Boolean);
  if (tokenIds.length) {
    const revoked = new Set((await RevokedToken.find({ _id: { $in: tokenIds } }).select('_id').lean())
      .map(entry => entry._id));
    live = live.filter(subscription => {
      if (subscription.jti && revoked.has(subscription.jti)) {
        stale.push(subscription._id);
        return false;
      }
      return true;
    });
  }

  if (stale.length) {
    await PushSubscription.deleteMany({ _id: { $in: stale } });
  }

  return live.filter(subscription => wants(subscription.level, kind));
}

/** People who can still be told anything: not switched off, removed or only invited. */
const ACTIVE_USER = {
  isActive: { $ne: false },
  invitePending: { $ne: true },
  deletedAt: null
};

/**
 * Push to every device of one person.
 *
 * @param {string|object} userId
 * @param {object} payload
 * @param {string} payload.title what the notification says
 * @param {string} payload.kind what kind of alert, for the device's setting:
 *        new-chat, handoff, assignment, transfer, rating, usage, task or test
 * @param {string} [payload.body] the line under the title, without previews
 * @param {string} [payload.preview] the line under the title for a device
 *        whose owner turned previews on
 * @param {string} [payload.url] the dashboard link to open
 * @param {string} [payload.tag] notifications with the same tag replace each
 *        other rather than piling up
 * @param {object} [options]
 * @param {string} [options.subscriptionId] only this one device
 * @returns {Promise<{sent: number, removed: number, failed: number}>}
 */
async function sendToUser(userId, payload = {}, options = {}) {
  if (!userId || !payload.title || !mongoose.isValidObjectId(String(userId)) || !isConfigured()) {
    return { ...NOTHING };
  }

  try {
    const user = await User.findById(userId)
      .select('tokenVersion company isActive invitePending deletedAt')
      .populate('company', 'isActive')
      .lean();

    if (!user) {
      await PushSubscription.deleteMany({ user: userId });
      return { ...NOTHING };
    }
    if (user.isActive === false || user.invitePending || user.deletedAt) {
      // Somebody who was removed has no business being told who is waiting.
      await PushSubscription.deleteMany({ user: userId });
      return { ...NOTHING };
    }
    if (user.company && user.company.isActive === false) {
      return { ...NOTHING };
    }

    const filter = {};
    if (options.subscriptionId) {
      if (!mongoose.isValidObjectId(String(options.subscriptionId))) {
        return { ...NOTHING };
      }
      filter._id = options.subscriptionId;
    }

    return await deliver(await liveSubscriptions([user], payload.kind, filter), payload);
  } catch (error) {
    logger.error('Could not send a push notification', { error: error.message });
    return { ...NOTHING };
  }
}

/**
 * Push to a company's operators and admins.
 *
 * @param {string|object} companyId
 * @param {object} payload as for sendToUser
 * @param {object} [options]
 * @param {boolean} [options.onlyAvailable=true] skip people who have switched
 *        off taking chats; somebody on leave should not be woken for the queue
 */
async function sendToOperators(companyId, payload = {}, { onlyAvailable = true } = {}) {
  if (!companyId || !payload.title || !mongoose.isValidObjectId(String(companyId)) || !isConfigured()) {
    return { ...NOTHING };
  }

  try {
    const company = await Company.findById(companyId).select('isActive').lean();
    if (!company || company.isActive === false) {
      return { ...NOTHING };
    }

    const query = { company: companyId, role: { $in: ['operator', 'company_admin'] }, ...ACTIVE_USER };
    if (onlyAvailable) {
      // `$ne: false` so a user written before the field existed still counts.
      query.acceptingChats = { $ne: false };
    }

    const users = await User.find(query).select('tokenVersion').lean();
    return await deliver(await liveSubscriptions(users, payload.kind), payload);
  } catch (error) {
    logger.error('Could not send push notifications to a team', { error: error.message });
    return { ...NOTHING };
  }
}

/** The dashboard link for a conversation. */
function chatUrl(sessionId) {
  return `/admin/?section=active-chats&chat=${encodeURIComponent(sessionId)}`;
}

/** What a new conversation or a handoff says, with or without a name. */
function conversationTitle(kind, name, reason) {
  if (kind === 'new-chat') {
    return name ? `New chat from ${name}` : 'New chat';
  }
  if (reason === 'visitor_request') {
    return name ? `${name} asked for a person` : 'A visitor asked for a person';
  }
  if (reason === 'offline_message') {
    return name ? `${name} left a message` : 'A visitor left a message';
  }
  return name ? `${name} needs a person` : 'A conversation needs a person';
}

/**
 * A conversation started, or was handed to the team: tell the operators
 * taking chats, on the devices whose setting wants it.
 *
 * Only inside the tenant's business hours. Outside them the visitor is told
 * nobody is there and offered email, and a phone that buzzes at midnight for
 * a conversation that will be answered in the morning is how push gets
 * switched off for good.
 *
 * Tagged the way the dashboard tags its own alerts (`handoff:<session>`), so
 * a repeat replaces the notification already showing.
 *
 * @param {'new-chat'|'handoff'} kind
 * @param {object} conversation
 * @param {object} [details]
 * @param {string} [details.name] the visitor's name, if they gave one
 * @param {string} [details.preview] a short preview of what they wrote
 */
async function conversationEvent(kind, conversation, { name, preview } = {}) {
  if (!conversation || !conversation.company || !conversation.sessionId || !isConfigured()) {
    return { ...NOTHING };
  }

  try {
    const hours = await availability.isWithinBusinessHours(conversation.company);
    if (!hours.open) {
      return { ...NOTHING, closed: true };
    }

    const event = kind === 'new-chat' ? 'new-chat' : 'handoff';
    const visitor = name ? String(name).trim().slice(0, 60) : '';
    const reason = conversation.handoff && conversation.handoff.reason;

    return await sendToOperators(conversation.company, {
      kind: event,
      title: conversationTitle(event, visitor, reason),
      body: 'Tap to open the conversation.',
      preview: preview ? String(preview).slice(0, 140) : undefined,
      url: chatUrl(conversation.sessionId),
      tag: `${event}:${conversation.sessionId}`,
      urgency: event === 'handoff' ? 'high' : 'normal',
      ttl: CONVERSATION_TTL_SECONDS
    }, { onlyAvailable: true });
  } catch (error) {
    logger.error('Could not push a conversation event', { kind, error: error.message });
    return { ...NOTHING };
  }
}

/**
 * A notification was stored for somebody (services/notification.js): push
 * the kinds worth a phone buzzing for.
 *
 * Deadline reminders are not among them; they wait in the bell.
 *
 * @param {string|object} userId
 * @param {object} notification the stored notification
 */
async function notificationEvent(userId, notification) {
  const spec = notification && NOTIFICATION_PUSH[notification.type];
  if (!spec || !isConfigured()) {
    return { ...NOTHING };
  }

  const link = typeof notification.link === 'string' && notification.link.startsWith('?') ? notification.link : '';
  const tag = notification.sessionId
    ? `${spec.kind}:${notification.sessionId}`
    : `notification:${notification._id}`;
  const message = String(notification.message || '').slice(0, 200);

  return sendToUser(userId, {
    kind: spec.kind,
    title: spec.title,
    body: spec.safe ? message : 'Tap to open it.',
    preview: message || undefined,
    url: `/admin/${link}`,
    tag,
    urgency: spec.urgency || 'normal',
    ttl: notification.sessionId ? CONVERSATION_TTL_SECONDS : DEFAULT_TTL_SECONDS
  });
}

/** What a test from My settings says. */
function testPayload() {
  return {
    kind: 'test',
    title: 'Notifications are on',
    body: 'This is how a customer waiting for a person will reach you on this device.',
    url: '/admin/?section=profile',
    tag: 'test',
    always: true,
    ttl: 5 * 60
  };
}

// ----------------------------------------------------------------- devices

/**
 * A short name for a device, from its user agent: "Chrome on Android".
 * Only so the person can tell their devices apart in a list.
 */
function deviceLabel(userAgent, installed = false) {
  const ua = String(userAgent || '');

  let system = null;
  if (/Android/i.test(ua)) {
    system = 'Android';
  } else if (/iPhone|iPod/i.test(ua)) {
    system = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    system = 'iPad';
  } else if (/Windows/i.test(ua)) {
    system = 'Windows';
  } else if (/CrOS/i.test(ua)) {
    system = 'ChromeOS';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    system = 'Mac';
  } else if (/Linux/i.test(ua)) {
    system = 'Linux';
  }

  if (installed) {
    return system ? `App on ${system}` : 'Installed app';
  }

  let browser = null;
  if (/Edg\//i.test(ua)) {
    browser = 'Edge';
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = 'Opera';
  } else if (/SamsungBrowser/i.test(ua)) {
    browser = 'Samsung Internet';
  } else if (/Firefox\/|FxiOS/i.test(ua)) {
    browser = 'Firefox';
  } else if (/Chrome\/|CriOS|Chromium/i.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari\//i.test(ua)) {
    browser = 'Safari';
  }

  if (browser && system) {
    return `${browser} on ${system}`;
  }
  return browser || system || 'A browser';
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * A subscription as the browser serialised it, checked, or an error.
 *
 * The endpoint has to be https and not a private address: it is where this
 * server will send requests, so it is treated like any other URL somebody
 * else gave us.
 */
function cleanSubscription(input) {
  const endpoint = input && typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const keys = (input && input.keys) || {};

  if (!endpoint || endpoint.length > 1024) {
    return { error: 'The browser did not give a push address.' };
  }

  const checked = safeHttp.validateUrl(endpoint);
  if (!checked.valid || checked.url.protocol !== 'https:') {
    return { error: 'That push address is not one this server can send to.' };
  }

  const valid = key => typeof key === 'string' && key.length <= 200 && KEY_PATTERN.test(key);
  if (!valid(keys.p256dh) || !valid(keys.auth)) {
    return { error: 'The browser did not give the keys a notification is encrypted with.' };
  }

  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * Register this device for the signed-in person, or refresh it.
 *
 * A browser holds one subscription per site, so a device belongs to whoever
 * last turned notifications on in it: on a shared reception computer the
 * person signed in now gets the notifications, not the one before.
 *
 * `refresh` is the dashboard checking in on every load with whatever
 * subscription the browser holds. It updates a device that is already this
 * person's - the session it belongs to, the dashboard's notification setting
 * - and never creates one: turning notifications on is the person's choice.
 * A device that was somebody else's has changed hands, so it stops being
 * theirs.
 *
 * @param {object} user `req.user`
 * @param {object} input
 * @param {object} input.subscription `PushSubscription.toJSON()`
 * @param {string} [input.applicationServerKey] the key it was made with
 * @param {string} [input.level] all, important or none
 * @param {boolean} [input.previews]
 * @param {boolean} [input.installed] the dashboard is running as the app
 * @param {boolean} [input.refresh]
 * @param {object} [context]
 * @param {{jti?: string}} [context.session] the token in use
 * @param {string} [context.userAgent]
 * @returns {Promise<{device?: object|null, created?: boolean,
 *                    resubscribe?: boolean, publicKey?: string,
 *                    error?: string, status?: number, code?: string}>}
 */
async function register(user, input = {}, { session = {}, userAgent } = {}, attempt = 0) {
  const config = settings();
  if (!config || !webPush()) {
    return { status: 503, code: 'PUSH_NOT_CONFIGURED', error: 'Push notifications are not set up on this server.' };
  }

  const cleaned = cleanSubscription(input.subscription);
  if (cleaned.error) {
    return { status: 400, error: cleaned.error };
  }

  const existing = await PushSubscription.findOne({ endpoint: cleaned.endpoint });
  const mine = Boolean(existing) && String(existing.user) === String(user.id);

  if (input.refresh && !mine) {
    if (existing) {
      await existing.deleteOne();
    }
    return { device: null, changedHands: Boolean(existing) };
  }

  // Made with a key this server no longer signs with, so it can never
  // receive anything: the browser has to subscribe again. On a check-in the
  // dashboard does that by itself, keeping the device's settings.
  if (input.applicationServerKey && normaliseKey(input.applicationServerKey) !== config.publicKey) {
    if (input.refresh) {
      return { device: existing.toPublic(), resubscribe: true, publicKey: config.publicKey };
    }
    return {
      status: 409,
      code: 'PUSH_KEY_CHANGED',
      error: 'This device subscribed with an older server key. Subscribe again.',
      publicKey: config.publicKey
    };
  }

  const owner = await User.findById(user.id).select('tokenVersion').lean();
  const device = existing || new PushSubscription({ endpoint: cleaned.endpoint });

  device.user = user.id;
  device.company = user.company && user.company.id ? user.company.id : undefined;
  device.keys = cleaned.keys;
  device.vapidKey = config.publicKey;
  device.jti = session.jti || undefined;
  device.tokenVersion = (owner && owner.tokenVersion) || 0;
  device.lastSeenAt = new Date();

  if (!mine) {
    // A new owner starts from the defaults, not from the last person's choices.
    device.createdAt = new Date();
    device.level = 'all';
    device.previews = false;
  }
  if (!mine || input.installed !== undefined) {
    device.label = deviceLabel(userAgent, Boolean(input.installed));
  }
  if (LEVELS.has(input.level)) {
    device.level = input.level;
  }
  if (typeof input.previews === 'boolean') {
    device.previews = input.previews;
  }

  try {
    await device.save();
  } catch (error) {
    // Two tabs turning notifications on at once: the other one won the
    // insert, so this becomes an update of it.
    if (error && error.code === 11000 && !existing && attempt === 0) {
      return register(user, input, { session, userAgent }, 1);
    }
    throw error;
  }

  return { device: device.toPublic(), created: !mine };
}

/**
 * Stop notifications to one of the person's devices, by its endpoint (this
 * browser) or its id (the device list).
 *
 * @returns {Promise<boolean>} whether there was one to remove
 */
async function unregister(userId, { endpoint, id } = {}) {
  const filter = { user: userId };
  if (typeof id === 'string' && mongoose.isValidObjectId(id)) {
    filter._id = id;
  } else if (typeof endpoint === 'string' && endpoint) {
    filter.endpoint = endpoint;
  } else {
    return false;
  }

  const result = await PushSubscription.deleteOne(filter);
  return result.deletedCount > 0;
}

/** The person's devices, most recently used first. */
async function devices(userId) {
  const list = await PushSubscription.find({ user: userId }).sort({ lastSeenAt: -1 }).limit(50);
  return list.map(device => device.toPublic());
}

module.exports = {
  isConfigured,
  publicKey,
  sendToUser,
  sendToOperators,
  conversationEvent,
  notificationEvent,
  testPayload,
  register,
  unregister,
  devices,
  deviceLabel,
  // Exported for tests.
  wants,
  topicFor,
  IMPORTANT
};
