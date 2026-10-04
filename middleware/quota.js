/**
 * Plan enforcement for HTTP routes.
 *
 * Kept as middleware rather than checks scattered through handlers so that a
 * new route cannot quietly escape enforcement, and so the refusal shape is
 * identical everywhere (a 402 with the meter, the limit and the current plan,
 * which is what a UI needs to show a useful upgrade prompt).
 */

const usageService = require('../services/usage');
const { logger } = require('../services/logging');

/**
 * The tenant a request belongs to.
 *
 * `req.user.company` is a populated document on most routes, but some attach
 * the bare id (an API key's company, a lean lookup), and a middleware that
 * only understood one of them would silently skip enforcement on the other:
 * `undefined.id` is not an error, it is "no company", and no company means
 * no limit.
 */
function companyIdOf(user) {
  const company = user && user.company;

  if (!company) {
    return null;
  }
  if (typeof company === 'string') {
    return company;
  }
  if (company.id) {
    return String(company.id);
  }
  if (company._id) {
    return String(company._id);
  }
  // An ObjectId, which has neither `.id` nor `._id` but stringifies to its hex.
  return String(company);
}

/**
 * Whether a company may perform `requested` more of `meter`, as a plain
 * answer with no response attached.
 *
 * For code that is not an Express handler - a socket event, a scheduled job,
 * a route that has to check before it knows what to refuse with - and for
 * handlers that want to check more than one meter before doing anything.
 * Fails open like the middleware, and for the same reason: enforcement must
 * not be a new way for the product to break.
 *
 * @returns {Promise<{allowed: boolean, reason?: string, limit: number|null,
 *                    used: number, remaining: number|null, planId: string}>}
 */
async function checkLimit(companyId, meter, requested = 1) {
  try {
    return await usageService.check(companyId, meter, requested);
  } catch (error) {
    logger.error('Quota check failed; allowing the action', { meter, error: error.message });
    return { allowed: true, limit: null, used: 0, remaining: null, planId: 'unknown', degraded: true };
  }
}

/**
 * Refuse the request when a meter is at its limit.
 *
 * @param {string} meter key from config/plans METERS
 * @param {object} [options]
 * @param {boolean} [options.superadminBypass=true] superadmins manage the
 *   platform and are not subject to a tenant's plan.
 */
function enforceLimit(meter, options = {}) {
  const { superadminBypass = true } = options;

  return async function quotaMiddleware(req, res, next) {
    try {
      if (superadminBypass && req.user && req.user.role === 'superadmin') {
        return next();
      }

      const companyId = companyIdOf(req.user);
      const result = await usageService.check(companyId, meter);

      if (!result.allowed) {
        await usageService.recordLimitHit(companyId);

        // 402 Payment Required is the honest status here: the request is
        // well-formed and authorised, but the plan does not cover it.
        return res.status(402).json({
          error: result.reason,
          code: 'PLAN_LIMIT_REACHED',
          meter,
          limit: result.limit,
          used: result.used,
          planId: result.planId
        });
      }

      // Handlers can surface "3 left this month" without re-querying.
      req.quota = result;
      next();
    } catch (error) {
      // Enforcement must not become a new way for the product to break. Log
      // and allow: over-serving a tenant is preferable to a 500.
      logger.error('Quota check failed; allowing the request', { meter, error: error.message });
      next();
    }
  };
}

/**
 * Refuse the request when the plan does not include a feature.
 */
function requireFeature(feature) {
  return async function featureMiddleware(req, res, next) {
    try {
      if (req.user && req.user.role === 'superadmin') {
        return next();
      }

      const companyId = companyIdOf(req.user);

      if (await usageService.hasFeature(companyId, feature)) {
        return next();
      }

      await usageService.recordLimitHit(companyId);

      return res.status(402).json({
        error: `Your plan does not include ${feature.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}.`,
        code: 'FEATURE_NOT_IN_PLAN',
        feature
      });
    } catch (error) {
      logger.error('Feature check failed; allowing the request', { feature, error: error.message });
      next();
    }
  };
}

module.exports = { enforceLimit, requireFeature, checkLimit, companyIdOf };
