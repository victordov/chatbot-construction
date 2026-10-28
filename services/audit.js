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

const mongoose = require('mongoose');
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
  const filter = filterFor(user, options);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const skip = Math.max(parseInt(options.skip, 10) || 0, 0);

  if (!filter) {
    return { entries: [], total: 0, limit, skip };
  }

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  return { entries, total, limit, skip };
}

/**
 * The query for one caller and one set of filters, or null when nothing can
 * match - a company admin without a company, an actor id that is not an id.
 */
function filterFor(user, options = {}) {
  const filter = {};

  if (user.role !== 'superadmin') {
    if (!user.company?.id) {
      return null;
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
    // An id that cannot be one matches nobody, rather than throwing a cast
    // error that would turn a bad filter into a 500.
    if (!mongoose.isValidObjectId(String(options.actorId))) {
      return null;
    }
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

  return filter;
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

/**
 * The people who appear in the log as the one acting, for the "who" filter.
 * Named as the entries name them, so somebody since renamed or removed is
 * still findable under the name they acted with.
 */
async function actors(user) {
  if (user.role !== 'superadmin' && !user.company?.id) {
    return [];
  }

  const match = { 'actor.id': { $exists: true, $ne: null } };
  if (user.role !== 'superadmin') {
    match.company = new mongoose.Types.ObjectId(String(user.company.id));
  }

  const rows = await AuditLog.aggregate([
    { $match: match },
    { $sort: { at: -1 } },
    {
      $group: {
        _id: '$actor.id',
        displayName: { $first: '$actor.displayName' },
        username: { $first: '$actor.username' },
        role: { $first: '$actor.role' },
        entries: { $sum: 1 }
      }
    },
    { $sort: { displayName: 1, username: 1 } },
    { $limit: 500 }
  ]);

  return rows.map(row => ({
    id: String(row._id),
    name: row.displayName || row.username || 'Unknown',
    role: row.role,
    entries: row.entries
  }));
}

/**
 * What each action means, in words somebody who was not there can read.
 *
 * One list for the screen and the export, so the two cannot describe the
 * same entry differently. Anything not listed is described from its name
 * ("webhook.secret_rotated" reads "Webhook: secret rotated"), so an action
 * added later still reads as words rather than as a code.
 */
const DESCRIPTIONS = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.logout_everywhere': 'Signed out on every device',
  'auth.password_change': 'Changed their password',
  'auth.password_reset': 'Reset their password from an emailed link',
  'auth.password_reset_requested': 'Asked for a password reset link',
  'user.created': 'Created an account',
  'user.email_verified': 'Confirmed their email address',
  'user.invite_accepted': 'Accepted an invitation and joined',
  'superadmin.created': 'Created a platform superadmin',
  'operator.created': 'Added a teammate with a password',
  'operator.invited': 'Invited a teammate',
  'operator.invite_resent': 'Sent an invitation again',
  'operator.invite_revoked': 'Withdrew an invitation',
  'operator.activated': 'Reactivated an account',
  'operator.deactivated': 'Deactivated an account',
  'operator.updated': 'Edited an account',
  'operator.role_changed': 'Changed a role',
  'operator.deleted': 'Removed a teammate',
  'operator.password_reset': 'Set a new password for someone',
  'company.signed_up': 'Signed up for a trial',
  'company.created': 'Created a company',
  'company.updated': 'Edited a company',
  'company.activated': 'Reactivated a company',
  'company.deactivated': 'Deactivated a company',
  'company.deleted': 'Deleted a company',
  'company.retention_changed': 'Changed how long conversations are kept',
  'company.hours_changed': 'Changed the business hours',
  'company.routing_changed': 'Changed how conversations are assigned',
  'company.user_password_reset': 'Set a new password for someone',
  'reports.settings_changed': 'Changed how the value report counts time',
  'conversation.deleted': 'Deleted a conversation',
  'plan.changed': 'Changed the plan',
  'billing.checkout_started': 'Started paying for a plan',
  'identity_secret.rotated': 'Rotated the identity secret',
  'connector.updated': 'Changed the connection to your systems',
  'workflow.published': 'Published a workflow',
  'workflow.unpublished': 'Took a workflow off the air',
  'workflow.rolled_back': 'Rolled a workflow back',
  'workflow.deleted': 'Deleted a workflow',
  'workflow.duplicated': 'Duplicated a workflow',
  'workflow.trigger_changed': 'Changed when a workflow runs',
  'bot.taught': 'Taught the bot a better answer',
  'bot.gap_dismissed': 'Dismissed an unanswered question',
  'knowledge.imported': 'Added knowledge',
  'knowledge.updated': 'Edited knowledge',
  'knowledge.refreshed': 'Refreshed a knowledge source',
  'knowledge.deleted': 'Removed knowledge',
  'assistant.updated': 'Changed the bot\'s persona or scope',
  'template.created': 'Created a canned reply',
  'template.updated': 'Edited a canned reply',
  'template.deleted': 'Deleted a canned reply',
  'action.created': 'Created an action',
  'action.updated': 'Edited an action',
  'action.deleted': 'Deleted an action',
  'action.tested': 'Tested an action',
  'action.run': 'Ran an action',
  'assistant.tool_called': 'The assistant used one of your actions',
  'webhook.created': 'Added a webhook endpoint',
  'webhook.updated': 'Edited a webhook endpoint',
  'webhook.deleted': 'Deleted a webhook endpoint',
  'webhook.secret_rotated': 'Made a new webhook signing secret',
  'webhook.redelivered': 'Sent a webhook delivery again',
  'api_key.created': 'Created an API key',
  'api_key.revoked': 'Revoked an API key',
  'tenant_backup.created': 'Backed up a company',
  'tenant_backup.restored': 'Restored a company from a backup',
  'gdpr.data_read': 'Read a person\'s data',
  'gdpr.exported': 'Exported a person\'s data',
  'gdpr.erased': 'Erased a person\'s data'
};

function describe(action) {
  if (DESCRIPTIONS[action]) {
    return DESCRIPTIONS[action];
  }

  const words = text => String(text || '').replace(/[_-]+/g, ' ').trim();
  const [noun, ...rest] = String(action || '').split('.');
  const subject = words(noun);
  const verb = words(rest.join(' '));
  const capitalised = subject ? subject.charAt(0).toUpperCase() + subject.slice(1) : '';

  if (!capitalised) {
    return 'Unknown action';
  }
  return verb ? `${capitalised}: ${verb}` : capitalised;
}

/** Descriptions for a list of actions, as `{ action: words }`. */
function descriptionsFor(list) {
  return Object.fromEntries((list || []).map(action => [action, describe(action)]));
}

/** The most rows one export carries. */
const EXPORT_LIMIT = 5000;

/**
 * One CSV cell. A leading =, +, - or @ is a formula to a spreadsheet, and an
 * audit export is opened in one with values strangers typed (a username that
 * failed to sign in), so those are prefixed to stay text.
 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The filtered log as CSV, newest first, capped at EXPORT_LIMIT rows.
 */
async function exportCsv(user, options = {}) {
  const filter = filterFor(user, options);
  const entries = filter
    ? await AuditLog.find(filter).sort({ at: -1 }).limit(EXPORT_LIMIT).lean()
    : [];

  const header = ['When (UTC)', 'Who', 'Role', 'What', 'Action', 'Outcome', 'Target', 'Details', 'IP address'];
  const rows = entries.map(entry => [
    new Date(entry.at).toISOString(),
    entry.actor ? (entry.actor.displayName || entry.actor.username || 'System') : 'System',
    entry.actor ? entry.actor.role : '',
    describe(entry.action),
    entry.action,
    entry.outcome,
    entry.target ? (entry.target.label || entry.target.id || '') : '',
    entry.details ? JSON.stringify(entry.details) : '',
    entry.ip || ''
  ].map(csvCell).join(','));

  return [header.map(csvCell).join(','), ...rows].join('\r\n');
}

module.exports = {
  record,
  search,
  actions,
  actors,
  describe,
  descriptionsFor,
  exportCsv,
  filterFor,
  DESCRIPTIONS,
  // Exported for tests: redaction is the part that must not regress.
  sanitise,
  NEVER_LOG
};
