/**
 * Inbound email.
 *
 * This is a public URL that a mail provider posts to, so authentication is the
 * whole game: without it anyone who found the endpoint could put messages into
 * a tenant's queue, impersonate their customers, and burn their plan quota.
 * Every request must carry the company's inbound secret.
 */

const express = require('express');
const router = express.Router();

const Company = require('../models/company');
const emailChannel = require('../services/email-channel');
const lifecycle = require('../services/conversation-lifecycle');
const socketManager = require('../socketManager');
const { logger } = require('../services/logging');

const SUPPORTED_PROVIDERS = ['generic', 'sendgrid', 'mailgun', 'postmark'];

/**
 * Providers post form-encoded as often as JSON, so both are accepted here
 * specifically rather than globally.
 */
router.use(express.urlencoded({ extended: true, limit: '10mb' }));
router.use(express.json({ limit: '10mb' }));

/**
 * POST /api/email/inbound/:companyId/:provider
 *
 * The secret goes in an `X-Inbound-Secret` header where the provider allows
 * custom headers, which keeps it out of access logs; `?secret=` still works
 * for providers that can only be given a URL.
 *
 * The company is in the path rather than inferred from the recipient address,
 * because the recipient is attacker-controlled and inferring a tenant from it
 * would let anyone choose whose queue to write to.
 */
router.post('/inbound/:companyId/:provider?', async (req, res) => {
  const { companyId } = req.params;
  const provider = SUPPORTED_PROVIDERS.includes(req.params.provider)
    ? req.params.provider
    : 'generic';

  try {
    // Only the `+` path: selecting the parent `emailChannel` as well is a
    // MongoDB path collision and the whole query errors. The subdocument comes
    // back in full anyway, with the deselected secret restored.
    //
    // Deliberately not wrapped in a catch that maps errors to null - doing so
    // reported a genuine query failure as "company not found", which is a
    // miserable thing to debug in production.
    const company = await Company.findById(companyId)
      .select('+emailChannel.inboundSecret')
      .lean();

    if (!company || !company.emailChannel || !company.emailChannel.enabled) {
      // Same response whether the company is unknown or the channel is off, so
      // the endpoint cannot be used to enumerate tenants.
      return res.status(404).json({ error: 'Not found' });
    }

    const provided = req.get('x-inbound-secret') ||
      req.query.secret ||
      (req.body && req.body.secret);

    if (!emailChannel.verifyInboundSecret(provided, company.emailChannel.inboundSecret)) {
      logger.warn('Rejected inbound email with a bad secret', { companyId });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const parsed = emailChannel.normaliseInbound(provider, req.body);

    if (!parsed) {
      // Acknowledged, not retried: a message with no usable sender will never
      // parse, and providers retry 5xx indefinitely.
      logger.warn('Discarded an inbound email with no usable sender', { companyId, provider });
      return res.status(202).json({ accepted: false, reason: 'no sender address' });
    }

    const result = await emailChannel.receive(companyId, parsed);

    if (!result) {
      return res.status(202).json({ accepted: false });
    }

    // Proof the forwarding works, for the settings screen. A retry counts:
    // it is still mail arriving.
    Company.updateOne({ _id: companyId }, { $set: { 'emailChannel.lastInboundAt': new Date() } })
      .catch(error => logger.warn('Could not record the last inbound email', { error: error.message }));

    if (result.duplicate) {
      return res.json({ accepted: true, conversation: result.conversation.sessionId, duplicate: true });
    }

    const conversation = result.conversation;
    const stored = conversation.messages[conversation.messages.length - 1];

    // Surface it in the operator queue exactly like a chat message.
    socketManager.emitToOperators(companyId, result.created ? 'new-chat' : 'new-message', {
      sessionId: conversation.sessionId,
      channel: 'email',
      message: parsed.text,
      sender: 'user',
      userName: parsed.from,
      subject: parsed.subject,
      // The fields a chat's `new-chat` carries, so the queue treats both alike.
      visitorName: parsed.from,
      domain: conversation.domain,
      preview: lifecycle.preview(parsed.text),
      createdAt: conversation.startedAt,
      timestamp: new Date()
    });

    lifecycle.announceMessages(conversation, [stored], {
      operators: (event, payload) => socketManager.emitToOperators(companyId, event, payload)
    });

    res.json({
      accepted: true,
      conversation: result.conversation.sessionId,
      newThread: result.created
    });
  } catch (error) {
    logger.error('Failed to process inbound email', { error: error.message });
    // 500 so the provider retries — losing a customer's email is worse than a
    // duplicate, which threading will absorb.
    res.status(500).json({ error: 'Failed to process the message' });
  }
});

module.exports = router;
