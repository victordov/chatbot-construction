/**
 * Workflow Runtime Service
 * Handles hot-swapping of workflows and execution management
 */

const EventEmitter = require('events');
const WorkflowCompilerService = require('./workflow-compiler');
const { logger } = require('./logging');

/**
 * How long a cached workflow is trusted before the database is asked whether
 * it is still the published one.
 *
 * The cache is per process. A publish on one instance hot-swaps that instance
 * only; every other instance behind the load balancer kept serving the old
 * graph until it restarted. Re-checking is one indexed query on `_id`,
 * `version` and `publishedAt`, so it is cheap enough to do often.
 */
const CACHE_TTL_MS = parseInt(process.env.WORKFLOW_CACHE_TTL_MS, 10) || 30000;

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

      // Always compile from the graph. A stored compiledChain can be stale
      // relative to the nodes/edges the tenant just published.
      const compilationResult = await this.compiler.compileWorkflow(
        workflow.nodes || [],
        workflow.edges || [],
        tenantId
      );

      // Store the active workflow. `compiledChain` must be the chain config the
      // executor consumes - previously the whole compilation result was stored
      // here, so executeWorkflow destructured undefined prompts and threw on
      // `prompts.moderation`.
      this.activeWorkflows.set(tenantId, {
        id: workflow._id,
        name: workflow.name,
        version: workflow.version,
        publishedAt: workflow.publishedAt || null,
        compiledChain: compilationResult.compiledChain,
        executionPlan: compilationResult.executionPlan,
        warnings: compilationResult.warnings,
        loadedAt: new Date(),
        checkedAt: Date.now(),
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
      return {
        success: true,
        tenantId,
        workflowId: workflow._id,
        version: workflow.version,
        warnings: compilationResult.warnings || []
      };
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
        publishedAt: newWorkflow.publishedAt || null,
        compiledChain: compilationResult.compiledChain,
        executionPlan: compilationResult.executionPlan,
        warnings: compilationResult.warnings,
        loadedAt: new Date(),
        checkedAt: Date.now(),
        executionCount: 0
      };

      // Atomic swap
      const oldWorkflow = this.activeWorkflows.get(tenantId);
      this.activeWorkflows.set(tenantId, newActiveWorkflow);

      // Broadcast hot-swap notification via WebSocket
      if (this.socketManager && typeof this.socketManager.broadcastToTenant === 'function') {
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
   * Ensure a tenant's published workflow is resident in memory.
   *
   * The runtime map lives in process memory, so after a restart (or on a new
   * instance behind a load balancer) it is empty and every tenant's bot would
   * be dead until an admin happened to re-publish. Lazily loading the published
   * workflow on first use closes that gap.
   *
   * @returns {Promise<object|null>} the active workflow entry, or null if the
   *   tenant has never published one.
   */
  async ensureWorkflowLoaded(tenantId) {
    const existing = this.activeWorkflows.get(tenantId);

    if (existing && Date.now() - existing.checkedAt < CACHE_TTL_MS) {
      return existing;
    }

    try {
      const Workflow = require('../models/workflow');

      if (existing) {
        // Cheap check: is what we hold still what is published? A publish,
        // archive or edit on another instance changes one of these.
        const current = await Workflow.getActiveWorkflow(tenantId)
          .select('_id version publishedAt')
          .lean();

        if (!current) {
          logger.info(`Published workflow for tenant ${tenantId} is gone; unloading`);
          this.unloadWorkflow(tenantId);
          return null;
        }

        if (sameRelease(existing, current)) {
          existing.checkedAt = Date.now();
          return existing;
        }

        logger.info(`Published workflow for tenant ${tenantId} changed elsewhere; reloading`);
      }

      const published = await Workflow.getActiveWorkflow(tenantId);

      if (!published) {
        return null;
      }

      logger.info(`Loading published workflow for tenant ${tenantId}`);
      await this.loadWorkflow(tenantId, published);
      return this.activeWorkflows.get(tenantId);
    } catch (error) {
      logger.error(`Unable to load workflow for tenant ${tenantId}`, { error: error.message });
      // Serve what we have rather than nothing: a database blip should not
      // take a working bot down.
      return existing || null;
    }
  }

  /**
   * Execute a workflow for a user message
   */
  async executeWorkflow(tenantId, userMessage, chatHistory = [], context = {}) {
    try {
      const startTime = Date.now();

      const activeWorkflow = await this.ensureWorkflowLoaded(tenantId);
      if (!activeWorkflow) {
        const error = new Error(`No active workflow found for tenant ${tenantId}`);
        error.code = 'NO_ACTIVE_WORKFLOW';
        throw error;
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
          workflowId: String(activeWorkflow.id),
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

    for (const tenantId of this.activeWorkflows.keys()) {
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
      if (this.socketManager && typeof this.socketManager.broadcastToTenant === 'function') {
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

/**
 * Whether a cached entry and the published record are the same release.
 */
function sameRelease(cached, current) {
  const cachedPublished = cached.publishedAt ? new Date(cached.publishedAt).getTime() : null;
  const currentPublished = current.publishedAt ? new Date(current.publishedAt).getTime() : null;

  return String(cached.id) === String(current._id) &&
    cached.version === current.version &&
    cachedPublished === currentPublished;
}

module.exports = WorkflowRuntimeService;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
