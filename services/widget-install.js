/**
 * Is the widget actually on the tenant's website?
 *
 * Two answers, because each misses something the other catches:
 *
 *   seen     the widget fetched its configuration from a page on one of the
 *            tenant's allowed domains. Proof it runs, however it was
 *            installed - a tag manager included - but only once somebody has
 *            visited the page.
 *   check    we fetch a page the admin names and look for the snippet in its
 *            HTML. Immediate, but blind to a snippet a tag manager injects.
 *
 * The dashboard shows both, so "is it installed?" stops being answered by
 * "well, a conversation exists".
 */

const Company = require('../models/company');
const tenantService = require('./tenant');
const safeHttp = require('./safe-http');
const { logger } = require('./logging');

/** At most one write per company per minute: config is fetched on every page view. */
const SEEN_THROTTLE_MS = 60 * 1000;

/** How many distinct sites the dashboard lists. */
const MAX_ORIGINS = 10;

// Company id -> when we last wrote (or decided not to), so a busy site does
// not cost a database round trip per page view. The database query is
// conditional as well, so several processes still write at most about once
// a minute between them.
const lastSeenWrite = new Map();

/** Forget the throttle. For tests. */
function resetThrottle() {
  lastSeenWrite.clear();
}

/** The origins a company has registered, normalised the way requests are. */
function allowedOrigins(company) {
  return (company && Array.isArray(company.allowedDomains) ? company.allowedDomains : [])
    .map(domain => tenantService.normaliseOrigin(domain))
    .filter(Boolean);
}

/**
 * Note that the widget was loaded from `origin`, if that is one of the
 * company's own sites.
 *
 * Only an allowed origin counts: that is where the widget answers, and a
 * key copied onto somebody else's page (or a developer's localhost) is not
 * "installed". Never throws - this rides on the public config request.
 *
 * @param {object} company a company with `_id` and `allowedDomains`
 * @param {string} rawOrigin the request's Origin, or its Referer
 * @param {object} [options] `now` (ms), for tests
 * @returns {Promise<boolean>} whether anything was written
 */
async function recordSeen(company, rawOrigin, options = {}) {
  try {
    if (!company || !company._id) {
      return false;
    }

    const origin = tenantService.normaliseOrigin(rawOrigin);
    if (!origin || !/^https?:\/\//.test(origin) || !allowedOrigins(company).includes(origin)) {
      return false;
    }

    const now = options.now !== undefined ? options.now : Date.now();
    const id = String(company._id);
    const last = lastSeenWrite.get(id);
    if (last !== undefined && now - last < SEEN_THROTTLE_MS) {
      return false;
    }
    lastSeenWrite.set(id, now);

    const current = await Company.findById(company._id).select('widgetSeen').lean();
    const previous = current && current.widgetSeen ? current.widgetSeen : {};
    const cutoff = new Date(now - SEEN_THROTTLE_MS);

    if (previous.at && new Date(previous.at) > cutoff) {
      // Another process wrote within the minute. The next try is a minute
      // after that write, not after this attempt.
      lastSeenWrite.set(id, new Date(previous.at).getTime());
      return false;
    }

    // Most recent first, each site once, the newest ten.
    const origins = [origin, ...(previous.origins || []).filter(known => known !== origin)].slice(0, MAX_ORIGINS);

    const result = await Company.updateOne(
      {
        _id: company._id,
        $or: [
          { 'widgetSeen.at': { $exists: false } },
          { 'widgetSeen.at': null },
          { 'widgetSeen.at': { $lte: cutoff } }
        ]
      },
      {
        $set: {
          'widgetSeen.at': new Date(now),
          'widgetSeen.origin': origin,
          'widgetSeen.origins': origins
        }
      }
    );

    return Boolean(result && (result.modifiedCount || result.nModified));
  } catch (error) {
    logger.warn('Could not record where the widget was seen', { error: error.message });
    return false;
  }
}

// The attributes the dashboard's snippet used to set. Still honoured by the
// loader, so a site carrying them keeps the old name, colour and position
// whatever the dashboard says.
const LEGACY_ATTRIBUTES = [
  'data-chatbot-name',
  'data-primary-color',
  'data-position',
  'data-initial-message'
];

/**
 * What a page's HTML says about the snippet.
 *
 * Pure, so the rules are testable without a network: the loader script,
 * which widget keys appear, and anything that will override the dashboard.
 */
function inspectHtml(html, widgetKey) {
  const source = String(html || '');
  const loaderFound = /widget-loader(\.[a-f0-9]{8})?\.js/i.test(source);

  const keys = [];
  const keyPattern = /data-widget-key\s*=\s*["']?([A-Za-z0-9_-]+)/gi;
  let match;
  while ((match = keyPattern.exec(source)) !== null) {
    if (!keys.includes(match[1])) {
      keys.push(match[1]);
    }
  }

  const keyFound = Boolean(widgetKey) && (keys.includes(widgetKey) || source.includes(widgetKey));
  const otherKeys = keys.filter(key => key !== widgetKey);

  return {
    loaderFound,
    keyFound,
    otherKeys,
    legacyAttributes: LEGACY_ATTRIBUTES.filter(attribute => new RegExp(`${attribute}\\s*=`, 'i').test(source)),
    // A tag manager injects the snippet after the page loads, so its absence
    // from the HTML proves nothing.
    tagManager: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(source)
  };
}

/** Read a URL the admin typed: a bare domain means its https home page. */
function normaliseCheckUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a page of the tenant's site and say whether the widget is on it.
 *
 * Through safe-http, because the URL is typed by a tenant: aimed at
 * 169.254.169.254 or localhost it would otherwise be a way to read our own
 * network.
 *
 * @returns {Promise<object>} `{ok, url, status, installed, loaderFound,
 *          keyFound, otherKeys, legacyAttributes, tagManager, domainAllowed,
 *          error?}`
 */
async function checkSite(rawUrl, company) {
  const url = normaliseCheckUrl(rawUrl);
  if (!url) {
    return { ok: false, error: 'Enter the address of a page on your website, for example https://www.example.com' };
  }

  const origin = tenantService.normaliseOrigin(url);
  const domainAllowed = allowedOrigins(company).includes(origin);

  let response;
  try {
    response = await safeHttp.fetchUrl(url, {
      timeoutMs: 10000,
      // Enough for any real page's HTML; the snippet is near the end, so a
      // smaller cap could stop just short of it.
      maxBytes: 3 * 1024 * 1024,
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
  } catch (error) {
    return { ok: false, url, domainAllowed, error: `We could not load that page: ${error.message}` };
  }

  const findings = inspectHtml(response.body, company && company.widgetKey);

  return {
    ok: true,
    url,
    status: response.statusCode,
    installed: findings.loaderFound && findings.keyFound,
    domainAllowed,
    ...findings
  };
}

module.exports = {
  recordSeen,
  checkSite,
  inspectHtml,
  normaliseCheckUrl,
  resetThrottle,
  SEEN_THROTTLE_MS,
  MAX_ORIGINS
};
