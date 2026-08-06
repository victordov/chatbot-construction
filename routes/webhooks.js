/**
 * Managing webhook endpoints.
 *
 * Admin-only, and scoped to the caller's company by the query itself rather
 * than by a check after the fetch — an endpoint URL belonging to another tenant
 * is not something a guessed id should reach.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Webhook = require('../models/webhook');
const WebhookDelivery = require('../models/webhook-delivery');
const webhookService = require('../services/webhooks');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const audit = require('../services/audit');
const { auth, admin } = require('../middleware/auth');
const { companyFilter, parsePagination } = require('../utils/query');
const { logger } = require('../services/logging');

router.use(auth, admin);

/**
 * Shape an endpoint for the dashboard.
 *
 * The secret never appears. Whether one is set does, because that is the part
 * an admin needs to know; the value itself they already copied when it was
 * created, and showing it again only widens who can read it.
 */
function present(hook) {
  return {
    _id: hook._id,
    description: hook.description,
    url: hook.url,
    events: hook.events || [],
    enabled: hook.enabled,
    // Either shape: the aggregated listing computes it in the database, and a
    // single document carries the encrypted value when it was just written.
    hasSecret: hook.hasSecret !== undefined ? hook.hasSecret : Boolean(hook.secret),
    consecutiveFailures: hook.consecutiveFailures || 0,
    disabledAt: hook.disabledAt,
    disabledReason: hook.disabledReason,
    lastSuccessAt: hook.lastSuccessAt,
    lastFailureAt: hook.lastFailureAt,
    createdAt: hook.createdAt
  };
}

/** The events on offer, so the UI does not carry its own copy of the list. */
router.get('/events', (req, res) => {
  res.json({ events: webhookService.EVENTS });
});

/**
 * What we tried to send, and what came back.
 *
 * The answer to "it isn't firing", which is otherwise unanswerable.
 */
router.get('/deliveries', async (req, res) => {
  try {
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
    const filter = { ...companyFilter(req.user) };

    if (req.query.webhook && mongoose.Types.ObjectId.isValid(req.query.webhook)) {
      filter.webhook = req.query.webhook;
    }

    if (['pending', 'delivered', 'failed'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [deliveries, total] = await Promise.all([
      WebhookDelivery.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WebhookDelivery.countDocuments(filter)
    ]);

    res.json({ deliveries, total, retentionDays: WebhookDelivery.RETENTION_DAYS });
  } catch (error) {
    logger.error('Failed to load webhook deliveries', { error: error.message });
    res.status(500).json({ error: 'Failed to load the deliveries' });
  }
});

router.get('/', async (req, res) => {
  try {
    // Aggregated rather than `find().select('+secret')` so the ciphertext never
    // leaves the database for a listing. `present` would drop it either way,
    // but a value that was never loaded cannot leak through a later change to
    // that function.
    const hooks = await Webhook.aggregate([
      { $match: companyFilter(req.user) },
      { $sort: { createdAt: -1 } },
      {
        $project: {
          description: 1, url: 1, events: 1, enabled: 1,
          consecutiveFailures: 1, disabledAt: 1, disabledReason: 1,
          lastSuccessAt: 1, lastFailureAt: 1, createdAt: 1,
          hasSecret: { $gt: [{ $strLenCP: { $ifNull: ['$secret', ''] } }, 0] }
        }
      }
    ]);

    res.json({ webhooks: hooks.map(present) });
  } catch (error) {
    logger.error('Failed to list webhooks', { error: error.message });
    res.status(500).json({ error: 'Failed to load the endpoints' });
  }
});

/**
 * Validate what an admin typed, before it is stored.
 *
 * The URL check is the same one workflow actions use, so an endpoint cannot be
 * pointed at the metadata service or at localhost. Rejecting it here means a
 * bad address is a form error rather than a delivery failure discovered later.
 */
function validate(body) {
  const errors = [];

  const check = safeHttp.validateUrl(body.url || '');
  if (!check.valid) {
    errors.push(check.error);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  const unknown = events.filter(event => !webhookService.EVENT_IDS.has(event));

  if (unknown.length > 0) {
    errors.push(`Unknown event${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }

  if (events.length === 0) {
    errors.push('Choose at least one event to send');
  }

  return { errors, events };
}

router.post('/', async (req, res) => {
  try {
    if (!req.user.company?.id) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const { errors, events } = validate(req.body);

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Minted here rather than accepted from the request: a secret the caller
    // chose is a secret they may have reused, and this one is ours to
    // guarantee the strength of.
    const secret = webhookService.generateSecret();

    const hook = await Webhook.create({
      company: req.user.company.id,
      description: String(req.body.description || '').trim().slice(0, 200),
      url: String(req.body.url).trim(),
      events,
      secret: secrets.encrypt(secret),
      createdBy: req.user.id
    });

    audit.record({
      req,
      action: 'webhook.created',
      target: { type: 'webhook', id: String(hook._id), label: hook.url },
      details: { events }
    });

    res.status(201).json({
      webhook: present(hook.toObject()),
      // The only time it is ever returned. Said plainly in the response so the
      // UI can tell the admin to copy it now.
      secret,
      secretNotice: 'Copy this now — it is not shown again.'
    });
  } catch (error) {
    logger.error('Failed to create webhook', { error: error.message });
    res.status(500).json({ error: 'Failed to create the endpoint' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const hook = await Webhook.findOne({ _id: req.params.id, ...companyFilter(req.user) });

    if (!hook) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    if (req.body.url !== undefined || req.body.events !== undefined) {
      const { errors, events } = validate({
        url: req.body.url ?? hook.url,
        events: req.body.events ?? hook.events
      });

      if (errors.length > 0) {
        return res.status(400).json({ error: errors[0], errors });
      }

      hook.url = String(req.body.url ?? hook.url).trim();
      hook.events = events;
    }

    if (req.body.description !== undefined) {
      hook.description = String(req.body.description).trim().slice(0, 200);
    }

    if (req.body.enabled !== undefined) {
      hook.enabled = Boolean(req.body.enabled);

      // Re-enabling clears the failure history. Otherwise an endpoint that was
      // switched off automatically would be switched off again on its next
      // failure, however long ago the previous nineteen were.
      if (hook.enabled) {
        hook.consecutiveFailures = 0;
        hook.disabledAt = undefined;
        hook.disabledReason = undefined;
      }
    }

    await hook.save();

    audit.record({
      req,
      action: 'webhook.updated',
      target: { type: 'webhook', id: String(hook._id), label: hook.url },
      details: { events: hook.events, enabled: hook.enabled }
    });

    res.json({ webhook: present(hook.toObject()) });
  } catch (error) {
    logger.error('Failed to update webhook', { error: error.message });
    res.status(500).json({ error: 'Failed to update the endpoint' });
  }
});

/**
 * Replace the signing secret.
 *
 * Deliveries signed with the old one stop verifying the moment this is called,
 * so the response says so rather than letting an admin discover it from their
 * own error logs.
 */
router.post('/:id/rotate-secret', async (req, res) => {
  try {
    const hook = await Webhook.findOne({ _id: req.params.id, ...companyFilter(req.user) });

    if (!hook) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    const secret = webhookService.generateSecret();
    hook.secret = secrets.encrypt(secret);
    await hook.save();

    audit.record({
      req,
      action: 'webhook.secret_rotated',
      target: { type: 'webhook', id: String(hook._id), label: hook.url }
    });

    res.json({
      secret,
      secretNotice: 'Copy this now — it is not shown again. Deliveries signed with the previous secret will no longer verify.'
    });
  } catch (error) {
    logger.error('Failed to rotate webhook secret', { error: error.message });
    res.status(500).json({ error: 'Failed to rotate the secret' });
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const hook = await Webhook.findOne({ _id: req.params.id, ...companyFilter(req.user) })
      .select('+secret').lean();

    if (!hook) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    // Deliberately runs even for a disabled endpoint: testing is how somebody
    // establishes it works again before switching it back on.
    const result = await webhookService.sendTest(hook);

    res.json({ result });
  } catch (error) {
    logger.error('Failed to send test webhook', { error: error.message });
    res.status(500).json({ error: 'Failed to send the test' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const hook = await Webhook.findOneAndDelete({
      _id: req.params.id,
      ...companyFilter(req.user)
    });

    if (!hook) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    // The delivery log goes with it: it is only meaningful against an endpoint
    // that exists, and keeping it would leave rows nothing can be traced to.
    await WebhookDelivery.deleteMany({ webhook: hook._id });

    audit.record({
      req,
      action: 'webhook.deleted',
      target: { type: 'webhook', id: String(hook._id), label: hook.url }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete webhook', { error: error.message });
    res.status(500).json({ error: 'Failed to delete the endpoint' });
  }
});

module.exports = router;
