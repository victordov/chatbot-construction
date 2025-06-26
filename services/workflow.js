/**
 * Workflow service for managing visual workflow editor operations
 */

const Workflow = require('../models/workflow');
const WorkflowVersion = require('../models/workflow-version');
const KnowledgeSource = require('../models/knowledge-source');
const WorkflowCompilerService = require('./workflow-compiler');
const { logger } = require('./logging');

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
        company,
        createdBy: user.id,
        version: 1
      });
      
      // Compile workflow if it has nodes
      if (workflowData.nodes && workflowData.nodes.length > 0) {
        const compiledChain = await this.compileWorkflow(workflowData, company);
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
      let filter = {};
      
      // Apply company filtering based on user role
      if (userRole === 'superadmin') {
        // Super admin can see all workflows
        if (status) filter.status = status;
      } else {
        // Regular users see only their company's workflows
        filter.company = userCompanyId;
        if (status) filter.status = status;
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
   * Validate workflow structure
   */
  validateWorkflow(workflowData) {
    const { nodes = [], edges = [] } = workflowData;
    
    if (nodes.length === 0) {
      return; // Empty workflow is valid for drafts
    }
    
    // Check for required node types
    const nodeTypes = nodes.map(node => node.type);
    
    // Must have at least one persona node for complete workflows
    if (!nodeTypes.includes('persona')) {
      throw new Error('Workflow must contain at least one persona node');
    }
    
    // Validate node structure
    nodes.forEach((node, index) => {
      if (!node.id || !node.type || !node.position) {
        throw new Error(`Invalid node structure at index ${index}`);
      }
      
      if (!node.position.x !== undefined || node.position.y === undefined) {
        throw new Error(`Invalid node position at index ${index}`);
      }
      
      // Validate node-specific data
      this.validateNodeData(node);
    });
    
    // Validate edges
    const nodeIds = new Set(nodes.map(n => n.id));
    edges.forEach((edge, index) => {
      if (!edge.id || !edge.source || !edge.target) {
        throw new Error(`Invalid edge structure at index ${index}`);
      }
      
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new Error(`Edge references non-existent node at index ${index}`);
      }
    });
    
    // Check for cycles (simple detection)
    this.detectCycles(nodes, edges);
  }
  
  /**
   * Validate node-specific data
   */
  validateNodeData(node) {
    switch (node.type) {
      case 'persona':
        if (!node.data || !node.data.prompt || node.data.prompt.trim().length === 0) {
          throw new Error(`Persona node ${node.id} must have a prompt`);
        }
        break;
        
      case 'knowledge':
        if (!node.data || !node.data.sourceType) {
          throw new Error(`Knowledge node ${node.id} must have a source type`);
        }
        
        // Validate source-specific configuration
        switch (node.data.sourceType) {
          case 'google_sheets':
            if (!node.data.config || !node.data.config.sheetId) {
              throw new Error(`Knowledge node ${node.id} with Google Sheets source must have a sheet ID`);
            }
            break;
          case 'pdf':
          case 'url':
            if (!node.data.config || (!node.data.config.url && !node.data.config.filePath)) {
              throw new Error(`Knowledge node ${node.id} must have a URL or file path`);
            }
            break;
          case 'vector_store':
            if (!node.data.config || !node.data.config.collectionName) {
              throw new Error(`Knowledge node ${node.id} with vector store source must have a collection name`);
            }
            break;
        }
        break;
        
      case 'moderation':
        // Moderation nodes are always valid as they use platform defaults
        break;
        
      case 'router':
        if (!node.data || !node.data.conditions || !Array.isArray(node.data.conditions)) {
          throw new Error(`Router node ${node.id} must have conditions array`);
        }
        break;
        
      case 'fallback':
        if (!node.data || !node.data.message || node.data.message.trim().length === 0) {
          throw new Error(`Fallback node ${node.id} must have a message`);
        }
        break;
        
      default:
        throw new Error(`Unknown node type: ${node.type}`);
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
      if (recStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      
      visited.add(nodeId);
      recStack.add(nodeId);
      
      const neighbors = graph[nodeId] || [];
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) return true;
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

module.exports = new WorkflowService();
