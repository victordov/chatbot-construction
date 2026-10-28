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
const usageService = require('../services/usage');
const widgetInstall = require('../services/widget-install');
const { logger } = require('../services/logging');
const { isWidgetLanguage, isSafeLogoUrl } = require('../config/widget-languages');

const DEFAULT_SETTINGS = {
  chatbotName: 'Assistant',
  primaryColor: '#2196f3',
  position: 'right',
  welcomeMessage: 'Hi! How can we help you today?',
  logoUrl: null,
  // `auto`: the widget follows the visitor's browser language.
  language: 'auto',
  // What the pre-chat form asks for. Off by default: a form in front of the
  // first answer loses more conversations than it gains, and the widget asks
  // for an email when a handover actually needs one.
  requireName: false,
  requireEmail: false,
  requirePhone: false,
  // The tenant's own policy. Null means no link at all: the tenant is the
  // data controller, so pointing their visitors at a policy of ours would be
  // the wrong document.
  privacyPolicyUrl: null,
  suggestedQuestions: [],
  consentRequired: false,
  consentText: null,
  proactive: null
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

const asBoolean = value => value === true || value === 'true';

/** Up to four non-empty questions, each as the settings screen limits it. */
function cleanQuestions(value) {
  return (Array.isArray(value) ? value : [])
    .filter(question => typeof question === 'string' && question.trim())
    .map(question => question.trim().slice(0, 120))
    .slice(0, 4);
}

/**
 * The proactive message when it is switched on and says something; null
 * otherwise, so the widget has nothing to schedule.
 */
function cleanProactive(value) {
  if (!value || !asBoolean(value.enabled) || typeof value.text !== 'string' || !value.text.trim()) {
    return null;
  }
  const delay = Number(value.delaySeconds);
  return {
    enabled: true,
    text: value.text.trim().slice(0, 200),
    delaySeconds: Number.isFinite(delay) ? Math.min(120, Math.max(5, Math.round(delay))) : 20,
    pathContains: typeof value.pathContains === 'string' && value.pathContains.trim()
      ? value.pathContains.trim().slice(0, 200)
      : null
  };
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
    // Re-checked on the way out as well as on the way in: a value stored
    // before validation existed must not reach somebody else's website.
    logoUrl: isSafeLogoUrl(merged.logoUrl) ? merged.logoUrl : null,
    language: isWidgetLanguage(merged.language) ? merged.language : 'auto',
    requireName: asBoolean(merged.requireName),
    requireEmail: asBoolean(merged.requireEmail),
    requirePhone: asBoolean(merged.requirePhone),
    privacyPolicyUrl: typeof merged.privacyPolicyUrl === 'string' && /^https?:\/\//i.test(merged.privacyPolicyUrl)
      ? merged.privacyPolicyUrl
      : null,
    suggestedQuestions: cleanQuestions(merged.suggestedQuestions),
    consentRequired: asBoolean(merged.consentRequired),
    consentText: typeof merged.consentText === 'string' && merged.consentText.trim()
      ? merged.consentText.trim().slice(0, 300)
      : null,
    proactive: cleanProactive(merged.proactive)
  };
}

/**
 * What the plan allows that changes what the widget draws. A visitor should
 * never be told about the tenant's plan; a button that could only say "not
 * on this plan" is simply left out.
 */
async function widgetFeatures(companyId) {
  try {
    return { fileUploads: await usageService.hasFeature(companyId, 'fileUploads') };
  } catch (error) {
    // Unknown is treated as allowed: the upload route still checks.
    logger.warn('Could not read plan features for the widget', { error: error.message });
    return { fileUploads: true };
  }
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

    // The install check on the dashboard: a page on one of the tenant's own
    // domains asked for the config, so the widget is on it. Throttled, and
    // never allowed to fail the request.
    await widgetInstall.recordSeen(company, origin);

    // Whether anyone can actually pick up. The widget uses this to avoid
    // promising a person outside opening hours or when nobody is logged in.
    const [availability, features] = await Promise.all([
      availabilityService.status(company._id),
      widgetFeatures(company._id)
    ]);

    res.json({
      recognised: true,
      // Shown in the widget header while the assistant has the stock name,
      // and under an operator's name once a person joins.
      companyName: company.name,
      settings: presentationSettings(company),
      availability: {
        open: availability.open,
        canReachOperator: availability.canReachOperator,
        offlineMessage: availability.offlineMessage,
        opensAt: availability.opensAt
      },
      features,
      assets
    });
  } catch (error) {
    logger.error('Error serving widget config', { error });
    res.json({ recognised: false, settings: DEFAULT_SETTINGS, assets: assetManifest.all() });
  }
});

module.exports = router;
