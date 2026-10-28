/**
 * Workflow Runtime Service
 *
 * Holds the compiled workflows each tenant has live, keeps them in step with
 * the database, runs them, and counts what they do.
 *
 * A tenant may have several workflows live at once, each answering the
 * messages its trigger matches (services/reply.js decides which). Each is
 * served at its `liveVersion`: saving a live workflow makes a draft, and only
 * publishing changes what visitors get.
 */

const EventEmitter = require('events');
const mongoose = require('mongoose');
const WorkflowCompilerService = require('./workflow-compiler');
const { logger } = require('./logging');

/**
 * How long a cached workflow is trusted before the database is asked whether
 * it is still the published one.
 *
 * The cache is per process. A publish on one instance hot-swaps that instance
 * only; every other instance behind the load balancer kept serving the old
 * graph until it restarted. Re-checking is one indexed query on the tenant's
 * published workflows, so it is cheap enough to do often.
 */
const CACHE_TTL_MS = parseInt(process.env.WORKFLOW_CACHE_TTL_MS, 10) || 30000;

/**
 * How often counted runs are written to the workflow documents. A write per
 * message would put the database on the path of every reply; a batch every
 * half minute loses at most that much on a crash.
 */
const STATS_FLUSH_MS = parseInt(process.env.WORKFLOW_STATS_FLUSH_MS, 10) || 30000;

class WorkflowRuntimeService extends EventEmitter {
  constructor(socketManager) {
    super();
    this.socketManager = socketManager;
    this.compiler = new WorkflowCompilerService();
    // tenantId -> { checkedAt, workflows: [entry] }, one entry per live
    // workflow, oldest publish first.
    this.activeWorkflows = new Map();
    this.executionStats = new Map(); // tenantId -> stats for this process
    // workflowId -> counts not yet written to the database
    this.pendingStats = new Map();
    this.flushTimer = null;
  }

  /**
   * Compile a workflow into the entry the runtime serves.
   *
   * `workflow` is whatever is to be served: a published document (whose
   * `liveVersion` snapshot the caller has already resolved) or a graph handed
   * in directly by a test or the reload route.
   */
  async buildEntry(tenantId, workflow) {
    // Always compile from the graph. A stored compiledChain can be stale
    // relative to the nodes/edges the tenant just published.
    const compilationResult = await this.compiler.compileWorkflow(
      workflow.nodes || [],
      workflow.edges || [],
      tenantId
    );

    const Workflow = require('../models/workflow');

    return {
      id: workflow._id,
      name: workflow.name,
      version: workflow.version,
      publishedAt: workflow.publishedAt || null,
      trigger: Workflow.normaliseTrigger(workflow.trigger),
      // `compiledChain` must be the chain config the executor consumes - the
      // whole compilation result was once stored here, so executeWorkflow
      // destructured undefined prompts and threw on `prompts.moderation`.
      compiledChain: compilationResult.compiledChain,
      executionPlan: compilationResult.executionPlan,
      warnings: compilationResult.warnings,
      loadedAt: new Date(),
      checkedAt: Date.now(),
      executionCount: 0
    };
  }

  /** Put an entry in the tenant's set, replacing the same workflow if present. */
  placeEntry(tenantId, entry, { fresh }) {
    const set = this.activeWorkflows.get(tenantId) || { checkedAt: 0, workflows: [] };
    const index = set.workflows.findIndex(existing => String(existing.id) === String(entry.id));
    const previous = index >= 0 ? set.workflows[index] : null;

    if (index >= 0) {
      set.workflows[index] = entry;
    } else {
      set.workflows.push(entry);
    }
    if (fresh) {
      set.checkedAt = Date.now();
    }

    this.activeWorkflows.set(tenantId, set);
    return previous;
  }

  /**
   * Load and activate a workflow for a tenant
   */
  async loadWorkflow(tenantId, workflow) {
    try {
      logger.info(`Loading workflow for tenant ${tenantId}: ${workflow._id}`);

      const entry = await this.buildEntry(tenantId, workflow);
      // Loaded on purpose, so trusted for a TTL like anything read from the
      // database.
      this.placeEntry(tenantId, entry, { fresh: true });

      if (!this.executionStats.has(tenantId)) {
        this.executionStats.set(tenantId, {
          executionCount: 0,
          averageResponseTime: 0,
          lastExecution: null,
          errors: 0
        });
      }

      logger.info(`Workflow loaded successfully for tenant ${tenantId}`);
      return {
        success: true,
        tenantId,
        workflowId: workflow._id,
        version: workflow.version,
        warnings: entry.warnings || []
      };
    } catch (error) {
      logger.error(`Error loading workflow for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Hot-swap a workflow without downtime.
   *
   * Replaces that workflow's entry (or adds it) and leaves the tenant's other
   * live workflows alone. A tenant whose set was never loaded here gets the
   * new entry marked as unchecked, so the next message also picks up whatever
   * else they have live.
   */
  async hotSwapWorkflow(tenantId, newWorkflow) {
    try {
      logger.info(`Hot-swapping workflow for tenant ${tenantId}`);

      const entry = await this.buildEntry(tenantId, newWorkflow);
      const oldWorkflow = this.placeEntry(tenantId, entry, { fresh: false });

      // Broadcast hot-swap notification via WebSocket
      if (this.socketManager && typeof this.socketManager.broadcastToTenant === 'function') {
        this.socketManager.broadcastToTenant(tenantId, 'workflow:hot-swap', {
          workflowId: String(newWorkflow._id),
          oldVersion: oldWorkflow?.version,
          newVersion: newWorkflow.version,
          timestamp: new Date().toISOString()
        });
      }

      // Emit event for other services
      this.emit('workflow:swapped', {
        tenantId,
        oldWorkflow,
        newWorkflow: entry
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
   * Every workflow a tenant has live, resident in memory.
   *
   * The runtime map lives in process memory, so after a restart (or on a new
   * instance behind a load balancer) it is empty and every tenant's bot would
   * be dead until an admin happened to re-publish. Loading lazily on first use
   * closes that gap, and re-checking against the database every TTL means a
   * publish, unpublish or edit made on another instance is noticed here.
   *
   * @returns {Promise<Array<object>>} the live entries, oldest publish first;
   *          empty when the tenant has nothing live
   */
  async ensureWorkflowsLoaded(tenantId) {
    const existing = this.activeWorkflows.get(tenantId);

    if (existing && Date.now() - existing.checkedAt < CACHE_TTL_MS) {
      return existing.workflows;
    }

    try {
      const Workflow = require('../models/workflow');

      // The cheap part: which workflows are live, and at which release.
      const published = await Workflow.getLiveWorkflows(tenantId)
        .select('_id version liveVersion publishedAt')
        .lean();

      if (published.length === 0) {
        if (existing) {
          logger.info(`Tenant ${tenantId} has no live workflow any more; unloading`);
          this.unloadWorkflow(tenantId);
        }
        return [];
      }

      const held = new Map((existing ? existing.workflows : []).map(entry => [String(entry.id), entry]));
      const workflows = [];

      for (const release of published) {
        const cached = held.get(String(release._id));
        if (cached && sameRelease(cached, release)) {
          workflows.push(cached);
          continue;
        }

        // New or changed: read it whole, resolve the live snapshot, compile.
        try {
          const document = await Workflow.findById(release._id);
          if (!document || document.status !== 'published') {
            continue;
          }
          const graph = await Workflow.liveGraph(document);
          logger.info(`Loading live workflow ${release._id} v${graph.version} for tenant ${tenantId}`);
          workflows.push(await this.buildEntry(tenantId, {
            _id: document._id,
            name: document.name,
            version: graph.version,
            publishedAt: document.publishedAt,
            trigger: graph.trigger,
            nodes: graph.nodes,
            edges: graph.edges
          }));
        } catch (error) {
          // One broken workflow must not take the tenant's others down with
          // it. It is left out, and logged, until it is fixed and republished.
          logger.error('A live workflow could not be loaded; serving the others', {
            tenantId, workflowId: String(release._id), error: error.message
          });
          if (cached) {
            workflows.push(cached);
          }
        }
      }

      this.activeWorkflows.set(tenantId, { checkedAt: Date.now(), workflows });
      return workflows;
    } catch (error) {
      logger.error(`Unable to load workflows for tenant ${tenantId}`, { error: error.message });
      // Serve what we have rather than nothing: a database blip should not
      // take a working bot down.
      return existing ? existing.workflows : [];
    }
  }

  /**
   * One live workflow: the one asked for, or - when none is named - the one
   * that answers everything, or the only one.
   *
   * Kept for callers from before several workflows could be live, which want
   * "the" workflow.
   *
   * @returns {Promise<object|null>}
   */
  async ensureWorkflowLoaded(tenantId, workflowId = null) {
    const workflows = await this.ensureWorkflowsLoaded(tenantId);
    return pickEntry(workflows, workflowId);
  }

  /**
   * Execute a workflow for a user message.
   *
   * `context.workflowId` names which live workflow; without it, the primary
   * one (see ensureWorkflowLoaded).
   */
  async executeWorkflow(tenantId, userMessage, chatHistory = [], context = {}) {
    let activeWorkflow = null;

    try {
      const startTime = Date.now();

      activeWorkflow = await this.ensureWorkflowLoaded(tenantId, context.workflowId || null);
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
      if (!context.simulate) {
        this.countRun(activeWorkflow.id, {
          started: !(context.state && context.state.awaiting),
          result
        });
      }

      // Update workflow execution count
      activeWorkflow.executionCount++;

      logger.info(`Workflow executed for tenant ${tenantId} in ${responseTime}ms`);

      return {
        ...result,
        metadata: {
          ...result.metadata,
          responseTime,
          workflowId: String(activeWorkflow.id),
          workflowName: activeWorkflow.name,
          workflowVersion: activeWorkflow.version,
          executionId: this.generateExecutionId()
        }
      };
    } catch (error) {
      this.updateExecutionStats(tenantId, 0, true);
      if (activeWorkflow && !context.simulate) {
        this.countRun(activeWorkflow.id, { started: !(context.state && context.state.awaiting), error });
      }
      logger.error(`Error executing workflow for tenant ${tenantId}:`, error);
      throw error;
    }
  }

  /**
   * Count one turn of a real conversation against its workflow.
   *
   * A turn that starts the flow from the top is a run. One that ends - no
   * question left waiting - without a person is a completion; one that hands
   * over is a handoff. A failed step is an error.
   */
  countRun(workflowId, { started, result = null, error = null }) {
    if (!workflowId || !mongoose.isValidObjectId(String(workflowId))) {
      return;
    }

    const key = String(workflowId);
    const counts = this.pendingStats.get(key) || { runs: 0, completions: 0, handoffs: 0, errors: 0, lastRunAt: null };

    if (started) {
      counts.runs += 1;
    }

    if (error || (result && (result.success === false || (result.errors && result.errors.length)))) {
      counts.errors += 1;
    } else if (result && result.escalation && result.escalation.enabled !== false) {
      counts.handoffs += 1;
    } else if (result && !(result.state && result.state.awaiting)) {
      counts.completions += 1;
    }

    counts.lastRunAt = new Date();
    this.pendingStats.set(key, counts);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushStats().catch(() => {});
    }, STATS_FLUSH_MS);
    // Never what keeps a process alive.
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /**
   * Write the counted runs to the workflow documents, one `$inc` each.
   *
   * Counts that cannot be written (no database yet) are kept for the next
   * flush rather than dropped.
   */
  async flushStats() {
    // A flush already under way has taken counts out of `pendingStats` but
    // not written them yet; a caller about to read the totals back (the stats
    // route) must wait for it, or it reads the numbers from before.
    if (this.flushing) {
      await this.flushing.catch(() => {});
    }
    if (this.pendingStats.size === 0) {
      return 0;
    }
    if (mongoose.connection.readyState !== 1) {
      this.scheduleFlush();
      return 0;
    }

    const Workflow = require('../models/workflow');
    const batch = [...this.pendingStats.entries()];
    this.pendingStats.clear();

    const writing = this.writeStats(Workflow, batch);
    this.flushing = writing;
    try {
      await writing;
    } finally {
      if (this.flushing === writing) {
        this.flushing = null;
      }
    }

    return batch.length;
  }

  /** One `$inc` per workflow, failures logged and dropped. */
  async writeStats(Workflow, batch) {
    await Promise.all(batch.map(async ([workflowId, counts]) => {
      try {
        await Workflow.updateOne(
          { _id: workflowId },
          {
            $inc: {
              'executionStats.runs': counts.runs,
              'executionStats.completions': counts.completions,
              'executionStats.handoffs': counts.handoffs,
              'executionStats.errors': counts.errors
            },
            $max: { 'executionStats.lastRunAt': counts.lastRunAt }
          }
        );
      } catch (error) {
        logger.warn('Could not record workflow stats', { workflowId, error: error.message });
      }
    }));

    return batch.length;
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
    const set = this.activeWorkflows.get(tenantId);
    const stats = this.executionStats.get(tenantId);
    const workflows = set ? set.workflows : [];

    if (workflows.length === 0) {
      return {
        status: 'not_loaded',
        tenantId
      };
    }

    const describe = entry => ({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      trigger: entry.trigger,
      loadedAt: entry.loadedAt,
      executionCount: entry.executionCount
    });

    return {
      status: 'active',
      tenantId,
      // The primary one, for callers that expect a single workflow.
      workflow: describe(pickEntry(workflows)),
      workflows: workflows.map(describe),
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
   * Unload every workflow for a tenant. The next message reloads whatever is
   * live from the database.
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
   * Stop serving one workflow and leave the tenant's others running - for an
   * unpublish, or a workflow replaced by another that answers everything.
   */
  removeWorkflow(tenantId, workflowId) {
    const set = this.activeWorkflows.get(tenantId);
    if (!set) {
      return false;
    }

    const before = set.workflows.length;
    set.workflows = set.workflows.filter(entry => String(entry.id) !== String(workflowId));

    if (set.workflows.length === 0) {
      this.unloadWorkflow(tenantId);
    }
    return set.workflows.length !== before;
  }

  /**
   * Health check for the runtime service
   */
  getHealthStatus() {
    return {
      status: 'healthy',
      activeWorkflows: [...this.activeWorkflows.values()]
        .reduce((sum, set) => sum + set.workflows.length, 0),
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
   * Clean up resources. Counted runs are written on the way out, best effort.
   */
  shutdown() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingStats.size > 0) {
      this.flushStats().catch(() => {});
    }
    this.activeWorkflows.clear();
    this.executionStats.clear();
    this.removeAllListeners();
    logger.info('Workflow runtime service shut down');
  }
}

/**
 * The entry for a workflow id, or the primary one: the live workflow that
 * answers everything, else the only one, else the oldest published.
 */
function pickEntry(workflows = [], workflowId = null) {
  if (workflowId) {
    return workflows.find(entry => String(entry.id) === String(workflowId)) || null;
  }
  if (workflows.length === 0) {
    return null;
  }
  return workflows.find(entry => !entry.trigger || entry.trigger.type === 'always') || workflows[0];
}

/**
 * Whether a cached entry and the published record are the same release:
 * the same workflow, served at the same version, published at the same time.
 */
function sameRelease(cached, current) {
  const cachedPublished = cached.publishedAt ? new Date(cached.publishedAt).getTime() : null;
  const currentPublished = current.publishedAt ? new Date(current.publishedAt).getTime() : null;
  const servedVersion = current.liveVersion || current.version;

  return String(cached.id) === String(current._id) &&
    cached.version === servedVersion &&
    cachedPublished === currentPublished;
}

module.exports = WorkflowRuntimeService;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
module.exports.STATS_FLUSH_MS = STATS_FLUSH_MS;
module.exports.pickEntry = pickEntry;
