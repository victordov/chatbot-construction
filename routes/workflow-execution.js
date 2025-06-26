/**
 * Workflow Execution Routes
 * Handles workflow runtime operations and execution
 */

const express = require('express');
const router = express.Router();
const WorkflowRuntimeService = require('../services/workflow-runtime');
const OperatorAssistService = require('../services/operator-assist');
const { auth: authenticate, admin, superadmin, operator } = require('../middleware/auth');
const { logger } = require('../services/logging');

// Initialize services (these would typically be injected or singleton)
let runtimeService;
let operatorAssistService;

// Initialize services with socket manager
const initializeServices = (socketManager) => {
  if (!runtimeService) {
    runtimeService = new WorkflowRuntimeService(socketManager);
  }
  if (!operatorAssistService) {
    operatorAssistService = new OperatorAssistService(socketManager);
  }
};

/**
 * Execute workflow for a user message
 * POST /api/workflow-execution/execute
 */
router.post('/execute', authenticate, async (req, res) => {
  try {
    const { message, chatHistory = [], context = {} } = req.body;
    const tenantId = req.user.company?.id || req.user.id;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    // Check if conversation has operator assistance
    const conversationId = context.conversationId || `conv_${Date.now()}`;
    const isAssisted = operatorAssistService?.isConversationAssisted(conversationId);

    if (isAssisted) {
      // Generate suggested response for operator instead of auto-responding
      const assistInfo = operatorAssistService.getAssistanceInfo(conversationId);
      
      // Get workflow for suggestion generation
      const workflowStatus = runtimeService?.getWorkflowStatus(tenantId);
      if (workflowStatus?.status === 'active') {
        await operatorAssistService.generateSuggestedResponse(
          conversationId,
          message,
          chatHistory,
          workflowStatus.workflow.compiledChain
        );
      }

      return res.json({
        success: true,
        response: null, // No automatic response
        mode: 'operator_assist',
        assistInfo: {
          operatorId: assistInfo.operatorId,
          sessionId: assistInfo.sessionId,
          mode: assistInfo.mode
        }
      });
    }

    // Normal workflow execution
    if (!runtimeService) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    const result = await runtimeService.executeWorkflow(
      tenantId,
      message,
      chatHistory,
      { ...context, conversationId }
    );

    res.json({
      success: true,
      response: result.response,
      metadata: result.metadata,
      mode: 'automated'
    });

  } catch (error) {
    logger.error('Error executing workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get workflow runtime status
 * GET /api/workflow-execution/status
 */
router.get('/status', authenticate, admin, (req, res) => {
  try {
    const tenantId = req.user.company?.id || req.user.id;
    
    if (!runtimeService) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    const status = runtimeService.getWorkflowStatus(tenantId);
    
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
    if (!runtimeService) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    const workflows = runtimeService.getAllActiveWorkflows();
    
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
    const tenantId = req.user.company?.id || req.user.id;

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
    if (req.user.role !== 'superadmin' && workflow.company?.toString() !== tenantId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!runtimeService) {
      return res.status(503).json({
        success: false,
        error: 'Workflow runtime service not available'
      });
    }

    // Load the workflow
    await runtimeService.loadWorkflow(tenantId, workflow);
    
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
    if (!runtimeService) {
      return res.status(503).json({
        healthy: false,
        error: 'Runtime service not initialized'
      });
    }

    const health = runtimeService.getHealthStatus();
    
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

// Operator Assist Routes

/**
 * Join conversation as operator
 * POST /api/workflow-execution/operator/join
 */
router.post('/operator/join', authenticate, operator, async (req, res) => {
  try {
    const { conversationId } = req.body;
    const operatorId = req.user.id;
    const tenantId = req.user.company?.id || req.user.id;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'Conversation ID is required'
      });
    }

    if (!operatorAssistService) {
      return res.status(503).json({
        success: false,
        error: 'Operator assist service not available'
      });
    }

    const result = await operatorAssistService.joinConversation(
      operatorId,
      conversationId,
      tenantId
    );

    res.json(result);

  } catch (error) {
    logger.error('Error joining conversation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Leave conversation as operator
 * POST /api/workflow-execution/operator/leave
 */
router.post('/operator/leave', authenticate, operator, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    if (!operatorAssistService) {
      return res.status(503).json({
        success: false,
        error: 'Operator assist service not available'
      });
    }

    const result = await operatorAssistService.leaveConversation(sessionId);
    
    res.json(result);

  } catch (error) {
    logger.error('Error leaving conversation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send operator response
 * POST /api/workflow-execution/operator/respond
 */
router.post('/operator/respond', authenticate, operator, async (req, res) => {
  try {
    const { sessionId, message, conversationId } = req.body;

    if (!sessionId || !message || !conversationId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID, message, and conversation ID are required'
      });
    }

    if (!operatorAssistService) {
      return res.status(503).json({
        success: false,
        error: 'Operator assist service not available'
      });
    }

    const result = await operatorAssistService.sendOperatorResponse(
      sessionId,
      message,
      conversationId
    );
    
    res.json(result);

  } catch (error) {
    logger.error('Error sending operator response:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get operator statistics
 * GET /api/workflow-execution/operator/stats
 */
router.get('/operator/stats', authenticate, admin, (req, res) => {
  try {
    const tenantId = req.user.company?.id || req.user.id;

    if (!operatorAssistService) {
      return res.status(503).json({
        success: false,
        error: 'Operator assist service not available'
      });
    }

    const stats = operatorAssistService.getOperatorStats(tenantId);
    
    res.json({
      success: true,
      stats
    });

  } catch (error) {
    logger.error('Error getting operator stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export initialization function
router.initializeServices = initializeServices;

module.exports = router;
