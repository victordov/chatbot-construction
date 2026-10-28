/**
 * Push notifications on the signed-in person's own devices, and the
 * operator app's manifest.
 *
 * Everything here is about the caller's own devices: nobody turns
 * notifications on for somebody else, and nobody sees anybody else's list.
 */

const express = require('express');
const pushService = require('../services/push');
const accountEmail = require('../services/account-email');
const audit = require('../services/audit');
const { auth, operator } = require('../middleware/auth');
const { logger } = require('../services/logging');

const router = express.Router();

router.use(auth, operator);

const NOT_CONFIGURED = {
  error: 'Push notifications are not set up on this server. Whoever runs it needs to add VAPID keys.',
  code: 'PUSH_NOT_CONFIGURED'
};

/** Whether push is on for this deployment, and the key browsers subscribe with. */
router.get('/key', (req, res) => {
  const publicKey = pushService.publicKey();
  res.json({ enabled: Boolean(publicKey), publicKey });
});

/** The caller's devices. */
router.get('/devices', async (req, res) => {
  try {
    res.json({ enabled: pushService.isConfigured(), devices: await pushService.devices(req.user.id) });
  } catch (error) {
    logger.error('Could not list push devices', { error: error.message });
    res.status(500).json({ error: 'Could not list your devices' });
  }
});

/**
 * Turn notifications on for this browser, change its settings, or (with
 * `refresh`) check in on a dashboard load. See services/push.js `register`.
 */
router.post('/subscribe', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await pushService.register(req.user, {
      subscription: body.subscription,
      applicationServerKey: typeof body.applicationServerKey === 'string' ? body.applicationServerKey : undefined,
      level: typeof body.level === 'string' ? body.level : undefined,
      previews: typeof body.previews === 'boolean' ? body.previews : undefined,
      installed: typeof body.installed === 'boolean' ? body.installed : undefined,
      refresh: body.refresh === true
    }, {
      session: req.token || {},
      userAgent: req.get('user-agent')
    });

    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        code: result.code,
        publicKey: result.publicKey
      });
    }

    if (result.created) {
      // A new place that will show who is waiting: worth a line in the log
      // next to the sign-ins.
      audit.record({
        req,
        action: 'push.device_added',
        target: { type: 'user', id: String(req.user.id), label: result.device.label },
        details: { device: result.device.label }
      });
    }

    if (result.resubscribe) {
      return res.json({ device: result.device, resubscribe: true, publicKey: result.publicKey });
    }

    res.status(result.created ? 201 : 200).json({ device: result.device });
  } catch (error) {
    logger.error('Could not save a push subscription', { error: error.message });
    res.status(500).json({ error: 'Could not turn notifications on for this device' });
  }
});

/** Turn notifications off for this browser (`endpoint`) or a listed device (`id`). */
router.delete('/subscribe', async (req, res) => {
  try {
    const body = req.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : undefined;
    const id = typeof body.id === 'string' ? body.id : (typeof req.query.id === 'string' ? req.query.id : undefined);

    if (!endpoint && !id) {
      return res.status(400).json({ error: 'Say which device to remove' });
    }

    const removed = await pushService.unregister(req.user.id, { endpoint, id });
    if (removed && id) {
      audit.record({
        req,
        action: 'push.device_removed',
        target: { type: 'user', id: String(req.user.id) },
        details: { device: id }
      });
    }

    res.json({ removed });
  } catch (error) {
    logger.error('Could not remove a push subscription', { error: error.message });
    res.status(500).json({ error: 'Could not remove that device' });
  }
});

/** Send a test notification to the caller's devices, or to one of them. */
router.post('/test', async (req, res) => {
  if (!pushService.isConfigured()) {
    return res.status(503).json(NOT_CONFIGURED);
  }

  try {
    const id = req.body && typeof req.body.id === 'string' ? req.body.id : undefined;
    const result = await pushService.sendToUser(req.user.id, pushService.testPayload(), { subscriptionId: id });

    if (result.sent === 0) {
      return res.status(404).json({
        error: result.removed
          ? 'That device no longer accepts notifications. Turn them on again.'
          : 'No device of yours could be reached. Turn notifications on first.',
        ...result
      });
    }

    res.json(result);
  } catch (error) {
    logger.error('Could not send a test push', { error: error.message });
    res.status(500).json({ error: 'Could not send a test notification' });
  }
});

/** "Support Desk" fits under a home-screen icon; a long product name does not. */
function shortName(name) {
  if (name.length <= 12) {
    return name;
  }
  const firstWord = name.split(/\s+/)[0];
  return firstWord.length <= 12 ? firstWord : name.slice(0, 12);
}

/**
 * The web app manifest, at /admin/manifest.webmanifest.
 *
 * Served rather than a static file so the installed app carries the
 * product's own name (PRODUCT_NAME), the same one the sign-in page and the
 * emails use. It opens on the live chats, because that is what somebody
 * reaching for the app on their phone has come to answer.
 */
function manifest(req, res) {
  const name = accountEmail.productName();

  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.send(JSON.stringify({
    id: '/admin/',
    name,
    short_name: shortName(name),
    description: 'Answer your customers from anywhere: live chats, handoffs and notifications.',
    start_url: '/admin/?section=active-chats',
    scope: '/admin/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#2563eb',
    icons: [
      { src: '/admin/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/admin/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/admin/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/admin/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }));
}

module.exports = router;
module.exports.manifest = manifest;
