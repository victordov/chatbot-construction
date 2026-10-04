/**
 * Managing saved Actions.
 *
 * Admin-only and tenant-scoped by the query itself, like webhooks. A superadmin
 * names the company (`companyId` in the query or body), because an action is a
 * call into one tenant's systems with that tenant's credential — there is no
 * such thing as a platform-wide one.
 *
 * The credential goes in and never comes out: responses carry
 * `request.auth.hasCredential` instead.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Action = require('../models/action');
const actions = require('../services/actions');
const audit = require('../services/audit');
const { auth, admin } = require('../middleware/auth');
const { enforceLimit, requireFeature } = require('../middleware/quota');
const { logger } = require('../services/logging');

router.use(auth, admin, requireFeature('actions'));

function companyFor(req) {
  if (req.user.role === 'superadmin') {
    return req.query.companyId || (req.body && req.body.companyId) || null;
  }
  return req.user.company ? req.user.company.id : null;
}

function requireCompany(req, res) {
  const companyId = companyFor(req);

  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    res.status(400).json({
      error: req.user.role === 'superadmin'
        ? 'Name a company: an action belongs to a tenant, not to the platform'
        : 'Your account is not attached to a company'
    });
    return null;
  }

  return companyId;
}

function validId(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Action not found' });
    return false;
  }
  return true;
}

/** The templates, before `/:id` so "presets" is not read as an id. */
router.get('/presets', (req, res) => {
  res.json({ presets: actions.PRESETS });
});

router.get('/', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    // The credential is `select: false`, so it never leaves the database for
    // a listing. Whether one is set is computed there instead.
    const list = await Action.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(String(companyId)) } },
      { $sort: { createdAt: -1 } },
      {
        $addFields: {
          hasCredential: { $gt: [{ $strLenCP: { $ifNull: ['$request.auth.value', ''] } }, 0] }
        }
      },
      { $project: { 'request.auth.value': 0 } }
    ]);

    res.json({ actions: list.map(actions.present) });
  } catch (error) {
    logger.error('Failed to list actions', { error: error.message });
    res.status(500).json({ error: 'Failed to load the actions' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }
    const action = await Action.findOne({ _id: req.params.id, company: companyId })
      .select('+request.auth.value').lean();
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }
    res.json({ action: actions.present(action) });
  } catch (error) {
    logger.error('Failed to load action', { error: error.message });
    res.status(500).json({ error: 'Failed to load the action' });
  }
});

router.post('/', enforceLimit('actions'), async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const normalised = actions.normalise(req.body);
    if (normalised.errors.length > 0) {
      return res.status(400).json({ error: normalised.errors[0], errors: normalised.errors });
    }

    const exists = await Action.exists({ company: companyId, name: normalised.value.name });
    if (exists) {
      return res.status(409).json({ error: `An action named "${normalised.value.name}" already exists` });
    }

    const doc = new Action({ company: companyId, createdBy: req.user.id });
    actions.apply(doc, normalised);
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'action.created',
      target: { type: 'action', id: String(doc._id), label: doc.name },
      details: { method: doc.request.method, mode: doc.mode, requiresVerified: doc.requiresVerified }
    });

    res.status(201).json({ action: actions.present(doc) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'An action with that name already exists' });
    }
    logger.error('Failed to create action', { error: error.message });
    res.status(500).json({ error: error.message.startsWith('Cannot store a secret') ? error.message : 'Failed to create the action' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await Action.findOne({ _id: req.params.id, company: companyId })
      .select('+request.auth.value');
    if (!doc) {
      return res.status(404).json({ error: 'Action not found' });
    }

    const normalised = actions.normalise(req.body, doc);
    if (normalised.errors.length > 0) {
      return res.status(400).json({ error: normalised.errors[0], errors: normalised.errors });
    }

    if (normalised.value.name !== doc.name) {
      const clash = await Action.exists({ company: companyId, name: normalised.value.name, _id: { $ne: doc._id } });
      if (clash) {
        return res.status(409).json({ error: `An action named "${normalised.value.name}" already exists` });
      }
    }

    const credentialChanged = normalised.credential !== undefined;
    actions.apply(doc, normalised);
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'action.updated',
      target: { type: 'action', id: String(doc._id), label: doc.name },
      details: {
        method: doc.request.method,
        mode: doc.mode,
        enabled: doc.enabled,
        requiresVerified: doc.requiresVerified,
        credentialChanged
      }
    });

    res.json({ action: actions.present(doc) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'An action with that name already exists' });
    }
    logger.error('Failed to update action', { error: error.message });
    res.status(500).json({ error: 'Failed to update the action' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await Action.findOneAndDelete({ _id: req.params.id, company: companyId });
    if (!doc) {
      return res.status(404).json({ error: 'Action not found' });
    }

    audit.record({
      req,
      company: companyId,
      action: 'action.deleted',
      target: { type: 'action', id: String(doc._id), label: doc.name }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete action', { error: error.message });
    res.status(500).json({ error: 'Failed to delete the action' });
  }
});

/**
 * Run an action once, for real, with sample inputs.
 *
 * The admin supplies a value for every input, verified ones included — this is
 * them inspecting their own API to find the right response paths, so there is
 * no visitor whose identity matters. It does send writes: the panel exists so
 * an action can be checked before the assistant is allowed to call it, and a
 * write that was never tried is the one most likely to be wrong.
 */
router.post('/:id/test', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const action = await actions.loadForRun(companyId, req.params.id);
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }

    const resolved = actions.resolveInputs(action, (req.body && req.body.inputs) || {}, { trustArgs: true });
    if (!resolved.ok) {
      return res.status(400).json({ error: resolved.error });
    }

    const result = await actions.run(action, resolved.values, {
      includeBody: true,
      maxBytes: Math.max((action.response && action.response.maxBytes) || 0, actions.DEFAULT_MAX_BYTES)
    });

    audit.record({
      req,
      company: companyId,
      action: 'action.tested',
      target: { type: 'action', id: String(action._id), label: action.name },
      details: { status: result.status, ok: result.ok },
      outcome: result.ok ? 'success' : 'failure'
    });

    res.json({
      status: result.status || null,
      ok: result.ok,
      body: result.body !== undefined ? result.body : null,
      truncated: Boolean(result.truncated),
      extracted: result.extracted,
      error: result.ok ? undefined : result.error,
      durationMs: result.durationMs
    });
  } catch (error) {
    logger.error('Failed to test action', { error: error.message });
    res.status(500).json({ error: 'Failed to run the action' });
  }
});

module.exports = router;
