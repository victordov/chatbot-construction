/**
 * Workflow Runtime Service
 * Handles hot-swapping of workflows and execution management
 */

const EventEmitter = require('events');
const WorkflowCompilerService = require('./workflow-compiler');
const { logger } = require('./logging');

class WorkflowRuntimeService extends EventEmitter {
  constructor(socketManager) {
    super();
    this.socketManager = socketManager;
    this.compiler = new WorkflowCompilerService();
    this.activeWorkflows = new Map(); // tenantId -> compiledWorkflow
    this.executionStats = new Map(); // tenantId -> stats
  }

  /**
   * Load and activate a workflow for a tenant
   */
  async loadWorkflow(tenantId, workflow) {
    try {
      logger.info(`Loading workflow for tenant ${tenantId}: ${workflow._id}`);
      
      // Compile the workflow if not already compiled
      let compiledChain = workflow.compiledChain;
      if (!compiledChain || !compiledChain.compiled) {
        const compilationResult = await this.compiler.compileWorkflow(
          workflow.nodes || [], 
          workflow.edges || [], 
          tenantId
        );
        compiledChain = {
          compiled: true,
          compilationResult,
          timestamp: new Date()
        };
      }

      // Store the active workflow
      this.activeWorkflows.set(tenantId, {
        id: workflow._id,
        name: workflow.name,
        version: workflow.version,
        compiledChain: compiledChain.compilationResult,
        loadedAt: new Date(),
        executionCount: 0
      });

      // Initialize stats
      this.executionStats.set(tenantId, {
        executionCount: 0,
        averageResponseTime: 0,
        lastExecution: null,
        errors: 0
      });

      logger.info(`Workflow loaded successfully for tenant ${tenantId}`);
      return true;
    } catch (error) {
      logger.error(`Error loading workflow for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Hot-swap a workflow without downtime
   */
  async hotSwapWorkflow(tenantId, newWorkflow) {
    try {
      logger.info(`Hot-swapping workflow for tenant ${tenantId}`);
      
      // Compile the new workflow
      const compilationResult = await this.compiler.compileWorkflow(
        newWorkflow.nodes || [], 
        newWorkflow.edges || [], 
        tenantId
      );

      // Prepare new workflow data
      const newActiveWorkflow = {
        id: newWorkflow._id,
        name: newWorkflow.name,
        version: newWorkflow.version,
        compiledChain: compilationResult,
        loadedAt: new Date(),
        executionCount: 0
      };

      // Atomic swap
      const oldWorkflow = this.activeWorkflows.get(tenantId);
      this.activeWorkflows.set(tenantId, newActiveWorkflow);

      // Broadcast hot-swap notification via WebSocket
      if (this.socketManager) {
        this.socketManager.broadcastToTenant(tenantId, 'workflow:hot-swap', {
          oldVersion: oldWorkflow?.version,
          newVersion: newWorkflow.version,
          timestamp: new Date().toISOString()
        });
      }

      // Emit event for other services
      this.emit('workflow:swapped', {
        tenantId,
        oldWorkflow,
        newWorkflow: newActiveWorkflow
      });

      logger.info(`Hot-swap completed for tenant ${tenantId}: v${oldWorkflow?.version} -> v${newWorkflow.version}`);
      
      return {
        success: true,
        oldVersion: oldWorkflow?.version,
        newVersion: newWorkflow.version,
        swappedAt: new Date()
      };
    } catch (error) {
      logger.error(`Error hot-swapping workflow for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Execute a workflow for a user message
   */
  async executeWorkflow(tenantId, userMessage, chatHistory = [], context = {}) {
    try {
      const startTime = Date.now();
      
      // Get active workflow
      const activeWorkflow = this.activeWorkflows.get(tenantId);
      if (!activeWorkflow) {
        throw new Error(`No active workflow found for tenant ${tenantId}`);
      }

      // Execute using compiler
      const result = await this.compiler.executeWorkflow(
        activeWorkflow.compiledChain,
        userMessage,
        chatHistory,
        context
      );

      const endTime = Date.now();
      const responseTime = endTime - startTime;

      // Update stats
      this.updateExecutionStats(tenantId, responseTime, !result.success);
      
      // Update workflow execution count
      activeWorkflow.executionCount++;

      logger.info(`Workflow executed for tenant ${tenantId} in ${responseTime}ms`);
      
      return {
        ...result,
        metadata: {
          ...result.metadata,
          responseTime,
          workflowVersion: activeWorkflow.version,
          executionId: this.generateExecutionId()
        }
      };
    } catch (error) {
      this.updateExecutionStats(tenantId, 0, true);
      logger.error(`Error executing workflow for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Update execution statistics
   */
  updateExecutionStats(tenantId, responseTime, isError = false) {
    const stats = this.executionStats.get(tenantId) || {
      executionCount: 0,
      averageResponseTime: 0,
      lastExecution: null,
      errors: 0
    };

    stats.executionCount++;
    stats.lastExecution = new Date();
    
    if (isError) {
      stats.errors++;
    } else {
      // Update rolling average response time
      stats.averageResponseTime = (stats.averageResponseTime * (stats.executionCount - 1) + responseTime) / stats.executionCount;
    }

    this.executionStats.set(tenantId, stats);
  }

  /**
   * Get workflow status for a tenant
   */
  getWorkflowStatus(tenantId) {
    const activeWorkflow = this.activeWorkflows.get(tenantId);
    const stats = this.executionStats.get(tenantId);

    if (!activeWorkflow) {
      return {
        status: 'not_loaded',
        tenantId
      };
    }

    return {
      status: 'active',
      tenantId,
      workflow: {
        id: activeWorkflow.id,
        name: activeWorkflow.name,
        version: activeWorkflow.version,
        loadedAt: activeWorkflow.loadedAt,
        executionCount: activeWorkflow.executionCount
      },
      stats: stats || {
        executionCount: 0,
        averageResponseTime: 0,
        lastExecution: null,
        errors: 0
      }
    };
  }

  /**
   * Get all active workflows
   */
  getAllActiveWorkflows() {
    const workflows = [];
    
    for (const [tenantId, workflow] of this.activeWorkflows) {
      workflows.push({
        tenantId,
        ...this.getWorkflowStatus(tenantId)
      });
    }

    return workflows;
  }

  /**
   * Unload workflow for a tenant
   */
  unloadWorkflow(tenantId) {
    const removed = this.activeWorkflows.delete(tenantId);
    this.executionStats.delete(tenantId);
    
    if (removed) {
      logger.info(`Workflow unloaded for tenant ${tenantId}`);
      
      // Broadcast unload notification
      if (this.socketManager) {
        this.socketManager.broadcastToTenant(tenantId, 'workflow:unloaded', {
          timestamp: new Date().toISOString()
        });
      }

      this.emit('workflow:unloaded', { tenantId });
    }

    return removed;
  }

  /**
   * Health check for the runtime service
   */
  getHealthStatus() {
    return {
      status: 'healthy',
      activeWorkflows: this.activeWorkflows.size,
      totalExecutions: Array.from(this.executionStats.values())
        .reduce((sum, stats) => sum + stats.executionCount, 0),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    };
  }

  /**
   * Generate unique execution ID
   */
  generateExecutionId() {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up resources
   */
  shutdown() {
    this.activeWorkflows.clear();
    this.executionStats.clear();
    this.removeAllListeners();
    logger.info('Workflow runtime service shut down');
  }
}

module.exports = WorkflowRuntimeService;
