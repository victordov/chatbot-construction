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
const availabilityService = require('../services/availability');
const { logger } = require('../services/logging');

const DEFAULT_SETTINGS = {
  chatbotName: 'Assistant',
  primaryColor: '#2196f3',
  position: 'right',
  welcomeMessage: 'Hi! How can we help you today?',
  logoUrl: null,
  // What the pre-chat form asks for. Name and email are what an operator
  // needs to follow up; a phone number is more than most visitors will hand
  // over just to ask a question, so it is optional unless the tenant says.
  requireName: true,
  requireEmail: true,
  requirePhone: false,
  // Linked from the pre-chat form. Null means the server's own policy page.
  privacyPolicyUrl: null
};

/**
 * The tenant's stored settings as a plain object, whichever shape the tenant
 * cache handed back (a mongoose subdocument spreads its internals, not its
 * fields).
 */
function storedSettings(company) {
  const settings = company && company.widgetSettings;
  if (!settings) {
    return {};
  }
  return typeof settings.toObject === 'function' ? settings.toObject() : settings;
}

/**
 * Only the keys the widget knows how to use, with the booleans coerced so a
 * stored "false" string never reads as required.
 */
function presentationSettings(company) {
  const merged = { ...DEFAULT_SETTINGS, ...storedSettings(company) };

  return {
    chatbotName: merged.chatbotName,
    primaryColor: merged.primaryColor,
    position: merged.position,
    welcomeMessage: merged.welcomeMessage,
    logoUrl: merged.logoUrl || null,
    requireName: merged.requireName !== false && merged.requireName !== 'false',
    requireEmail: merged.requireEmail !== false && merged.requireEmail !== 'false',
    requirePhone: merged.requirePhone === true || merged.requirePhone === 'true',
    privacyPolicyUrl: typeof merged.privacyPolicyUrl === 'string' && /^https?:\/\//i.test(merged.privacyPolicyUrl)
      ? merged.privacyPolicyUrl
      : null
  };
}

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

    // Whether anyone can actually pick up. The widget uses this to avoid
    // promising a person outside opening hours or when nobody is logged in.
    const availability = await availabilityService.status(company._id);

    res.json({
      recognised: true,
      companyName: company.name,
      settings: presentationSettings(company),
      availability: {
        open: availability.open,
        canReachOperator: availability.canReachOperator,
        offlineMessage: availability.offlineMessage,
        opensAt: availability.opensAt
      },
      assets
    });
  } catch (error) {
    logger.error('Error serving widget config', { error });
    res.json({ recognised: false, settings: DEFAULT_SETTINGS, assets: assetManifest.all() });
  }
});

module.exports = router;
