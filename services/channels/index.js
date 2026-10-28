/**
 * Messaging apps as conversation channels: WhatsApp, Facebook Messenger and
 * Instagram Direct.
 *
 * A customer writing on WhatsApp gets the same bot, the same hand-over to a
 * person and the same inbox as one using the website widget; only delivery
 * differs. This module is the registry the rest of the product asks: which
 * channels exist, which adapter speaks each, whether a tenant's plan includes
 * them, how long a reply is allowed, and whether a webhook really came from
 * Meta. Receiving lives in ./inbound.js and sending in ./outbound.js.
 *
 * The rules each provider sets, which shape everything here:
 *
 *   window     a free-form reply only within 24 hours of the customer's last
 *              message. After that WhatsApp allows an approved template and
 *              nothing else; Messenger and Instagram allow a person to answer
 *              for seven days with the HUMAN_AGENT tag, if Meta has approved
 *              the app for it.
 *   webhooks   signed with the Meta app's secret over the exact bytes sent
 *              (`X-Hub-Signature-256`), and retried - so every message id is
 *              received once however many times it is delivered.
 */

const crypto = require('crypto');

const ChannelAccount = require('../../models/channel-account');
const secrets = require('../secrets');
const usageService = require('../usage');
const { getPlan } = require('../../config/plans');
const { logger } = require('../logging');
const whatsapp = require('./whatsapp');
const messenger = require('./messenger');
const graph = require('./graph');

const PROVIDERS = ChannelAccount.PROVIDERS;

const ADAPTERS = {
  whatsapp,
  messenger,
  instagram: messenger
};

/** How each is named to people. */
const LABELS = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram'
};

const HOUR = 60 * 60 * 1000;
/** The customer service window: a free reply within this of their last message. */
const REPLY_WINDOW_MS = 24 * HOUR;
/** How long after that a person may still answer with the HUMAN_AGENT tag. */
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * HOUR;

/** Plans that include the channels when the plan does not say either way. */
const CHANNEL_PLANS = ['professional', 'enterprise'];

function isMessagingChannel(channel) {
  return PROVIDERS.includes(channel);
}

/**
 * Whether a session id names a messaging-app conversation. They are minted
 * here, `whatsapp-<hex>` and so on, so the socket layer can tell one from a
 * widget's session without a database read.
 */
function isChannelSession(sessionId) {
  return typeof sessionId === 'string' && PROVIDERS.some(provider => sessionId.startsWith(`${provider}-`));
}

function newSessionId(provider) {
  return `${provider}-${crypto.randomBytes(12).toString('hex')}`;
}

function adapterFor(provider) {
  return ADAPTERS[provider] || null;
}

/**
 * Whether a tenant's plan includes the messaging channels.
 *
 * The `channels` feature flag decides when the plan has one. Until it does,
 * Professional and Enterprise include them and nothing else does - so adding
 * the flag to every plan changes nothing that was already true.
 */
async function channelsAllowed(companyId) {
  if (!companyId) {
    return false;
  }
  try {
    const subscription = await usageService.getSubscription(companyId);
    if (!subscription || !subscription.isEntitled()) {
      return false;
    }
    const plan = getPlan(subscription.planId);
    const flag = plan && plan.features ? plan.features.channels : undefined;
    if (flag !== undefined) {
      return Boolean(flag);
    }
    return CHANNEL_PLANS.includes(plan && plan.id);
  } catch (error) {
    logger.warn('Could not read whether the plan includes messaging channels', { error: error.message });
    return false;
  }
}

/** The secret fields, for a query that needs them. */
const SECRET_FIELDS = '+accessToken +appSecret +verifyToken';

/**
 * One company's account for a provider.
 *
 * @param {string} companyId
 * @param {string} provider
 * @param {{secrets?: boolean, lean?: boolean}} [options]
 */
function findAccount(companyId, provider, options = {}) {
  let query = ChannelAccount.findOne({ company: companyId, provider });
  if (options.secrets) {
    query = query.select(SECRET_FIELDS);
  }
  return options.lean === false ? query : query.lean();
}

/** The decrypted token and app secret, or null when either cannot be read. */
function credentialsFor(account) {
  if (!account) {
    return null;
  }
  const token = secrets.decrypt(account.accessToken);
  const appSecret = secrets.decrypt(account.appSecret);
  if (!token || !appSecret) {
    return null;
  }
  return { token, appSecret };
}

/**
 * Whether `X-Hub-Signature-256` is the HMAC-SHA256 of these exact bytes under
 * this secret. Compared in constant time; anything malformed is simply false.
 *
 * @param {Buffer} raw the request body as received
 * @param {string} header e.g. `sha256=4f1c…`
 * @param {string} secret the app secret, decrypted
 */
function verifySignature(raw, header, secret) {
  if (!Buffer.isBuffer(raw) || typeof header !== 'string' || !secret) {
    return false;
  }
  const match = header.trim().match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(match[1].toLowerCase(), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * What an operator may send on a conversation now.
 *
 *   open         anything, until `until`
 *   human_agent  a person's reply with the HUMAN_AGENT tag, until `until`
 *   template     WhatsApp after 24 hours: an approved template only
 *   closed       nothing; `reason` says why
 *
 * @param {object} conversation with `channel` and `external.lastInboundAt`
 * @param {object|null} account the ChannelAccount, for its template and tag
 * @param {number} [now]
 */
function windowFor(conversation, account, now = Date.now()) {
  const provider = conversation && conversation.channel;
  const last = conversation && conversation.external && conversation.external.lastInboundAt
    ? new Date(conversation.external.lastInboundAt).getTime()
    : null;
  const age = last === null ? Infinity : now - last;
  const label = LABELS[provider] || 'This channel';

  if (!account || account.enabled === false) {
    return {
      mode: 'closed',
      reason: `${label} is not connected any more, so replies cannot be sent. An admin can reconnect it under Channels.`
    };
  }

  if (age < REPLY_WINDOW_MS) {
    return { mode: 'open', until: new Date(last + REPLY_WINDOW_MS) };
  }

  if (provider === 'whatsapp') {
    const template = account.template && account.template.name ? account.template.name : null;
    return {
      mode: 'template',
      template,
      reason: template
        ? `More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template. Send "${template}" to invite them back.`
        : 'More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template, and none is set up. An admin can add one under Channels → WhatsApp.'
    };
  }

  if (age < HUMAN_AGENT_WINDOW_MS && account.humanAgentTag) {
    return { mode: 'human_agent', until: new Date(last + HUMAN_AGENT_WINDOW_MS) };
  }

  return {
    mode: 'closed',
    reason: age < HUMAN_AGENT_WINDOW_MS
      ? `More than 24 hours have passed since the customer last wrote. ${label} only allows a later reply with the Human Agent tag, which this Page's app has not been approved for.`
      : `More than 7 days have passed since the customer last wrote, so ${label} does not allow a reply until they write again.`
  };
}

/** Record that a send was refused, so the settings screen can say so. */
function noteError(account, error) {
  if (!account || !account._id) {
    return;
  }
  const message = graph.describe(error);
  const update = { lastError: { message: message.slice(0, 500), at: new Date() } };
  if (error && error.isAuthFailure) {
    update.status = 'error';
  }
  ChannelAccount.updateOne({ _id: account._id }, { $set: update })
    .catch(failure => logger.warn('Could not record a channel error', { error: failure.message }));
}

module.exports = {
  PROVIDERS,
  LABELS,
  REPLY_WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
  CHANNEL_PLANS,
  GRAPH_VERSION: graph.GRAPH_VERSION,
  isMessagingChannel,
  isChannelSession,
  newSessionId,
  adapterFor,
  channelsAllowed,
  findAccount,
  credentialsFor,
  verifySignature,
  windowFor,
  noteError,
  // Receiving and sending, required when used: both need this module first.
  receiveWebhook: (...args) => require('./inbound').receiveWebhook(...args),
  settled: (...args) => require('./inbound').settled(...args),
  toCustomer: (...args) => require('./outbound').toCustomer(...args),
  sendOperatorReply: (...args) => require('./outbound').sendOperatorReply(...args),
  sendTemplate: (...args) => require('./outbound').sendTemplate(...args),
  sendTest: (...args) => require('./outbound').sendTest(...args)
};
