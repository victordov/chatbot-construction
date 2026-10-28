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
const { wrapKnowledge } = require('./promptEngineering');
const { openaiClientOptions } = require('../config/env');

const CONFIGURATION_NODES = new Set(['persona', 'moderation']);

/** Node types the executor knows how to run. */
const FLOW_NODES = new Set([
  'start', 'knowledge', 'knowledge-source', 'llm',
  'response', 'router', 'fallback', 'operator-handoff', 'action',
  // Nodes that make a workflow a conversation rather than a single reply.
  'ask', 'buttons', 'condition', 'set', 'business-hours', 'tag', 'task', 'notify',
  // Calls into the tenant's own systems through the connector SDK, with shapes
  // we know rather than JSON we guess at.
  'capability'
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
  ['capability', ['success', 'error']],
  // One output per choice, plus a fallback for an answer that matched none.
  ['buttons', null],
  // An answer that fails validation too many times takes its own path.
  ['ask', ['next', 'invalid']]
]);

const MAX_EXECUTION_STEPS = 50;

/**
 * What the editor calls each node type, so a problem names the step the
 * author can see ("Ask for the order number" or "Ask a Question") rather than
 * an internal id like `ask_lq3k9_x81bz2` they have never seen.
 */
const NODE_LABELS = {
  start: 'Start',
  persona: 'Persona',
  knowledge: 'Knowledge',
  'knowledge-source': 'Knowledge',
  llm: 'AI Reply',
  response: 'Fixed Reply',
  router: 'Router',
  moderation: 'Moderation',
  fallback: 'Fallback',
  ask: 'Ask a Question',
  buttons: 'Offer Choices',
  condition: 'Check a Value',
  set: 'Set a Value',
  'business-hours': 'Open or Closed',
  tag: 'Add a Tag',
  task: 'Create a Task',
  capability: 'Use Your Data',
  notify: 'Email the Team',
  action: 'Call an API',
  'operator-handoff': 'Human Handoff'
};

/**
 * Ids end up in the editor's HTML and in CSS selectors, so they are held to a
 * shape that cannot carry markup. The editor's own ids and every template's
 * already fit; this stops one arriving through the API that does not.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Moderation "Strictness", made to mean something.
 *
 * The setting used to be stored and never read. Now:
 *   low     only the categories nobody should ever receive (threats, sexual
 *           content involving minors, self-harm instructions, graphic
 *           violence) - for a business whose customers vent
 *   medium  whatever the moderation model itself flags (the default)
 *   high    that, plus anything scoring above STRICT_SCORE in any category -
 *           for a children's service or a regulated one
 */
const SEVERE_CATEGORIES = [
  'sexual/minors', 'hate/threatening', 'harassment/threatening',
  'self-harm/intent', 'self-harm/instructions', 'violence/graphic', 'illicit/violent'
];
const STRICT_SCORE = 0.2;

class WorkflowCompilerService {
  constructor() {
    this.openai = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...openaiClientOptions() })
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

  /** The name an author knows a node by. */
  nodeLabel(node) {
    const type = this.nodeType(node);
    return (node && node.data && String(node.data.label || '').trim()) || NODE_LABELS[type] || type;
  }

  /**
   * Problems that make a graph unsafe to store at all, as opposed to merely
   * unfinished: ids that could carry markup, nodes with no id or no data,
   * positions the editor cannot draw. A half-built draft may be saved; one of
   * these may not.
   *
   * @returns {Array<{message: string, nodeId: string|null}>}
   */
  structuralProblems(nodes = [], edges = []) {
    const problems = [];

    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return [{ message: 'Nodes and edges must be lists', nodeId: null }];
    }

    nodes.forEach((node, index) => {
      if (!node || typeof node !== 'object' || !node.data || typeof node.data !== 'object') {
        problems.push({ message: `Step ${index + 1} has no configuration`, nodeId: null });
        return;
      }
      if (!SAFE_ID.test(String(node.id || ''))) {
        problems.push({
          message: `"${this.nodeLabel(node)}" has an id that is not allowed. Ids are 1 to 64 letters, digits, "-" or "_".`,
          nodeId: null
        });
      }
      if (node.position !== undefined) {
        const { x, y } = node.position || {};
        if (typeof x !== 'number' || typeof y !== 'number') {
          problems.push({ message: `"${this.nodeLabel(node)}" has no position on the canvas`, nodeId: SAFE_ID.test(String(node.id)) ? node.id : null });
        }
      }
      // Choice and rule ids become output handles, which are drawn into the
      // page exactly like node ids.
      const handles = [
        ...(Array.isArray(node.data.choices) ? node.data.choices : []),
        ...(Array.isArray(node.data.conditions) ? node.data.conditions : [])
      ];
      handles.forEach(item => {
        if (item && item.id !== undefined && item.id !== null && item.id !== '' && !SAFE_ID.test(String(item.id))) {
          problems.push({
            message: `"${this.nodeLabel(node)}" has an output with an id that is not allowed`,
            nodeId: SAFE_ID.test(String(node.id)) ? node.id : null
          });
        }
      });
    });

    edges.forEach((edge, index) => {
      if (!edge || typeof edge !== 'object') {
        problems.push({ message: `Connection ${index + 1} is not a connection`, nodeId: null });
        return;
      }
      if (!SAFE_ID.test(String(edge.id || ''))) {
        problems.push({ message: `Connection ${index + 1} has an id that is not allowed`, nodeId: null });
      }
      if (!SAFE_ID.test(String(edge.source || '')) || !SAFE_ID.test(String(edge.target || ''))) {
        problems.push({ message: `Connection ${index + 1} joins steps with ids that are not allowed`, nodeId: null });
      }
      if (edge.sourceHandle !== undefined && edge.sourceHandle !== null && edge.sourceHandle !== '' &&
          !SAFE_ID.test(String(edge.sourceHandle))) {
        problems.push({ message: `Connection ${index + 1} leaves from an output that is not allowed`, nodeId: null });
      }
    });

    return problems;
  }

  /**
   * Validate workflow structure.
   *
   * Every rule is checked and every problem reported, so the editor can show
   * the whole list at once. `errors` and `warnings` are the messages as
   * strings, for the callers that only print them; `problems` carries the
   * same messages with the node each one is about, so the editor highlights
   * the right node rather than guessing from the text.
   *
   * @returns {{valid: boolean, errors: string[], warnings: string[],
   *            problems: Array<{message: string, nodeId: string|null,
   *                             level: 'error'|'warning'}>}}
   */
  validateWorkflow(nodes = [], edges = []) {
    const problems = [];
    const error = (message, nodeId = null) => problems.push({ message, nodeId, level: 'error' });
    const warning = (message, nodeId = null) => problems.push({ message, nodeId, level: 'warning' });
    const report = () => {
      const errors = problems.filter(p => p.level === 'error').map(p => p.message);
      const warnings = problems.filter(p => p.level === 'warning').map(p => p.message);
      return { valid: errors.length === 0, errors, warnings, problems };
    };

    if (!Array.isArray(nodes) || nodes.length === 0) {
      // Report every applicable rule rather than short-circuiting, so the
      // editor can show a new user the full set of things to add.
      error('Workflow must contain at least one node');
      error('Workflow must include at least one Persona node');
      return report();
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const types = nodes.map(n => this.nodeType(n));

    if (!types.includes('persona')) {
      error('Workflow must include at least one Persona node');
    }

    const duplicateIds = nodes
      .map(n => n.id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    [...new Set(duplicateIds)].forEach(id => {
      error(`Two steps share the same id ("${this.nodeLabel(byId.get(id))}"). Delete one and add it again.`, id);
    });

    // Edges must reference nodes that exist, otherwise the executor walks off
    // the end of the graph at runtime.
    edges.forEach(edge => {
      if (!nodeIds.has(edge.source)) {
        error(
          'A connection starts at a step that no longer exists' +
            (byId.has(edge.target) ? ` (it leads to "${this.nodeLabel(byId.get(edge.target))}")` : ''),
          byId.has(edge.target) ? edge.target : null
        );
      }
      if (!nodeIds.has(edge.target)) {
        error(
          `"${byId.has(edge.source) ? this.nodeLabel(byId.get(edge.source)) : 'A step'}" is connected to a step that no longer exists`,
          byId.has(edge.source) ? edge.source : null
        );
      }
    });

    nodes.forEach(n => {
      const type = this.nodeType(n);
      if (!FLOW_NODES.has(type) && !CONFIGURATION_NODES.has(type)) {
        warning(`"${this.nodeLabel(n)}" is a kind of step this version does not know ("${type}") and will be skipped`, n.id);
      }
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

      flowNodes
        .filter(node => !connected.has(node.id))
        .forEach(node => error(`"${this.nodeLabel(node)}" is not connected to anything`, node.id));
    }

    // A node with one output may have one connection leaving it; a node with
    // several (a router's rules, an action's Worked and Failed) may have one
    // per output. Two leaving the same output is ambiguous - the executor
    // would silently follow whichever happened to be first.
    const perNode = new Map();
    const perHandle = new Map();
    edges.forEach(edge => {
      perNode.set(edge.source, (perNode.get(edge.source) || 0) + 1);
      const handles = perHandle.get(edge.source) || new Map();
      const handle = edge.sourceHandle || '';
      handles.set(handle, (handles.get(handle) || 0) + 1);
      perHandle.set(edge.source, handles);
    });

    nodes.forEach(node => {
      const type = this.nodeType(node);
      const name = this.nodeLabel(node);

      if (!BRANCHING_NODES.has(type)) {
        const count = perNode.get(node.id) || 0;
        if (count > 1) {
          error(`"${name}" has ${count} outgoing connections but only one output. ` +
            'Use a Router or a Check a Value step to choose between paths.', node.id);
        }
      } else {
        const handles = perHandle.get(node.id) || new Map();
        if ([...handles.values()].some(count => count > 1)) {
          error(`"${name}" has two connections leaving the same output. Each output can lead to one step.`, node.id);
        }
      }

      // An action node's destination is checked here, at design time, so a bad
      // URL is a validation error in the editor rather than a failed call in
      // front of a customer.
      if (type === 'action') {
        const actionWarnings = [];
        this.validateActionNode(node, edges, actionWarnings).forEach(message => error(message, node.id));
        actionWarnings.forEach(message => warning(message, node.id));
      }

      // Likewise every regular expression a tenant wrote: an invalid or
      // catastrophically slow one is refused here, with the node named, rather
      // than hanging the bot for whoever types the wrong thing.
      this.validatePatterns(node).forEach(message => error(message, node.id));
    });

    if (this.detectCycles(nodes, edges)) {
      error('Workflow contains a loop, which would run forever. Remove one of the connections that leads back.');
    }

    // The blank starter used to be Persona, Start and AI Reply with nothing in
    // between, so publishing it stopped the bot reading the knowledge base it
    // had been answering from. A workflow that writes its own answers and
    // never looks anything up is almost always that mistake. A warning, not
    // an error: a flow that only chats is allowed, just rarely meant.
    const hasKnowledge = types.some(type => type === 'knowledge' || type === 'knowledge-source');
    const speaks = types.some(type => ['response', 'fallback', 'operator-handoff', 'ask', 'buttons'].includes(type));
    const writesFreely = types.includes('llm') || !speaks;
    if (!hasKnowledge && writesFreely) {
      const llm = nodes.find(n => this.nodeType(n) === 'llm');
      warning('This workflow writes its own answers but has no Knowledge step, so it answers without ' +
        'your knowledge base. Add a Knowledge step before the AI Reply.', llm ? llm.id : null);
    }

    return report();
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
    const name = this.nodeLabel(node);

    if (data.actionId) {
      // A saved Action was validated when it was saved; only the reference
      // can be checked here, because validation has no tenant to look it up
      // against. A missing one fails down the error branch at run time.
      if (!/^[a-f0-9]{24}$/i.test(String(data.actionId))) {
        errors.push(`"${name}" has an invalid saved action reference`);
      }
    } else if (!data.url) {
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
      // Placeholders are replaced with a literal of the right kind first, so
      // both {"id": "{{order_id}}"} and {"count": {{count}}} parse.
      if (!workflowActions.isJsonTemplate(data.body)) {
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
   * Every regular expression a node carries, checked and compiled once.
   *
   * Three places take one: a router condition of type `regex`, an Ask node's
   * `pattern`, and a Check node clause using `matches`. The compiled form is
   * cached by workflow-nodes so the run path never constructs it again.
   */
  validatePatterns(node) {
    const errors = [];
    const data = node.data || {};
    const name = this.nodeLabel(node);
    const type = this.nodeType(node);

    const check = (pattern, flags, where) => {
      if (pattern === undefined || pattern === null || pattern === '') {
        return;
      }
      const compiled = nodes.compilePattern(String(pattern), flags);
      if (compiled.error) {
        errors.push(`"${name}" ${where}: ${compiled.error}`);
      }
    };

    if (type === 'router') {
      (data.conditions || []).forEach((condition, index) => {
        if (condition && condition.type === 'regex') {
          check(condition.value, 'i', `condition ${index + 1}`);
        }
      });
    }

    if (type === 'ask') {
      check(data.pattern, '', 'answer pattern');
    }

    if (type === 'condition') {
      const clauses = Array.isArray(data.clauses) && data.clauses.length > 0 ? data.clauses : [data];
      clauses.forEach((clause, index) => {
        if (clause && clause.operator === 'matches') {
          check(clause.right, 'i', `clause ${index + 1}`);
        }
      });
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
    // An inherited persona has no text of its own here: it is looked up when
    // the workflow runs (see inheritedPersona), so a change on the Persona
    // screen reaches the workflow without republishing it.
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

    // The blank starter's persona says "You are a helpful assistant." It used
    // to replace whatever the tenant wrote on the Persona screen the moment
    // the starter was published. Until somebody edits it, it defers to that
    // screen instead.
    if (inheritsPersona(node.data)) {
      return {
        inherit: true,
        userPrompt: null,
        tone: null,
        personality: null,
        compiled: { systemPrompt: null }
      };
    }

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
      level: ['low', 'medium', 'high'].includes(strictness) ? strictness : 'medium',
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

        if (awaiting.next) {
          // Results offered as buttons by a Use Your Data step: whichever was
          // tapped, the flow carries on down one output, with the pick saved.
          variables[`${awaiting.variable}_label`] = choice.label;
          const onward = edges.find(edge => edge.handle === awaiting.next) ||
            (edges.length === 1 && !edges[0].handle ? edges[0] : null);
          return { nextId: onward ? onward.target : null };
        }

        const named = edges.find(edge => edge.handle === choice.id);
        return { nextId: named ? named.target : (edges[0] && edges[0].target) || null };
      }

      if (attempts >= maxAttempts) {
        // Stop asking. Somebody typing something else three times over is
        // telling you the buttons do not cover their problem.
        const other = edges.find(edge => edge.handle === (awaiting.giveUp || 'other'));
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
      const result = await this.moderateContent(userMessage, moderation.level);
      if (result.flagged) {
        return {
          success: true,
          response: 'I can\'t assist with that request. Please try rephrasing your question.',
          flagged: true,
          reason: result.reason
        };
      }
    }

    // Whether the last turn stopped at a question this message answers. An
    // answer to "what is your order number?" is not a query worth searching
    // the knowledge base for, and the search is the slowest thing in the turn.
    const answering = Boolean(
      context.state && context.state.awaiting && context.state.awaiting.nodeId &&
      steps[context.state.awaiting.nodeId]
    );

    // Retrieved at most once per turn, and only when something will read it:
    // up front on a fresh message so every node can reference it, or on
    // demand when an answer to a question goes on to reach an LLM node.
    let knowledgeContext = '';
    let retrieved = false;
    const retrieveKnowledge = async () => {
      if (retrieved || knowledge.sources.length === 0) {
        return knowledgeContext;
      }
      retrieved = true;
      try {
        const results = await this.knowledgeService.getKnowledge(
          userMessage,
          knowledge.sources,
          tenantId
        );
        knowledgeContext = (results || []).map(r => r.content).join('\n');
      } catch (error) {
        // A knowledge source being down should degrade the answer, not break
        // the conversation - but it is logged as the error it is, because the
        // tenant's bot has just answered as though they imported nothing.
        logger.error('Knowledge retrieval failed, continuing without it', {
          tenantId, error: error.message
        });
      }
      return knowledgeContext;
    };

    if (!answering) {
      await retrieveKnowledge();
    }

    // The tenant's own persona, for a workflow whose Persona step defers to
    // the Persona screen. Looked up once per turn, and only if a model is
    // about to be asked something.
    let inheritedText;
    const persona = async () => {
      if (!(prompts.persona && prompts.persona.inherit)) {
        return null;
      }
      if (inheritedText === undefined) {
        inheritedText = await this.inheritedPersona(tenantId);
      }
      return inheritedText;
    };

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
    // A node that speaks adds to what was already said rather than replacing
    // it, so a Fixed Reply wired into an Ask reads "Thanks. What is your
    // order number?" instead of losing its first half.
    const say = text => {
      const spoken = text === undefined || text === null ? '' : String(text);
      if (!spoken) {
        return;
      }
      response = response ? `${response}\n\n${spoken}` : spoken;
    };
    let escalate = null;
    let choices = null;
    // Structured results — products, appointment times — for the widget to
    // render properly rather than describe in a sentence.
    let cards = null;
    let awaiting = null;
    // Whether a model wrote any of the reply (metered) and whether the walk
    // ended on "I don't know" (the unanswered-questions list). Fixed replies
    // cost nothing and are not a gap.
    let llmUsed = false;
    let fellBack = false;
    // Steps that failed. A tag or a task that could not be written degrades
    // the conversation and the walk carries on; an answer that could not be
    // written leaves nothing to send, which is a failed run. Either way the
    // caller hears about it - this used to report success whatever happened.
    const failures = [];
    let fatal = null;
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
        // The walk carries on along the node's edge, if it has one. Stopping
        // here made "say this, then ask that" impossible to draw: the reply
        // was sent and the Ask it was wired to never ran.
        say(this.renderTemplate(step.data.template || step.data.message, variables));
        break;

      case 'llm':
        try {
          llmUsed = llmUsed || Boolean(this.openai);
          say(await this.runLlmNode(
            step, userMessage, chatHistory, await retrieveKnowledge(), variables, null, await persona()
          ));
        } catch (error) {
          failures.push({ node: currentId, error: error.message });
          fatal = fatal || error;
          nextId = null;
        }
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
        //
        // A node may reference a saved Action (`actionId`) instead of carrying
        // its own request. It is resolved here, at run time and scoped to this
        // tenant, so editing the Action changes every flow that uses it and a
        // deleted one fails down the error branch rather than at publish.
        const result = step.data.actionId
          ? await require('./actions').runForWorkflow(tenantId, step.data.actionId, variables, {
            simulate: context.simulate
          })
          : await workflowActions.execute(step.data, variables, {
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
          label: step.data.label || result.label || 'Action',
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
      case 'notify':
      case 'capability': {
        const outcome = await this.runNode(step.type, step, {
          currentId,
          variables,
          companyId: tenantId,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          simulate: context.simulate,
          render: template => this.renderTemplate(template, variables)
        });

        if (outcome.failed) {
          failures.push({ node: currentId, error: outcome.failed });
        }

        Object.assign(variables, outcome.variables || {});

        if (outcome.simulated) {
          simulated.push(...outcome.simulated);
        }

        if (outcome.response) {
          say(outcome.response);
        }
        if (outcome.choices) {
          choices = outcome.choices;
        }
        if (outcome.cards) {
          cards = outcome.cards;
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
        fellBack = true;
        say(this.renderTemplate(step.data.message, variables) ||
            routing.fallback?.message ||
            'I\'m not sure how to help with that.');
        escalate = step.data.escalation || routing.fallback?.escalation || null;
        nextId = null;
        break;

      case 'operator-handoff':
        escalate = { enabled: true, type: 'operator' };
        say(this.renderTemplate(step.data.message, variables) ||
            'Let me connect you with a member of our team.');

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

    if (fatal) {
      // The answer itself could not be produced. The caller falls back to the
      // assistant and clears the state, exactly as for a thrown error, so the
      // visitor is not left with half a reply from a flow that broke.
      logger.error('A workflow step failed and the reply could not be produced', {
        tenantId, failures
      });
      return {
        success: false,
        error: fatal.message,
        response,
        escalation: escalate,
        state: { awaiting: null, variables: this.persistableVariables(variables) },
        metadata: { path: visited, failures, llmUsed, fellBack, tenantId }
      };
    }

    // Nothing produced a response: fall back to a plain LLM answer so the
    // visitor is never met with silence.
    if (response === null) {
      if (routing.fallback) {
        fellBack = true;
        response = routing.fallback.message;
        escalate = routing.fallback.escalation;
      } else {
        llmUsed = llmUsed || Boolean(this.openai);
        try {
          const inherited = await persona();
          response = await this.runLlmNode(
            { data: {} },
            userMessage,
            chatHistory,
            await retrieveKnowledge(),
            variables,
            inherited
              ? { ...prompts, persona: { compiled: { systemPrompt: `Persona: ${inherited}` } } }
              : prompts
          );
        } catch (error) {
          failures.push({ node: null, error: error.message });
          logger.error('The workflow ended without a reply and the model could not write one', {
            tenantId, error: error.message
          });
          return {
            success: false,
            error: error.message,
            response: null,
            escalation: escalate,
            state: { awaiting: null, variables: this.persistableVariables(variables) },
            metadata: { path: visited, failures, llmUsed, fellBack, tenantId }
          };
        }
      }
    }

    // Output moderation
    if (moderation.enabled && response) {
      const result = await this.moderateContent(response, moderation.level);
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
      // Steps that failed without stopping the reply (a tag, a task, an
      // email). Reported so the run can be counted as having had an error.
      ...(failures.length ? { errors: failures } : {}),
      // Buttons for the widget to render, when the last node offered any.
      choices,
      cards,
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
        llmUsed,
        fellBack,
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
      notify: nodes.runNotify,
      capability: nodes.runCapability
    };

    const handler = handlers[type];

    if (!handler) {
      return {};
    }

    try {
      return (await handler(step, context)) || {};
    } catch (error) {
      logger.error('Workflow node failed', { type, error: error.message });
      return { failed: error.message };
    }
  }

  /**
   * The persona on the tenant's Persona screen, for a workflow that defers
   * to it. assistant-config ignores an inheriting workflow persona, so this
   * cannot come back round to the workflow asking.
   */
  async inheritedPersona(tenantId) {
    if (!tenantId) {
      return null;
    }
    try {
      const { resolve } = require('./assistant-config');
      const resolved = await resolve(tenantId);
      return resolved && resolved.persona ? String(resolved.persona) : null;
    } catch (error) {
      logger.warn('Could not read the tenant persona for a workflow', { tenantId, error: error.message });
      return null;
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
  async runLlmNode(step, userMessage, chatHistory, knowledgeContext, variables, prompts = null, inheritedPersona = null) {
    const systemPrompt = this.buildPromptHierarchy(
      prompts || {
        rootSystem: step.data.systemPrompt || this.rootSystemPrompt,
        persona: inheritedPersona ? { compiled: { systemPrompt: `Persona: ${inheritedPersona}` } } : null
      },
      knowledgeContext
    );

    const rendered = this.renderTemplate(step.data.userPrompt || step.data.prompt, variables);

    if (!this.openai) {
      // Without an API key the workflow still runs; it just cannot call out.
      logger.warn('OPENAI_API_KEY is not configured; returning a static reply');
      return 'I\'m not able to answer that right now. Let me get someone to help you.';
    }

    // The socket layer's history already ends with the message being answered
    // (it is saved before the reply is generated), so appending it again put
    // two identical user turns at the end of every request. Drop the trailing
    // copy rather than the appended one: the appended turn is the rendered
    // prompt, which is what the node was configured to say.
    const history = (chatHistory || []).slice(-10);
    const last = history[history.length - 1];
    if (last && last.role === 'user' && String(last.content) === String(userMessage)) {
      history.pop();
    }

    const messages = [
      // `systemPrompt`, not `step.data.systemPrompt || systemPrompt`.
      // `applyPromptHierarchyToNodes` sets `data.systemPrompt` on every LLM
      // node at compile time, so that fallback was never a fallback - the left
      // branch always won and threw away the hierarchy built two lines up,
      // knowledge included. An author who wired Knowledge into an LLM node got
      // an ungrounded answer, and nothing said so. The safety and persona
      // prompts are in `systemPrompt` too, so nothing is lost by using it.
      { role: 'system', content: systemPrompt },
      ...history,
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

    if (prompts.persona && prompts.persona.compiled && prompts.persona.compiled.systemPrompt) {
      systemPrompt += `\n\n${prompts.persona.compiled.systemPrompt}`;
    }

    if (knowledgeContext) {
      // Delimited and labelled as material: see promptEngineering#wrapKnowledge.
      systemPrompt += `\n\n${wrapKnowledge(knowledgeContext)}`;
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

      case 'regex': {
        // Compiled once and cached; a pattern the validator would have refused
        // (from a workflow saved before the check existed) is skipped rather
        // than run. The input is capped so even an accepted pattern stays
        // bounded.
        const compiled = nodes.compilePattern(String(value), 'i');
        if (compiled.error) {
          logger.warn('Router condition has an unusable regex', { error: compiled.error });
        } else if (compiled.regex.test(message.slice(0, 2000))) {
          return { type: 'matched', condition };
        }
        break;
      }

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
   * Apply the node's strictness to a moderation result. Split out so the
   * three levels can be tested without the API.
   */
  judgeModeration(result, level = 'medium') {
    const categories = (result && result.categories) || {};
    const scores = (result && result.category_scores) || {};
    const raised = Object.keys(categories).filter(category => categories[category]);

    let flagged;
    if (level === 'low') {
      flagged = Boolean(result && result.flagged) && raised.some(category => SEVERE_CATEGORIES.includes(category));
    } else if (level === 'high') {
      flagged = Boolean(result && result.flagged) ||
        Object.values(scores).some(score => typeof score === 'number' && score >= STRICT_SCORE);
    } else {
      flagged = Boolean(result && result.flagged);
    }

    const strongest = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return {
      flagged,
      reason: flagged ? (raised[0] || (strongest ? strongest[0] : 'policy')) : null,
      categories
    };
  }

  /**
   * Content moderation using OpenAI
   */
  async moderateContent(content, level = 'medium') {
    if (!this.openai) {
      return { flagged: false };
    }

    try {
      const moderation = await this.openai.moderations.create({ input: content });
      return this.judgeModeration(moderation.results[0], level);
    } catch (error) {
      logger.error('Error in content moderation', { error: error.message });
      // Fail open: a moderation outage must not silence the bot entirely.
      return { flagged: false };
    }
  }
}

/**
 * Whether a Persona step defers to the Persona screen. The flag is set on the
 * blank starter and cleared by the editor as soon as the prompt is edited.
 */
function inheritsPersona(data) {
  return Boolean(data) && (data.inheritPersona === true || data.inheritPersona === 'true');
}

module.exports = WorkflowCompilerService;
module.exports.NODE_LABELS = NODE_LABELS;
module.exports.SAFE_ID = SAFE_ID;
module.exports.inheritsPersona = inheritsPersona;
module.exports.SEVERE_CATEGORIES = SEVERE_CATEGORIES;
module.exports.STRICT_SCORE = STRICT_SCORE;
