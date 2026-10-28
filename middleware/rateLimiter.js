/**
 * Rate limiting.
 *
 * Two things were wrong with counting requests per IP in each process's own
 * memory:
 *
 *   - The limits multiplied by the instance count. "5 login attempts an hour"
 *     meant fifteen behind three replicas, and nobody noticed because nothing
 *     about the configuration changed when the deployment was scaled.
 *   - An IP is not a customer. Everyone behind one office NAT shared a bucket,
 *     so a busy tenant's staff throttled each other, while a tenant with a
 *     thousand users across a thousand addresses was effectively unlimited.
 *
 * So: counts live in MongoDB (services/rate-limit-store.js), and the key is
 * the tenant wherever the request proves which tenant it belongs to.
 *
 * ## What counts as proof
 *
 * Authenticated traffic carries a signed token, so the company and user in it
 * cannot be invented: those requests are keyed by company and user, and an
 * office NAT stops being a shared bucket. The limit for them comes from the
 * plan (`apiRequestsPerMinute`), so a paying tenant is not held to a trial's
 * ceiling, and a superadmin is not held to anything.
 *
 * Anonymous traffic - the widget, the login form - proves nothing. A widget
 * key is public by construction and a visitor could send any string, so it is
 * used only to *separate* tenants, never on its own: the key is still the
 * address plus the tenant. Otherwise anyone wanting a fresh bucket would just
 * make up a new widget key.
 */

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const MongoRateLimitStore = require('../services/rate-limit-store');
const usageService = require('../services/usage');
const { logger } = require('../services/logging');

function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The claims of a *verified* token, or null.
 *
 * Verification matters here beyond the usual reason: an unverified claim would
 * let anyone mint a company id per request and never be limited at all.
 */
function tokenClaims(req) {
  const header = req.headers.authorization;
  const token = req.headers['x-auth-token']
    || (header && header.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'chatbot-jwt-secret');
  } catch {
    return null;
  }
}

/**
 * Who this request is, as far as anything can be trusted.
 *
 * `req.user` is preferred when present (a limiter mounted after auth), and the
 * token is verified directly otherwise, because the app-level limiters run
 * before any route has authenticated anybody.
 */
function identify(req) {
  if (req.user && req.user.id) {
    return {
      authenticated: true,
      userId: String(req.user.id),
      companyId: req.user.company ? String(req.user.company.id) : null,
      role: req.user.role
    };
  }

  const claims = tokenClaims(req);
  if (claims && claims.id) {
    return {
      authenticated: true,
      userId: String(claims.id),
      companyId: claims.company ? String(claims.company) : null,
      role: claims.role
    };
  }

  return { authenticated: false, userId: null, companyId: null, role: null };
}

/**
 * A tenant hint from anonymous traffic. Never a key on its own - see the note
 * at the top of the file.
 */
function anonymousTenantHint(req) {
  const candidate = req.headers['x-widget-key']
    || (req.query && req.query.widgetKey)
    || (req.body && typeof req.body === 'object' ? req.body.widgetKey : null);

  if (typeof candidate !== 'string' || !candidate) {
    return 'anon';
  }

  // Bounded so a long header cannot become a long document id.
  return candidate.slice(0, 64);
}

/**
 * A stable address for a client.
 *
 * IPv6 is collapsed to its /64 prefix because a single host is routinely given
 * an entire /64: limiting the full address would let one machine walk through
 * addresses to get a fresh bucket each time.
 */
function addressKey(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  if (ip.includes(':') && !ip.startsWith('::ffff:')) {
    return ip.split(':').slice(0, 4).join(':') + '::/64';
  }

  return ip.replace(/^::ffff:/, '');
}

function tenantKey(req) {
  const who = identify(req);

  if (who.authenticated) {
    return who.companyId
      ? `c:${who.companyId}:u:${who.userId}`
      : `u:${who.userId}`;
  }

  return `t:${anonymousTenantHint(req)}:ip:${addressKey(req)}`;
}

/**
 * The per-minute allowance for an authenticated tenant, from their plan or
 * from a negotiated override on their subscription.
 *
 * A lookup per request would be a database round trip in front of every API
 * call; `usageService.getSubscription` caches for 30 seconds, which is the
 * same freshness the quota middleware already accepts.
 */
async function planLimit(req, fallback) {
  const who = identify(req);

  if (!who.authenticated) {
    return fallback;
  }

  if (!who.companyId) {
    return fallback;
  }

  try {
    const subscription = await usageService.getSubscription(who.companyId);
    const limit = subscription.limitFor('apiRequestsPerMinute');
    // `null` is this codebase's "unlimited". express-rate-limit has no such
    // value - 0 blocks everything - so it becomes a number nobody reaches.
    if (limit === null) {
      return Number.MAX_SAFE_INTEGER;
    }
    // A signed-in person using the dashboard is not a program: one page load
    // is a dozen requests, and a trial admin clicking through setup must not
    // meet "too many requests" on their first afternoon. The plan's number
    // still governs the public API, which has its own per-key limiter.
    return Math.max(limit, envInt('RATE_LIMIT_DASHBOARD_MIN', 300));
  } catch (error) {
    logger.error('Rate limit plan lookup failed; using the default allowance', {
      companyId: who.companyId,
      error: error.message
    });
    return fallback;
  }
}

function buildLimiter({ prefix, windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    store: new MongoRateLimitStore({ prefix, windowMs }),
    keyGenerator: keyGenerator || tenantKey,
    // Superadmins operate the platform. Throttling them is how an incident
    // becomes an incident nobody can log in to fix.
    skip: req => identify(req).role === 'superadmin',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message }
  });
}

/**
 * General API traffic. The allowance is the tenant's plan for authenticated
 * requests and a modest fixed number for everyone else.
 */
const API_ANONYMOUS_MAX = envInt('RATE_LIMIT_API_MAX', 100);

const apiLimiter = buildLimiter({
  prefix: 'api',
  windowMs: 60 * 1000,
  limit: req => planLimit(req, API_ANONYMOUS_MAX),
  message: 'Too many requests. Please slow down.'
});

/**
 * Login. Deliberately not per tenant: the whole point is to limit somebody who
 * has not proved who they are, and a failed login proves nothing at all.
 */
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_AUTH_MAX', 10),
  store: new MongoRateLimitStore({ prefix: 'auth', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => {
    // Including the username stops one address hammering many accounts from
    // looking like one account being hammered, and vice versa.
    const username = req.body && typeof req.body.username === 'string'
      ? req.body.username.toLowerCase().slice(0, 64)
      : '';
    return `ip:${addressKey(req)}:u:${username}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Only failures count. Somebody who keeps signing in successfully is not
  // brute-forcing anything.
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again later.' }
});

/**
 * The ceiling over the login limiter above.
 *
 * Keying on the username means that limiter never notices one address trying
 * ten passwords each against a thousand accounts - which is what a spray looks
 * like. This one ignores the username: an address that has failed to sign in
 * fifty times in an hour, whoever it claimed to be, is done for the hour.
 */
const loginAddressLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_AUTH_IP_MAX', 50),
  store: new MongoRateLimitStore({ prefix: 'auth-ip', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => `ip:${addressKey(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts from this address. Please try again later.' }
});

/**
 * Password reset requests, per address.
 *
 * The forgot-password endpoint answers 200 whether or not the address exists,
 * so `skipSuccessfulRequests` would never count it. Every request counts, and
 * the allowance is small: a person forgets a password a few times a year, and
 * a script asking for a thousand reset emails is the only other caller.
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envInt('RATE_LIMIT_PASSWORD_RESET_MAX', 5),
  store: new MongoRateLimitStore({ prefix: 'pwreset', windowMs: 60 * 60 * 1000 }),
  keyGenerator: req => `ip:${addressKey(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' }
});

/** Chat. Per visitor address within a tenant, since visitors are anonymous. */
const chatLimiter = buildLimiter({
  prefix: 'chat',
  windowMs: 60 * 1000,
  limit: req => planLimit(req, envInt('RATE_LIMIT_CHAT_MAX', 20)),
  message: 'Too many messages sent, please slow down.'
});

/**
 * The public read API, limited per key rather than per tenant.
 *
 * A key is a program, and one program looping is not a reason to throttle the
 * tenant's own dashboard. The allowance still comes from their plan.
 */
const publicApiLimiter = buildLimiter({
  prefix: 'papi',
  windowMs: 60 * 1000,
  limit: async req => {
    if (!req.apiCompanyId) {
      return envInt('RATE_LIMIT_API_MAX', 100);
    }
    try {
      const subscription = await usageService.getSubscription(req.apiCompanyId);
      const limit = subscription.limitFor('apiRequestsPerMinute');
      return limit === null ? Number.MAX_SAFE_INTEGER : limit;
    } catch {
      return envInt('RATE_LIMIT_API_MAX', 100);
    }
  },
  keyGenerator: req => (req.apiKey ? `key:${req.apiKey._id}` : `ip:${addressKey(req)}`),
  message: 'Too many API requests. Please slow down.'
});

module.exports = {
  apiLimiter,
  authLimiter,
  loginAddressLimiter,
  passwordResetLimiter,
  chatLimiter,
  publicApiLimiter,
  // Exported for tests and for anything that needs to reason about the key.
  tenantKey,
  addressKey,
  buildLimiter
};
