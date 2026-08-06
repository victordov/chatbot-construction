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

      const companyId = req.user && req.user.company ? req.user.company.id : null;
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

      const companyId = req.user && req.user.company ? req.user.company.id : null;

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

module.exports = { enforceLimit, requireFeature };
