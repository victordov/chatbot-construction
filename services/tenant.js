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

const mongoose = require('mongoose');
const Company = require('../models/company');
const { logger } = require('./logging');

const CACHE_TTL_MS = 60 * 1000;

const keyCache = new Map();
const domainCache = new Map();
const idCache = new Map();

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
  idCache.clear();
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

async function findById(companyId) {
  if (!mongoose.isValidObjectId(companyId)) {
    return null;
  }

  const key = String(companyId);
  const cached = cacheGet(idCache, key);
  if (cached !== undefined) {
    return cached;
  }

  const company = await Company.findOne({ _id: companyId, isActive: true })
    .select('_id name widgetSettings allowedDomains')
    .lean();

  cacheSet(idCache, key, company || null);
  return company || null;
}

/**
 * Origins the platform itself vouches for, whoever the tenant: the operator's
 * ALLOWED_DOMAINS list and this server's own public address.
 */
function platformOrigins() {
  return [
    ...(process.env.ALLOWED_DOMAINS ? process.env.ALLOWED_DOMAINS.split(',') : []),
    process.env.PUBLIC_URL
  ]
    .map(value => normaliseOrigin(value && String(value).trim()))
    .filter(Boolean);
}

/**
 * A page on the developer's own machine. Allowed in development, where the
 * widget is tried out from a file server on some port, and never in
 * production: anyone can serve a page from their own localhost.
 */
function isLocalDevelopmentOrigin(normalised) {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  try {
    const { hostname } = new URL(normalised);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Whether a page at `origin` may use a widget.
 *
 * With a tenant named - the widget key a page presents, or a company id -
 * the answer is about that tenant: the origin must be one of *its* allowed
 * domains. This used to accept any origin any tenant had registered, so a
 * domain somebody listed under their own (free) account could embed every
 * other tenant's widget, run up their bill and wear their name.
 *
 * Without a tenant it answers the narrower question the HTTP edge asks before
 * it knows who a request is for: is this origin registered by some tenant.
 * Such a request is then attributed by that same origin, so it reaches the
 * tenant that registered it and nobody else.
 *
 * The platform's own origins (ALLOWED_DOMAINS, PUBLIC_URL) are always
 * allowed, and localhost only outside production.
 *
 * @param {string} origin an Origin or Referer header
 * @param {{widgetKey?: string, companyId?: string}} [tenant]
 * @returns {Promise<boolean>}
 */
async function isOriginAllowed(origin, tenant = {}) {
  const normalised = normaliseOrigin(origin);
  if (!normalised) {
    return false;
  }

  if (platformOrigins().includes(normalised) || isLocalDevelopmentOrigin(normalised)) {
    return true;
  }

  const { widgetKey, companyId } = tenant || {};

  if (companyId || widgetKey) {
    const company = companyId
      ? await findById(companyId)
      : await findByWidgetKey(widgetKey);

    if (!company) {
      // An unknown or rotated key names no tenant, so there are no domains
      // it could be allowed on.
      return false;
    }

    return (company.allowedDomains || [])
      .map(domain => normaliseOrigin(domain))
      .includes(normalised);
  }

  return Boolean(await findByOrigin(normalised));
}

module.exports = {
  resolveCompany,
  resolveCompanyId,
  findByWidgetKey,
  findByOrigin,
  isOriginAllowed,
  isLocalDevelopmentOrigin,
  normaliseOrigin,
  invalidate
};
