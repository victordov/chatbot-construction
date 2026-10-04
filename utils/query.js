/**
 * Shared query helpers for multi-tenant scoping and safe user input handling.
 */

const mongoose = require('mongoose');

/**
 * Escape a user-supplied string so it can be embedded in a RegExp literally.
 * Without this, a search term like `.*` scans everything and `(a+)+$` opens a
 * ReDoS vector against the database.
 */
function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive "contains" regex from untrusted input.
 */
function containsRegex(input) {
  return { $regex: escapeRegex(input), $options: 'i' };
}

/**
 * Returns the company filter that restricts a query to the caller's tenant.
 * Superadmins are unrestricted and get an empty filter.
 *
 * @param {object} user req.user as populated by the auth middleware
 * @returns {object} a partial mongo filter, e.g. `{ company: <id> }` or `{}`
 */
function companyFilter(user) {
  if (!user || user.role === 'superadmin') {
    return {};
  }
  // A non-superadmin without a company must not see anything. Matching an
  // impossible value is safer than silently returning every document.
  if (!user.company || !user.company.id) {
    return { company: null, _id: { $exists: false } };
  }
  return { company: user.company.id };
}

/**
 * `companyFilter` for callers that hold the company id and role as separate
 * values rather than a `req.user`.
 *
 * The service layer used to write this inline as
 * `if (role !== 'superadmin' && companyId) { query.company = companyId; }`,
 * which fails *open*: a non-superadmin whose company id is missing gets no
 * filter at all and reads every tenant's documents. Same job, same rule, one
 * implementation - and the rule is that an unknown tenant sees nothing.
 */
function companyScope(companyId, role) {
  if (role === 'superadmin') {
    return {};
  }
  if (!companyId) {
    return { company: null, _id: { $exists: false } };
  }
  return { company: companyId };
}

/**
 * Same as `companyFilter` but returns ObjectId values, for aggregation
 * pipelines where mongoose cannot cast strings automatically.
 */
function companyMatch(user) {
  const filter = companyFilter(user);
  if (!filter.company) {
    return filter;
  }
  return { company: toObjectId(filter.company) };
}

/**
 * Cast to ObjectId, tolerating values that are already ObjectIds.
 */
function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  return new mongoose.Types.ObjectId(String(value));
}

/**
 * True when the caller may act on a document belonging to `companyId`.
 */
function canAccessCompany(user, companyId) {
  if (!user) {
    return false;
  }
  if (user.role === 'superadmin') {
    return true;
  }
  if (!user.company || !user.company.id) {
    return false;
  }
  if (!companyId) {
    // Documents with no company predate multi-tenancy; only superadmins get them.
    return false;
  }
  return user.company.id.toString() === companyId.toString();
}

/**
 * Parse `page`/`limit` query params into safe skip/limit values.
 */
function parsePagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const requested = parseInt(query.limit, 10) || defaultLimit;
  const limit = Math.min(Math.max(1, requested), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = {
  escapeRegex,
  containsRegex,
  companyFilter,
  companyScope,
  companyMatch,
  canAccessCompany,
  toObjectId,
  parsePagination
};
