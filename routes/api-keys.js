/**
 * Managing the keys that reach the public read API.
 *
 * A company's own admins, for their own company. A superadmin creating keys
 * into a tenant's data on their behalf is a support action that should leave
 * a very visible trace, so it is not offered here at all.
 */

const express = require('express');
const apiKeyService = require('../services/api-keys');
const usageService = require('../services/usage');
const audit = require('../services/audit');
const { auth } = require('../middleware/auth');
const { logger } = require('../services/logging');

const router = express.Router();

router.use(auth);

function requireOwnCompanyAdmin(req, res, next) {
  if (req.user.role !== 'company_admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  if (!req.user.company) {
    return res.status(400).json({ error: 'Your account is not linked to a company' });
  }
  next();
}

router.get('/', requireOwnCompanyAdmin, async (req, res) => {
  try {
    res.json({
      keys: await apiKeyService.list(req.user.company.id),
      scopes: apiKeyService.VALID_SCOPES,
      enabled: await usageService.hasFeature(req.user.company.id, 'apiAccess')
    });
  } catch (error) {
    logger.error('Failed to list API keys', { error: error.message });
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.post('/', requireOwnCompanyAdmin, async (req, res) => {
  try {
    if (!(await usageService.hasFeature(req.user.company.id, 'apiAccess'))) {
      return res.status(402).json({
        error: 'API access is not included in your plan.',
        code: 'FEATURE_NOT_IN_PLAN',
        feature: 'apiAccess'
      });
    }

    const { name, scopes } = req.body;
    let { expiresAt } = req.body;

    // Optional, and in the future: a key that expired before it was made is a
    // typo, and one that silently never expires is what the field exists to avoid.
    if (expiresAt === '' || expiresAt === null) {
      expiresAt = undefined;
    }
    if (expiresAt !== undefined) {
      const when = new Date(expiresAt);
      if (Number.isNaN(when.getTime()) || when <= new Date()) {
        return res.status(400).json({ error: 'The expiry date must be in the future' });
      }
      if (when > new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000)) {
        return res.status(400).json({ error: 'Choose an expiry within five years, or none' });
      }
      expiresAt = when;
    }

    const unknown = (Array.isArray(scopes) ? scopes : [])
      .filter(scope => !apiKeyService.VALID_SCOPES.includes(scope));

    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. `
          + `Valid scopes: ${apiKeyService.VALID_SCOPES.join(', ')}`
      });
    }

    const { record, key } = await apiKeyService.create({
      companyId: req.user.company.id,
      name,
      scopes,
      createdBy: req.user.displayName || req.user.username,
      expiresAt
    });

    await audit.record({
      action: 'api_key.created',
      req,
      target: { type: 'api_key', id: String(record._id), label: record.name },
      details: { prefix: record.prefix, scopes: record.scopes, expiresAt: record.expiresAt }
    });

    res.status(201).json({
      // The one and only time this exists outside the caller's hands. Said in
      // the response rather than only in the UI, because whoever is reading
      // this from a script needs to know there is no second chance.
      key,
      warning: 'Copy this key now. It is stored only as a hash and cannot be shown again.',
      apiKey: record.toPublic()
    });
  } catch (error) {
    if (/at least one scope/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Failed to create an API key', { error: error.message });
    res.status(500).json({ error: 'Failed to create the API key' });
  }
});

router.delete('/:id', requireOwnCompanyAdmin, async (req, res) => {
  try {
    const key = await apiKeyService.revoke(
      req.user.company.id,
      req.params.id,
      req.user.displayName || req.user.username
    );

    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await audit.record({
      action: 'api_key.revoked',
      req,
      target: { type: 'api_key', id: String(key._id), label: key.name },
      details: { prefix: key.prefix }
    });

    res.json({ success: true, apiKey: key.toPublic() });
  } catch (error) {
    logger.error('Failed to revoke an API key', { error: error.message });
    res.status(500).json({ error: 'Failed to revoke the API key' });
  }
});

module.exports = router;
