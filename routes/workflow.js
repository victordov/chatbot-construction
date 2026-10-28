/**
 * Workflow API routes for visual workflow editor
 */

const express = require('express');
const router = express.Router();
const WorkflowService = require('../services/workflow');
const { redactWorkflow } = require('../services/workflow');
const workflowActions = require('../services/workflow-actions');
const workflowTemplates = require('../config/workflow-templates');
const audit = require('../services/audit');
const { auth: authMiddleware } = require('../middleware/auth');
const { logger } = require('../services/logging');
const socketManager = require('../socketManager');
const runtimeRegistry = require('../services/runtime-registry');
const { requireFeature } = require('../middleware/quota');

/**
 * Variables a caller may not assert.
 *
 * `contact_verified` is what a flow gates account details on, and it is true
 * only when the tenant's own backend signed the visitor's identity. A preview
 * or an execute call that could set it would let whoever holds an admin token
 * read any account through the flow.
 */
const RESERVED_VARIABLES = new Set([
  'contact_verified', 'contact_external_id', 'contact_name', 'contact_email'
]);

function stripReservedVariables(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(variables).filter(([key]) => !RESERVED_VARIABLES.has(key))
  );
}

/**
 * The tenant a workflow belongs to, as the string the runtime keys on.
 *
 * `getWorkflow` populates `company`, so `workflow.company` is a document,
 * and `String(document)` is not its id. The publish route used to hot-swap
 * under that key, so the workflow serving traffic (keyed by the id string)
 * never changed and the persona cache was invalidated for nobody.
 */
function tenantIdOf(workflow) {
  const company = workflow && workflow.company;
  if (!company) {
    return null;
  }
  return String(company._id || company);
}

/**
 * Drop the tenant's live workflow from every process's view of it.
 *
 * The runtime's own copy is unloaded here; other instances notice on their
 * next lookup, because the runtime re-checks the database every
 * WORKFLOW_CACHE_TTL_MS.
 */
function forgetLiveWorkflow(tenantId) {
  if (!tenantId) {
    return;
  }
  require('../services/assistant-config').invalidate(tenantId);
  try {
    runtimeRegistry.getRuntimeService().unloadWorkflow(tenantId);
  } catch (error) {
    logger.warn('Could not unload the runtime workflow', { tenantId, error: error.message });
  }
}

/**
 * A workflow as the editor and the list see it: credentials redacted, plus
 * what can only be worked out from several fields - whether visitors are
 * getting the version on the canvas, and the trigger in effect.
 */
function present(workflow) {
  const Workflow = require('../models/workflow');
  const plain = redactWorkflow(workflow);
  if (!plain) {
    return plain;
  }
  return {
    ...plain,
    trigger: Workflow.normaliseTrigger(plain.trigger),
    liveTrigger: plain.status === 'published' ? Workflow.liveTriggerOf(plain) : null,
    // A workflow published before drafts existed has no liveVersion: what
    // it serves is its own version.
    liveVersion: plain.status === 'published' ? (plain.liveVersion || plain.version) : null,
    hasUnpublishedChanges: Workflow.hasUnpublishedChanges(plain)
  };
}

/** The tenant a request is about, as the runtime and the quota key it. */
function requestCompanyId(req) {
  return req.user.company?.id ? String(req.user.company.id) : null;
}

/** Answer a service error with the status it carries (404 / 400 otherwise). */
function sendError(res, error, fallback) {
  const status = error.status ||
    (error.message === 'Workflow not found' || /not found/i.test(error.message || '') ? 404 : 400);

  res.status(status).json({
    success: false,
    error: error.message || fallback,
    ...(error.code ? { code: error.code } : {}),
    ...(error.conflict ? { conflict: error.conflict } : {}),
    ...(error.problems ? { problems: error.problems } : {}),
    ...(error.errors ? { errors: error.errors } : {}),
    ...(error.meter ? { meter: error.meter, limit: error.limit, used: error.used } : {})
  });
}

/**
 * A runtime-only refresh: written runs reach the database at most every half
 * minute, which is too slow for somebody who has just tried their flow and
 * opened the list.
 */
async function flushRunCounts() {
  try {
    await runtimeRegistry.getRuntimeService().flushStats();
  } catch (error) {
    logger.warn('Could not write pending workflow stats', { error: error.message });
  }
}

/**
 * Workflow management is an admin capability.
 *
 * This previously allowed `superadmin` or a role named `admin` - but the User
 * schema only defines superadmin/company_admin/operator, so every company
 * admin got a 403 and the workflow editor was unreachable for the people it
 * was built for.
 */
const checkWorkflowAccess = (req, res, next) => {
  if (req.user.role === 'superadmin' || req.user.role === 'company_admin') {
    return next();
  }
  return res.status(403).json({
    success: false,
    error: 'Insufficient permissions for workflow management'
  });
};

// Get all workflows
router.get('/', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const { status } = req.query;
    await flushRunCounts();

    const workflows = await WorkflowService.getWorkflows(
      req.user.company?.id,
      req.user.role,
      status
    );

    // "1 of 1 live workflows": what the plan allows, said where somebody is
    // about to publish rather than discovered as a refusal.
    const companyId = requestCompanyId(req);
    const usage = companyId ? await WorkflowService.liveUsage(companyId) : null;

    res.json({
      success: true,
      workflows: workflows.map(present),
      count: workflows.length,
      liveUsage: usage ? { used: usage.used, limit: usage.limit } : null
    });
  } catch (error) {
    logger.error('Error fetching workflows:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch workflows'
    });
  }
});

/**
 * The workflows a tenant can start from.
 *
 * A blank canvas is the worst thing to hand somebody who has just been told
 * they can automate their support; these are the flows they were going to build
 * anyway, already wired.
 */
router.get('/templates', authMiddleware, checkWorkflowAccess, (req, res) => {
  res.json({ success: true, templates: workflowTemplates.summaries() });
});

router.get('/templates/:id', authMiddleware, checkWorkflowAccess, (req, res) => {
  const template = workflowTemplates.byId(req.params.id);

  if (!template) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }

  res.json({ success: true, template });
});

// Get specific workflow
router.get('/:id', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.getWorkflow(
      req.params.id,
      req.user.company?.id,
      req.user.role
    );

    res.json({
      success: true,
      workflow: present(workflow)
    });
  } catch (error) {
    logger.error('Error fetching workflow:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch workflow'
    });
  }
});

/**
 * Create a new workflow.
 *
 * Drafts are not limited by the plan: a draft answers nobody. The limit is on
 * how many are live, and is checked when one is published.
 */
router.post('/', authMiddleware, checkWorkflowAccess, requireFeature('workflows'), async (req, res) => {
  try {
    const { name, description, nodes = [], edges = [], trigger } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Workflow name is required'
      });
    }

    const workflowData = {
      name: name.trim(),
      description: description?.trim(),
      nodes,
      edges,
      trigger
    };

    const workflow = await WorkflowService.createWorkflow(workflowData, req.user);
    const report = WorkflowService.report(workflow.nodes, workflow.edges, workflow.trigger);

    res.status(201).json({
      success: true,
      workflow: present(workflow),
      message: 'Workflow created successfully',
      // A half-built draft saves; what it still needs comes back as warnings
      // for the Problems panel rather than as a refusal.
      ready: report.valid,
      warnings: [...report.errors, ...report.warnings],
      problems: report.problems
    });
  } catch (error) {
    logger.error('Error creating workflow:', error);
    sendError(res, error, 'Failed to create workflow');
  }
});

// A copy of a workflow, as a new draft.
router.post('/:id/duplicate', authMiddleware, checkWorkflowAccess, requireFeature('workflows'), async (req, res) => {
  try {
    const workflow = await WorkflowService.duplicateWorkflow(req.params.id, req.user);

    audit.record({
      req,
      action: 'workflow.duplicated',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
      details: { from: req.params.id }
    });

    res.status(201).json({ success: true, workflow: present(workflow) });
  } catch (error) {
    logger.error('Error duplicating workflow:', error);
    sendError(res, error, 'Failed to duplicate workflow');
  }
});

/**
 * Save changes.
 *
 * A save never changes what visitors get: on a live workflow it makes a draft
 * version, and Publish makes it live. The runtime is therefore left alone.
 */
router.put('/:id', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const updateData = { ...req.body };

    // Trim string fields
    if (updateData.name) {
      updateData.name = updateData.name.trim();
    }
    if (updateData.description) {
      updateData.description = updateData.description.trim();
    }

    const workflow = await WorkflowService.updateWorkflow(
      req.params.id,
      updateData,
      req.user
    );

    if (workflow.$locals.triggerChanged) {
      audit.record({
        req,
        action: 'workflow.trigger_changed',
        company: workflow.company,
        target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
        details: { trigger: workflow.trigger ? workflow.trigger.type : 'always' }
      });
    }

    const report = WorkflowService.report(workflow.nodes, workflow.edges, workflow.trigger);

    res.json({
      success: true,
      workflow: present(workflow),
      message: workflow.status === 'published'
        ? 'Saved as a draft. Visitors keep getting the live version until you publish.'
        : 'Workflow updated successfully',
      ready: report.valid,
      warnings: [...report.errors, ...report.warnings],
      problems: report.problems
    });
  } catch (error) {
    logger.error('Error updating workflow:', error);
    sendError(res, error, 'Failed to update workflow');
  }
});

/**
 * Make the current version live.
 *
 * Body `{ replace: true }` takes the tenant's other "answers everything"
 * workflow offline; without it, publishing a second one is a 409 naming the
 * first, so the editor can ask.
 */
router.post('/:id/publish', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.publishWorkflow(req.params.id, req.user, {
      replace: req.body && req.body.replace === true
    });
    const replaced = workflow.$locals.replaced;

    // Hot-swap into the runtime that is actually serving traffic. This used to
    // construct a fresh WorkflowRuntimeService, so the swap landed in a
    // throwaway object and live conversations kept the old workflow.
    const tenantId = tenantIdOf(workflow) || String(req.user.id);
    let hotSwapCompleted = false;

    // The live "answers everything" workflow's Persona step is what the
    // assistant uses, so a publish must invalidate the resolved persona.
    require('../services/assistant-config').invalidate(tenantId);

    try {
      const runtime = runtimeRegistry.getRuntimeService();
      if (replaced) {
        runtime.removeWorkflow(tenantId, replaced.id);
      }
      await runtime.hotSwapWorkflow(tenantId, workflow);
      hotSwapCompleted = true;
      logger.info(`Hot-swap completed for tenant ${tenantId}, workflow ${workflow._id}`);
    } catch (hotSwapError) {
      // Publishing still succeeded; the new version takes effect on next load.
      logger.error('Error during hot-swap:', hotSwapError);
    }

    socketManager.broadcastToTenant(tenantId, 'workflow:published', {
      workflowId: workflow._id,
      workflowName: workflow.name,
      version: workflow.version,
      publishedAt: workflow.publishedAt,
      hotSwapCompleted
    });

    // Publishing changes what this tenant's visitors are answered by.
    audit.record({
      req,
      action: 'workflow.published',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
      details: {
        version: workflow.version,
        trigger: workflow.liveTrigger ? workflow.liveTrigger.type : 'always',
        hotSwapCompleted,
        ...(replaced ? { replaced: replaced.name } : {})
      }
    });

    if (replaced) {
      audit.record({
        req,
        action: 'workflow.unpublished',
        company: workflow.company,
        target: { type: 'workflow', id: replaced.id, label: replaced.name },
        details: { replacedBy: workflow.name }
      });
    }

    res.json({
      success: true,
      workflow: present(workflow),
      hotSwapCompleted,
      replaced: replaced || null,
      message: hotSwapCompleted
        ? `"${workflow.name}" is live${replaced ? `, in place of "${replaced.name}"` : ''}`
        : 'Workflow published; it will take effect on the next runtime load'
    });
  } catch (error) {
    logger.error('Error publishing workflow:', error);
    sendError(res, error, 'Failed to publish workflow');
  }
});

/**
 * Take a workflow off live. It becomes a draft again; the messages it
 * answered go to the tenant's other workflows or the assistant from the next
 * one.
 */
router.post('/:id/unpublish', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.unpublishWorkflow(req.params.id, req.user);
    const tenantId = tenantIdOf(workflow);

    if (tenantId) {
      require('../services/assistant-config').invalidate(tenantId);
      try {
        runtimeRegistry.getRuntimeService().removeWorkflow(tenantId, String(workflow._id));
      } catch (error) {
        logger.warn('Could not unload the unpublished workflow', { tenantId, error: error.message });
      }
    }

    audit.record({
      req,
      action: 'workflow.unpublished',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name }
    });

    res.json({
      success: true,
      workflow: present(workflow),
      message: `"${workflow.name}" is no longer live`
    });
  } catch (error) {
    logger.error('Error unpublishing workflow:', error);
    sendError(res, error, 'Failed to unpublish workflow');
  }
});

// Archive workflow
router.post('/:id/archive', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.getWorkflow(
      req.params.id,
      req.user.company?.id,
      req.user.role
    );

    if (workflow.status === 'archived') {
      return res.status(400).json({
        success: false,
        error: 'Workflow is already archived'
      });
    }

    const wasLive = workflow.status === 'published';
    await workflow.archive();

    // Archiving a live workflow stops it answering; the runtime must stop
    // serving the archived graph now, not when the process happens to restart.
    if (wasLive) {
      forgetLiveWorkflow(tenantIdOf(workflow));
    }

    res.json({
      success: true,
      workflow: present(workflow),
      message: 'Workflow archived successfully'
    });
  } catch (error) {
    logger.error('Error archiving workflow:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to archive workflow'
    });
  }
});

// Get workflow versions
router.get('/:id/versions', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const versions = await WorkflowService.getWorkflowVersions(
      req.params.id,
      req.user.company?.id,
      req.user.role
    );

    res.json({
      success: true,
      // A version snapshot embeds the nodes as they were, credentials and all,
      // so it needs the same redaction as a live workflow.
      versions: versions.map(redactWorkflow),
      count: versions.length
    });
  } catch (error) {
    logger.error('Error fetching workflow versions:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch workflow versions'
    });
  }
});

// Rollback to specific version
router.post('/:id/rollback/:version', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const version = parseInt(req.params.version);

    if (isNaN(version) || version < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid version number'
      });
    }

    const workflow = await WorkflowService.rollbackWorkflow(
      req.params.id,
      version,
      req.user
    );

    // Like a save, a restore is a draft: visitors keep the live version until
    // it is published, so the runtime is left alone.

    audit.record({
      req,
      action: 'workflow.rolled_back',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
      details: { to: version, now: workflow.version }
    });

    res.json({
      success: true,
      workflow: present(workflow),
      message: workflow.status === 'published'
        ? `Version ${version} is back on the canvas as a draft. Publish it to make it live.`
        : `Workflow rolled back to version ${version}`
    });
  } catch (error) {
    logger.error('Error rolling back workflow:', error);
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to rollback workflow'
    });
  }
});

// Delete workflow
router.delete('/:id', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const result = await WorkflowService.deleteWorkflow(req.params.id, req.user);

    // Only drafts and archived workflows can be deleted, so nothing live is
    // affected - but a stale runtime entry for the tenant is cheap to drop and
    // means a delete never leaves a ghost serving traffic.
    forgetLiveWorkflow(result.company);

    audit.record({
      req,
      action: 'workflow.deleted',
      target: { type: 'workflow', id: req.params.id, label: result.name || req.params.id }
    });

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    logger.error('Error deleting workflow:', error);
    sendError(res, error, 'Failed to delete workflow');
  }
});

// Get active workflow for company
router.get('/active/current', authMiddleware, async (req, res) => {
  try {
    if (!req.user.company?.id) {
      return res.status(400).json({
        success: false,
        error: 'No company associated with user'
      });
    }

    const workflow = await WorkflowService.getActiveWorkflow(req.user.company.id);

    if (!workflow) {
      return res.json({
        success: true,
        workflow: null,
        message: 'No active workflow found'
      });
    }

    res.json({
      success: true,
      workflow: present(workflow)
    });
  } catch (error) {
    logger.error('Error fetching active workflow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch active workflow'
    });
  }
});

// Validate workflow structure
router.post('/validate', authMiddleware, checkWorkflowAccess, async (req, res) => {
  // A structurally invalid graph is a valid answer to "is this valid?", not a
  // failed request - so this always responds 200 and reports the verdict in the
  // body. It also returns every problem at once, each with the node it is
  // about, so the editor can highlight them all instead of drip-feeding them
  // one save at a time.
  const { nodes = [], edges = [], trigger } = req.body;
  const report = WorkflowService.report(
    Array.isArray(nodes) ? nodes : [],
    Array.isArray(edges) ? edges : [],
    trigger
  );

  res.json({
    success: true,
    valid: report.valid,
    errors: report.errors,
    warnings: report.warnings,
    problems: report.problems,
    message: report.valid
      ? 'Workflow structure is valid'
      : `Found ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`
  });
});

/**
 * Try an action node's call without publishing it.
 *
 * Configuring an API call blind - save, publish, wait for a customer to hit it,
 * read the logs - is a miserable loop, so this runs it once and reports both
 * what came back and what the field mappings picked out of it.
 *
 * This does mean an authenticated admin can make the server issue a request of
 * their choosing. That is the same capability the node itself has, and it is
 * bounded by the same address checks: private and reserved ranges are refused
 * at connect time, on the resolved address, redirects included.
 */
router.post('/actions/test', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const { config = {}, variables = {}, workflowId, nodeId } = req.body;

    if (!config.url) {
      return res.status(400).json({ success: false, error: 'Enter a URL to test' });
    }

    const auth = { ...(config.auth || {}) };
    let url = config.url;

    // The editor never holds a saved credential, so a test of an existing node
    // has to pick the stored one up from the workflow - fetched with the
    // tenant filter, so another company's secret cannot be borrowed by id.
    //
    // When the stored credential is used, the stored URL is used with it. The
    // request's URL was honoured before, which let anyone with editor access
    // send a colleague's saved API key to an address of their choosing.
    if (auth.type && auth.type !== 'none' && !auth.value && workflowId && nodeId) {
      const stored = await WorkflowService.getWorkflow(
        workflowId,
        req.user.role === 'superadmin' ? null : req.user.company?.id,
        req.user.role
      ).catch(() => null);

      const node = stored && (stored.nodes || []).find(n => n.id === nodeId);
      if (node && node.data && node.data.auth && node.data.auth.value) {
        auth.value = node.data.auth.value;
        if (node.data.url) {
          url = node.data.url;
        }
      }
    }

    // Test values, so a URL containing {{order_id}} resolves to something.
    const result = await workflowActions.execute(
      { ...config, url, auth },
      { user_input: 'test message', ...stripReservedVariables(variables) },
      { includeBody: true }
    );

    logger.info('Workflow action tested', {
      company: req.user.company?.id,
      by: req.user.username,
      ok: result.ok
    });

    res.json({ success: true, result });
  } catch (error) {
    logger.error('Error testing workflow action:', error);
    res.status(500).json({ success: false, error: 'Failed to run the test' });
  }
});

/**
 * Try a workflow without publishing it.
 *
 * The graph comes in the request rather than from the database, because the
 * whole point is to try the thing on the canvas — including changes that have
 * not been saved. Until this existed, the only way to find out whether a
 * twelve-node flow worked was to publish it to real visitors and watch, which
 * is how bad bots ship.
 *
 * Runs in simulate mode: reads happen, writes do not. See services/workflow-
 * nodes.js for what each node declines to do.
 */
router.post('/preview', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const { nodes = [], edges = [], message = '', state = {}, variables = {} } = req.body;

    if (!Array.isArray(nodes) || nodes.length === 0) {
      return res.status(400).json({ success: false, error: 'There is nothing on the canvas to try' });
    }

    const WorkflowCompilerService = require('../services/workflow-compiler');
    const compiler = new WorkflowCompilerService();

    const validation = compiler.validateWorkflow(nodes, edges);

    if (!validation.valid) {
      // Reported as a 200 with the problems listed: an invalid draft is a
      // normal state while building, not a failed request.
      return res.json({
        success: false,
        invalid: true,
        errors: validation.errors,
        warnings: validation.warnings,
        problems: validation.problems
      });
    }

    const tenantId = req.user.company?.id || null;

    // Compiled fresh from the request every turn. Caching it would mean an
    // author editing a node mid-conversation keeps testing the old one.
    const compiled = await compiler.compileWorkflow(nodes, edges, tenantId);

    const result = await compiler.executeWorkflow(
      compiled.compiledChain,
      message,
      Array.isArray(req.body.history) ? req.body.history.slice(-10) : [],
      {
        simulate: true,
        state,
        // A preview may set up any variable it likes to try a branch, except
        // the ones that assert who the visitor is.
        variables: stripReservedVariables(variables),
        // No session and no conversation: nothing here is attached to a real
        // one, which is also why the side-effecting nodes have nothing to
        // write to even if the simulate flag were missed.
        sessionId: null,
        conversationId: null
      }
    );

    res.json({
      success: true,
      response: result.response,
      choices: result.choices || null,
      escalation: result.escalation || null,
      state: result.state,
      simulated: result.simulated || [],
      // The nodes the run passed through, so the editor can light up the path.
      path: result.metadata?.path || [],
      actions: result.metadata?.actions || [],
      warnings: validation.warnings
    });
  } catch (error) {
    logger.error('Workflow preview failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get workflow execution stats
router.get('/:id/stats', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.getWorkflow(
      req.params.id,
      req.user.company?.id,
      req.user.role
    );

    await flushRunCounts();
    const fresh = await require('../models/workflow').findById(workflow._id).select('executionStats').lean();
    const stats = (fresh && fresh.executionStats) || {};

    res.json({
      success: true,
      stats: {
        runs: stats.runs || 0,
        completions: stats.completions || 0,
        handoffs: stats.handoffs || 0,
        errors: stats.errors || 0,
        lastRunAt: stats.lastRunAt || null
      }
    });
  } catch (error) {
    logger.error('Error fetching workflow stats:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch workflow stats'
    });
  }
});

module.exports = router;
module.exports.stripReservedVariables = stripReservedVariables;
module.exports.RESERVED_VARIABLES = RESERVED_VARIABLES;
