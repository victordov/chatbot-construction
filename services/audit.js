/**
 * Recording who did what.
 *
 * Called explicitly at the actions worth recording rather than bolted on as
 * middleware over every route. Middleware would guarantee coverage, but it
 * cannot say what a request meant: it would record `POST /api/admin/users/:id`
 * where what happened was "Dana changed Alice's role to company_admin", and the
 * second is the only version anyone can act on.
 *
 * Writing an entry never blocks or fails the action that caused it. A failure
 * to record is logged loudly — losing an audit entry is a real problem — but a
 * customer's conversation is not going to be broken by a logging outage.
 */

const AuditLog = require('../models/audit-log');
const { logger } = require('./logging');

/**
 * Field names that must never reach the audit log.
 *
 * The log is read by more people than the systems it describes, kept longer,
 * and exported. Putting a credential in it turns the record of a change into a
 * copy of the thing that changed.
 */
const NEVER_LOG = /^(password|passwordConfirm|token|secret|apiKey|api_key|identitySecret|inboundSecret|value|auth|authorization|cookie|hash|userHash)$/i;

/**
 * Strip anything sensitive, and anything large enough to be a message body.
 */
function sanitise(details, depth = 0) {
  if (details === null || details === undefined || depth > 4) {
    return undefined;
  }

  if (Array.isArray(details)) {
    return details.slice(0, 25).map(item => sanitise(item, depth + 1));
  }

  if (typeof details !== 'object') {
    // Truncated rather than dropped: a long value is usually still worth
    // seeing the start of, but the log is not a place for a document.
    return typeof details === 'string' && details.length > 500
      ? `${details.slice(0, 500)}…`
      : details;
  }

  if (details instanceof Date) {
    return details;
  }

  const clean = {};

  Object.entries(details).forEach(([key, value]) => {
    if (NEVER_LOG.test(key)) {
      // Recorded as having changed, without recording what to.
      clean[key] = '[redacted]';
      return;
    }
    const sanitised = sanitise(value, depth + 1);
    if (sanitised !== undefined) {
      clean[key] = sanitised;
    }
  });

  return clean;
}

/**
 * Pull the actor out of a request.
 *
 * Works with an unauthenticated request too, because failed sign-ins are among
 * the most useful things in here and there is no `req.user` on those.
 */
function actorFrom(req) {
  if (!req || !req.user) {
    return {};
  }

  return {
    id: req.user.id,
    username: req.user.username,
    displayName: req.user.displayName || req.user.username,
    role: req.user.role
  };
}

/**
 * The caller's address, through whatever proxies are in front.
 *
 * `req.ip` already honours the app's `trust proxy` setting, so it is preferred
 * over reading the header directly — which would take an attacker-supplied
 * value at face value on a deployment with no proxy.
 */
function addressFrom(req) {
  return req && (req.ip || req.connection?.remoteAddress) || undefined;
}

/**
 * Record an action.
 *
 * @param {object} entry
 * @param {string} entry.action `noun.verb`, e.g. `operator.deleted`
 * @param {object} [entry.req] the request, for actor, address and user agent
 * @param {string} [entry.company] the company affected; taken from the actor
 *        when not given
 * @returns {Promise<object|null>} the entry, or null if it could not be written
 */
async function record(entry = {}) {
  try {
    if (!entry.action) {
      return null;
    }

    const { req } = entry;
    const actor = entry.actor || actorFrom(req);

    const company = entry.company !== undefined
      ? entry.company
      : (req && req.user && req.user.company && req.user.company.id) || null;

    return await AuditLog.create({
      company: company || null,
      actor,
      action: entry.action,
      target: entry.target,
      details: sanitise(entry.details),
      outcome: entry.outcome || 'success',
      ip: entry.ip || addressFrom(req),
      // Truncated: a user agent is context, and some are absurdly long.
      userAgent: (entry.userAgent || (req && req.get && req.get('user-agent')) || '').slice(0, 300),
      at: new Date()
    });
  } catch (error) {
    // Loud, because losing an audit entry matters — but not thrown, because a
    // logging outage must not break the thing being logged.
    logger.error('Failed to write an audit entry', {
      action: entry.action,
      error: error.message
    });
    return null;
  }
}

/**
 * Read the log.
 *
 * Scoped by the query itself rather than filtered after the fetch, so a
 * guessed company id cannot reach another tenant's history. A company admin
 * never sees platform-level entries, which belong to the operator of the
 * platform rather than to any tenant.
 */
async function search(user, options = {}) {
  const filter = {};

  if (user.role !== 'superadmin') {
    if (!user.company?.id) {
      return { entries: [], total: 0 };
    }
    filter.company = user.company.id;
  } else if (options.company) {
    filter.company = options.company;
  }

  if (options.action) {
    // Prefix match, so `operator.` finds every operator event.
    filter.action = options.action.endsWith('.')
      ? new RegExp(`^${options.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      : options.action;
  }

  if (options.actorId) {
    filter['actor.id'] = options.actorId;
  }

  if (options.outcome) {
    filter.outcome = options.outcome;
  }

  if (options.since || options.until) {
    filter.at = {};
    if (options.since) {
      filter.at.$gte = new Date(options.since);
    }
    if (options.until) {
      filter.at.$lte = new Date(options.until);
    }
  }

  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const skip = Math.max(parseInt(options.skip, 10) || 0, 0);

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  return { entries, total, limit, skip };
}

/**
 * The distinct actions present, for the filter control.
 */
async function actions(user) {
  const filter = user.role === 'superadmin'
    ? {}
    : { company: user.company?.id };

  if (user.role !== 'superadmin' && !user.company?.id) {
    return [];
  }

  return AuditLog.distinct('action', filter);
}

module.exports = {
  record,
  search,
  actions,
  // Exported for tests: redaction is the part that must not regress.
  sanitise,
  NEVER_LOG
};
