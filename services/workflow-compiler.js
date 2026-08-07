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
 *                   `fallback`, `operator-handoff`, `action`. These are wired
 *                   together and walked at execution time.
 *
 * The distinction matters: the previous validator treated every unconnected
 * node as an orphan, so a workflow with a persona and a start node - the
 * minimum viable workflow - failed validation.
 */

const { OpenAI } = require('openai');
const KnowledgeConnectorService = require('./knowledge-connector');
const { logger } = require('./logging');
const { getIntentClassifier } = require('./intent-classifier');
const workflowActions = require('./workflow-actions');
const nodes = require('./workflow-nodes');

const CONFIGURATION_NODES = new Set(['persona', 'moderation']);

/** Node types the executor knows how to run. */
const FLOW_NODES = new Set([
  'start', 'knowledge', 'knowledge-source', 'llm',
  'response', 'router', 'fallback', 'operator-handoff', 'action',
  // Nodes that make a workflow a conversation rather than a single reply.
  'ask', 'buttons', 'condition', 'set', 'business-hours', 'tag', 'task', 'notify'
]);

/** Nodes that stop the walk and wait for the visitor to answer. */
const WAITING_NODES = new Set(['ask', 'buttons']);

/**
 * Nodes that legitimately have more than one output, and the handles they use.
 *
 * Everything else with two outgoing edges is ambiguous - the executor would
 * follow whichever happened to be first - so it is rejected at design time.
 */
const BRANCHING_NODES = new Map([
  ['router', null],
  ['action', ['success', 'error']],
  ['condition', ['true', 'false']],
  ['business-hours', ['open', 'closed']],
  // One output per choice, plus a fallback for an answer that matched none.
  ['buttons', null],
  // An answer that fails validation too many times takes its own path.
  ['ask', ['next', 'invalid']]
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
      const count = outgoing.get(node.id) || 0;

      if (!BRANCHING_NODES.has(type) && count > 1) {
        errors.push(
          `"${node.data?.label || node.id}" has ${count} outgoing connections. ` +
          'Only Router and Action nodes can branch - use a Router to choose between paths.'
        );
      }

      // An action node's destination is checked here, at design time, so a bad
      // URL is a validation error in the editor rather than a failed call in
      // front of a customer.
      if (type === 'action') {
        errors.push(...this.validateActionNode(node, edges, warnings));
      }
    });

    if (this.detectCycles(nodes, edges)) {
      errors.push('Workflow contains a cycle, which would loop forever at runtime');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Check an action node's configuration.
   *
   * A URL containing `{{placeholders}}` cannot be fully validated until it is
   * rendered, so the check is run against the template with the placeholders
   * removed - enough to catch a missing scheme or a private address, without
   * rejecting a legitimately dynamic URL.
   */
  validateActionNode(node, edges = [], warnings = []) {
    const errors = [];
    const data = node.data || {};
    const name = data.label || node.id;

    if (!data.url) {
      errors.push(`"${name}" needs the URL of the API to call`);
    } else {
      const probe = String(data.url).replace(/\{\{\s*[\w.]+\s*\}\}/g, 'x');
      const check = workflowActions.validateUrl(probe);
      if (!check.valid) {
        errors.push(`"${name}": ${check.error}`);
      }
    }

    if (data.method && !workflowActions.ALLOWED_METHODS.has(String(data.method).toUpperCase())) {
      errors.push(`"${name}" uses an unsupported method "${data.method}"`);
    }

    if (data.body && String(data.method || 'GET').toUpperCase() !== 'GET') {
      try {
        // Placeholders are replaced with a quoted string first so a template
        // like {"id": "{{order_id}}"} parses.
        JSON.parse(String(data.body).replace(/\{\{\s*[\w.]+\s*\}\}/g, 'x'));
      } catch {
        errors.push(`"${name}" has a request body that is not valid JSON`);
      }
    }

    // A warning, not an error: the workflow still runs, but an API that is
    // down or slow will drop the visitor into the generic fallback with no
    // acknowledgement that anything was attempted.
    const handles = edges.filter(e => e.source === node.id).map(e => e.sourceHandle);
    if (handles.length > 0 && !handles.includes('error')) {
      warnings.push(
        `"${name}" has nothing connected to its Failed output. If the API is ` +
        'down the visitor will get the generic fallback message.'
      );
    }

    return errors;
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
      },
      // Recorded for the editor and for support: which external systems this
      // workflow reaches out to. Credentials are deliberately not included.
      actions: []
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
      case 'action':
        chainConfig.actions.push({ id: node.id, label: node.data.label, url: node.data.url });
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
   * Pick up where the last turn left off.
   *
   * Returns null when there is nothing to resume, so a fresh conversation
   * simply starts at the entry point.
   *
   * @returns {{nextId: string|null}|{reprompt: string, state: object}|null}
   */
  resume(steps, state, userMessage, variables) {
    const awaiting = state && state.awaiting;

    if (!awaiting || !awaiting.nodeId) {
      return null;
    }

    const step = steps[awaiting.nodeId];

    if (!step) {
      // The workflow was edited and the node is gone. Starting again is the
      // only coherent option, and it is better than replying to a question
      // that no longer exists.
      return null;
    }

    const edges = step.next || [];
    const attempts = (awaiting.attempts || 0) + 1;
    const maxAttempts = awaiting.maxAttempts || nodes.MAX_ASK_ATTEMPTS;

    if (awaiting.kind === 'choice') {
      const choice = nodes.matchChoice(userMessage, awaiting.choices);

      if (choice) {
        variables[awaiting.variable] = choice.value;
        const named = edges.find(edge => edge.handle === choice.id);
        return { nextId: named ? named.target : (edges[0] && edges[0].target) || null };
      }

      if (attempts >= maxAttempts) {
        // Stop asking. Somebody typing something else three times over is
        // telling you the buttons do not cover their problem.
        const other = edges.find(edge => edge.handle === 'other');
        return { nextId: other ? other.target : null };
      }

      return {
        reprompt: 'Sorry — could you pick one of those options?',
        choices: awaiting.choices,
        state: { ...state, awaiting: { ...awaiting, attempts } }
      };
    }

    const result = nodes.validateAnswer(userMessage, awaiting.kind, awaiting.pattern);

    if (result.valid) {
      variables[awaiting.variable] = result.value;
      const next = edges.find(edge => edge.handle === 'next') ||
        edges.find(edge => !edge.handle) || edges[0];
      return { nextId: next ? next.target : null };
    }

    if (attempts >= maxAttempts) {
      // Give up on the question rather than trapping somebody in a loop. The
      // `invalid` branch is where a flow hands over to a person.
      const invalid = edges.find(edge => edge.handle === 'invalid');
      return { nextId: invalid ? invalid.target : null };
    }

    return {
      reprompt: result.message,
      state: { ...state, awaiting: { ...awaiting, attempts } }
    };
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

    // Variables carried over from earlier turns come first, so an answer
    // collected three messages ago is still available; the current message
    // always wins over a stale copy of itself.
    const carried = (context.state && context.state.variables) || {};

    const variables = {
      ...carried,
      user_input: userMessage,
      user_message: userMessage,
      knowledge_result: knowledgeContext,
      ...context.variables
    };

    let currentId = entryPoint;
    let response = null;
    let escalate = null;
    let choices = null;
    let awaiting = null;
    const visited = [];
    const actionRuns = [];
    // What a preview run declined to do for real. Empty on a live run.
    const simulated = [];

    // Resume, if the last turn stopped at a question.
    //
    // Without this the walk restarts from the entry point on every message, so
    // a workflow could never ask anything: the answer would be treated as a
    // brand new conversation and the question asked again, forever.
    const resumed = this.resume(steps, context.state, userMessage, variables);

    if (resumed) {
      if (resumed.reprompt) {
        // The answer did not validate and there are attempts left, so the
        // question is asked again rather than the flow moving on with a value
        // it knows is wrong.
        return {
          success: true,
          response: resumed.reprompt,
          choices: resumed.choices,
          state: resumed.state,
          metadata: { path: [], tenantId, awaiting: true }
        };
      }
      currentId = resumed.nextId;
    }

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
        // Must be awaited: intent conditions resolve asynchronously, and a
        // pending Promise here would look like "no match" to
        // resolveRouterTarget and silently take the default branch.
        const match = await this.evaluateRouting(userMessage, {
          conditions: step.data.conditions || [],
          fallback: routing.fallback
        });
        nextId = this.resolveRouterTarget(step, match);
        break;
      }

      case 'action': {
        // The call the whole node exists for. Its result becomes variables the
        // rest of the walk can use, so a downstream reply can say "your order
        // shipped on Tuesday" rather than "let me look into that".
        const result = await workflowActions.execute(step.data, variables, {
          simulate: context.simulate
        });

        if (result.simulated) {
          simulated.push(...result.simulated);
        }

        Object.assign(variables, result.variables);
        variables.action_status = result.ok ? 'success' : 'failed';
        variables.action_error = result.ok ? '' : result.error;

        actionRuns.push({
          node: currentId,
          label: step.data.label || 'Action',
          ok: result.ok,
          status: result.status,
          durationMs: result.durationMs
        });

        if (!result.ok) {
          logger.warn('Workflow action node failed', {
            tenantId, node: currentId, error: result.error
          });
        }

        nextId = this.resolveActionTarget(step, result.ok);
        break;
      }

      case 'ask':
      case 'buttons':
      case 'condition':
      case 'set':
      case 'business-hours':
      case 'tag':
      case 'task':
      case 'notify': {
        const outcome = await this.runNode(step.type, step, {
          currentId,
          variables,
          companyId: tenantId,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          simulate: context.simulate,
          render: template => this.renderTemplate(template, variables)
        });

        Object.assign(variables, outcome.variables || {});

        if (outcome.simulated) {
          simulated.push(...outcome.simulated);
        }

        if (outcome.response) {
          response = outcome.response;
        }
        if (outcome.choices) {
          choices = outcome.choices;
        }

        if (outcome.awaiting) {
          // The visitor now has a question in front of them. Stop here and
          // remember where, so their answer resumes rather than restarting.
          awaiting = outcome.awaiting;
          nextId = null;
          break;
        }

        nextId = outcome.branch
          ? this.resolveBranch(step, outcome.branch)
          : nextId;
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

        if (context.simulate) {
          // Nothing is assigned here even on a live run — the socket layer does
          // that — but the author still needs to see that the flow reached a
          // handover, because "the bot went quiet" is what it looks like
          // otherwise.
          simulated.push({ description: 'Hand the conversation to an operator' });
        }

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
      // Buttons for the widget to render, when the last node offered any.
      choices,
      // Only populated on a preview run: what was declined rather than done.
      simulated,
      // Handed back to the caller to persist on the conversation. Without it
      // the next message would start the workflow again from the top.
      state: {
        awaiting,
        variables: this.persistableVariables(variables)
      },
      metadata: {
        knowledgeUsed: Boolean(knowledgeContext),
        path: visited,
        // Surfaced so an operator picking up the conversation, and the
        // analytics view, can see the bot actually did something rather than
        // only said something.
        actions: actionRuns,
        tenantId
      }
    };
  }

  /**
   * Dispatch to the node implementations in workflow-nodes.
   *
   * A failing node returns nothing rather than throwing: one broken step
   * should degrade the conversation, not end it.
   */
  async runNode(type, step, context) {
    const handlers = {
      ask: nodes.runAsk,
      buttons: nodes.runButtons,
      condition: nodes.runCondition,
      set: nodes.runSet,
      'business-hours': nodes.runBusinessHours,
      tag: nodes.runTag,
      task: nodes.runTask,
      notify: nodes.runNotify
    };

    const handler = handlers[type];

    if (!handler) {
      return {};
    }

    try {
      return (await handler(step, context)) || {};
    } catch (error) {
      logger.error('Workflow node failed', { type, error: error.message });
      return {};
    }
  }

  /**
   * Follow a named output.
   *
   * Falls through to the only edge when a node has one, so a condition wired
   * to a single next step still works while the author is building it up.
   */
  resolveBranch(step, branch) {
    const edges = step.next || [];
    const named = edges.find(edge => edge.handle === branch);

    if (named) {
      return named.target;
    }

    if (edges.length === 1 && !edges[0].handle) {
      return edges[0].target;
    }

    return null;
  }

  /**
   * Pick the branch an action node takes.
   *
   * A workflow that only draws the success path still works: a failure simply
   * ends the walk and the fallback answers, which is better than following the
   * success path with no data and telling the customer their order shipped.
   */
  resolveActionTarget(step, ok) {
    const edges = step.next || [];
    const wanted = ok ? 'success' : 'error';

    const named = edges.find(e => e.handle === wanted);
    if (named) {
      return named.target;
    }

    // One unlabelled output is the simple case - a single "then" - and only
    // applies on success.
    if (ok && edges.length === 1 && !edges[0].handle) {
      return edges[0].target;
    }

    return null;
  }

  /**
   * The variables worth carrying to the next turn.
   *
   * The current message and the retrieved knowledge are per-turn by nature;
   * keeping them would mean a question answered two turns ago silently
   * referring to the wrong message.
   */
  persistableVariables(variables) {
    const transient = new Set([
      'user_input', 'user_message', 'knowledge_result', 'action_error'
    ]);

    return Object.fromEntries(
      Object.entries(variables)
        .filter(([key, value]) => !transient.has(key) && value !== undefined && value !== null)
        // Capped: this is persisted on the conversation, and a workflow that
        // accumulated a variable per turn would grow without limit.
        .slice(0, 50)
        .map(([key, value]) => [key, String(value).slice(0, 2000)])
    );
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

    // The editor gives a router one output per condition plus an "Otherwise"
    // output on the `default` handle.
    const defaultEdge = edges.find(e => e.handle === 'default');

    if (match.type === 'matched' && match.condition) {
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
    } else if (defaultEdge) {
      // Nothing matched, so take the "Otherwise" branch.
      //
      // This used to fall through to `edges[0]`, which is whichever condition
      // happened to be wired first - so an unmatched message was routed as if
      // it had matched the first rule. A visitor asking about opening hours
      // would be handed to the refunds team.
      return defaultEdge.target;
    }

    if (step.data.defaultRoute) {
      return step.data.defaultRoute;
    }

    if (defaultEdge) {
      return defaultEdge.target;
    }

    // No default branch was drawn. Only fall back to the first edge when the
    // router has exactly one output, where there is no ambiguity about intent.
    if (edges.length === 1) {
      return edges[0].target;
    }

    logger.warn('Router had no matching condition and no default branch; ending the walk', {
      node: step.data?.label || 'router',
      outputs: edges.length
    });
    return null;
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
   * Evaluate routing conditions.
   *
   * Async because `intent` conditions need an embedding of the message. The
   * other condition types resolve without any I/O, and are evaluated first so
   * a workflow that uses only those never pays for a network round trip.
   */
  async evaluateRouting(userMessage, routing) {
    const { conditions = [] } = routing;
    const message = String(userMessage || '').toLowerCase();

    const intentConditions = [];

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
          // The pattern is authored by a tenant admin, not a visitor, but a
          // catastrophically backtracking pattern would still hang the
          // request for every conversation. Cap the input length so the
          // worst case stays bounded.
          if (new RegExp(value, 'i').test(message.slice(0, 2000))) {
            return { type: 'matched', condition };
          }
        } catch {
          logger.warn(`Router condition has an invalid regex: ${value}`);
        }
        break;

      case 'intent':
        // Deferred: literal matches are cheaper and should win outright.
        intentConditions.push(condition);
        break;

      default:
        break;
      }
    }

    // No literal rule matched, so fall back to semantic intent matching.
    if (intentConditions.length > 0) {
      const result = await getIntentClassifier().classify(userMessage, intentConditions);

      if (result.matched) {
        return { type: 'matched', condition: result.intent, score: result.score, scores: result.scores };
      }

      return { type: 'default', shouldFallback: true, scores: result.scores };
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
