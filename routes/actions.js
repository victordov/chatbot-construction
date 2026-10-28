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
const AuditLog = require('../models/audit-log');
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
 * The action a "Run once" tries.
 *
 * With `config` in the body it is the form as it stands, saved or not: an
 * admin changes the URL, presses Run once, and expects the new URL to be the
 * one called. It used to run the saved copy, so the panel tested something
 * other than what was on the screen.
 *
 * The saved credential is used only together with the saved address, the same
 * rule as the workflow editor's test: otherwise anyone who can open the form
 * could send a colleague's API key to an address of their choosing.
 *
 * @returns {Promise<{action?: object, status?: number, error?: string}>}
 */
async function actionToTry(req, companyId, id) {
  const stored = id ? await actions.loadForRun(companyId, id) : null;
  if (id && !stored) {
    return { status: 404, error: 'Action not found' };
  }

  const config = req.body && req.body.config;
  if (!config || typeof config !== 'object') {
    return stored ? { action: stored } : { status: 400, error: 'Nothing to run: fill in the form first' };
  }

  // A test does not need a name or a title yet; everything else is checked
  // exactly as a save would check it.
  const normalised = actions.normalise({
    ...config,
    name: config.name || (stored && stored.name) || 'unsaved_action',
    title: config.title || (stored && stored.title) || 'Unsaved action'
  }, stored);
  if (normalised.errors.length > 0) {
    return { status: 400, error: normalised.errors[0] };
  }

  const value = normalised.value;
  const auth = { ...value.request.auth };

  if (auth.type !== 'none') {
    if (normalised.credential) {
      // Typed into the form and not saved: used for this one call, in memory.
      auth.value = normalised.credential;
    } else {
      const storedAuth = stored && stored.request && stored.request.auth;
      const storedUrl = stored && stored.request && stored.request.url;
      if (!storedAuth || !storedAuth.value) {
        return { status: 400, error: 'Enter the secret to try it' };
      }
      if (storedUrl !== value.request.url) {
        return {
          status: 400,
          error: 'The address has changed, so the saved secret is not sent to it. Enter the secret again to try the new address.'
        };
      }
      auth.value = storedAuth.value;
    }
  }

  return {
    action: {
      ...value,
      _id: stored ? stored._id : null,
      request: { ...value.request, auth }
    }
  };
}

/**
 * Run an action once, for real, with sample inputs.
 *
 * The admin supplies a value for every input, verified ones included — this is
 * them inspecting their own API to find the right response paths, so there is
 * no visitor whose identity matters. It does send writes: the panel exists so
 * an action can be checked before the assistant is allowed to call it, and a
 * write that was never tried is the one most likely to be wrong.
 *
 * Body `{ inputs, config? }`: see actionToTry. `POST /test` (no id) tries an
 * action that has never been saved.
 */
async function runOnce(req, res) {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || (req.params.id && !validId(req, res))) {
      return;
    }

    const prepared = await actionToTry(req, companyId, req.params.id);
    if (!prepared.action) {
      return res.status(prepared.status).json({ error: prepared.error });
    }
    const action = prepared.action;

    const resolved = actions.resolveInputs(action, (req.body && req.body.inputs) || {}, { trustArgs: true });
    if (!resolved.ok) {
      return res.status(400).json({ error: resolved.error });
    }

    const result = await actions.run(action, resolved.values, {
      includeBody: true,
      maxBytes: Math.max((action.response && action.response.maxBytes) || 0, actions.DEFAULT_MAX_BYTES)
    });

    if (action._id) {
      audit.record({
        req,
        company: companyId,
        action: 'action.tested',
        target: { type: 'action', id: String(action._id), label: action.name },
        details: {
          method: action.request.method,
          httpStatus: result.status,
          ok: result.ok,
          durationMs: result.durationMs,
          unsaved: Boolean(req.body && req.body.config),
          ...(result.ok ? {} : { error: result.error })
        },
        outcome: result.ok ? 'success' : 'failure'
      });
    }

    res.json({
      status: result.status || null,
      ok: result.ok,
      method: action.request.method,
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
}

router.post('/test', runOnce);
router.post('/:id/test', runOnce);

/** How many calls the run log shows. */
const RUN_LOG_LIMIT = 20;

/** One audit entry as a line in the run log. */
function runEntry(entry) {
  const details = entry.details || {};
  const kind = entry.action === 'assistant.tool_called' ? 'assistant'
    : entry.action === 'action.run' ? 'workflow'
      : 'test';
  // The assistant records 'ok' or 'error' as its status; the test and the
  // workflow record whether it worked.
  const ok = kind === 'assistant'
    ? details.status === 'ok'
    : details.ok === true;
  const httpStatus = details.httpStatus || (kind === 'test' && typeof details.status === 'number' ? details.status : null);

  return {
    at: entry.at,
    by: kind,
    ok,
    status: kind === 'assistant' ? (details.status || null) : (ok ? 'ok' : 'error'),
    httpStatus: httpStatus || null,
    durationMs: typeof details.durationMs === 'number' ? details.durationMs : null,
    error: ok ? null : (details.error || (httpStatus ? `HTTP ${httpStatus}` : null))
  };
}

/**
 * The last calls of one action, whoever made them: the assistant, a workflow,
 * or the Run once panel. Read from the audit log, which every one of them
 * already writes, so there is no second record to keep in step.
 */
router.get('/:id/runs', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const action = await Action.findOne({ _id: req.params.id, company: companyId }).select('name').lean();
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }

    const entries = await AuditLog.find({
      company: companyId,
      $or: [
        { action: 'assistant.tool_called', 'details.tool': action.name },
        { action: { $in: ['action.run', 'action.tested'] }, 'target.id': String(action._id) }
      ]
    }).sort({ at: -1 }).limit(RUN_LOG_LIMIT).lean();

    const runs = entries.map(runEntry);
    const lastFailure = runs.find(run => !run.ok) || null;

    res.json({
      runs,
      lastError: lastFailure ? { at: lastFailure.at, error: lastFailure.error || 'Failed', by: lastFailure.by } : null
    });
  } catch (error) {
    logger.error('Failed to load action runs', { error: error.message });
    res.status(500).json({ error: 'Failed to load the run log' });
  }
});

module.exports = router;
