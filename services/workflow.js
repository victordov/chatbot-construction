/**
 * Workflow service for managing visual workflow editor operations
 */

const Workflow = require('../models/workflow');
const WorkflowVersion = require('../models/workflow-version');
const KnowledgeSource = require('../models/knowledge-source');
const WorkflowCompilerService = require('./workflow-compiler');
const secrets = require('./secrets');
const { logger } = require('./logging');

/**
 * Encrypt any credential an action node carries, and keep the one already
 * stored when the editor sends the node back without it.
 *
 * The editor never receives a saved secret - it gets `hasSecret: true` and an
 * empty value - so a save that leaves the field blank must not be read as
 * "clear the credential", or editing a node's URL would silently break its
 * authentication.
 */
function protectNodeSecrets(incomingNodes, existingNodes = []) {
  if (!Array.isArray(incomingNodes)) {
    return incomingNodes;
  }

  const previous = new Map(
    existingNodes.map(node => [node.id, (node.data && node.data.auth) || {}])
  );

  return incomingNodes.map(node => {
    const auth = node.data && node.data.auth;

    if (!auth || !auth.type || auth.type === 'none') {
      // Switching authentication off drops the stored credential rather than
      // leaving it decryptable in a node nobody is looking at any more.
      if (auth) {
        return { ...node, data: { ...node.data, auth: { type: 'none' } } };
      }
      return node;
    }

    const provided = auth.value;
    const stored = previous.get(node.id) || {};

    let value;
    if (provided && !secrets.isEncrypted(provided)) {
      value = secrets.encrypt(provided);
    } else if (provided && secrets.isEncrypted(provided)) {
      value = provided;
    } else {
      value = stored.value || '';
    }

    return {
      ...node,
      data: {
        ...node.data,
        auth: { type: auth.type, header: auth.header, value }
      }
    };
  });
}

/**
 * Strip credentials before a workflow crosses back to a browser.
 *
 * Whether one is set is useful in the editor; the value itself is not, and an
 * admin should not be able to read back a key a colleague entered.
 *
 * This walks the whole document rather than the two or three places a
 * credential is expected. The first version redacted `nodes` and
 * `compiledChain.steps`, and the ciphertext still went out - because the stored
 * chain is actually nested under `compiledChain.compilationResult`, twice over,
 * in the execution plan and the chain config. Anything shaped like an auth
 * block gets redacted wherever it turns up, so a future change to the compiled
 * shape cannot quietly reintroduce the leak.
 *
 * The value is a ciphertext, not a plaintext key, so this was not an immediate
 * disclosure - but handing out the encrypted secret means anyone who later gets
 * the key can decrypt what they already collected.
 */
function redactWorkflow(workflow) {
  if (!workflow) {
    return workflow;
  }

  const plain = typeof workflow.toObject === 'function' ? workflow.toObject() : workflow;

  const isAuthBlock = value =>
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value') &&
    Object.prototype.hasOwnProperty.call(value, 'type');

  // Copies on the way down rather than editing in place: the argument is
  // usually a live mongoose document whose Mixed paths are shared with what the
  // caller goes on to save, and stripping those removed the credential from the
  // workflow being persisted.
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      return value.map(item => walk(item));
    }

    if (!value || typeof value !== 'object' || value instanceof Date ||
        typeof value.toHexString === 'function') {
      return value;
    }

    if (key === 'auth' && isAuthBlock(value)) {
      return { type: value.type || 'none', header: value.header, hasSecret: Boolean(value.value) };
    }

    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, walk(child, childKey)])
    );
  };

  return walk(plain);
}

class WorkflowService {
  constructor() {
    this.compiler = new WorkflowCompilerService();
  }
  /**
   * Create a new workflow
   */
  async createWorkflow(workflowData, user) {
    try {
      // Validate workflow structure
      this.validateWorkflow(workflowData);

      // Set company context for multi-tenancy
      const company = user.role === 'superadmin' ? null : user.company?.id;

      const workflow = new Workflow({
        ...workflowData,
        nodes: protectNodeSecrets(workflowData.nodes),
        company,
        createdBy: user.id,
        version: 1
      });

      // Compile workflow if it has nodes
      if (workflow.nodes && workflow.nodes.length > 0) {
        // Compiled from the protected nodes, so the chain that gets persisted
        // carries the encrypted credential rather than the plaintext one the
        // request arrived with.
        const compiledChain = await this.compileWorkflow(
          { nodes: workflow.nodes, edges: workflow.edges },
          company
        );
        workflow.compiledChain = compiledChain;
      }

      await workflow.save();

      // Save initial version
      await this.saveVersion(workflow, user, 'Initial version');

      logger.info(`Workflow created: ${workflow._id} by user ${user.id}`);
      return workflow;
    } catch (error) {
      logger.error('Error creating workflow:', error);
      throw error;
    }
  }

  /**
   * Get workflows for a company or user
   */
  async getWorkflows(userCompanyId = null, userRole = null, status = null) {
    try {
      const filter = {};

      // Apply company filtering based on user role
      if (userRole === 'superadmin') {
        // Super admin can see all workflows
        if (status) {
          filter.status = status;
        }
      } else {
        // Regular users see only their company's workflows
        filter.company = userCompanyId;
        if (status) {
          filter.status = status;
        }
      }

      const workflows = await Workflow.find(filter)
        .populate('createdBy', 'username displayName')
        .populate('company', 'name')
        .sort({ updatedAt: -1 });

      return workflows;
    } catch (error) {
      logger.error('Error getting workflows:', error);
      throw error;
    }
  }

  /**
   * Get a specific workflow by ID
   */
  async getWorkflow(workflowId, userCompanyId = null, userRole = null) {
    try {
      const query = { _id: workflowId };

      // Apply company filter for regular users
      if (userRole !== 'superadmin' && userCompanyId) {
        query.company = userCompanyId;
      }

      const workflow = await Workflow.findOne(query)
        .populate('createdBy', 'username displayName email')
        .populate('company', 'name description');

      if (!workflow) {
        throw new Error('Workflow not found');
      }

      return workflow;
    } catch (error) {
      logger.error('Error getting workflow:', error);
      throw error;
    }
  }

  /**
   * Update an existing workflow
   */
  async updateWorkflow(workflowId, updateData, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;

      // Get existing workflow
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      // Validate updates
      if (updateData.nodes || updateData.edges) {
        this.validateWorkflow(updateData);
      }

      if (updateData.nodes) {
        updateData.nodes = protectNodeSecrets(updateData.nodes, workflow.nodes);
      }

      // Recompile if structure changed
      if (updateData.nodes || updateData.edges) {
        const workflowForCompilation = {
          nodes: updateData.nodes || workflow.nodes,
          edges: updateData.edges || workflow.edges
        };

        const compiledChain = await this.compileWorkflow(workflowForCompilation, workflow.company);
        updateData.compiledChain = compiledChain;
      }

      // Increment version
      updateData.version = workflow.version + 1;
      updateData.updatedAt = new Date();

      // Update workflow
      Object.assign(workflow, updateData);
      await workflow.save();

      // Save new version
      await this.saveVersion(workflow, user, updateData.changeDescription);

      logger.info(`Workflow updated: ${workflowId} to version ${workflow.version}`);
      return workflow;
    } catch (error) {
      logger.error('Error updating workflow:', error);
      throw error;
    }
  }

  /**
   * Publish a workflow
   */
  async publishWorkflow(workflowId, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      // Validate workflow is ready for publishing
      this.validateForPublishing(workflow);

      // Archive any currently published workflow for this company
      if (workflow.company) {
        await Workflow.updateMany(
          { company: workflow.company, status: 'published' },
          { status: 'archived' }
        );
      }

      // Publish this workflow
      workflow.status = 'published';
      workflow.publishedAt = new Date();
      await workflow.save();

      logger.info(`Workflow published: ${workflowId}`);
      return workflow;
    } catch (error) {
      logger.error('Error publishing workflow:', error);
      throw error;
    }
  }

  /**
   * Get workflow versions
   */
  async getWorkflowVersions(workflowId, userCompanyId = null, userRole = null) {
    try {
      // Verify user has access to this workflow
      await this.getWorkflow(workflowId, userCompanyId, userRole);

      const versions = await WorkflowVersion.getVersionHistory(workflowId, 20);
      return versions;
    } catch (error) {
      logger.error('Error getting workflow versions:', error);
      throw error;
    }
  }

  /**
   * Rollback workflow to a specific version
   */
  async rollbackWorkflow(workflowId, targetVersion, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;

      // Get current workflow and target version
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);
      const targetVersionData = await WorkflowVersion.getVersion(workflowId, targetVersion);

      if (!targetVersionData) {
        throw new Error(`Version ${targetVersion} not found`);
      }

      // Update workflow with target version data
      workflow.nodes = targetVersionData.nodes;
      workflow.edges = targetVersionData.edges;
      workflow.compiledChain = targetVersionData.compiledChain;
      workflow.version = workflow.version + 1; // Increment version for rollback
      workflow.updatedAt = new Date();

      await workflow.save();

      // Save rollback version
      await this.saveVersion(
        workflow,
        user,
        `Rollback to version ${targetVersion}`,
        true,
        targetVersion
      );

      logger.info(`Workflow ${workflowId} rolled back to version ${targetVersion}`);
      return workflow;
    } catch (error) {
      logger.error('Error rolling back workflow:', error);
      throw error;
    }
  }

  /**
   * Delete a workflow
   */
  async deleteWorkflow(workflowId, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      // Check if workflow can be deleted
      if (workflow.status === 'published') {
        throw new Error('Cannot delete a published workflow. Archive it first.');
      }

      // Delete workflow and its versions
      await WorkflowVersion.deleteMany({ workflowId: workflow._id });
      await Workflow.findByIdAndDelete(workflow._id);

      logger.info(`Workflow deleted: ${workflowId}`);
      return { success: true, message: 'Workflow deleted successfully' };
    } catch (error) {
      logger.error('Error deleting workflow:', error);
      throw error;
    }
  }

  /**
   * Get active workflow for a company
   */
  async getActiveWorkflow(companyId) {
    try {
      return await Workflow.getActiveWorkflow(companyId);
    } catch (error) {
      logger.error('Error getting active workflow:', error);
      throw error;
    }
  }

  /**
   * Validate workflow structure.
   *
   * Delegates the graph-level rules (persona present, orphans, cycles, dangling
   * edges) to the compiler so there is one definition of a valid workflow, then
   * layers on the editor-specific checks (positions, per-node config).
   *
   * The previous implementation duplicated the graph rules and got both wrong:
   * it read `node.type` (always the React Flow renderer type, `customNode`)
   * instead of `node.data.type`, so the persona check rejected every workflow;
   * and its position check `!node.position.x !== undefined` is a boolean
   * compared to undefined, which is always true, so it threw for every node.
   * Between them, no workflow could ever be created.
   */
  validateWorkflow(workflowData) {
    const { nodes = [], edges = [] } = workflowData;

    if (nodes.length === 0) {
      return; // Empty workflow is valid for drafts
    }

    const result = this.compiler.validateWorkflow(nodes, edges);
    if (!result.valid) {
      throw new Error(result.errors[0]);
    }

    nodes.forEach((node, index) => {
      if (!node.id || !node.data) {
        throw new Error(`Invalid node structure at index ${index}`);
      }

      // Position is optional for programmatically created workflows, but when
      // present both coordinates must be numbers or the editor cannot render it.
      if (node.position !== undefined) {
        const { x, y } = node.position || {};
        if (typeof x !== 'number' || typeof y !== 'number') {
          throw new Error(`Invalid node position at index ${index}`);
        }
      }

      this.validateNodeData(node);
    });
  }

  /**
   * Validate node-specific data
   */
  validateNodeData(node) {
    const type = (node.data && node.data.type) || node.type;
    const data = node.data || {};
    const config = data.config || {};

    switch (type) {
    case 'persona':
      if (!data.prompt || data.prompt.trim().length === 0) {
        throw new Error(`Persona node ${node.id} must have a prompt`);
      }
      break;

    case 'knowledge':
    case 'knowledge-source': {
      if (!data.sourceType) {
        throw new Error(`Knowledge node ${node.id} must have a source type`);
      }

      switch (data.sourceType) {
      case 'google_sheets':
      case 'google-sheets':
        if (!config.sheetId && !config.spreadsheetId) {
          throw new Error(`Knowledge node ${node.id} with Google Sheets source must have a sheet ID`);
        }
        break;
      case 'pdf':
      case 'url':
      case 'pdf-url':
        if (!config.url && !config.filePath) {
          throw new Error(`Knowledge node ${node.id} must have a URL or file path`);
        }
        break;
      case 'vector_store':
      case 'vector-store':
        if (!config.collectionName && !config.collection) {
          throw new Error(`Knowledge node ${node.id} with vector store source must have a collection name`);
        }
        break;
      default:
        throw new Error(`Knowledge node ${node.id} has an unsupported source type: ${data.sourceType}`);
      }
      break;
    }

    case 'router':
      if (!Array.isArray(data.conditions)) {
        throw new Error(`Router node ${node.id} must have conditions array`);
      }
      break;

    case 'action': {
      if (!data.url || String(data.url).trim().length === 0) {
        throw new Error(`Action node ${node.id} must have a URL`);
      }

      // A mapping with a name but no path would quietly resolve to nothing, so
      // a downstream reply would say "your order is " and stop.
      (data.outputs || []).forEach(output => {
        if (output.variable && !output.path) {
          throw new Error(
            `Action node ${node.id}: "${output.variable}" has no path into the response`
          );
        }
      });
      break;
    }

    case 'fallback':
      if (!data.message || data.message.trim().length === 0) {
        throw new Error(`Fallback node ${node.id} must have a message`);
      }
      break;

    case 'llm':
      if (!data.prompt || data.prompt.trim().length === 0) {
        throw new Error(`LLM node ${node.id} must have a prompt`);
      }
      break;

    case 'response':
      if (!data.template && !data.message) {
        throw new Error(`Response node ${node.id} must have a message template`);
      }
      break;

    case 'start':
    case 'moderation':
    case 'operator-handoff':
      // No extra configuration required.
      break;

    default:
      throw new Error(`Unknown node type: ${type}`);
    }
  }

  /**
   * Validate workflow is ready for publishing
   */
  validateForPublishing(workflow) {
    if (!workflow.nodes || workflow.nodes.length === 0) {
      throw new Error('Cannot publish empty workflow');
    }

    // Must have at least one entry point
    const entryNodes = this.findEntryPoints(workflow.nodes, workflow.edges);
    if (entryNodes.length === 0) {
      throw new Error('Workflow must have at least one entry point');
    }

    // Must have a compiled chain
    if (!workflow.compiledChain) {
      throw new Error('Workflow must be compiled before publishing');
    }
  }

  /**
   * Find entry points in workflow
   */
  findEntryPoints(nodes, edges) {
    const nodeIds = new Set(nodes.map(n => n.id));
    const targetsWithSources = new Set(edges.map(e => e.target));

    return nodes.filter(node => !targetsWithSources.has(node.id));
  }

  /**
   * Simple cycle detection
   */
  detectCycles(nodes, edges) {
    const graph = {};
    const visited = new Set();
    const recStack = new Set();

    // Build adjacency list
    nodes.forEach(node => {
      graph[node.id] = [];
    });

    edges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });

    // DFS to detect cycles
    const hasCycle = (nodeId) => {
      if (recStack.has(nodeId)) {
        return true;
      }
      if (visited.has(nodeId)) {
        return false;
      }

      visited.add(nodeId);
      recStack.add(nodeId);

      const neighbors = graph[nodeId] || [];
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) {
          return true;
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const nodeId of Object.keys(graph)) {
      if (hasCycle(nodeId)) {
        throw new Error('Workflow contains circular dependencies');
      }
    }
  }

  /**
   * Save workflow version
   */
  async saveVersion(workflow, user, changeDescription = null, isRollback = false, rollbackFromVersion = null) {
    try {
      const version = new WorkflowVersion({
        workflowId: workflow._id,
        version: workflow.version,
        nodes: workflow.nodes,
        edges: workflow.edges,
        compiledChain: workflow.compiledChain,
        changeDescription,
        isRollback,
        rollbackFromVersion,
        createdBy: user.id
      });

      await version.save();
      return version;
    } catch (error) {
      logger.error('Error saving workflow version:', error);
      throw error;
    }
  }

  /**
   * Compile workflow using WorkflowCompilerService
   */
  async compileWorkflow(workflowData, tenantId = null) {
    try {
      const nodes = workflowData.nodes || [];
      const edges = workflowData.edges || [];

      if (nodes.length === 0) {
        return {
          compiled: false,
          reason: 'No nodes to compile',
          timestamp: new Date()
        };
      }

      // Use the workflow compiler service
      const compilationResult = await this.compiler.compileWorkflow(nodes, edges, tenantId);

      return {
        compiled: true,
        timestamp: new Date(),
        compilationResult,
        entryPoints: this.findEntryPoints(nodes, edges),
        nodeCount: nodes.length,
        edgeCount: edges.length
      };
    } catch (error) {
      logger.error('Error compiling workflow:', error);
      throw error;
    }
  }
}

const instance = new WorkflowService();

module.exports = instance;
module.exports.redactWorkflow = redactWorkflow;
module.exports.protectNodeSecrets = protectNodeSecrets;
