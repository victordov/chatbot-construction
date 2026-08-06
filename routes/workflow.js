/**
 * Workflow API routes for visual workflow editor
 */

const express = require('express');
const router = express.Router();
const WorkflowService = require('../services/workflow');
const KnowledgeSource = require('../models/knowledge-source');
const { auth: authMiddleware } = require('../middleware/auth');
const { logger } = require('../services/logging');
const socketManager = require('../socketManager');
const runtimeRegistry = require('../services/runtime-registry');
const { enforceLimit, requireFeature } = require('../middleware/quota');

/** Knowledge source types the compiler knows how to query. */
const SUPPORTED_KNOWLEDGE_SOURCE_TYPES = ['google_sheets', 'pdf', 'url', 'vector_store'];

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
      workflows,
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

// Get knowledge sources for workflow nodes
router.get('/knowledge-sources', authMiddleware, checkWorkflowAccess, async (req, res) => {
  try {
    const { type } = req.query;

    let knowledgeSources = [];

    if (req.user.company?.id) {
      knowledgeSources = await KnowledgeSource.getByCompany(req.user.company.id, type);
    }

    // Add public sources if available
    const publicSources = await KnowledgeSource.getPublicSources(type);

    res.json({
      success: true,
      // Source types the editor can offer in the node palette.
      sources: SUPPORTED_KNOWLEDGE_SOURCE_TYPES,
      // Sources this company has already configured.
      knowledgeSources: [...knowledgeSources, ...publicSources]
    });
  } catch (error) {
    logger.error('Error fetching knowledge sources:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch knowledge sources'
    });
  }
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
      workflow
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
      workflow,
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

    res.json({
      success: true,
      workflow,
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
    const tenantId = workflow.company || req.user.id;
    let hotSwapCompleted = false;

    // The published workflow's Persona node is what the assistant uses, so a
    // publish must invalidate the resolved persona immediately.
    require('../services/assistant-config').invalidate(workflow.company);

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

    res.json({
      success: true,
      workflow,
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

    await workflow.archive();

    res.json({
      success: true,
      workflow,
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
      versions,
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

    res.json({
      success: true,
      workflow,
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
      workflow
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
