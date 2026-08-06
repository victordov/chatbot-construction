/**
 * Public widget bootstrap.
 *
 * The embedded widget calls this before rendering to discover which tenant it
 * belongs to and how it should look. It is deliberately unauthenticated - the
 * widget key is a public identifier - so it only ever returns presentation
 * data, never anything about the company's users or conversations.
 */

const express = require('express');
const router = express.Router();
const tenantService = require('../services/tenant');
const assetManifest = require('../services/asset-manifest');
const { logger } = require('../services/logging');

const DEFAULT_SETTINGS = {
  chatbotName: 'Assistant',
  primaryColor: '#2196f3',
  position: 'right',
  welcomeMessage: 'Hi! How can we help you today?',
  logoUrl: null
};

router.get('/config', async (req, res) => {
  try {
    const widgetKey = req.query.key;
    const origin = req.get('Origin') || req.get('Referer');

    const company = await tenantService.resolveCompany({ widgetKey, origin });

    // Content-hashed URLs, so the loader fetches an immutable, hard-cacheable
    // build rather than revalidating the widget on every page view.
    const assets = assetManifest.all();

    if (!company) {
      // Unknown tenant: still return a usable default so a misconfigured
      // snippet degrades to a working generic widget rather than a blank page.
      return res.json({
        recognised: false,
        settings: DEFAULT_SETTINGS,
        assets
      });
    }

    res.json({
      recognised: true,
      companyName: company.name,
      settings: { ...DEFAULT_SETTINGS, ...(company.widgetSettings || {}) },
      assets
    });
  } catch (error) {
    logger.error('Error serving widget config', { error });
    res.json({ recognised: false, settings: DEFAULT_SETTINGS, assets: assetManifest.all() });
  }
});

module.exports = router;
