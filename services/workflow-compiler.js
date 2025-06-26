/**
 * Workflow Compiler Service
 * Converts React Flow graph data into executable LCEL/LangGraph chains
 */

const { OpenAI } = require('openai');
const KnowledgeConnectorService = require('./knowledge-connector');

class WorkflowCompilerService {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.knowledgeService = new KnowledgeConnectorService();
    
    // Root system prompt that's never editable by tenants
    this.rootSystemPrompt = `You are a helpful AI assistant. You must follow all safety guidelines and provide accurate, helpful responses. Never generate harmful, illegal, or inappropriate content. Always maintain a professional and respectful tone.`;
  }

  /**
   * Compile a React Flow workflow into an executable plan
   */
  async compileWorkflow(nodes, edges, tenantId) {
    try {
      // Validate the workflow
      const validation = this.validateWorkflow(nodes, edges);
      if (!validation.valid) {
        throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
      }

      // Build execution plan
      const executionPlan = this.buildExecutionPlan(nodes, edges);
      
      // Generate the compiled chain
      const compiledChain = await this.generateCompiledChain(executionPlan, tenantId);

      return {
        success: true,
        executionPlan,
        compiledChain,
        metadata: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          compiledAt: new Date().toISOString(),
          tenantId
        }
      };
    } catch (error) {
      console.error('Error compiling workflow:', error);
      throw error;
    }
  }

  /**
   * Validate workflow structure
   */
  validateWorkflow(nodes, edges) {
    const errors = [];

    // Check for required nodes
    const nodeTypes = nodes.map(n => n.data.type);
    
    if (!nodeTypes.includes('persona')) {
      errors.push('Workflow must include at least one Persona node');
    }

    // Check for orphaned nodes
    const connectedNodes = new Set();
    edges.forEach(edge => {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    });

    const orphanedNodes = nodes.filter(node => !connectedNodes.has(node.id));
    if (orphanedNodes.length > 1) { // Allow one starting node
      errors.push(`Found ${orphanedNodes.length} orphaned nodes`);
    }

    // Check for cycles (basic check)
    const hasCycle = this.detectCycles(nodes, edges);
    if (hasCycle) {
      errors.push('Workflow contains cycles which may cause infinite loops');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Detect cycles in the workflow
   */
  detectCycles(nodes, edges) {
    const visited = new Set();
    const recursionStack = new Set();

    const dfs = (nodeId) => {
      if (recursionStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;

      visited.add(nodeId);
      recursionStack.add(nodeId);

      const outgoingEdges = edges.filter(edge => edge.source === nodeId);
      for (const edge of outgoingEdges) {
        if (dfs(edge.target)) return true;
      }

      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) return true;
      }
    }

    return false;
  }

  /**
   * Build execution plan from nodes and edges
   */
  buildExecutionPlan(nodes, edges) {
    // Find entry point (node with no incoming edges)
    const targetNodes = new Set(edges.map(e => e.target));
    const entryNodes = nodes.filter(node => !targetNodes.has(node.id));
    
    if (entryNodes.length === 0) {
      throw new Error('No entry point found in workflow');
    }

    // Build execution graph
    const executionGraph = {};
    
    nodes.forEach(node => {
      executionGraph[node.id] = {
        id: node.id,
        type: node.data.type,
        data: node.data,
        next: edges.filter(e => e.source === node.id).map(e => e.target),
        previous: edges.filter(e => e.target === node.id).map(e => e.source)
      };
    });

    return {
      entryPoint: entryNodes[0].id,
      graph: executionGraph,
      nodeOrder: this.topologicalSort(nodes, edges)
    };
  }

  /**
   * Topological sort for execution order
   */
  topologicalSort(nodes, edges) {
    const inDegree = {};
    const adjList = {};
    
    // Initialize
    nodes.forEach(node => {
      inDegree[node.id] = 0;
      adjList[node.id] = [];
    });

    // Build adjacency list and calculate in-degrees
    edges.forEach(edge => {
      adjList[edge.source].push(edge.target);
      inDegree[edge.target]++;
    });

    // Kahn's algorithm
    const queue = [];
    const result = [];

    // Find nodes with no incoming edges
    Object.keys(inDegree).forEach(nodeId => {
      if (inDegree[nodeId] === 0) {
        queue.push(nodeId);
      }
    });

    while (queue.length > 0) {
      const current = queue.shift();
      result.push(current);

      adjList[current].forEach(neighbor => {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      });
    }

    return result;
  }

  /**
   * Generate compiled chain for execution
   */
  async generateCompiledChain(executionPlan, tenantId) {
    const { entryPoint, graph } = executionPlan;
    
    // Build the chain configuration
    const chainConfig = {
      tenantId,
      entryPoint,
      steps: {},
      prompts: {
        rootSystem: this.rootSystemPrompt,
        persona: null,
        moderation: {
          enabled: false,
          level: 'medium'
        }
      },
      knowledge: {
        sources: [],
        vectorCollections: []
      },
      routing: {
        conditions: [],
        fallback: null
      }
    };

    // Process each node in the execution plan
    Object.values(graph).forEach(node => {
      switch (node.type) {
        case 'persona':
          chainConfig.prompts.persona = this.compilePersonaNode(node);
          break;
        case 'knowledge':
          chainConfig.knowledge.sources.push(this.compileKnowledgeNode(node, tenantId));
          break;
        case 'moderation':
          chainConfig.prompts.moderation = this.compileModerationNode(node);
          break;
        case 'router':
          chainConfig.routing.conditions.push(this.compileRouterNode(node));
          break;
        case 'fallback':
          chainConfig.routing.fallback = this.compileFallbackNode(node);
          break;
      }

      chainConfig.steps[node.id] = {
        type: node.type,
        data: node.data,
        next: node.next,
        compiled: true
      };
    });

    return chainConfig;
  }

  /**
   * Compile persona node
   */
  compilePersonaNode(node) {
    const { prompt, tone, personality } = node.data;
    
    return {
      userPrompt: prompt || 'You are a helpful assistant.',
      tone: tone || 'professional',
      personality: personality || 'helpful',
      compiled: {
        systemPrompt: `${this.rootSystemPrompt}\n\nPersona: ${prompt}\nTone: ${tone}\nPersonality: ${personality}`
      }
    };
  }

  /**
   * Compile knowledge node
   */
  compileKnowledgeNode(node, tenantId) {
    const { sourceType, config } = node.data;
    
    return {
      id: node.id,
      type: sourceType,
      config,
      collectionName: config.collectionName || `tenant_${tenantId}_knowledge`,
      searchable: true
    };
  }

  /**
   * Compile moderation node
   */
  compileModerationNode(node) {
    const { strictness, filters } = node.data;
    
    return {
      enabled: true,
      level: strictness || 'medium',
      customFilters: filters || [],
      useOpenAIModeration: true
    };
  }

  /**
   * Compile router node
   */
  compileRouterNode(node) {
    const { conditions, defaultRoute } = node.data;
    
    return {
      id: node.id,
      conditions: conditions || [],
      defaultRoute,
      type: 'conditional'
    };
  }

  /**
   * Compile fallback node
   */
  compileFallbackNode(node) {
    const { message, escalation } = node.data;
    
    return {
      message: message || 'I apologize, but I don\'t understand your request.',
      escalation: {
        enabled: escalation?.enabled || false,
        type: escalation?.type || 'operator'
      }
    };
  }

  /**
   * Execute a compiled workflow
   */
  async executeWorkflow(compiledChain, userMessage, chatHistory = [], context = {}) {
    try {
      const { tenantId, prompts, knowledge, routing } = compiledChain;
      
      // Step 1: Apply moderation to user input
      if (prompts.moderation.enabled) {
        const moderationResult = await this.moderateContent(userMessage);
        if (moderationResult.flagged) {
          return {
            response: "I can't assist with that request. Please try rephrasing your question.",
            flagged: true,
            reason: moderationResult.reason
          };
        }
      }

      // Step 2: Get relevant knowledge
      let knowledgeContext = '';
      if (knowledge.sources.length > 0) {
        const knowledgeResults = await this.knowledgeService.getKnowledge(
          userMessage, 
          knowledge.sources, 
          tenantId
        );
        knowledgeContext = knowledgeResults.map(r => r.content).join('\n');
      }

      // Step 3: Build prompt hierarchy
      const systemPrompt = this.buildPromptHierarchy(prompts, knowledgeContext);
      
      // Step 4: Check routing conditions
      const route = this.evaluateRouting(userMessage, routing);
      
      if (route.shouldFallback) {
        return {
          response: routing.fallback?.message || "I'm not sure how to help with that.",
          escalation: routing.fallback?.escalation
        };
      }

      // Step 5: Generate response using OpenAI
      const messages = [
        { role: 'system', content: systemPrompt },
        ...chatHistory.slice(-10), // Last 10 messages for context
        { role: 'user', content: userMessage }
      ];

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
        temperature: 0.7,
        max_tokens: 1000
      });

      const response = completion.choices[0].message.content;

      // Step 6: Final moderation check
      if (prompts.moderation.enabled) {
        const moderationResult = await this.moderateContent(response);
        if (moderationResult.flagged) {
          return {
            response: "I apologize, but I can't provide that response. Let me try to help you differently.",
            flagged: true,
            reason: 'output_moderation'
          };
        }
      }

      return {
        response,
        success: true,
        metadata: {
          knowledgeUsed: knowledge.sources.length > 0,
          route: route.type,
          tenantId
        }
      };

    } catch (error) {
      console.error('Error executing workflow:', error);
      throw error;
    }
  }

  /**
   * Build prompt hierarchy: root_system_prompt → tenant_persona_prompt → user_message → chat_history
   */
  buildPromptHierarchy(prompts, knowledgeContext = '') {
    let systemPrompt = prompts.rootSystem;
    
    if (prompts.persona) {
      systemPrompt += `\n\n${prompts.persona.compiled.systemPrompt}`;
    }

    if (knowledgeContext) {
      systemPrompt += `\n\nRelevant Knowledge:\n${knowledgeContext}`;
    }

    return systemPrompt;
  }

  /**
   * Evaluate routing conditions
   */
  evaluateRouting(userMessage, routing) {
    const { conditions, fallback } = routing;
    
    // Simple condition evaluation (in production, use more sophisticated NLP)
    for (const condition of conditions) {
      const { type, value } = condition;
      
      switch (type) {
        case 'contains':
          if (userMessage.toLowerCase().includes(value.toLowerCase())) {
            return { type: 'matched', condition };
          }
          break;
        case 'intent':
          // Placeholder for intent matching
          break;
        case 'keyword':
          const keywords = value.split(',').map(k => k.trim().toLowerCase());
          if (keywords.some(keyword => userMessage.toLowerCase().includes(keyword))) {
            return { type: 'matched', condition };
          }
          break;
      }
    }

    return { 
      type: 'default', 
      shouldFallback: conditions.length > 0 // If conditions exist but none match
    };
  }

  /**
   * Content moderation using OpenAI
   */
  async moderateContent(content) {
    try {
      const moderation = await this.openai.moderations.create({
        input: content
      });

      const result = moderation.results[0];
      
      return {
        flagged: result.flagged,
        reason: result.flagged ? Object.keys(result.categories).find(cat => result.categories[cat]) : null,
        categories: result.categories
      };
    } catch (error) {
      console.error('Error in content moderation:', error);
      // Fail safe - don't block content if moderation fails
      return { flagged: false };
    }
  }
}

module.exports = WorkflowCompilerService;
