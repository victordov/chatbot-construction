/**
 * Workflow Compiler Service
 *
 * Turns the visual editor's node/edge graph into an execution plan, then runs
 * that plan against a user message.
 *
 * Node kinds fall into two groups:
 *
 *   configuration - `persona`, `moderation`. These configure the whole chain
 *                   and legitimately have no edges.
 *   flow          - `start`, `knowledge-source`, `llm`, `response`, `router`,
 *                   `fallback`, `operator-handoff`. These are wired together
 *                   and walked at execution time.
 *
 * The distinction matters: the previous validator treated every unconnected
 * node as an orphan, so a workflow with a persona and a start node - the
 * minimum viable workflow - failed validation.
 */

const { OpenAI } = require('openai');
const KnowledgeConnectorService = require('./knowledge-connector');
const { logger } = require('./logging');

const CONFIGURATION_NODES = new Set(['persona', 'moderation']);

/** Node types the executor knows how to run. */
const FLOW_NODES = new Set([
  'start', 'knowledge', 'knowledge-source', 'llm',
  'response', 'router', 'fallback', 'operator-handoff'
]);

const MAX_EXECUTION_STEPS = 50;

class WorkflowCompilerService {
  constructor() {
    this.openai = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null;
    this.knowledgeService = new KnowledgeConnectorService();

    // Root system prompt that's never editable by tenants
    this.rootSystemPrompt = 'You are a helpful AI assistant. You must follow all safety guidelines and provide accurate, helpful responses. Never generate harmful, illegal, or inappropriate content. Always maintain a professional and respectful tone.';
  }

  /**
   * Compile a React Flow workflow into an executable plan
   */
  async compileWorkflow(nodes = [], edges = [], tenantId) {
    const validation = this.validateWorkflow(nodes, edges);
    if (!validation.valid) {
      throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
    }

    const executionPlan = this.buildExecutionPlan(nodes, edges);
    const compiledChain = await this.generateCompiledChain(executionPlan, tenantId);

    // Safety and persona prompts are injected here, after the chain config
    // exists, so every LLM node inherits them no matter how the tenant wired
    // the graph. Tenants cannot edit or remove them from the editor.
    this.applyPromptHierarchyToNodes(executionPlan, compiledChain);

    return {
      success: true,
      executionPlan,
      compiledChain,
      warnings: validation.warnings,
      metadata: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        compiledAt: new Date().toISOString(),
        tenantId
      }
    };
  }

  /**
   * Normalise a node into `{ id, type, data, ... }` regardless of whether the
   * type lives on the node or inside `node.data`.
   */
  nodeType(node) {
    return (node.data && node.data.type) || node.type || 'unknown';
  }

  /**
   * Validate workflow structure
   */
  validateWorkflow(nodes = [], edges = []) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(nodes) || nodes.length === 0) {
      // Report every applicable rule rather than short-circuiting, so the
      // editor can show a new user the full set of things to add.
      return {
        valid: false,
        errors: [
          'Workflow must contain at least one node',
          'Workflow must include at least one Persona node'
        ],
        warnings
      };
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    const types = nodes.map(n => this.nodeType(n));

    if (!types.includes('persona')) {
      errors.push('Workflow must include at least one Persona node');
    }

    const duplicateIds = nodes
      .map(n => n.id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      errors.push(`Duplicate node ids: ${[...new Set(duplicateIds)].join(', ')}`);
    }

    // Edges must reference nodes that exist, otherwise the executor walks off
    // the end of the graph at runtime.
    edges.forEach(edge => {
      if (!nodeIds.has(edge.source)) {
        errors.push(`Edge "${edge.id || `${edge.source}->${edge.target}`}" starts at unknown node "${edge.source}"`);
      }
      if (!nodeIds.has(edge.target)) {
        errors.push(`Edge "${edge.id || `${edge.source}->${edge.target}`}" ends at unknown node "${edge.target}"`);
      }
    });

    const unknownTypes = nodes.filter(n => {
      const type = this.nodeType(n);
      return !FLOW_NODES.has(type) && !CONFIGURATION_NODES.has(type);
    });
    unknownTypes.forEach(n => {
      warnings.push(`Node "${n.id}" has unrecognised type "${this.nodeType(n)}" and will be skipped at runtime`);
    });

    // Orphan detection applies only to flow nodes, and only once there is more
    // than one of them: a single flow node is the whole workflow.
    const flowNodes = nodes.filter(n => !CONFIGURATION_NODES.has(this.nodeType(n)));
    if (flowNodes.length > 1) {
      const connected = new Set();
      edges.forEach(edge => {
        connected.add(edge.source);
        connected.add(edge.target);
      });

      const orphaned = flowNodes.filter(node => !connected.has(node.id));
      if (orphaned.length > 0) {
        errors.push(
          `${orphaned.length} node(s) are not connected to anything: ${orphaned.map(n => n.data?.label || n.id).join(', ')}`
        );
      }
    }

    // Only routers branch. Any other node with two outgoing edges is
    // ambiguous - the executor would silently follow whichever happened to be
    // first - so reject it at design time instead.
    const outgoing = new Map();
    edges.forEach(edge => {
      outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + 1);
    });

    nodes.forEach(node => {
      const type = this.nodeType(node);
      if (type !== 'router' && (outgoing.get(node.id) || 0) > 1) {
        errors.push(
          `"${node.data?.label || node.id}" has ${outgoing.get(node.id)} outgoing connections. ` +
          'Only Router nodes can branch - use a Router to choose between paths.'
        );
      }
    });

    if (this.detectCycles(nodes, edges)) {
      errors.push('Workflow contains a cycle, which would loop forever at runtime');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Detect cycles in the workflow
   */
  detectCycles(nodes, edges) {
    const visited = new Set();
    const recursionStack = new Set();
    const outgoing = new Map();

    edges.forEach(edge => {
      if (!outgoing.has(edge.source)) {
        outgoing.set(edge.source, []);
      }
      outgoing.get(edge.source).push(edge.target);
    });

    const dfs = (nodeId) => {
      if (recursionStack.has(nodeId)) {
        return true;
      }
      if (visited.has(nodeId)) {
        return false;
      }

      visited.add(nodeId);
      recursionStack.add(nodeId);

      for (const target of outgoing.get(nodeId) || []) {
        if (dfs(target)) {
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    return nodes.some(node => !visited.has(node.id) && dfs(node.id));
  }

  /**
   * Build execution plan from nodes and edges
   */
  buildExecutionPlan(nodes, edges) {
    const targetNodes = new Set(edges.map(e => e.target));

    const compiledNodes = nodes.map(node => ({
      id: node.id,
      type: this.nodeType(node),
      // Clone so prompt injection does not mutate the caller's node objects
      // (which are the exact documents persisted for the editor).
      data: { ...(node.data || {}) },
      position: node.position,
      next: edges.filter(e => e.source === node.id).map(e => ({
        target: e.target,
        handle: e.sourceHandle || null,
        label: e.label || null
      })),
      previous: edges.filter(e => e.target === node.id).map(e => e.source)
    }));

    const graph = {};
    compiledNodes.forEach(node => {
      graph[node.id] = node;
    });

    // Prefer an explicit `start` node; otherwise the first flow node with no
    // incoming edges. Configuration nodes are never an entry point.
    const flowNodes = compiledNodes.filter(n => !CONFIGURATION_NODES.has(n.type));
    const explicitStart = flowNodes.find(n => n.type === 'start');
    const entryCandidates = flowNodes.filter(n => !targetNodes.has(n.id));
    const entryNode = explicitStart || entryCandidates[0] || flowNodes[0];

    if (!entryNode) {
      throw new Error('No entry point found in workflow: add a Start node');
    }

    return {
      entryPoint: entryNode.id,
      nodes: compiledNodes,
      graph,
      nodeOrder: this.topologicalSort(compiledNodes, edges)
    };
  }

  /**
   * Topological sort for execution order
   */
  topologicalSort(nodes, edges) {
    const inDegree = {};
    const adjList = {};

    nodes.forEach(node => {
      inDegree[node.id] = 0;
      adjList[node.id] = [];
    });

    edges.forEach(edge => {
      // Guard against edges referencing removed nodes.
      if (adjList[edge.source] && inDegree[edge.target] !== undefined) {
        adjList[edge.source].push(edge.target);
        inDegree[edge.target]++;
      }
    });

    const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
    const result = [];

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
    const { entryPoint, nodes } = executionPlan;

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

    nodes.forEach(node => {
      switch (node.type) {
      case 'persona':
        chainConfig.prompts.persona = this.compilePersonaNode(node);
        break;
      case 'knowledge':
      case 'knowledge-source':
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
      default:
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
   * Prepend the immutable safety prompt and the tenant's persona to every LLM
   * node's prompt, then mirror the result back into the chain config's steps.
   */
  applyPromptHierarchyToNodes(executionPlan, chainConfig) {
    const preamble = [
      this.rootSystemPrompt,
      chainConfig.prompts.persona ? chainConfig.prompts.persona.compiled.systemPrompt : null
    ].filter(Boolean).join('\n\n');

    executionPlan.nodes.forEach(node => {
      if (node.type !== 'llm') {
        return;
      }

      const userPrompt = node.data.prompt || '';
      node.data.systemPrompt = preamble;
      node.data.userPrompt = userPrompt;
      node.data.prompt = userPrompt ? `${preamble}\n\n${userPrompt}` : preamble;

      if (chainConfig.steps[node.id]) {
        chainConfig.steps[node.id].data = node.data;
      }
    });
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
        systemPrompt: [
          `Persona: ${prompt || 'You are a helpful assistant.'}`,
          `Tone: ${tone || 'professional'}`,
          `Personality: ${personality || 'helpful'}`
        ].join('\n')
      }
    };
  }

  /**
   * Compile knowledge node
   */
  compileKnowledgeNode(node, tenantId) {
    const { sourceType, config = {} } = node.data;

    return {
      id: node.id,
      type: sourceType || node.data.type,
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
   * Render `{{variable}}` placeholders in a template against the run context.
   */
  renderTemplate(template, variables = {}) {
    if (!template) {
      return '';
    }
    return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
      const value = variables[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /**
   * Execute a compiled workflow by walking the graph from the entry point.
   *
   * The previous implementation ignored the graph entirely and went straight to
   * an OpenAI call, so response/router/fallback nodes drawn in the editor had
   * no effect on the running bot.
   */
  async executeWorkflow(compiledChain, userMessage, chatHistory = [], context = {}) {
    if (!compiledChain || !compiledChain.steps) {
      throw new Error('Workflow has not been compiled');
    }

    const { tenantId, steps, entryPoint } = compiledChain;
    const prompts = compiledChain.prompts || { moderation: { enabled: false } };
    const knowledge = compiledChain.knowledge || { sources: [] };
    const routing = compiledChain.routing || { conditions: [], fallback: null };
    const moderation = prompts.moderation || { enabled: false };

    // Input moderation
    if (moderation.enabled) {
      const result = await this.moderateContent(userMessage);
      if (result.flagged) {
        return {
          success: true,
          response: 'I can\'t assist with that request. Please try rephrasing your question.',
          flagged: true,
          reason: result.reason
        };
      }
    }

    // Knowledge retrieval happens once up front so every node can reference it.
    let knowledgeContext = '';
    if (knowledge.sources.length > 0) {
      try {
        const results = await this.knowledgeService.getKnowledge(
          userMessage,
          knowledge.sources,
          tenantId
        );
        knowledgeContext = (results || []).map(r => r.content).join('\n');
      } catch (error) {
        // A knowledge source being down should degrade the answer, not break
        // the conversation.
        logger.warn('Knowledge retrieval failed, continuing without it', { error: error.message });
      }
    }

    const variables = {
      user_input: userMessage,
      user_message: userMessage,
      knowledge_result: knowledgeContext,
      ...context.variables
    };

    let currentId = entryPoint;
    let response = null;
    let escalate = null;
    const visited = [];

    while (currentId && visited.length < MAX_EXECUTION_STEPS) {
      const step = steps[currentId];
      if (!step) {
        break;
      }

      visited.push(currentId);
      let nextId = step.next && step.next[0] ? step.next[0].target : null;

      switch (step.type) {
      case 'start':
        break;

      case 'knowledge':
      case 'knowledge-source':
        // Already retrieved above; nothing to do while walking.
        break;

      case 'response':
        response = this.renderTemplate(step.data.template || step.data.message, variables);
        nextId = null;
        break;

      case 'llm':
        response = await this.runLlmNode(step, userMessage, chatHistory, knowledgeContext, variables);
        nextId = null;
        break;

      case 'router': {
        const match = this.evaluateRouting(userMessage, {
          conditions: step.data.conditions || [],
          fallback: routing.fallback
        });
        nextId = this.resolveRouterTarget(step, match);
        break;
      }

      case 'fallback':
        response = this.renderTemplate(step.data.message, variables) ||
            routing.fallback?.message ||
            'I\'m not sure how to help with that.';
        escalate = step.data.escalation || routing.fallback?.escalation || null;
        nextId = null;
        break;

      case 'operator-handoff':
        escalate = { enabled: true, type: 'operator' };
        response = this.renderTemplate(step.data.message, variables) ||
            'Let me connect you with a member of our team.';
        nextId = null;
        break;

      default:
        // Unrecognised node: skip to the next one rather than stalling.
        break;
      }

      currentId = nextId;
    }

    if (visited.length >= MAX_EXECUTION_STEPS) {
      logger.warn('Workflow execution hit the step limit', { tenantId, visited: visited.length });
    }

    // Nothing produced a response: fall back to a plain LLM answer so the
    // visitor is never met with silence.
    if (response === null) {
      if (routing.fallback) {
        response = routing.fallback.message;
        escalate = routing.fallback.escalation;
      } else {
        response = await this.runLlmNode(
          { data: {} },
          userMessage,
          chatHistory,
          knowledgeContext,
          variables,
          prompts
        );
      }
    }

    // Output moderation
    if (moderation.enabled && response) {
      const result = await this.moderateContent(response);
      if (result.flagged) {
        return {
          success: true,
          response: 'I apologize, but I can\'t provide that response. Let me try to help you differently.',
          flagged: true,
          reason: 'output_moderation'
        };
      }
    }

    return {
      success: true,
      response,
      escalation: escalate,
      metadata: {
        knowledgeUsed: Boolean(knowledgeContext),
        path: visited,
        tenantId
      }
    };
  }

  /**
   * Run a single LLM node.
   */
  async runLlmNode(step, userMessage, chatHistory, knowledgeContext, variables, prompts = null) {
    const systemPrompt = this.buildPromptHierarchy(
      prompts || { rootSystem: step.data.systemPrompt || this.rootSystemPrompt, persona: null },
      knowledgeContext
    );

    const rendered = this.renderTemplate(step.data.userPrompt || step.data.prompt, variables);

    if (!this.openai) {
      // Without an API key the workflow still runs; it just cannot call out.
      logger.warn('OPENAI_API_KEY is not configured; returning a static reply');
      return 'I\'m not able to answer that right now. Let me get someone to help you.';
    }

    const messages = [
      { role: 'system', content: step.data.systemPrompt || systemPrompt },
      ...chatHistory.slice(-10),
      { role: 'user', content: rendered || userMessage }
    ];

    const completion = await this.openai.chat.completions.create({
      model: step.data.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: step.data.temperature ?? 0.7,
      max_tokens: step.data.maxTokens || 1000
    });

    return completion.choices[0].message.content;
  }

  /**
   * Pick the outgoing edge a router should follow.
   */
  resolveRouterTarget(step, match) {
    const edges = step.next || [];

    if (match.type === 'matched' && match.condition) {
      // Prefer an edge whose handle or label names the matched condition.
      const named = edges.find(e =>
        e.handle === match.condition.id ||
        e.handle === match.condition.route ||
        e.label === match.condition.label
      );
      if (named) {
        return named.target;
      }
      if (match.condition.route) {
        return match.condition.route;
      }
    }

    if (step.data.defaultRoute) {
      return step.data.defaultRoute;
    }

    return edges[0] ? edges[0].target : null;
  }

  /**
   * Build prompt hierarchy: root_system_prompt -> tenant_persona_prompt -> knowledge
   */
  buildPromptHierarchy(prompts, knowledgeContext = '') {
    let systemPrompt = prompts.rootSystem || this.rootSystemPrompt;

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
    const { conditions = [] } = routing;
    const message = String(userMessage || '').toLowerCase();

    for (const condition of conditions) {
      const { type, value } = condition;
      if (!value) {
        continue;
      }

      switch (type) {
      case 'contains':
        if (message.includes(String(value).toLowerCase())) {
          return { type: 'matched', condition };
        }
        break;

      case 'keyword': {
        const keywords = String(value).split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        if (keywords.some(keyword => message.includes(keyword))) {
          return { type: 'matched', condition };
        }
        break;
      }

      case 'regex':
        try {
          if (new RegExp(value, 'i').test(userMessage)) {
            return { type: 'matched', condition };
          }
        } catch {
          logger.warn(`Router condition has an invalid regex: ${value}`);
        }
        break;

      case 'intent':
        // Intent classification is not implemented; treated as no match so a
        // router with only intent conditions falls through to its default.
        break;

      default:
        break;
      }
    }

    return {
      type: 'default',
      shouldFallback: conditions.length > 0
    };
  }

  /**
   * Content moderation using OpenAI
   */
  async moderateContent(content) {
    if (!this.openai) {
      return { flagged: false };
    }

    try {
      const moderation = await this.openai.moderations.create({ input: content });
      const result = moderation.results[0];

      return {
        flagged: result.flagged,
        reason: result.flagged
          ? Object.keys(result.categories).find(cat => result.categories[cat])
          : null,
        categories: result.categories
      };
    } catch (error) {
      logger.error('Error in content moderation', { error: error.message });
      // Fail open: a moderation outage must not silence the bot entirely.
      return { flagged: false };
    }
  }
}

module.exports = WorkflowCompilerService;
