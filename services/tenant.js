/**
 * Tenant resolution.
 *
 * Incoming chats arrive from an embedded widget on a customer's website. To
 * attribute them to a company we look at, in order of confidence:
 *
 *   1. the widget key in the embed snippet (`data-widget-key`)
 *   2. the request Origin/Referer matched against the company's allowedDomains
 *
 * Results are cached briefly because this runs on every socket connection and
 * every widget bootstrap.
 */

const Company = require('../models/company');
const { logger } = require('./logging');

const CACHE_TTL_MS = 60 * 1000;

const keyCache = new Map();
const domainCache = new Map();

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (!hit) {
    return undefined;
  }
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Drop cached entries. Call after a company's key or domains change.
 */
function invalidate() {
  keyCache.clear();
  domainCache.clear();
}

/**
 * Normalise an Origin/Referer header down to `scheme://host[:port]`.
 */
function normaliseOrigin(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return String(value).trim().toLowerCase().replace(/\/+$/, '') || null;
  }
}

async function findByWidgetKey(widgetKey) {
  if (!widgetKey || typeof widgetKey !== 'string') {
    return null;
  }

  const cached = cacheGet(keyCache, widgetKey);
  if (cached !== undefined) {
    return cached;
  }

  const company = await Company.findOne({ widgetKey, isActive: true })
    .select('_id name widgetSettings allowedDomains')
    .lean();

  cacheSet(keyCache, widgetKey, company || null);
  return company || null;
}

async function findByOrigin(origin) {
  const normalised = normaliseOrigin(origin);
  if (!normalised) {
    return null;
  }

  const cached = cacheGet(domainCache, normalised);
  if (cached !== undefined) {
    return cached;
  }

  const company = await Company.findOne({ allowedDomains: normalised, isActive: true })
    .select('_id name widgetSettings allowedDomains')
    .lean();

  cacheSet(domainCache, normalised, company || null);
  return company || null;
}

/**
 * Resolve the tenant for an incoming widget request.
 *
 * @param {object} input
 * @param {string} [input.widgetKey]
 * @param {string} [input.origin] Origin or Referer header
 * @returns {Promise<object|null>} the company document (lean) or null
 */
async function resolveCompany({ widgetKey, origin } = {}) {
  try {
    const byKey = await findByWidgetKey(widgetKey);
    if (byKey) {
      return byKey;
    }
    return await findByOrigin(origin);
  } catch (error) {
    logger.error('Tenant resolution failed', { error: error.message });
    return null;
  }
}

/**
 * Resolve just the company id, which is all most call sites need.
 */
async function resolveCompanyId(input) {
  const company = await resolveCompany(input);
  return company ? company._id : null;
}

/**
 * True when `origin` is allowed to embed any tenant's widget. Used by CORS so
 * that onboarding a customer does not require an environment variable change
 * and a redeploy.
 */
async function isOriginAllowed(origin) {
  const normalised = normaliseOrigin(origin);
  if (!normalised) {
    return false;
  }

  const staticAllowList = (process.env.ALLOWED_DOMAINS
    ? process.env.ALLOWED_DOMAINS.split(',')
    : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'])
    .map(d => normaliseOrigin(d))
    .filter(Boolean);

  if (staticAllowList.includes(normalised)) {
    return true;
  }

  return Boolean(await findByOrigin(normalised));
}

module.exports = {
  resolveCompany,
  resolveCompanyId,
  findByWidgetKey,
  findByOrigin,
  isOriginAllowed,
  normaliseOrigin,
  invalidate
};
