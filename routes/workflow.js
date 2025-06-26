/**
 * Workflow API routes for visual workflow editor
 */

const express = require('express');
const router = express.Router();
const WorkflowService = require('../services/workflow');
const KnowledgeSource = require('../models/knowledge-source');
const { auth: authMiddleware } = require('../middleware/auth');
const { logger } = require('../services/logging');

// Middleware to check workflow editor permissions
const checkWorkflowAccess = (req, res, next) => {
  if (req.user.role === 'superadmin' || req.user.role === 'admin') {
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
router.post('/', authMiddleware, checkWorkflowAccess, async (req, res) => {
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
    if (updateData.name) updateData.name = updateData.name.trim();
    if (updateData.description) updateData.description = updateData.description.trim();
    
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
    
    // Trigger hot-swap in runtime service
    try {
      const WorkflowRuntimeService = require('../services/workflow-runtime');
      const socketManager = require('../socketManager');
      
      // Initialize runtime service if not already done
      const runtimeService = new WorkflowRuntimeService(socketManager);
      
      // Perform hot-swap
      const tenantId = workflow.company || req.user.id;
      await runtimeService.hotSwapWorkflow(tenantId, workflow);
      
      logger.info(`Hot-swap triggered for tenant ${tenantId}, workflow ${workflow._id}`);
    } catch (hotSwapError) {
      logger.error('Error during hot-swap:', hotSwapError);
      // Don't fail the request if hot-swap fails
    }
    
    // Broadcast hot-swap message via WebSocket  
    try {
      const socketManager = require('../socketManager');
      const tenantId = workflow.company || req.user.id;
      
      socketManager.broadcastToTenant(tenantId, 'workflow:published', {
        workflowId: workflow._id,
        workflowName: workflow.name,
        version: workflow.version,
        publishedAt: workflow.publishedAt,
        hotSwapCompleted: true
      });
    } catch (wsError) {
      logger.error('Error broadcasting workflow publish event:', wsError);
      // Don't fail the request if WebSocket fails
    }
    
    res.json({ 
      success: true, 
      workflow,
      message: 'Workflow published successfully'
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
  try {
    const { nodes, edges } = req.body;
    
    // Use the workflow service validation
    const workflowService = require('../services/workflow');
    workflowService.validateWorkflow({ nodes, edges });
    
    res.json({ 
      success: true, 
      valid: true,
      message: 'Workflow structure is valid'
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      valid: false,
      error: error.message || 'Workflow validation failed'
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
