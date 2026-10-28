/**
 * Workflow Execution Routes
 * Handles workflow runtime operations and execution
 */

const express = require('express');
const router = express.Router();
const { auth: authenticate, admin, superadmin } = require('../middleware/auth');
const { logger } = require('../services/logging');

// Shared singletons: routes/workflow.js publishes into the same instances, so
// a hot-swap is visible to the requests being served here.
const runtimeRegistry = require('../services/runtime-registry');

const initializeServices = (socketManager) => {
  runtimeRegistry.initialize(socketManager);
};

const runtimeServiceRef = () => runtimeRegistry.getRuntimeService();

/**
 * What of the request's `context` reaches the workflow.
 *
 * The body used to be passed through whole, so a caller could name any
 * session id (the tag node then wrote to it), assert `contact_verified`
 * (the flow then read account details), or switch on `simulate`. Only the
 * fields a client legitimately owns are copied, and the identity variables
 * are stripped - they come from the conversation's contact, never a request.
 */
function safeContext(context = {}) {
  const { stripReservedVariables } = require('./workflow');
  const clean = {};

  if (context.sessionId) {
    clean.sessionId = String(context.sessionId);
  }
  if (context.state && typeof context.state === 'object') {
    clean.state = context.state;
  }
  if (context.workflowId && /^[a-f0-9]{24}$/i.test(String(context.workflowId))) {
    clean.workflowId = String(context.workflowId);
  }
  clean.variables = stripReservedVariables(context.variables);

  return clean;
}

/**
 * Execute workflow for a user message
 * POST /api/workflow-execution/execute
 *
 * Admins only. It runs the tenant's live workflow for real - an Ask a
 * Question step's tag, task and email included - so an operator or any other
 * signed-in user must not be able to drive it with messages of their choosing.
 * Body `context.workflowId` picks one of several live workflows; without it,
 * the one that answers everything.
 */
router.post('/execute', authenticate, admin, async (req, res) => {
  try {
    const { message, chatHistory = [], context = {} } = req.body;
    const tenantId = String(req.user.company?.id || req.user.id);

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    if (!runtimeServiceRef()) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    // No conversation id: nothing here is attached to a stored conversation,
    // and an id the caller made up must not become one for the task node to
    // reference. Any write a node makes is scoped to this tenant.
    const result = await runtimeServiceRef().executeWorkflow(
      tenantId,
      message,
      Array.isArray(chatHistory) ? chatHistory.slice(-10) : [],
      { ...safeContext(context), conversationId: null }
    );

    res.json({
      success: true,
      response: result.response,
      metadata: result.metadata,
      mode: 'automated'
    });

  } catch (error) {
    // A tenant that has not published a workflow yet is a configuration state,
    // not a server fault - returning 500 made it look like an outage.
    if (error.code === 'NO_ACTIVE_WORKFLOW') {
      return res.status(409).json({
        success: false,
        code: 'NO_ACTIVE_WORKFLOW',
        error: 'No published workflow for this company. Publish one in the workflow editor.'
      });
    }

    logger.error('Error executing workflow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute workflow'
    });
  }
});

/**
 * Get workflow runtime status
 * GET /api/workflow-execution/status
 */
router.get('/status', authenticate, admin, (req, res) => {
  try {
    const tenantId = String(req.user.company?.id || req.user.id);

    if (!runtimeServiceRef()) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    const status = runtimeServiceRef().getWorkflowStatus(tenantId);

    res.json({
      success: true,
      status
    });
  } catch (error) {
    logger.error('Error getting workflow status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get all active workflows (superadmin only)
 * GET /api/workflow-execution/all-active
 */
router.get('/all-active', authenticate, superadmin, (req, res) => {
  try {
    if (!runtimeServiceRef()) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    const workflows = runtimeServiceRef().getAllActiveWorkflows();

    res.json({
      success: true,
      workflows
    });
  } catch (error) {
    logger.error('Error getting all active workflows:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Force reload a workflow
 * POST /api/workflow-execution/reload
 */
router.post('/reload', authenticate, admin, async (req, res) => {
  try {
    const { workflowId } = req.body;
    const tenantId = String(req.user.company?.id || req.user.id);

    if (!workflowId) {
      return res.status(400).json({
        success: false,
        error: 'Workflow ID is required'
      });
    }

    // Get workflow from database
    const Workflow = require('../models/workflow');
    const workflow = await Workflow.findById(workflowId);

    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: 'Workflow not found'
      });
    }

    // Check permissions
    if (req.user.role !== 'superadmin' &&
        workflow.company?.toString() !== tenantId?.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!runtimeServiceRef()) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    // Only a live workflow is served, and at its live version: reloading a
    // draft by id would have been a way to put unpublished work in front of
    // visitors without publishing it.
    if (workflow.status !== 'published') {
      return res.status(409).json({
        success: false,
        error: 'That workflow is not live. Publish it first.'
      });
    }

    const graph = await Workflow.liveGraph(workflow);
    await runtimeServiceRef().loadWorkflow(tenantId, {
      _id: workflow._id,
      name: workflow.name,
      version: graph.version,
      publishedAt: workflow.publishedAt,
      trigger: graph.trigger,
      nodes: graph.nodes,
      edges: graph.edges
    });

    res.json({
      success: true,
      message: 'Workflow reloaded successfully'
    });

  } catch (error) {
    logger.error('Error reloading workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Health check for runtime service
 * GET /api/workflow-execution/health
 */
router.get('/health', (req, res) => {
  try {
    if (!runtimeServiceRef()) {
      return res.status(503).json({
        healthy: false,
        error: 'Runtime service not initialized'
      });
    }

    const health = runtimeServiceRef().getHealthStatus();

    res.json({
      healthy: true,
      ...health
    });
  } catch (error) {
    logger.error('Error getting health status:', error);
    res.status(500).json({
      healthy: false,
      error: error.message
    });
  }
});

router.initializeServices = initializeServices;

module.exports = router;
