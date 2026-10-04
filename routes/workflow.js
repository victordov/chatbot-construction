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
const { enforceLimit, requireFeature } = require('../middleware/quota');

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
    const workflows = await WorkflowService.getWorkflows(
      req.user.company?.id,
      req.user.role,
      status
    );

    res.json({
      success: true,
      workflows: workflows.map(redactWorkflow),
      count: workflows.length
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
      workflow: redactWorkflow(workflow)
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

// Create new workflow
router.post('/', authMiddleware, checkWorkflowAccess, requireFeature('workflows'), enforceLimit('workflows'), async (req, res) => {
  try {
    const { name, description, nodes = [], edges = [] } = req.body;

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
      edges
    };

    const workflow = await WorkflowService.createWorkflow(workflowData, req.user);

    res.status(201).json({
      success: true,
      workflow: redactWorkflow(workflow),
      message: 'Workflow created successfully'
    });
  } catch (error) {
    logger.error('Error creating workflow:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to create workflow'
    });
  }
});

// Update workflow
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

    // Editing the live workflow changes what visitors are answered by, so the
    // runtime's copy is dropped and reloaded from the saved graph on the next
    // message. Persona lives in the graph too.
    if (workflow.status === 'published') {
      forgetLiveWorkflow(tenantIdOf(workflow));
    }

    res.json({
      success: true,
      workflow: redactWorkflow(workflow),
      message: 'Workflow updated successfully'
    });
  } catch (error) {
    logger.error('Error updating workflow:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update workflow'
    });
  }
});

// Publish workflow
router.post('/:id/publish', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const workflow = await WorkflowService.publishWorkflow(req.params.id, req.user);

    // Hot-swap into the runtime that is actually serving traffic. This used to
    // construct a fresh WorkflowRuntimeService, so the swap landed in a
    // throwaway object and live conversations kept the old workflow.
    const tenantId = tenantIdOf(workflow) || String(req.user.id);
    let hotSwapCompleted = false;

    // The published workflow's Persona node is what the assistant uses, so a
    // publish must invalidate the resolved persona immediately.
    require('../services/assistant-config').invalidate(tenantId);

    try {
      await runtimeRegistry.getRuntimeService().hotSwapWorkflow(tenantId, workflow);
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

    // Publishing changes what every visitor to this tenant is answered by.
    audit.record({
      req,
      action: 'workflow.published',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
      details: { version: workflow.version, hotSwapCompleted }
    });

    res.json({
      success: true,
      workflow: redactWorkflow(workflow),
      hotSwapCompleted,
      message: hotSwapCompleted
        ? 'Workflow published and is now live'
        : 'Workflow published; it will take effect on the next runtime load'
    });
  } catch (error) {
    logger.error('Error publishing workflow:', error);
    const statusCode = error.message === 'Workflow not found' ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to publish workflow'
    });
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

    // Archiving the live workflow takes the tenant back to the plain
    // assistant; the runtime must stop serving the archived graph now, not
    // when the process happens to restart.
    if (wasLive) {
      forgetLiveWorkflow(tenantIdOf(workflow));
    }

    res.json({
      success: true,
      workflow: redactWorkflow(workflow),
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

    // A rolled-back graph that is live is served from the next message.
    if (workflow.status === 'published') {
      forgetLiveWorkflow(tenantIdOf(workflow));
    }

    audit.record({
      req,
      action: 'workflow.rolled_back',
      company: workflow.company,
      target: { type: 'workflow', id: String(workflow._id), label: workflow.name },
      details: { to: version, now: workflow.version }
    });

    res.json({
      success: true,
      workflow: redactWorkflow(workflow),
      message: `Workflow rolled back to version ${version}`
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
    const statusCode = error.message === 'Workflow not found' ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete workflow'
    });
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
      workflow: redactWorkflow(workflow)
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
  // body. It also returns every error at once, so the editor can highlight all
  // the problems instead of drip-feeding them one save at a time.
  const { nodes = [], edges = [] } = req.body;

  const WorkflowCompilerService = require('../services/workflow-compiler');
  const compiler = new WorkflowCompilerService();
  const result = compiler.validateWorkflow(nodes, edges);

  const errors = [...result.errors];

  // Layer on the per-node configuration checks the editor cares about.
  if (result.valid) {
    const workflowService = require('../services/workflow');
    nodes.forEach(node => {
      try {
        workflowService.validateNodeData(node);
      } catch (error) {
        errors.push(error.message);
      }
    });
  }

  res.json({
    success: true,
    valid: errors.length === 0,
    errors,
    warnings: result.warnings || [],
    message: errors.length === 0
      ? 'Workflow structure is valid'
      : `Found ${errors.length} problem${errors.length === 1 ? '' : 's'}`
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
        warnings: validation.warnings
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

    res.json({
      success: true,
      stats: workflow.executionStats || {
        totalExecutions: 0,
        averageExecutionTime: 0,
        lastExecuted: null
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
