/**
 * Downloads for installing the chat on a site builder: the WordPress plugin
 * and the Shopify theme snippet (services/install-packages.js).
 *
 * Public, like the widget config: a link from the dashboard's install tabs
 * carries the widget key, which is in every page the widget runs on anyway.
 * A key that belongs to a company gets a copy with it and this server's
 * address filled in; anything else gets the plain copy, which asks for both.
 */

const express = require('express');
const Company = require('../models/company');
const packages = require('../services/install-packages');
const { logger } = require('../services/logging');

const router = express.Router();

/** This server's address, as the widget snippet names it. */
function serverUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/** Install values for a key that exists, or null. */
async function valuesFor(req) {
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  const values = packages.installValues(key, serverUrl(req));
  if (!values) {
    return null;
  }
  const company = await Company.findOne({ widgetKey: values.widgetKey }).select('_id').lean();
  return company ? values : null;
}

router.get('/wordpress/support-desk-chat.zip', async (req, res) => {
  try {
    const archive = packages.wordpressPlugin(await valuesFor(req));
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${packages.PLUGIN_SLUG}.zip"`,
      // Filled in per company: never stored by a shared cache.
      'Cache-Control': 'private, no-store'
    });
    res.send(archive);
  } catch (error) {
    logger.error('Could not build the WordPress plugin download', { error: error.message });
    res.status(500).json({ error: 'The plugin could not be prepared. Please try again.' });
  }
});

router.get('/shopify/support-desk-chat.liquid', async (req, res) => {
  try {
    const snippet = packages.shopifySnippet(await valuesFor(req));
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.query.download !== undefined) {
      res.set('Content-Disposition', 'attachment; filename="support-desk-chat.liquid"');
    }
    res.send(snippet);
  } catch (error) {
    logger.error('Could not build the Shopify snippet download', { error: error.message });
    res.status(500).json({ error: 'The snippet could not be prepared. Please try again.' });
  }
});

module.exports = router;
