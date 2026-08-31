/**
 * Authentication for the public read API.
 *
 * Separate from `middleware/auth.js` on purpose. That one authenticates a
 * person with a session-length token and a role; this authenticates a program
 * with a long-lived key and a set of scopes, and the two must not be
 * interchangeable - an API key that could be presented to the dashboard would
 * be a permanent password with no way to sign it out.
 */

const apiKeyService = require('../services/api-keys');
const usageService = require('../services/usage');
const { logger } = require('../services/logging');

/**
 * Require a valid key, and put the tenant it belongs to on the request.
 */
async function apiKeyAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : req.headers['x-api-key'];

    if (!presented) {
      return res.status(401).json({
        error: 'Provide an API key as "Authorization: Bearer ck_...".',
        code: 'API_KEY_MISSING'
      });
    }

    const record = await apiKeyService.resolve(presented);

    if (!record) {
      // Unknown, revoked and expired are one answer: distinguishing them tells
      // somebody holding a stolen key which one they are holding.
      return res.status(401).json({ error: 'Invalid API key', code: 'API_KEY_INVALID' });
    }

    // The plan gate is checked per request rather than at creation, so a
    // downgrade takes effect rather than leaving keys minted under a better
    // plan working forever.
    if (!(await usageService.hasFeature(record.company, 'apiAccess'))) {
      return res.status(402).json({
        error: 'API access is not included in your plan.',
        code: 'FEATURE_NOT_IN_PLAN',
        feature: 'apiAccess'
      });
    }

    apiKeyService.touch(record);

    req.apiKey = record;
    req.apiCompanyId = String(record.company);
    next();
  } catch (error) {
    logger.error('API key authentication failed', { error: error.message });
    res.status(500).json({ error: 'Could not verify the API key' });
  }
}

/**
 * Require one scope. A key that reads conversations has no business reading
 * contacts, and saying so per route is what makes that true rather than
 * aspirational.
 */
function requireScope(scope) {
  return function scopeMiddleware(req, res, next) {
    if (!req.apiKey || !req.apiKey.scopes.includes(scope)) {
      return res.status(403).json({
        error: `This key does not have the "${scope}" scope.`,
        code: 'SCOPE_MISSING',
        required: scope
      });
    }
    next();
  };
}

module.exports = { apiKeyAuth, requireScope };
