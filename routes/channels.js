/**
 * WhatsApp, Messenger and Instagram: the webhooks Meta calls, the settings
 * screens that connect an account, and what an operator needs to answer
 * within each provider's rules.
 *
 * The webhooks are public URLs and authenticate by signature alone: Meta signs
 * the exact bytes it sends with the app's secret. So this router reads the
 * webhook body raw - server.js keeps those paths away from the JSON parser,
 * which would otherwise consume the bytes and leave nothing to check - and
 * parses it only once the signature has been verified.
 */

const express = require('express');

const ChannelAccount = require('../models/channel-account');
const Conversation = require('../models/conversation');
const channels = require('../services/channels');
const secrets = require('../services/secrets');
const audit = require('../services/audit');
const { auth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { canAccessCompany } = require('../utils/query');
const { logger } = require('../services/logging');

const router = express.Router();

/** The URL paths Meta posts to, one per provider. */
const WEBHOOK_ROUTES = ['whatsapp', 'messenger', 'instagram'];

/** Webhook bodies are small; a bigger one is not from Meta. */
const rawBody = express.raw({ type: () => true, limit: '1mb' });

/** What Meta sends as `hub.challenge`, and all that is ever echoed back. */
const CHALLENGE = /^[A-Za-z0-9_.-]{1,256}$/;

const DIGITS = /^\d{5,30}$/;
/** Meta app secrets are 32 hex characters; a little latitude for the future. */
const APP_SECRET = /^[A-Za-z0-9]{16,128}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;
const PARAM_NAME = /^[a-z0-9_]{1,60}$/;

// --------------------------------------------------------------- webhooks

/**
 * GET /api/channels/webhook/:provider - Meta's subscription handshake.
 *
 * Answered with the challenge when the verify token is one this server
 * issued, and the account is marked as verified so the settings screen can
 * show that step worked.
 */
router.get('/webhook/:provider', async (req, res) => {
  const { provider } = req.params;
  if (!WEBHOOK_ROUTES.includes(provider)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || typeof token !== 'string' || !token ||
      typeof challenge !== 'string' || !CHALLENGE.test(challenge)) {
    return res.status(400).json({ error: 'Not a subscription request' });
  }

  try {
    const providers = provider === 'whatsapp' ? ['whatsapp'] : ['messenger', 'instagram'];
    const accounts = await ChannelAccount.find({ provider: { $in: providers }, verifyToken: token })
      .select('_id')
      .lean();

    if (accounts.length === 0) {
      logger.warn('Webhook verification with an unknown verify token', { provider });
      return res.status(403).json({ error: 'Forbidden' });
    }

    const ids = accounts.map(account => account._id);
    await ChannelAccount.updateMany({ _id: { $in: ids } }, { $set: { webhookVerifiedAt: new Date() } });
    await ChannelAccount.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { status: 'connected' } });

    res.type('text/plain').send(challenge);
  } catch (error) {
    logger.error('Webhook verification failed', { provider, error: error.message });
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * POST /api/channels/webhook/:provider - messages and delivery reports.
 */
router.post('/webhook/:provider', rawBody, async (req, res) => {
  const { provider } = req.params;
  if (!WEBHOOK_ROUTES.includes(provider)) {
    return res.status(404).json({ error: 'Not found' });
  }

  // A buffer from the raw parser, or the copy a JSON parser's `verify` kept.
  const raw = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
  if (!Buffer.isBuffer(raw)) {
    logger.error('Channel webhook arrived already parsed: mount express.raw for /api/channels/webhook before express.json');
    return res.status(400).json({ error: 'Unreadable body' });
  }

  try {
    const result = await channels.receiveWebhook(provider, raw, req.get('x-hub-signature-256'));
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('Failed to process a channel webhook', { provider, error: error.message });
    // 500 so Meta delivers it again: a lost customer message is worse than a
    // repeat, which the message id makes harmless.
    res.status(500).json({ error: 'Failed to process the webhook' });
  }
});

// --------------------------------------------------------------- settings

/** Admins of a company; the screens are about one company's accounts. */
function requireOwnCompany(req, res, next) {
  if (req.user.role !== 'superadmin' && req.user.role !== 'company_admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  if (!req.user.company) {
    return res.status(400).json({ error: 'Your account is not linked to a company' });
  }
  next();
}

/** Refuse a plan without the channels, the way other plan features are refused. */
async function requireChannelsPlan(req, res, next) {
  if (await channels.channelsAllowed(req.user.company.id)) {
    return next();
  }
  res.status(402).json({
    error: 'WhatsApp, Messenger and Instagram are not included in your plan. They come with the trial and with the Professional, Agency and Enterprise plans.',
    code: 'FEATURE_NOT_IN_PLAN'
  });
}

/** Where Meta should send each provider's webhooks. */
function webhookUrls(req) {
  const root = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return WEBHOOK_ROUTES.reduce((urls, provider) => {
    urls[provider] = `${root}/api/channels/webhook/${provider}`;
    return urls;
  }, {});
}

/** What the screen may see of an account: never the token or the secret. */
function describeAccount(account) {
  if (!account) {
    return null;
  }
  return {
    provider: account.provider,
    enabled: account.enabled !== false,
    phoneNumberId: account.phoneNumberId || '',
    wabaId: account.wabaId || '',
    displayPhoneNumber: account.displayPhoneNumber || '',
    pageId: account.pageId || '',
    igUserId: account.igUserId || '',
    displayName: account.displayName || '',
    hasAccessToken: Boolean(account.accessToken),
    hasAppSecret: Boolean(account.appSecret),
    verifyToken: account.verifyToken || '',
    template: {
      name: (account.template && account.template.name) || '',
      language: (account.template && account.template.language) || 'en_US',
      param: (account.template && account.template.param) || 'positional',
      paramName: (account.template && account.template.paramName) || ''
    },
    humanAgentTag: Boolean(account.humanAgentTag),
    status: account.enabled === false ? 'disabled' : (account.status || 'pending'),
    webhookVerifiedAt: account.webhookVerifiedAt || null,
    lastInboundAt: account.lastInboundAt || null,
    lastError: account.lastError && account.lastError.message ? account.lastError : null
  };
}

async function loadSettings(req) {
  const companyId = req.user.company.id;
  const [allowed, accounts] = await Promise.all([
    channels.channelsAllowed(companyId),
    ChannelAccount.find({ company: companyId }).select('+accessToken +appSecret +verifyToken').lean()
  ]);
  const byProvider = provider => describeAccount(accounts.find(account => account.provider === provider));

  return {
    allowed,
    graphVersion: channels.GRAPH_VERSION,
    webhookUrls: webhookUrls(req),
    whatsapp: byProvider('whatsapp'),
    messenger: byProvider('messenger'),
    instagram: byProvider('instagram')
  };
}

/** A trimmed string from the body, or undefined when it was not sent. */
function field(body, name) {
  const value = body[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * A credential to store: the new value encrypted, or the stored one when the
 * form left it blank (the screen never shows a saved secret back).
 *
 * @returns {{value?: string, error?: string}}
 */
function credential(input, existing, { label, pattern }) {
  if (input === null) {
    return { error: `${label} must be text` };
  }
  if (!input) {
    return existing ? { value: existing } : { error: `${label} is required` };
  }
  if (pattern && !pattern.test(input)) {
    return { error: `That does not look like a ${label.toLowerCase()}` };
  }
  return { value: secrets.encrypt(input) };
}

/** A unique-index clash: the id is already connected to another company. */
function isDuplicate(error) {
  return error && error.code === 11000;
}

/**
 * Whether another company has already connected this id. Asked before saving
 * as well as enforced by the unique index, so the answer does not depend on
 * the index having been built.
 */
function claimedElsewhere(companyId, provider, field, value) {
  return ChannelAccount.exists({ provider, [field]: value, company: { $ne: companyId } });
}

router.get('/settings', auth, apiLimiter, requireOwnCompany, async (req, res) => {
  try {
    res.json(await loadSettings(req));
  } catch (error) {
    logger.error('Failed to load channel settings', { error: error.message });
    res.status(500).json({ error: 'Failed to load the channel settings' });
  }
});

/**
 * PUT /api/channels/whatsapp - connect, or change, the company's number.
 */
router.put('/whatsapp', auth, apiLimiter, requireOwnCompany, requireChannelsPlan, async (req, res) => {
  try {
    const body = req.body || {};
    const companyId = req.user.company.id;
    const existing = await ChannelAccount.findOne({ company: companyId, provider: 'whatsapp' })
      .select('+accessToken +appSecret +verifyToken');

    const phoneNumberId = field(body, 'phoneNumberId');
    if (!phoneNumberId || !DIGITS.test(phoneNumberId)) {
      return res.status(400).json({ error: 'Enter the phone number ID from WhatsApp Manager (digits only, not the number itself)' });
    }
    const wabaId = field(body, 'wabaId');
    if (wabaId && !DIGITS.test(wabaId)) {
      return res.status(400).json({ error: 'The WhatsApp Business Account ID is digits only' });
    }
    if (await claimedElsewhere(companyId, 'whatsapp', 'phoneNumberId', phoneNumberId)) {
      return res.status(409).json({ error: 'This WhatsApp number is already connected to another account' });
    }

    const token = credential(field(body, 'accessToken'), existing && existing.accessToken, { label: 'Access token' });
    const secret = credential(field(body, 'appSecret'), existing && existing.appSecret, { label: 'App secret', pattern: APP_SECRET });
    if (token.error || secret.error) {
      return res.status(400).json({ error: token.error || secret.error });
    }

    const template = body.template && typeof body.template === 'object' ? body.template : {};
    const templateName = typeof template.name === 'string' ? template.name.trim() : '';
    const templateLanguage = typeof template.language === 'string' && template.language.trim() ? template.language.trim() : 'en_US';
    const templateParam = ChannelAccount.TEMPLATE_PARAMS.includes(template.param) ? template.param : 'positional';
    const templateParamName = typeof template.paramName === 'string' ? template.paramName.trim() : '';

    if (templateName && !TEMPLATE_NAME.test(templateName)) {
      return res.status(400).json({ error: 'A template name is lower-case letters, numbers and underscores, as in WhatsApp Manager' });
    }
    if (!TEMPLATE_LANGUAGE.test(templateLanguage)) {
      return res.status(400).json({ error: 'The template language is a code such as en_US or es' });
    }
    if (templateName && templateParam === 'named' && !PARAM_NAME.test(templateParamName)) {
      return res.status(400).json({ error: 'Enter the name of the template parameter that takes the customer\'s name, such as first_name' });
    }

    const account = existing || new ChannelAccount({
      company: companyId,
      provider: 'whatsapp',
      verifyToken: ChannelAccount.newVerifyToken()
    });
    const before = existing ? describeAccount(existing.toObject()) : null;

    account.enabled = body.enabled !== false;
    account.phoneNumberId = phoneNumberId;
    account.wabaId = wabaId || undefined;
    account.displayPhoneNumber = field(body, 'displayPhoneNumber') || undefined;
    account.displayName = (field(body, 'displayName') || '').slice(0, 120) || undefined;
    account.accessToken = token.value;
    account.appSecret = secret.value;
    account.template = {
      name: templateName || undefined,
      language: templateLanguage,
      param: templateParam,
      paramName: templateParam === 'named' ? templateParamName : undefined
    };
    if (!account.verifyToken) {
      account.verifyToken = ChannelAccount.newVerifyToken();
    }
    if (body.accessToken) {
      // A new token is a fresh start: whatever went wrong with the old one
      // is no longer what the screen should be warning about.
      account.lastError = undefined;
      if (account.status === 'error') {
        account.status = 'connected';
      }
    }
    account.status = account.enabled ? (account.status === 'disabled' ? 'pending' : account.status) : 'disabled';

    await account.save();

    const after = describeAccount(account.toObject());
    audit.record({
      req,
      action: existing ? 'channels.whatsapp_updated' : 'channels.whatsapp_connected',
      target: { type: 'channel', id: String(account._id), label: 'WhatsApp' },
      details: {
        from: before && { enabled: before.enabled, phoneNumberId: before.phoneNumberId, template: before.template.name || null },
        to: { enabled: after.enabled, phoneNumberId: after.phoneNumberId, template: after.template.name || null },
        tokenChanged: Boolean(body.accessToken),
        appSecretChanged: Boolean(body.appSecret)
      }
    });

    res.json(await loadSettings(req));
  } catch (error) {
    if (isDuplicate(error)) {
      return res.status(409).json({ error: 'This WhatsApp number is already connected to another account' });
    }
    logger.error('Failed to save WhatsApp settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save the WhatsApp settings' });
  }
});

/**
 * PUT /api/channels/messenger - the Facebook Page, and the Instagram account
 * linked to it. One form, because Instagram is reached through the Page with
 * the Page's token; two accounts, because they are two inboxes.
 */
router.put('/messenger', auth, apiLimiter, requireOwnCompany, requireChannelsPlan, async (req, res) => {
  try {
    const body = req.body || {};
    const companyId = req.user.company.id;
    const [existing, existingInstagram] = await Promise.all(['messenger', 'instagram'].map(provider =>
      ChannelAccount.findOne({ company: companyId, provider }).select('+accessToken +appSecret +verifyToken')));

    const pageId = field(body, 'pageId');
    if (!pageId || !DIGITS.test(pageId)) {
      return res.status(400).json({ error: 'Enter the Facebook Page ID (digits only)' });
    }
    const igUserId = field(body, 'igUserId');
    if (igUserId && !DIGITS.test(igUserId)) {
      return res.status(400).json({ error: 'The Instagram account ID is digits only' });
    }
    if (await claimedElsewhere(companyId, 'messenger', 'pageId', pageId) ||
        (igUserId && await claimedElsewhere(companyId, 'instagram', 'igUserId', igUserId))) {
      return res.status(409).json({ error: 'This Page or Instagram account is already connected to another account' });
    }

    const stored = existing || existingInstagram;
    const token = credential(field(body, 'accessToken'), stored && stored.accessToken, { label: 'Page access token' });
    const secret = credential(field(body, 'appSecret'), stored && stored.appSecret, { label: 'App secret', pattern: APP_SECRET });
    if (token.error || secret.error) {
      return res.status(400).json({ error: token.error || secret.error });
    }

    const enabled = body.enabled !== false;
    const verifyToken = (stored && stored.verifyToken) || ChannelAccount.newVerifyToken();
    const shared = {
      enabled,
      pageId,
      displayName: (field(body, 'displayName') || '').slice(0, 120) || undefined,
      accessToken: token.value,
      appSecret: secret.value,
      verifyToken,
      humanAgentTag: body.humanAgentTag === true
    };

    const apply = (account, provider) => {
      const target = account || new ChannelAccount({ company: companyId, provider });
      Object.assign(target, shared);
      if (body.accessToken) {
        target.lastError = undefined;
        if (target.status === 'error') {
          target.status = 'connected';
        }
      }
      target.status = enabled ? (target.status === 'disabled' ? 'pending' : target.status) : 'disabled';
      return target;
    };

    const page = apply(existing, 'messenger');
    await page.save();

    if (igUserId) {
      const instagram = apply(existingInstagram, 'instagram');
      instagram.igUserId = igUserId;
      await instagram.save();
    } else if (existingInstagram) {
      await existingInstagram.deleteOne();
    }

    audit.record({
      req,
      action: existing ? 'channels.messenger_updated' : 'channels.messenger_connected',
      target: { type: 'channel', id: String(page._id), label: 'Messenger & Instagram' },
      details: {
        enabled,
        pageId,
        igUserId: igUserId || null,
        humanAgentTag: shared.humanAgentTag,
        tokenChanged: Boolean(body.accessToken),
        appSecretChanged: Boolean(body.appSecret)
      }
    });

    res.json(await loadSettings(req));
  } catch (error) {
    if (isDuplicate(error)) {
      return res.status(409).json({ error: 'This Page or Instagram account is already connected to another account' });
    }
    logger.error('Failed to save Messenger settings', { error: error.message });
    res.status(500).json({ error: 'Failed to save the Messenger and Instagram settings' });
  }
});

/** The accounts one settings screen manages. */
function screenProviders(provider) {
  return provider === 'whatsapp' ? ['whatsapp'] : ['messenger', 'instagram'];
}

/**
 * POST /api/channels/:provider/verify-token - a new verify token, for when
 * the old one was shared somewhere it should not have been.
 */
router.post('/:provider(whatsapp|messenger)/verify-token', auth, apiLimiter, requireOwnCompany, async (req, res) => {
  try {
    const token = ChannelAccount.newVerifyToken();
    const result = await ChannelAccount.updateMany(
      { company: req.user.company.id, provider: { $in: screenProviders(req.params.provider) } },
      { $set: { verifyToken: token } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ error: 'Save the settings first' });
    }
    audit.record({
      req,
      action: 'channels.verify_token_rotated',
      target: { type: 'channel', label: req.params.provider }
    });
    res.json(await loadSettings(req));
  } catch (error) {
    logger.error('Failed to rotate a verify token', { error: error.message });
    res.status(500).json({ error: 'Failed to create a new verify token' });
  }
});

/** DELETE /api/channels/:provider - disconnect, forgetting the credentials. */
router.delete('/:provider(whatsapp|messenger)', auth, apiLimiter, requireOwnCompany, async (req, res) => {
  try {
    await ChannelAccount.deleteMany({
      company: req.user.company.id,
      provider: { $in: screenProviders(req.params.provider) }
    });
    audit.record({
      req,
      action: 'channels.disconnected',
      target: { type: 'channel', label: req.params.provider }
    });
    res.json(await loadSettings(req));
  } catch (error) {
    logger.error('Failed to disconnect a channel', { error: error.message });
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

/**
 * POST /api/channels/whatsapp/test - "send a test message to my number".
 */
router.post('/whatsapp/test', auth, apiLimiter, requireOwnCompany, requireChannelsPlan, async (req, res) => {
  try {
    const result = await channels.sendTest(req.user.company.id, req.body && req.body.to);

    audit.record({
      req,
      action: 'channels.whatsapp_test_sent',
      outcome: result.sent ? 'success' : 'failure',
      details: { reason: result.reason }
    });

    if (!result.sent) {
      return res.status(400).json({ sent: false, error: `The test message could not be sent: ${result.reason}` });
    }
    res.json(result);
  } catch (error) {
    logger.error('Failed to send a WhatsApp test message', { error: error.message });
    res.status(500).json({ error: 'Failed to send the test message' });
  }
});

// ---------------------------------------------------------- conversations

/** A messaging-app conversation the signed-in person may work on. */
async function loadChannelConversation(req, res) {
  const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });
  if (!conversation || !canAccessCompany(req.user, conversation.company)) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }
  if (!channels.isMessagingChannel(conversation.channel)) {
    res.status(400).json({ error: 'This is not a WhatsApp, Messenger or Instagram conversation' });
    return null;
  }
  return conversation;
}

/**
 * GET /api/channels/conversations/:sessionId/window - what the composer may
 * send now: anything until a time, a template only, or nothing and why.
 */
router.get('/conversations/:sessionId/window', auth, apiLimiter, async (req, res) => {
  try {
    const conversation = await loadChannelConversation(req, res);
    if (!conversation) {
      return;
    }
    const account = await channels.findAccount(conversation.company, conversation.channel);
    const window = channels.windowFor(conversation, account);
    res.json({
      provider: conversation.channel,
      label: channels.LABELS[conversation.channel],
      lastInboundAt: conversation.external ? conversation.external.lastInboundAt || null : null,
      ...window
    });
  } catch (error) {
    logger.error('Failed to read a reply window', { error: error.message });
    res.status(500).json({ error: 'Failed to read the reply window' });
  }
});

/**
 * POST /api/channels/conversations/:sessionId/template - send the approved
 * WhatsApp template, the only way back to a customer after 24 hours.
 */
router.post('/conversations/:sessionId/template', auth, apiLimiter, async (req, res) => {
  try {
    const conversation = await loadChannelConversation(req, res);
    if (!conversation) {
      return;
    }
    if (conversation.status !== 'active') {
      return res.status(409).json({ error: 'This conversation has ended' });
    }

    const result = await channels.sendTemplate(conversation, {
      id: req.user.id,
      displayName: req.user.displayName,
      username: req.user.username
    });

    audit.record({
      req,
      action: 'channels.template_sent',
      outcome: result.sent ? 'success' : 'failure',
      target: { type: 'conversation', id: conversation.sessionId },
      details: { reason: result.reason }
    });

    if (!result.sent) {
      return res.status(400).json({ sent: false, error: result.reason });
    }
    res.json(result);
  } catch (error) {
    logger.error('Failed to send a WhatsApp template', { error: error.message });
    res.status(500).json({ error: 'Failed to send the template' });
  }
});

module.exports = router;
