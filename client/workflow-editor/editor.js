/**
 * Visual Workflow Editor
 *
 * A self-contained SVG/DOM node editor. It deliberately has no React or
 * React Flow dependency: the previous page loaded React 17 and React 18 plus
 * two incompatible React Flow builds from two CDNs, and then fell back to a
 * canvas editor that implemented none of the toolbar actions.
 *
 * Everything here is one class so state, rendering and persistence stay in
 * step; `render()` is the single place that reconciles state onto the DOM.
 */

import * as bootstrap from 'bootstrap';
import feather from 'feather-icons';

const AUTH_TOKEN_KEY = 'chatbot-auth-token';

/**
 * What the connector contract offers and what this tenant's connector
 * implements, fetched once at start-up for the Use Your Data node.
 */
const workflowCapabilities = { contract: [], connector: [] };
const GRID = 16;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 74;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const HISTORY_LIMIT = 60;

/**
 * The node palette. `fields` drives the properties panel, so adding a node
 * type here is all that is needed for it to be fully editable.
 */
const NODE_TYPES = {
  start: {
    label: 'Start', icon: 'play', color: '#6f42c1',
    description: 'Where every conversation enters',
    inputs: 0, outputs: 1, singleton: true,
    fields: []
  },
  persona: {
    label: 'Persona', icon: 'user', color: '#28a745',
    description: 'Define the chatbot personality',
    inputs: 0, outputs: 0, singleton: true, configuration: true,
    fields: [
      { key: 'prompt', label: 'Persona prompt', type: 'textarea', rows: 4, required: true,
        placeholder: 'You are a friendly support assistant for Acme...',
        help: 'Platform safety rules are always applied on top of this.' },
      { key: 'tone', label: 'Tone', type: 'select',
        options: ['professional', 'friendly', 'casual', 'formal', 'empathetic'] },
      { key: 'personality', label: 'Personality', type: 'select',
        options: ['helpful', 'concise', 'thorough', 'proactive'] }
    ]
  },
  knowledge: {
    label: 'Knowledge', icon: 'database', color: '#17a2b8',
    description: 'Ground answers in your data',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'sourceType', label: 'Source type', type: 'select', required: true,
        options: ['google_sheets', 'pdf', 'url', 'vector_store'] },
      { key: 'config.sheetId', label: 'Spreadsheet ID', type: 'text',
        showWhen: d => d.sourceType === 'google_sheets' },
      { key: 'config.range', label: 'Range', type: 'text', placeholder: 'A:Z',
        showWhen: d => d.sourceType === 'google_sheets' },
      { key: 'config.url', label: 'Document URL', type: 'text',
        showWhen: d => d.sourceType === 'pdf' || d.sourceType === 'url' },
      { key: 'config.collectionName', label: 'Collection', type: 'text',
        showWhen: d => d.sourceType === 'vector_store' }
    ]
  },
  llm: {
    label: 'AI Reply', icon: 'cpu', color: '#0d6efd',
    description: 'Generate an answer with a model',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'prompt', label: 'Instruction', type: 'textarea', rows: 4, required: true,
        placeholder: 'Answer the question using the knowledge provided.\n\nQuestion: {{user_input}}',
        help: 'Use {{user_input}} and {{knowledge_result}} as placeholders.' },
      { key: 'model', label: 'Model', type: 'select',
        options: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'] },
      { key: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 1, step: 0.1 }
    ]
  },
  response: {
    label: 'Fixed Reply', icon: 'message-square', color: '#20c997',
    description: 'Send an exact, scripted message',
    inputs: 1, outputs: 0,
    fields: [
      { key: 'template', label: 'Message', type: 'textarea', rows: 4, required: true,
        placeholder: 'Thanks for getting in touch! {{user_input}}',
        help: 'Supports {{user_input}} and {{knowledge_result}}.' }
    ]
  },
  router: {
    label: 'Router', icon: 'git-branch', color: '#fd7e14',
    description: 'Branch on what the visitor said',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'conditions', label: 'Conditions', type: 'conditions' }
    ]
  },
  moderation: {
    label: 'Moderation', icon: 'shield', color: '#ffc107',
    description: 'Filter unsafe content',
    inputs: 0, outputs: 0, singleton: true, configuration: true,
    fields: [
      { key: 'strictness', label: 'Strictness', type: 'select', options: ['low', 'medium', 'high'] }
    ]
  },
  fallback: {
    label: 'Fallback', icon: 'help-circle', color: '#dc3545',
    description: 'What to say when nothing matches',
    inputs: 1, outputs: 0,
    fields: [
      { key: 'message', label: 'Message', type: 'textarea', rows: 3, required: true,
        placeholder: 'Sorry, I did not catch that. Could you rephrase?' }
    ]
  },
  ask: {
    label: 'Ask a Question', icon: 'help-circle', color: '#0dcaf0',
    description: 'Ask, then use the answer',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'question', label: 'Question', type: 'textarea', rows: 2, required: true,
        placeholder: 'What is your order number?' },
      { key: 'variable', label: 'Save the answer as', type: 'text', required: true,
        placeholder: 'order_id',
        help: 'Use it later as {{order_id}}.' },
      { key: 'validate', label: 'Expected answer', type: 'select',
        options: ['any', 'email', 'phone', 'number', 'reference'] },
      { key: 'maxAttempts', label: 'Give up after', type: 'select',
        options: ['2', '3', '4', '5'],
        help: 'Then the Could not answer output is taken.' }
    ]
  },
  buttons: {
    label: 'Offer Choices', icon: 'list', color: '#6f42c1',
    description: 'Ask with buttons instead of free text',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'question', label: 'Question', type: 'textarea', rows: 2, required: true,
        placeholder: 'What can I help you with?' },
      { key: 'variable', label: 'Save the choice as', type: 'text', placeholder: 'choice' },
      { key: 'choices', label: 'Choices', type: 'choices' }
    ]
  },
  condition: {
    label: 'Check a Value', icon: 'filter', color: '#fd7e14',
    description: 'Branch on what you found out',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'clauses', label: 'Checks', type: 'clauses' }
    ]
  },
  set: {
    label: 'Set a Value', icon: 'edit-3', color: '#20c997',
    description: 'Build or rename a value',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'assignments', label: 'Values', type: 'assignments' }
    ]
  },
  'business-hours': {
    label: 'Open or Closed', icon: 'clock', color: '#795548',
    description: 'Branch on whether anyone is there',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'requireOperator', label: 'Count as open when', type: 'select',
        options: ['an operator is online', 'inside opening hours'],
        help: 'Inside opening hours with nobody connected is still nobody to talk to.' }
    ]
  },
  tag: {
    label: 'Add a Tag', icon: 'tag', color: '#0d6efd',
    description: 'Label the conversation',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'tags', label: 'Tags', type: 'taglist',
        help: 'Applied to the conversation so the queue can be filtered by them.' }
    ]
  },
  task: {
    label: 'Create a Task', icon: 'check-square', color: '#198754',
    description: 'Raise work for the team',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true,
        placeholder: 'Refund request for {{order_id}}' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 3,
        help: 'Everything the flow collected is appended automatically.' },
      { key: 'priority', label: 'Priority', type: 'select',
        options: ['low', 'medium', 'high', 'urgent'] },
      { key: 'dueInDays', label: 'Due in (days)', type: 'text', placeholder: '3' }
    ]
  },
  capability: {
    label: 'Use Your Data', icon: 'box', color: '#6610f2',
    description: 'Search your catalogue, offer appointment times',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'capability', label: 'What to do', type: 'capability', required: true },
      { key: 'input', label: 'Inputs', type: 'capability-input' },
      { key: 'offerAsChoices', label: 'Offer the results as buttons', type: 'select',
        options: ['no', 'yes'],
        help: 'A visitor tapping a product or a time is unambiguous in a way typing is not.' }
    ]
  },
  notify: {
    label: 'Email the Team', icon: 'mail', color: '#d63384',
    description: 'Send an email when the flow gets here',
    inputs: 1, outputs: 1,
    fields: [
      { key: 'to', label: 'Send to', type: 'text', required: true,
        placeholder: 'support@yourcompany.com' },
      { key: 'subject', label: 'Subject', type: 'text', required: true,
        placeholder: 'Complaint from {{contact_name}}' },
      { key: 'body', label: 'Message', type: 'textarea', rows: 4,
        placeholder: 'They said: {{complaint}}',
        help: 'Placeholders are filled in. Needs SMTP configured on the server.' }
    ]
  },
  action: {
    label: 'Call an API', icon: 'zap', color: '#e83e8c',
    description: 'Look something up in your own system',
    inputs: 1, outputs: 2,
    fields: [
      { key: 'preset', label: 'Start from a service', type: 'preset' },
      { key: 'url', label: 'URL', type: 'text', required: true,
        placeholder: 'https://api.yourcompany.com/orders/{{order_id}}',
        help: 'Must be https. Placeholders are URL-encoded before being sent.' },
      { key: 'method', label: 'Method', type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'body', label: 'Request body (JSON)', type: 'textarea', rows: 4,
        placeholder: '{"question": "{{user_input}}"}',
        showWhen: d => (d.method || 'GET') !== 'GET' },
      { key: 'auth', label: 'Authentication', type: 'auth' },
      { key: 'outputs', label: 'Read from the response', type: 'outputs' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'text', placeholder: '8000',
        help: 'Between 1000 and 20000. A visitor is waiting, so keep it short.' }
    ]
  },
  'operator-handoff': {
    label: 'Human Handoff', icon: 'users', color: '#6610f2',
    description: 'Escalate to a live operator',
    inputs: 1, outputs: 0,
    fields: [
      { key: 'message', label: 'Handoff message', type: 'textarea', rows: 2,
        placeholder: 'Let me connect you with a colleague.' }
    ]
  }
};

/** Sensible starting data so a freshly dropped node is already valid. */
const NODE_DEFAULTS = {
  start: { label: 'Start' },
  persona: { label: 'Persona', prompt: 'You are a helpful assistant.', tone: 'professional', personality: 'helpful' },
  knowledge: { label: 'Knowledge', sourceType: 'google_sheets', config: { range: 'A:Z' } },
  llm: { label: 'AI Reply', prompt: 'Answer the question.\n\nQuestion: {{user_input}}', model: 'gpt-4o-mini', temperature: 0.7 },
  response: { label: 'Fixed Reply', template: 'Thanks for reaching out!' },
  router: { label: 'Router', conditions: [] },
  moderation: { label: 'Moderation', strictness: 'medium' },
  fallback: { label: 'Fallback', message: 'Sorry, I did not understand that.' },
  action: {
    label: 'Call an API', method: 'GET', url: '', outputs: [],
    auth: { type: 'none' }, timeoutMs: 8000
  },
  ask: {
    label: 'Ask a Question', question: 'What is your order number?',
    variable: 'order_id', validate: 'reference', maxAttempts: '3'
  },
  buttons: {
    label: 'Offer Choices', question: 'What can I help you with?',
    variable: 'choice', choices: []
  },
  condition: {
    label: 'Check a Value', match: 'all',
    clauses: [{ left: '', operator: 'equals', right: '' }]
  },
  notify: { label: 'Email the Team', to: '', subject: '', body: '' },
  capability: { label: 'Use Your Data', capability: '', input: {}, offerAsChoices: 'yes' },
  set: { label: 'Set a Value', assignments: [] },
  'business-hours': { label: 'Open or Closed', requireOperator: 'an operator is online' },
  tag: { label: 'Add a Tag', tags: [] },
  task: { label: 'Create a Task', title: '', description: '', priority: 'medium', dueInDays: '3' },
  'operator-handoff': { label: 'Human Handoff', message: 'Let me connect you with a colleague.' }
};

/**
 * Router condition types. `intent` matches semantically, so it catches
 * phrasings the author did not list - "money back" reaching a refund intent
 * whose examples only say "refund".
 */
const CONDITION_TYPES = [
  { value: 'intent', label: 'Intent (meaning)' },
  { value: 'keyword', label: 'Keyword' },
  { value: 'contains', label: 'Contains text' },
  { value: 'regex', label: 'Regex' }
];

/**
 * Recipes for the services standard customers already use.
 *
 * Each is only a prefilled Call an API node — no per-service code exists
 * anywhere in the runtime, so there is nothing here to break when a vendor
 * changes something other than the recipe itself. `note` tells the tenant
 * where their credential comes from, which is the part they always get
 * stuck on.
 */
const ACTION_PRESETS = [
  {
    id: 'shopify-order',
    label: 'Shopify — look up an order',
    note: 'Create an Admin API access token (Settings → Apps and sales channels → Develop apps) and paste it as the credential.',
    config: {
      label: 'Shopify order lookup',
      url: 'https://{{shop_domain}}.myshopify.com/admin/api/2024-07/orders/{{order_id}}.json',
      method: 'GET',
      auth: { type: 'header', header: 'X-Shopify-Access-Token' },
      outputs: [
        { variable: 'payment_status', path: 'order.financial_status' },
        { variable: 'fulfillment_status', path: 'order.fulfillment_status' }
      ]
    }
  },
  {
    id: 'stripe-subscription',
    label: 'Stripe — check a subscription',
    note: 'Use a restricted key with read access to subscriptions, not your live secret key.',
    config: {
      label: 'Stripe subscription',
      url: 'https://api.stripe.com/v1/customers/{{customer_id}}/subscriptions',
      method: 'GET',
      auth: { type: 'bearer' },
      outputs: [
        { variable: 'subscription_status', path: 'data.0.status' },
        { variable: 'current_period_end', path: 'data.0.current_period_end' }
      ]
    }
  },
  {
    id: 'zendesk-ticket',
    label: 'Zendesk — raise a ticket',
    note: 'The credential is your agent email and API token joined as email/token:api_token — exactly in that form.',
    config: {
      label: 'Zendesk ticket',
      url: 'https://{{subdomain}}.zendesk.com/api/v2/tickets.json',
      method: 'POST',
      auth: { type: 'basic' },
      body: '{"ticket": {"subject": "Chat escalation", "comment": {"body": "{{user_input}}"}}}',
      outputs: [{ variable: 'ticket_id', path: 'ticket.id' }]
    }
  },
  {
    id: 'slack-notify',
    label: 'Slack — post to a channel',
    note: 'Paste the full webhook URL over the placeholder. Note the URL itself is the secret — unlike the credential field, it is stored as written, so treat anyone who can edit this workflow as able to post to that channel.',
    config: {
      label: 'Slack message',
      url: 'https://hooks.slack.com/services/{{webhook_path}}',
      method: 'POST',
      auth: { type: 'none' },
      body: '{"text": "New conversation needs attention: {{user_input}}"}',
      outputs: []
    }
  },
  {
    id: 'hubspot-contact',
    label: 'HubSpot — look up a contact',
    note: 'Use a private app token with crm.objects.contacts.read scope.',
    config: {
      label: 'HubSpot contact',
      url: 'https://api.hubapi.com/crm/v3/objects/contacts/{{contact_email}}?idProperty=email',
      method: 'GET',
      auth: { type: 'bearer' },
      outputs: [
        { variable: 'crm_first_name', path: 'properties.firstname' },
        { variable: 'crm_lifecycle_stage', path: 'properties.lifecyclestage' }
      ]
    }
  }
];

/** Host plus path, so a long URL still reads on a 190px node. */
function shortUrl(url) {
  const stripped = String(url).replace(/^https?:\/\//, '');
  return stripped.length > 34 ? `${stripped.slice(0, 33)}…` : stripped;
}

/**
 * The output ports a node has, in the order they are drawn.
 *
 * Two node types branch, for different reasons: a router has one port per
 * routing rule plus "Otherwise", and an action has one for the call working
 * and one for it failing. Everything else has a single unlabelled output.
 *
 * Kept in one place because the node rendering and the edge geometry both
 * need the same list - when they disagreed, edges left from empty space.
 */
function outputHandles(node) {
  if (node.type === 'router') {
    return [
      ...(node.data.conditions || []).map((c, i) => ({
        handle: c.id || `cond_${i}`,
        label: c.label || c.value || `Rule ${i + 1}`
      })),
      { handle: 'default', label: 'Otherwise' }
    ];
  }

  if (node.type === 'action') {
    return [
      { handle: 'success', label: 'Worked' },
      { handle: 'error', label: 'Failed' }
    ];
  }

  if (node.type === 'ask') {
    return [
      { handle: 'next', label: 'Answered' },
      { handle: 'invalid', label: 'Could not answer' }
    ];
  }

  if (node.type === 'buttons') {
    return [
      ...(node.data.choices || []).map((choice, i) => ({
        handle: choice.id || `choice_${i}`,
        label: choice.label || `Choice ${i + 1}`
      })),
      // For somebody who types something else entirely. Without it a flow
      // has no answer for "none of the above".
      { handle: 'other', label: 'Something else' }
    ];
  }

  if (node.type === 'condition') {
    return [
      { handle: 'true', label: 'Yes' },
      { handle: 'false', label: 'No' }
    ];
  }

  if (node.type === 'capability') {
    // "Found nothing" shares the failure branch on purpose: from the
    // visitor's side an empty result and an unreachable connector are the
    // same problem, and wiring three paths for two outcomes is how flows
    // grow dead ends.
    return [
      { handle: 'success', label: 'Found something' },
      { handle: 'error', label: 'Nothing found or failed' }
    ];
  }

  if (node.type === 'business-hours') {
    return [
      { handle: 'open', label: 'Open' },
      { handle: 'closed', label: 'Closed' }
    ];
  }

  return [{ handle: null, label: '' }];
}

const CONDITION_HELP = {
  intent: {
    placeholder: 'I want a refund, cancel my order, money back',
    help: 'Example phrases, comma separated. Matches similar meaning, not exact words.'
  },
  keyword: {
    placeholder: 'refund, cancel, return',
    help: 'Matches if the message contains any of these words.'
  },
  contains: {
    placeholder: 'order number',
    help: 'Matches if the message contains this exact text.'
  },
  regex: {
    placeholder: '^order\\s+#?\\d+',
    help: 'Matches if this regular expression matches the message.'
  }
};

const escapeHtml = value => String(value === undefined || value === null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Read/write `a.b.c` paths so field keys can target nested config objects. */
const getPath = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? acc : acc[key]), obj);

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (typeof acc[key] !== 'object' || acc[key] === null) {
      acc[key] = {};
    }
    return acc[key];
  }, obj);
  target[last] = value;
};

class WorkflowEditor {
  constructor() {
    this.token = localStorage.getItem(AUTH_TOKEN_KEY);
    this.workflowId = new URLSearchParams(location.search).get('id');
    this.workflow = null;
    this.nodes = [];
    this.edges = [];
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this.dirty = false;
    // The graph as it stands on the server, in pushHistory's snapshot
    // format, so undo can tell when it has walked back to a saved state.
    this.savedSnapshot = null;
    this.validationErrors = [];
    // Where the preview conversation has got to. Reset when the panel is
    // restarted or the canvas changes shape underneath it.
    this.previewState = null;
    // Stand-in values for an action node's placeholders, keyed by node id.
    // Scaffolding for the "Try it" button, deliberately not persisted.
    this.testValues = {};

    this.view = { x: 0, y: 0, zoom: 1 };
    this.history = [];
    this.historyIndex = -1;
    this.drag = null;
    this.linking = null;

    this.el = {};
  }

  // -- lifecycle --------------------------------------------------------

  async init() {
    if (!this.token) {
      location.href = '/admin/login.html';
      return;
    }

    // Keep the loading overlay up until the server has accepted the token,
    // so a stale session never sees the editor flash before the redirect.
    if (document.getElementById('wf-loading')) {
      this.setBusy(true);
    }
    if (!(await this.verifyToken())) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      location.href = '/admin/login.html?expired=1';
      return;
    }

    this.cacheElements();

    // Before the palette, so the Use Your Data node knows what this tenant
    // has actually implemented the first time somebody opens it.
    await this.loadCapabilities();

    this.bindPalette();
    this.bindCanvas();
    this.bindToolbar();
    this.bindKeyboard();

    window.addEventListener('beforeunload', e => {
      if (this.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    await this.loadWorkflowList();

    if (this.workflowId) {
      await this.openWorkflow(this.workflowId);
    } else {
      this.startBlankWorkflow();
      this.setBusy(false);
    }
  }

  /**
   * Whether the server still accepts the stored token. A rejected token
   * is false; a server that cannot be reached at all is treated as
   * accepted, because the token may well be fine and the editor's own
   * requests will surface the outage. Only a real 401 signs anyone out.
   */
  async verifyToken() {
    try {
      const response = await fetch('/api/auth/verify', {
        headers: { 'x-auth-token': this.token }
      });
      return response.ok;
    } catch {
      return true;
    }
  }

  cacheElements() {
    const byId = id => document.getElementById(id);
    this.el = {
      canvas: byId('wf-canvas'),
      surface: byId('wf-surface'),
      edgeLayer: byId('wf-edges'),
      nodeLayer: byId('wf-nodes'),
      palette: byId('wf-palette'),
      properties: byId('wf-properties'),
      title: byId('wf-title'),
      status: byId('wf-status'),
      version: byId('wf-version'),
      saveState: byId('wf-save-state'),
      workflowList: byId('wf-workflow-list'),
      problems: byId('wf-problems'),
      problemCount: byId('wf-problem-count'),
      zoomLabel: byId('wf-zoom-label'),
      emptyHint: byId('wf-empty-hint'),
      templatePicker: byId('wf-template-picker'),
      templateList: byId('wf-template-list'),
      preview: byId('wf-preview'),
      previewTranscript: byId('wf-preview-transcript'),
      previewMessage: byId('wf-preview-message')
    };
  }

  // -- API --------------------------------------------------------------

  async api(path, options = {}) {
    const response = await fetch(`/api/workflows${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': this.token,
        ...options.headers
      }
    });

    if (response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      location.href = '/admin/login.html';
      throw new Error('Session expired');
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }

    return body;
  }

  // -- workflow loading -------------------------------------------------

  async loadWorkflowList() {
    try {
      const { workflows } = await this.api('');
      this.renderWorkflowList(workflows || []);
    } catch (error) {
      this.toast(`Could not load workflows: ${error.message}`, 'danger');
    }
  }

  renderWorkflowList(workflows) {
    const items = workflows.map(wf => `
      <li>
        <a class="dropdown-item d-flex justify-content-between align-items-center gap-3
           ${wf._id === this.workflowId ? 'active' : ''}"
           href="?id=${encodeURIComponent(wf._id)}">
          <span class="text-truncate">${escapeHtml(wf.name)}</span>
          <span class="badge bg-${wf.status === 'published' ? 'success' : 'secondary'}">${escapeHtml(wf.status)}</span>
        </a>
      </li>`).join('');

    this.el.workflowList.innerHTML = `
      <li><a class="dropdown-item" href="/admin/workflow-editor.html">＋ New workflow</a></li>
      ${workflows.length ? '<li><hr class="dropdown-divider"></li>' : ''}
      ${items}`;
  }

  startBlankWorkflow() {
    this.workflow = { name: 'Untitled workflow', description: '', status: 'draft', version: 1 };
    // A blank canvas is intimidating and a workflow is invalid without a
    // persona, so seed the two nodes every workflow needs.
    this.nodes = [
      this.makeNode('persona', { x: 80, y: 60 }),
      this.makeNode('start', { x: 80, y: 220 }),
      this.makeNode('llm', { x: 360, y: 220 })
    ];
    this.edges = [{ id: this.uid('edge'), source: this.nodes[1].id, target: this.nodes[2].id }];
    this.markSaved();
    this.pushHistory();
    this.render();
  }

  async openWorkflow(id) {
    this.setBusy(true);
    try {
      const { workflow } = await this.api(`/${encodeURIComponent(id)}`);
      this.workflow = workflow;
      this.workflowId = workflow._id;
      this.nodes = (workflow.nodes || []).map(n => ({
        id: n.id,
        type: (n.data && n.data.type) || n.type,
        position: n.position || { x: 100, y: 100 },
        data: { ...(n.data || {}) }
      }));
      this.edges = (workflow.edges || []).map(e => ({ ...e }));
      this.markSaved();
      this.history = [];
      this.historyIndex = -1;
      this.pushHistory();
      this.fitView();
      this.render();
    } catch (error) {
      this.toast(`Could not open workflow: ${error.message}`, 'danger');
      this.startBlankWorkflow();
    } finally {
      this.setBusy(false);
    }
  }

  // -- model helpers ----------------------------------------------------

  uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  makeNode(type, position) {
    return {
      id: this.uid(type),
      type,
      position: { x: Math.round(position.x / GRID) * GRID, y: Math.round(position.y / GRID) * GRID },
      data: { type, ...JSON.parse(JSON.stringify(NODE_DEFAULTS[type] || {})) }
    };
  }

  nodeById(id) {
    return this.nodes.find(n => n.id === id);
  }

  /** Serialise to the shape the API stores (type lives inside `data`). */
  serialise() {
    return {
      nodes: this.nodes.map(n => ({
        id: n.id,
        type: 'customNode',
        position: n.position,
        data: { ...n.data, type: n.type }
      })),
      edges: this.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || null,
        type: 'default'
      }))
    };
  }

  // -- history ----------------------------------------------------------

  pushHistory() {
    const snapshot = JSON.stringify({ nodes: this.nodes, edges: this.edges });
    if (this.history[this.historyIndex] === snapshot) {
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snapshot);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }
    this.historyIndex = this.history.length - 1;
  }

  restore(index) {
    if (index < 0 || index >= this.history.length) {
      return;
    }
    const snapshot = this.history[index];
    const { nodes, edges } = JSON.parse(snapshot);
    this.nodes = nodes;
    this.edges = edges;
    this.historyIndex = index;
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    // Undoing back to exactly what the server holds is not an unsaved
    // change; render() resets the label when the flag is clear.
    if (snapshot === this.savedSnapshot) {
      this.dirty = false;
    } else {
      this.markDirty();
    }
    this.render();
  }

  undo() {
    this.restore(this.historyIndex - 1);
  }
  redo() {
    this.restore(this.historyIndex + 1);
  }

  markDirty() {
    this.dirty = true;
    this.el.saveState.textContent = 'Unsaved changes';
    this.el.saveState.className = 'wf-save-state text-warning';
  }

  /** The graph now matches what the server holds. */
  markSaved() {
    this.dirty = false;
    this.savedSnapshot = JSON.stringify({ nodes: this.nodes, edges: this.edges });
  }

  /**
   * Push a history entry once an edit is finished rather than on every
   * keystroke: `change` covers selects, ranges and committed text, `blur`
   * catches a text field left without one. pushHistory ignores a snapshot
   * identical to the last, so a field that fires both is recorded once.
   */
  commitOnChange(input) {
    const commit = () => this.pushHistory();
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
  }

  // -- coordinate conversion -------------------------------------------

  toCanvas(clientX, clientY) {
    const rect = this.el.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.zoom,
      y: (clientY - rect.top - this.view.y) / this.view.zoom
    };
  }

  // -- palette ----------------------------------------------------------

  bindPalette() {
    const groups = {
      'Entry & identity': ['start', 'persona'],
      'Answering': ['knowledge', 'llm', 'response'],
      'Asking': ['ask', 'buttons'],
      'Control flow': ['router', 'condition', 'business-hours', 'fallback', 'operator-handoff'],
      'Doing': ['capability', 'action', 'set', 'tag', 'task', 'notify'],
      'Safety': ['moderation']
    };

    this.el.palette.innerHTML = Object.entries(groups).map(([group, types]) => `
      <div class="wf-palette-group">
        <div class="wf-palette-group-title">${escapeHtml(group)}</div>
        ${types.map(type => {
    const def = NODE_TYPES[type];
    return `
            <button type="button" class="wf-palette-item" draggable="true"
                    data-node-type="${type}" title="${escapeHtml(def.description)}">
              <span class="wf-palette-icon" style="background:${def.color}">
                <i data-feather="${def.icon}"></i>
              </span>
              <span class="wf-palette-text">
                <span class="wf-palette-label">${escapeHtml(def.label)}</span>
                <span class="wf-palette-desc">${escapeHtml(def.description)}</span>
              </span>
            </button>`;
  }).join('')}
      </div>`).join('');

    this.el.palette.querySelectorAll('.wf-palette-item').forEach(item => {
      item.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/node-type', item.dataset.nodeType);
        e.dataTransfer.effectAllowed = 'copy';
      });
      // Click-to-add: dragging is fiddly on trackpads and impossible on touch.
      item.addEventListener('click', () => this.addNodeAtCentre(item.dataset.nodeType));
    });

    if (feather) {
      feather.replace();
    }
  }

  addNodeAtCentre(type) {
    const rect = this.el.canvas.getBoundingClientRect();
    const centre = this.toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 3);
    this.addNode(type, this.freeSpotNear(centre.x - NODE_WIDTH / 2, centre.y));
  }

  /**
   * The nearest place a node can sit without landing on another one.
   *
   * Clicking the palette used to drop every node at the same point, so a
   * second one covered the first and looked like it had not been added.
   */
  freeSpotNear(x, y) {
    const clear = (px, py) => !this.nodes.some(node =>
      Math.abs(node.position.x - px) < NODE_WIDTH + 20 &&
      Math.abs(node.position.y - py) < NODE_HEIGHT + 20);

    if (clear(x, y)) {
      return { x, y };
    }

    // Spiral outwards in the direction a workflow grows: right, then down.
    for (let ring = 1; ring <= 12; ring += 1) {
      const candidates = [
        { x: x + ring * (NODE_WIDTH + 40), y },
        { x, y: y + ring * (NODE_HEIGHT + 40) },
        { x: x + ring * (NODE_WIDTH + 40), y: y + ring * (NODE_HEIGHT + 40) },
        { x: x - ring * (NODE_WIDTH + 40), y }
      ];
      const spot = candidates.find(c => clear(c.x, c.y));
      if (spot) {
        return spot;
      }
    }

    return { x, y };
  }

  addNode(type, position) {
    const def = NODE_TYPES[type];

    if (def.singleton && this.nodes.some(n => n.type === type)) {
      this.toast(`This workflow already has a ${def.label} node`, 'warning');
      return;
    }

    const node = this.makeNode(type, position);
    this.nodes.push(node);
    this.selectedNodeId = node.id;
    this.selectedEdgeId = null;
    this.markDirty();
    this.pushHistory();
    this.render();
  }

  deleteSelection() {
    if (this.selectedEdgeId) {
      this.edges = this.edges.filter(e => e.id !== this.selectedEdgeId);
      this.selectedEdgeId = null;
    } else if (this.selectedNodeId) {
      this.nodes = this.nodes.filter(n => n.id !== this.selectedNodeId);
      this.edges = this.edges.filter(e =>
        e.source !== this.selectedNodeId && e.target !== this.selectedNodeId);
      this.selectedNodeId = null;
    } else {
      return;
    }

    this.markDirty();
    this.pushHistory();
    this.render();
  }

  duplicateSelectedNode() {
    const node = this.nodeById(this.selectedNodeId);
    if (!node || NODE_TYPES[node.type].singleton) {
      return;
    }
    const copy = {
      ...JSON.parse(JSON.stringify(node)),
      id: this.uid(node.type),
      position: { x: node.position.x + GRID * 2, y: node.position.y + GRID * 2 }
    };
    this.nodes.push(copy);
    this.selectedNodeId = copy.id;
    this.markDirty();
    this.pushHistory();
    this.render();
  }

  // -- canvas interaction ----------------------------------------------

  bindCanvas() {
    const canvas = this.el.canvas;

    canvas.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', e => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/node-type');
      if (!type || !NODE_TYPES[type]) {
        return;
      }
      const point = this.toCanvas(e.clientX, e.clientY);
      this.addNode(type, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 });
    });

    // Pointer events rather than mouse events so a finger can drag nodes,
    // pan and connect ports too. Without this the browser would scroll or
    // zoom the page instead of sending us pointermove.
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', e => {
      // Right and middle buttons, and a second finger, do nothing here.
      if (e.button !== 0 || !e.isPrimary) {
        return;
      }
      const port = e.target.closest('[data-port]');
      const nodeEl = e.target.closest('[data-node-id]');
      const edgeEl = e.target.closest('[data-edge-id]');

      if (port && port.dataset.port === 'out') {
        this.linking = {
          source: port.dataset.nodeId,
          sourceHandle: port.dataset.handle || null,
          to: this.toCanvas(e.clientX, e.clientY)
        };
        e.preventDefault();
        return;
      }

      if (nodeEl) {
        this.selectedNodeId = nodeEl.dataset.nodeId;
        this.selectedEdgeId = null;
        const node = this.nodeById(this.selectedNodeId);
        const point = this.toCanvas(e.clientX, e.clientY);
        this.drag = {
          kind: 'node',
          id: node.id,
          offsetX: point.x - node.position.x,
          offsetY: point.y - node.position.y,
          origin: { ...node.position },
          moved: false
        };
        this.render();
        return;
      }

      if (edgeEl) {
        this.selectedEdgeId = edgeEl.dataset.edgeId;
        this.selectedNodeId = null;
        this.render();
        return;
      }

      // Empty canvas: pan, and clear the selection.
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: this.view.x, originY: this.view.y };
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.render();
    });

    window.addEventListener('pointermove', e => {
      if (!e.isPrimary) {
        return;
      }
      if (this.linking) {
        this.linking.to = this.toCanvas(e.clientX, e.clientY);
        this.renderEdges();
        return;
      }

      if (!this.drag) {
        return;
      }

      if (this.drag.kind === 'pan') {
        this.view.x = this.drag.originX + (e.clientX - this.drag.startX);
        this.view.y = this.drag.originY + (e.clientY - this.drag.startY);
        this.applyTransform();
        return;
      }

      const node = this.nodeById(this.drag.id);
      if (!node) {
        return;
      }
      const point = this.toCanvas(e.clientX, e.clientY);
      const next = {
        x: Math.round((point.x - this.drag.offsetX) / GRID) * GRID,
        y: Math.round((point.y - this.drag.offsetY) / GRID) * GRID
      };

      // A plain click carries a pixel or two of pointer jitter. Only treat it
      // as a drag once the node actually lands on a different grid cell,
      // otherwise selecting a node marks the workflow as unsaved.
      if (next.x === node.position.x && next.y === node.position.y) {
        return;
      }

      node.position = next;
      this.drag.moved =
        next.x !== this.drag.origin.x || next.y !== this.drag.origin.y;
      this.renderNodePosition(node);
      this.renderEdges();
    });

    const endPointer = e => {
      if (!e.isPrimary) {
        return;
      }
      if (this.linking) {
        // A touch is captured by the element it started on, so `e.target`
        // is the source port; look at what is actually under the pointer.
        // A cancelled pointer (the browser took the gesture) connects nothing.
        const under = e.type === 'pointerup'
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
        const port = under ? under.closest('[data-port="in"]') : null;
        if (port && port.dataset.nodeId !== this.linking.source) {
          this.connect(this.linking.source, port.dataset.nodeId, this.linking.sourceHandle);
        }
        this.linking = null;
        this.render();
        return;
      }

      if (this.drag && this.drag.kind === 'node' && this.drag.moved) {
        this.markDirty();
        this.pushHistory();
      }
      this.drag = null;
    };
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
      // Zoom around the pointer so the thing under the cursor stays put.
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      this.view.x = px - (px - this.view.x) * (next / this.view.zoom);
      this.view.y = py - (py - this.view.y) * (next / this.view.zoom);
      this.view.zoom = next;
      this.applyTransform();
    }, { passive: false });

    canvas.addEventListener('dblclick', e => {
      const nodeEl = e.target.closest('[data-node-id]');
      if (nodeEl) {
        document.getElementById('wf-properties-panel')?.classList.add('open');
      }
    });
  }

  connect(source, target, sourceHandle) {
    const targetDef = NODE_TYPES[this.nodeById(target)?.type];
    if (!targetDef || targetDef.inputs === 0) {
      this.toast(`${targetDef ? targetDef.label : 'That node'} does not accept incoming connections`, 'warning');
      return;
    }

    const exists = this.edges.some(e =>
      e.source === source && e.target === target && (e.sourceHandle || null) === (sourceHandle || null));
    if (exists) {
      return;
    }

    // Reject connections that would create a cycle - the compiler rejects
    // them too, but failing here means the user finds out immediately.
    if (this.wouldCycle(source, target)) {
      this.toast('That connection would create a loop', 'warning');
      return;
    }

    // Only routers branch. Reconnecting any other node's output replaces the
    // existing link rather than silently creating an ambiguous fork.
    const sourceNode = this.nodeById(source);
    if (sourceNode && sourceNode.type !== 'router') {
      this.edges = this.edges.filter(e => e.source !== source);
    } else {
      // A router's individual output can still only go to one place.
      this.edges = this.edges.filter(e =>
        !(e.source === source && (e.sourceHandle || null) === (sourceHandle || null)));
    }

    this.edges.push({ id: this.uid('edge'), source, target, sourceHandle: sourceHandle || null });
    this.markDirty();
    this.pushHistory();
  }

  wouldCycle(source, target) {
    const adjacency = new Map();
    this.edges.forEach(e => {
      if (!adjacency.has(e.source)) {
        adjacency.set(e.source, []);
      }
      adjacency.get(e.source).push(e.target);
    });

    const seen = new Set();
    const stack = [target];
    while (stack.length) {
      const current = stack.pop();
      if (current === source) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      (adjacency.get(current) || []).forEach(next => stack.push(next));
    }
    return false;
  }

  // -- rendering --------------------------------------------------------

  applyTransform() {
    this.el.surface.style.transform =
      `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    this.el.zoomLabel.textContent = `${Math.round(this.view.zoom * 100)}%`;
  }

  render() {
    this.renderNodes();
    this.renderEdges();
    this.renderProperties();
    this.renderHeader();
    this.applyTransform();
    this.el.emptyHint.style.display = this.nodes.length ? 'none' : 'block';
    if (feather) {
      feather.replace();
    }
  }

  renderHeader() {
    const wf = this.workflow || {};
    this.el.title.textContent = wf.name || 'Untitled workflow';
    this.el.version.textContent = `v${wf.version || 1}`;

    const status = wf.status || 'draft';
    this.el.status.textContent = status;
    this.el.status.className = `wf-status wf-status-${status}`;

    if (!this.dirty) {
      this.el.saveState.textContent = this.workflowId ? 'All changes saved' : 'Not saved yet';
      this.el.saveState.className = 'wf-save-state text-muted';
    }
  }

  renderNodes() {
    this.el.nodeLayer.innerHTML = this.nodes.map(node => {
      const def = NODE_TYPES[node.type] || { label: node.type, color: '#6c757d', icon: 'box', inputs: 1, outputs: 1 };
      const selected = node.id === this.selectedNodeId;
      const invalid = this.validationErrors.some(err => err.nodeId === node.id);
      const summary = this.summarise(node);

      const ports = [];
      if (def.inputs > 0) {
        ports.push(`<span class="wf-port wf-port-in" data-port="in" data-node-id="${node.id}" title="Incoming"></span>`);
      }
      if (def.outputs > 0) {
        const handles = outputHandles(node);

        handles.forEach((h, index) => {
          const offset = handles.length === 1 ? 50 : (100 / (handles.length + 1)) * (index + 1);
          ports.push(`<span class="wf-port wf-port-out" data-port="out" data-node-id="${node.id}"
            ${h.handle ? `data-handle="${escapeHtml(h.handle)}"` : ''}
            style="top:${offset}%" title="${escapeHtml(h.label || 'Outgoing')}"></span>`);
        });
      }

      return `
        <div class="wf-node ${selected ? 'selected' : ''} ${invalid ? 'invalid' : ''} ${def.configuration ? 'config' : ''}"
             data-node-id="${node.id}"
             style="left:${node.position.x}px; top:${node.position.y}px; --node-color:${def.color}">
          <div class="wf-node-head">
            <span class="wf-node-icon"><i data-feather="${def.icon}"></i></span>
            <span class="wf-node-title">${escapeHtml(node.data.label || def.label)}</span>
          </div>
          <div class="wf-node-body">${escapeHtml(summary)}</div>
          ${ports.join('')}
        </div>`;
    }).join('');

    this.repaintPath();
  }

  /** One-line preview of a node's configuration, shown on the node itself. */
  summarise(node) {
    const d = node.data || {};
    switch (node.type) {
    case 'persona': return d.prompt || 'No prompt set';
    case 'llm': return d.prompt || 'No instruction set';
    case 'response': return d.template || 'No message set';
    case 'fallback':
    case 'operator-handoff': return d.message || 'No message set';
    case 'knowledge': return `${d.sourceType || 'no source'}${d.config?.sheetId ? ` · ${d.config.sheetId}` : ''}`;
    case 'router': return `${(d.conditions || []).length} condition(s)`;
    case 'moderation': return `Strictness: ${d.strictness || 'medium'}`;
    case 'action': return d.url ? `${d.method || 'GET'} ${shortUrl(d.url)}` : 'No URL set';
    case 'ask': return d.question ? `${d.question} → {{${d.variable || 'answer'}}}` : 'No question set';
    case 'buttons': return `${(d.choices || []).length} choice(s)`;
    case 'condition': {
      const clauses = (d.clauses && d.clauses.length ? d.clauses : [d])
        .filter(c => c && c.left);
      if (!clauses.length) {
        return 'Nothing to check';
      }
      const first = `${clauses[0].left} ${(clauses[0].operator || 'equals').replace(/_/g, ' ')} ${clauses[0].right || ''}`.trim();
      return clauses.length > 1
        ? `${first} +${clauses.length - 1} more (${d.match === 'any' ? 'any' : 'all'})`
        : first;
    }
    case 'notify': return d.to || 'No recipient set';
    case 'capability': {
      const known = (workflowCapabilities.contract || []).find(c => c.id === d.capability);
      return known ? known.label : 'Nothing chosen yet';
    }
    case 'set': return `${(d.assignments || []).length} value(s)`;
    case 'business-hours': return 'Branch on availability';
    case 'tag': return (d.tags || []).length ? d.tags.join(', ') : 'No tags set';
    case 'task': return d.title || 'No title set';
    case 'start': return 'Conversation entry point';
    default: return '';
    }
  }

  renderNodePosition(node) {
    const el = this.el.nodeLayer.querySelector(`[data-node-id="${node.id}"]`);
    if (el) {
      el.style.left = `${node.position.x}px`;
      el.style.top = `${node.position.y}px`;
    }
  }

  portPosition(nodeId, side, handle) {
    const node = this.nodeById(nodeId);
    if (!node) {
      return { x: 0, y: 0 };
    }
    const def = NODE_TYPES[node.type] || { outputs: 1 };

    if (side === 'in') {
      return { x: node.position.x, y: node.position.y + NODE_HEIGHT / 2 };
    }

    let fraction = 0.5;
    const handles = outputHandles(node);
    if (handles.length > 1) {
      // Must match the offsets renderNodes uses, or an edge leaves from
      // somewhere the port is not. An edge with no handle predates the
      // branching outputs, so it takes the first port - which for a router
      // means "Otherwise", the branch it would have fallen through to.
      const wanted = handle || (node.type === 'router' ? 'default' : handles[0].handle);
      const index = Math.max(0, handles.findIndex(h => h.handle === wanted));
      fraction = (index + 1) / (handles.length + 1);
    }
    void def;
    return { x: node.position.x + NODE_WIDTH, y: node.position.y + NODE_HEIGHT * fraction };
  }

  renderEdges() {
    const path = (from, to) => {
      // Horizontal bezier: control points scale with distance so short and
      // long links both read cleanly.
      const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
      return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
    };

    const edges = this.edges.map(edge => {
      const from = this.portPosition(edge.source, 'out', edge.sourceHandle);
      const to = this.portPosition(edge.target, 'in');
      const selected = edge.id === this.selectedEdgeId;
      return `
        <g data-edge-id="${edge.id}" class="wf-edge ${selected ? 'selected' : ''}">
          <path class="wf-edge-hit" d="${path(from, to)}" />
          <path class="wf-edge-line" d="${path(from, to)}" marker-end="url(#wf-arrow)" />
        </g>`;
    }).join('');

    let pending = '';
    if (this.linking) {
      const from = this.portPosition(this.linking.source, 'out', this.linking.sourceHandle);
      pending = `<path class="wf-edge-pending" d="${path(from, this.linking.to)}" />`;
    }

    this.el.edgeLayer.innerHTML = `
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      ${edges}${pending}`;
  }

  // -- properties panel -------------------------------------------------

  renderProperties() {
    const node = this.nodeById(this.selectedNodeId);

    if (!node) {
      this.el.properties.innerHTML = `
        <div class="wf-properties-empty">
          <i data-feather="mouse-pointer"></i>
          <p>Select a node to edit it</p>
          <p class="small text-muted">Drag from a node's right edge to connect it to another.</p>
        </div>
        <div class="wf-workflow-settings">
          <h6>Workflow</h6>
          <label class="form-label" for="wf-name-input">Name</label>
          <input class="form-control form-control-sm" id="wf-name-input"
                 value="${escapeHtml(this.workflow?.name || '')}">
          <label class="form-label mt-2" for="wf-desc-input">Description</label>
          <textarea class="form-control form-control-sm" id="wf-desc-input" rows="3"
            >${escapeHtml(this.workflow?.description || '')}</textarea>
        </div>`;

      document.getElementById('wf-name-input')?.addEventListener('input', e => {
        this.workflow.name = e.target.value;
        this.el.title.textContent = e.target.value || 'Untitled workflow';
        this.markDirty();
      });
      document.getElementById('wf-desc-input')?.addEventListener('input', e => {
        this.workflow.description = e.target.value;
        this.markDirty();
      });
      return;
    }

    const def = NODE_TYPES[node.type];
    const fields = (def.fields || []).filter(f => !f.showWhen || f.showWhen(node.data));

    this.el.properties.innerHTML = `
      <div class="wf-properties-head">
        <span class="wf-palette-icon" style="background:${def.color}">
          <i data-feather="${def.icon}"></i>
        </span>
        <div>
          <div class="fw-semibold">${escapeHtml(def.label)}</div>
          <div class="small text-muted">${escapeHtml(def.description)}</div>
        </div>
      </div>

      <label class="form-label" for="wf-field-label">Node label</label>
      <input class="form-control form-control-sm mb-3" id="wf-field-label"
             data-field="label" value="${escapeHtml(node.data.label || def.label)}">

      ${fields.map(field => this.renderField(node, field)).join('')}

      ${node.type === 'action' ? this.renderActionTest(node) : ''}

      ${def.singleton ? '' : `
        <button class="btn btn-outline-danger btn-sm w-100 mt-3" id="wf-delete-node">
          <i data-feather="trash-2"></i> Delete node
        </button>`}`;

    this.bindPropertyInputs(node);
  }

  renderField(node, field) {
    const value = getPath(node.data, field.key);
    const id = `wf-field-${field.key.replace(/\./g, '-')}`;
    const help = field.help ? `<div class="form-text">${escapeHtml(field.help)}</div>` : '';
    const required = field.required ? ' <span class="text-danger">*</span>' : '';

    let control;
    switch (field.type) {
    case 'textarea':
      control = `<textarea class="form-control form-control-sm" id="${id}" rows="${field.rows || 3}"
          data-field="${field.key}" placeholder="${escapeHtml(field.placeholder || '')}"
          >${escapeHtml(value)}</textarea>`;
      break;

    case 'select':
      control = `<select class="form-select form-select-sm" id="${id}" data-field="${field.key}">
          ${(field.options || []).map(opt =>
    `<option value="${escapeHtml(opt)}" ${opt === value ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
        </select>`;
      break;

    case 'range':
      control = `<input type="range" class="form-range" id="${id}" data-field="${field.key}"
          min="${field.min}" max="${field.max}" step="${field.step}" value="${value ?? field.max}">
          <output class="small text-muted">${escapeHtml(value ?? field.max)}</output>`;
      break;

    case 'conditions':
      return this.renderConditions(node);

    case 'auth':
      return this.renderAuth(node);

    case 'outputs':
      return this.renderOutputs(node);

    case 'choices':
      return this.renderChoices(node);

    case 'assignments':
      return this.renderAssignments(node);

    case 'taglist':
      return this.renderTagList(node, field);

    case 'clauses':
      return this.renderClauses(node);

    case 'capability':
      return this.renderCapabilityPicker(node);

    case 'capability-input':
      return this.renderCapabilityInput(node);

    case 'preset':
      return this.renderActionPresets(node);

    default:
      control = `<input class="form-control form-control-sm" id="${id}" data-field="${field.key}"
          value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || '')}">`;
    }

    return `<div class="mb-3">
      <label class="form-label" for="${id}">${escapeHtml(field.label)}${required}</label>
      ${control}${help}
    </div>`;
  }

  /**
   * Credentials for the tenant's API.
   *
   * The stored value never comes back from the server - it arrives as
   * `hasSecret: true` and nothing else - so this shows whether one is set and
   * offers to replace it. An admin cannot read back a key a colleague
   * entered, which is the point.
   */
  renderAuth(node) {
    const auth = node.data.auth || { type: 'none' };
    const types = [
      { value: 'none', label: 'None' },
      { value: 'bearer', label: 'Bearer token' },
      { value: 'header', label: 'Custom header' },
      { value: 'basic', label: 'Basic (user:password)' }
    ];

    const secretState = auth.hasSecret
      ? `<div class="form-text text-success d-flex align-items-center gap-1">
           <i data-feather="check" style="width:14px;height:14px"></i>
           A credential is saved. Type a new one to replace it.
         </div>`
      : '<div class="form-text">Stored encrypted. It is never shown again once saved.</div>';

    return `
      <div class="mb-3">
        <label class="form-label" for="wf-auth-type">Authentication</label>
        <select class="form-select form-select-sm" id="wf-auth-type">
          ${types.map(t =>
    `<option value="${t.value}" ${t.value === (auth.type || 'none') ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
        </select>

        ${auth.type === 'header' ? `
          <input class="form-control form-control-sm mt-2" id="wf-auth-header"
                 value="${escapeHtml(auth.header || 'x-api-key')}" placeholder="Header name">` : ''}

        ${auth.type && auth.type !== 'none' ? `
          <input class="form-control form-control-sm mt-2" id="wf-auth-value" type="password"
                 autocomplete="new-password"
                 placeholder="${auth.hasSecret ? 'Leave blank to keep the saved value' : 'Paste the key or token'}">
          ${secretState}` : ''}
      </div>`;
  }

  /**
   * The test panel, plus somewhere to put values for the placeholders.
   *
   * Without these a URL like /orders/{{order_id}} tests as /orders/ and
   * returns a 404 that tells the admin nothing about their configuration.
   * The values are scaffolding, so they are held for the session rather than
   * saved onto the node.
   */
  renderActionTest(node) {
    const template = `${node.data.url || ''} ${node.data.body || ''}`;
    const placeholders = [...new Set(
      (template.match(/\{\{\s*([\w.]+)\s*\}\}/g) || [])
        .map(match => match.replace(/[{}\s]/g, ''))
    )].filter(name => name !== 'user_input');

    const values = this.testValues[node.id] || {};

    return `
      <div class="wf-workflow-settings">
        <h6>Try it</h6>
        ${placeholders.length ? `
          <div class="form-text mb-2">Values to stand in for the placeholders.</div>
          ${placeholders.map(name => `
            <div class="mb-2">
              <label class="form-label small mb-1" for="wf-test-var-${name}">{{${escapeHtml(name)}}}</label>
              <input class="form-control form-control-sm" id="wf-test-var-${name}"
                     data-test-var="${escapeHtml(name)}" value="${escapeHtml(values[name] || '')}">
            </div>`).join('')}` : ''}
        <button class="btn btn-outline-primary btn-sm w-100" id="wf-test-action">
          <i data-feather="play-circle"></i> Test this call
        </button>
        <div id="wf-test-result" class="mt-2"></div>
      </div>`;
  }

  /**
   * Which parts of the response the rest of the workflow can use.
   *
   * Explicit by design: nothing from the response reaches the model or the
   * transcript unless it is named here, so an endpoint that returns more than
   * expected does not leak it into the conversation.
   */
  renderOutputs(node) {
    const outputs = node.data.outputs || [];

    return `
      <div class="mb-3">
        <label class="form-label">Read from the response</label>
        <div class="form-text mb-2">
          Pick out the fields you need. Use them later as
          <code>{{name}}</code>. Nothing else from the response is used.
        </div>
        ${outputs.map((output, i) => `
          <div class="wf-output" data-output-index="${i}">
            <div class="wf-output-row">
              <span class="wf-output-prefix">{{</span>
              <input class="form-control form-control-sm" data-output-field="variable"
                     value="${escapeHtml(output.variable || '')}" placeholder="order_status"
                     aria-label="Name to use later">
              <span class="wf-output-prefix">}}</span>
              <button class="btn btn-sm btn-outline-danger" data-remove-output="${i}" title="Remove">
                <i data-feather="x"></i>
              </button>
            </div>
            <input class="form-control form-control-sm mt-1" data-output-field="path"
                   value="${escapeHtml(output.path || '')}" placeholder="data.order.status"
                   aria-label="Where it sits in the response">
          </div>`).join('')}
        <button class="btn btn-sm btn-outline-secondary w-100 mt-2" id="wf-add-output">
          <i data-feather="plus"></i> Add field
        </button>
        ${outputs.length ? `
          <div class="form-text mt-2">
            Below each name, the path into the JSON — e.g.
            <code>data.order.status</code> or <code>items.0.id</code>.
          </div>` : ''}
      </div>`;
  }

  /**
   * The buttons a visitor will see.
   *
   * Each one gets its own output on the node, so the branch a choice leads to
   * is drawn rather than configured — which is the entire reason to build a
   * flow visually instead of writing it.
   */
  renderChoices(node) {
    const choices = node.data.choices || [];

    return `
      <div class="mb-3">
        <label class="form-label">Choices</label>
        <div class="form-text mb-2">
          Each choice gets its own output. Anything else the visitor types
          goes to "Something else".
        </div>
        ${choices.map((choice, i) => `
          <div class="wf-condition" data-choice-index="${i}">
            <input class="form-control form-control-sm" data-choice-field="label"
                   value="${escapeHtml(choice.label || '')}" placeholder="Track my order">
            <input class="form-control form-control-sm" data-choice-field="value"
                   value="${escapeHtml(choice.value || '')}" placeholder="value (optional)">
            <button class="btn btn-sm btn-outline-danger" data-remove-choice="${i}" title="Remove">
              <i data-feather="x"></i>
            </button>
          </div>`).join('')}
        <button class="btn btn-sm btn-outline-secondary w-100 mt-2" id="wf-add-choice">
          <i data-feather="plus"></i> Add choice
        </button>
      </div>`;
  }

  /** Values to compute or rename before the next step. */
  renderAssignments(node) {
    const assignments = node.data.assignments || [];

    return `
      <div class="mb-3">
        <label class="form-label">Values</label>
        <div class="form-text mb-2">
          The name on the left, what it should be on the right. Placeholders
          such as <code>{{order_id}}</code> are filled in.
        </div>
        ${assignments.map((assignment, i) => `
          <div class="wf-condition" data-assignment-index="${i}">
            <input class="form-control form-control-sm" data-assignment-field="variable"
                   value="${escapeHtml(assignment.variable || '')}" placeholder="greeting">
            <input class="form-control form-control-sm" data-assignment-field="value"
                   value="${escapeHtml(assignment.value || '')}" placeholder="Hello {{name}}">
            <button class="btn btn-sm btn-outline-danger" data-remove-assignment="${i}" title="Remove">
              <i data-feather="x"></i>
            </button>
          </div>`).join('')}
        <button class="btn btn-sm btn-outline-secondary w-100 mt-2" id="wf-add-assignment">
          <i data-feather="plus"></i> Add value
        </button>
      </div>`;
  }

  /** A comma-separated list, which is how people already write tags. */
  renderTagList(node, field) {
    const value = (node.data[field.key] || []).join(', ');

    return `
      <div class="mb-3">
        <label class="form-label" for="wf-field-taglist">${escapeHtml(field.label)}</label>
        <input class="form-control form-control-sm" id="wf-field-taglist"
               data-taglist="${escapeHtml(field.key)}"
               value="${escapeHtml(value)}" placeholder="refund, urgent">
        ${field.help ? `<div class="form-text">${escapeHtml(field.help)}</div>` : ''}
      </div>`;
  }

  /**
   * Checks combined with all/any.
   *
   * This is the deliberate answer to "do we need scripting": nearly every
   * real condition is two or three comparisons AND-ed together, and a clause
   * list covers that without evaluating tenant-supplied code.
   */
  renderClauses(node) {
    // Workflows saved before clauses existed carry a single
    // left/operator/right — seed the list from it so nothing is lost.
    if ((!node.data.clauses || !node.data.clauses.length) && node.data.left !== undefined) {
      node.data.clauses = [{
        left: node.data.left || '',
        operator: node.data.operator || 'equals',
        right: node.data.right || ''
      }];
    }

    const clauses = node.data.clauses || [];
    const operators = ['equals', 'not_equals', 'contains', 'starts_with',
      'greater_than', 'less_than', 'is_empty', 'is_not_empty', 'matches'];

    return `
      <div class="mb-3">
        <label class="form-label">Checks</label>
        ${clauses.length > 1 ? `
          <select class="form-select form-select-sm mb-2" data-field="match"
                  aria-label="How the checks combine">
            <option value="all" ${node.data.match !== 'any' ? 'selected' : ''}>All must be true</option>
            <option value="any" ${node.data.match === 'any' ? 'selected' : ''}>Any may be true</option>
          </select>` : ''}
        ${clauses.map((clause, i) => `
          <div class="wf-clause" data-clause-index="${i}">
            <input class="form-control form-control-sm" data-clause-field="left"
                   value="${escapeHtml(clause.left || '')}" placeholder="{{order_status}}"
                   aria-label="Value to check">
            <div class="wf-clause-row">
              <select class="form-select form-select-sm" data-clause-field="operator"
                      aria-label="Comparison">
                ${operators.map(op => `
                  <option value="${op}" ${op === (clause.operator || 'equals') ? 'selected' : ''}>
                    ${op.replace(/_/g, ' ')}
                  </option>`).join('')}
              </select>
              <input class="form-control form-control-sm" data-clause-field="right"
                     value="${escapeHtml(clause.right || '')}" placeholder="shipped"
                     aria-label="Compared with">
              <button class="btn btn-sm btn-outline-danger" data-remove-clause="${i}" title="Remove">
                <i data-feather="x"></i>
              </button>
            </div>
          </div>`).join('')}
        <button class="btn btn-sm btn-outline-secondary w-100 mt-2" id="wf-add-clause">
          <i data-feather="plus"></i> Add a check
        </button>
      </div>`;
  }

  /**
   * Prefilled recipes for the services people actually use.
   *
   * The Call an API node already reaches any of these — what stops a tenant
   * is knowing each API's shape. A preset fills in the URL, method, auth
   * style and field mappings; they paste one credential and change the
   * placeholders. This is the whole integration strategy: recipes over
   * connectors, so five presets cover what would otherwise be five
   * subsystems to build and maintain.
   */
  renderActionPresets(node) {
    void node;
    return `
      <div class="mb-3">
        <label class="form-label" for="wf-action-preset">Start from a service</label>
        <select class="form-select form-select-sm" id="wf-action-preset">
          <option value="">Custom — configure by hand</option>
          ${ACTION_PRESETS.map(preset => `
            <option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`).join('')}
        </select>
        <div class="form-text">
          Picking one fills in the fields below, replacing what is there. It
          does not add a credential — that stays yours to paste.
        </div>
      </div>`;
  }

  /**
   * Which of the tenant's capabilities this node uses.
   *
   * Only the ones their connector actually implements are offered. Listing
   * capabilities they have not built would let somebody wire a flow that can
   * never work and only find out in front of a customer.
   */
  renderCapabilityPicker(node) {
    const available = workflowCapabilities.contract || [];
    const implemented = new Set(workflowCapabilities.connector || []);

    if (available.length === 0) {
      return `
        <div class="alert alert-warning py-2 px-3 small">
          No connector is set up yet. Add one under
          <strong>Settings → Your data</strong> to use your own catalogue and
          appointment times here.
        </div>`;
    }

    return `
      <div class="mb-3">
        <label class="form-label" for="wf-capability">What to do <span class="text-danger">*</span></label>
        <select class="form-select form-select-sm" id="wf-capability" data-field="capability">
          <option value="">Choose…</option>
          ${available.map(capability => {
    const ready = implemented.has(capability.id);
    return `<option value="${escapeHtml(capability.id)}"
                      ${capability.id === node.data.capability ? 'selected' : ''}
                      ${ready ? '' : 'disabled'}>
                ${escapeHtml(capability.label)}${ready ? '' : ' — not implemented yet'}
              </option>`;
  }).join('')}
        </select>
        ${node.data.capability ? `
          <div class="form-text">
            ${escapeHtml((available.find(c => c.id === node.data.capability) || {}).description || '')}
          </div>` : ''}
      </div>`;
  }

  /**
   * The inputs the chosen capability takes.
   *
   * Built from the contract rather than typed by hand, so an author cannot
   * misspell a field name and get silence.
   */
  renderCapabilityInput(node) {
    const capability = (workflowCapabilities.contract || [])
      .find(entry => entry.id === node.data.capability);

    if (!capability) {
      return '';
    }

    const values = node.data.input || {};

    return `
      <div class="mb-3">
        <label class="form-label">Inputs</label>
        <div class="form-text mb-2">
          Placeholders such as <code>{{user_input}}</code> are filled in.
        </div>
        ${Object.entries(capability.input).map(([field, spec]) => {
    const optional = spec.endsWith('?');
    return `
            <div class="mb-2">
              <label class="form-label small mb-1" for="wf-cap-${field}">
                ${escapeHtml(field)}${optional ? '' : ' <span class="text-danger">*</span>'}
                <span class="text-muted">${escapeHtml(spec.replace('?', ''))}</span>
              </label>
              <input class="form-control form-control-sm" id="wf-cap-${field}"
                     data-capability-input="${escapeHtml(field)}"
                     value="${escapeHtml(values[field] || '')}"
                     placeholder="${field === 'query' ? '{{user_input}}' : ''}">
            </div>`;
  }).join('')}
      </div>`;
  }

  renderConditions(node) {
    const conditions = node.data.conditions || [];
    return `
      <div class="mb-3">
        <label class="form-label">Routing rules</label>
        <div class="form-text mb-2">Each rule gets its own output on the node. Anything that matches none goes to "Otherwise".</div>
        ${conditions.map((c, i) => `
          <div class="wf-condition" data-condition-index="${i}">
            <select class="form-select form-select-sm" data-condition-field="type">
              ${CONDITION_TYPES.map(t =>
    `<option value="${t.value}" ${t.value === c.type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
            </select>
            <input class="form-control form-control-sm" data-condition-field="value"
                   value="${escapeHtml(c.value || '')}"
                   placeholder="${escapeHtml(CONDITION_HELP[c.type]?.placeholder || 'refund, cancel')}">
            <button class="btn btn-sm btn-outline-danger" data-remove-condition="${i}" title="Remove">
              <i data-feather="x"></i>
            </button>
          </div>
          <div class="wf-condition-help">${escapeHtml(CONDITION_HELP[c.type]?.help || '')}</div>`).join('')}
        <button class="btn btn-sm btn-outline-secondary w-100 mt-2" id="wf-add-condition">
          <i data-feather="plus"></i> Add rule
        </button>
      </div>`;
  }

  bindPropertyInputs(node) {
    this.el.properties.querySelectorAll('[data-field]').forEach(input => {
      const handler = e => {
        let value = e.target.value;
        if (e.target.type === 'range') {
          value = parseFloat(value);
          const output = e.target.parentElement.querySelector('output');
          if (output) {
            output.textContent = value;
          }
        }
        setPath(node.data, e.target.dataset.field, value);
        this.markDirty();

        // Only the fields that change the node's appearance need a repaint.
        if (['label', 'sourceType', 'prompt', 'template', 'message', 'strictness',
          'url', 'method', 'question', 'variable', 'left', 'operator', 'right',
          'title', 'capability'].includes(e.target.dataset.field)) {
          this.renderNodes();
          if (feather) {
            feather.replace();
          }
        }
        // Changing the method shows or hides the request body field.
        if (['sourceType', 'method', 'operator', 'capability'].includes(e.target.dataset.field)) {
          this.renderProperties();
        }

        // Editing a URL or body changes which placeholders exist, and the
        // "Try it" inputs are built from them. Redrawn on `change` rather
        // than `input` so the field is not rebuilt under the cursor on every
        // keystroke.
        if (e.type === 'change' && ['url', 'body'].includes(e.target.dataset.field)) {
          this.renderProperties();
          if (feather) {
            feather.replace();
          }
        }
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
      // After the handler, so the snapshot holds the new value.
      this.commitOnChange(input);
    });

    this.el.properties.querySelector('#wf-auth-type')?.addEventListener('change', e => {
      node.data.auth = { ...(node.data.auth || {}), type: e.target.value };
      this.markDirty();
      this.pushHistory();
      this.renderProperties();
    });

    const authHeader = this.el.properties.querySelector('#wf-auth-header');
    authHeader?.addEventListener('input', e => {
      node.data.auth = { ...(node.data.auth || {}), header: e.target.value };
      this.markDirty();
    });
    if (authHeader) {
      this.commitOnChange(authHeader);
    }

    const authValue = this.el.properties.querySelector('#wf-auth-value');
    authValue?.addEventListener('input', e => {
      // Only sent when non-empty, so leaving the field blank keeps whatever
      // is already stored rather than wiping it.
      node.data.auth = { ...(node.data.auth || {}), value: e.target.value };
      this.markDirty();
    });
    if (authValue) {
      this.commitOnChange(authValue);
    }

    this.el.properties.querySelector('#wf-add-output')?.addEventListener('click', () => {
      node.data.outputs = node.data.outputs || [];
      node.data.outputs.push({ variable: '', path: '' });
      this.markDirty();
      this.renderProperties();
      if (feather) {
        feather.replace();
      }
    });

    this.el.properties.querySelectorAll('[data-remove-output]').forEach(btn => {
      btn.addEventListener('click', () => {
        node.data.outputs.splice(parseInt(btn.dataset.removeOutput, 10), 1);
        this.markDirty();
        this.pushHistory();
        this.renderProperties();
        if (feather) {
          feather.replace();
        }
      });
    });

    this.el.properties.querySelectorAll('.wf-output').forEach(row => {
      const index = parseInt(row.dataset.outputIndex, 10);
      row.querySelectorAll('[data-output-field]').forEach(input => {
        input.addEventListener('input', e => {
          node.data.outputs[index][e.target.dataset.outputField] = e.target.value;
          this.markDirty();
        });
        this.commitOnChange(input);
      });
    });

    this.el.properties.querySelectorAll('[data-test-var]').forEach(input => {
      input.addEventListener('input', e => {
        this.testValues[node.id] = this.testValues[node.id] || {};
        this.testValues[node.id][e.target.dataset.testVar] = e.target.value;
      });
    });

    // Repeating groups: choices and assignments behave identically, so the
    // wiring is shared rather than written twice with one of them subtly
    // different.
    [
      { add: 'wf-add-choice', key: 'choices', indexAttr: 'choiceIndex',
        fieldAttr: 'choiceField', removeAttr: 'removeChoice',
        blank: () => ({ id: this.uid('choice'), label: '', value: '' }) },
      { add: 'wf-add-assignment', key: 'assignments', indexAttr: 'assignmentIndex',
        fieldAttr: 'assignmentField', removeAttr: 'removeAssignment',
        blank: () => ({ variable: '', value: '' }) },
      { add: 'wf-add-clause', key: 'clauses', indexAttr: 'clauseIndex',
        fieldAttr: 'clauseField', removeAttr: 'removeClause',
        blank: () => ({ left: '', operator: 'equals', right: '' }) }
    ].forEach(group => {
      this.el.properties.querySelector(`#${group.add}`)?.addEventListener('click', () => {
        node.data[group.key] = node.data[group.key] || [];
        node.data[group.key].push(group.blank());
        this.markDirty();
        this.pushHistory();
        this.render();
      });

      this.el.properties.querySelectorAll(`[data-${group.removeAttr.replace(/([A-Z])/g, '-$1').toLowerCase()}]`)
        .forEach(button => {
          button.addEventListener('click', () => {
            const index = parseInt(button.dataset[group.removeAttr], 10);
            const removed = node.data[group.key][index];
            node.data[group.key].splice(index, 1);

            // Drop edges hanging off an output that no longer exists,
            // otherwise they point at a handle that is gone.
            if (removed && removed.id) {
              this.edges = this.edges.filter(edge =>
                !(edge.source === node.id && edge.sourceHandle === removed.id));
            }

            this.markDirty();
            this.pushHistory();
            this.render();
          });
        });

      this.el.properties.querySelectorAll(`[data-${group.indexAttr.replace(/([A-Z])/g, '-$1').toLowerCase()}]`)
        .forEach(row => {
          const index = parseInt(row.dataset[group.indexAttr], 10);
          row.querySelectorAll(`[data-${group.fieldAttr.replace(/([A-Z])/g, '-$1').toLowerCase()}]`)
            .forEach(input => {
              input.addEventListener('input', event => {
                node.data[group.key][index][event.target.dataset[group.fieldAttr]] = event.target.value;
                this.markDirty();
                this.renderNodes();
              });
              this.commitOnChange(input);
            });
        });
    });

    this.el.properties.querySelectorAll('[data-capability-input]').forEach(input => {
      input.addEventListener('input', event => {
        node.data.input = node.data.input || {};
        node.data.input[event.target.dataset.capabilityInput] = event.target.value;
        this.markDirty();
      });
      this.commitOnChange(input);
    });

    this.el.properties.querySelectorAll('[data-taglist]').forEach(input => {
      input.addEventListener('input', event => {
        node.data[event.target.dataset.taglist] = event.target.value
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean);
        this.markDirty();
        this.renderNodes();
      });
      this.commitOnChange(input);
    });

    this.el.properties.querySelector('#wf-action-preset')?.addEventListener('change', event => {
      const preset = ACTION_PRESETS.find(entry => entry.id === event.target.value);

      if (!preset) {
        return;
      }

      // A deep copy, so editing the node never mutates the catalogue and a
      // second use of the same preset starts clean. The credential is left
      // alone: a preset must never wipe a key someone already pasted.
      const config = JSON.parse(JSON.stringify(preset.config));
      const keepAuthValue = node.data.auth && node.data.auth.value;

      Object.assign(node.data, config);
      if (keepAuthValue && node.data.auth) {
        node.data.auth.value = keepAuthValue;
      }

      this.markDirty();
      this.pushHistory();
      this.render();
      if (feather) {
        feather.replace();
      }

      // Shown for longer than a normal toast: it says where the credential
      // comes from, which is the step people get stuck on, and it is gone
      // from the panel once the fields are filled.
      this.toast(preset.note, 'info', 12000);
    });

    this.el.properties.querySelector('#wf-test-action')?.addEventListener('click', async () => {
      const button = this.el.properties.querySelector('#wf-test-action');
      const output = this.el.properties.querySelector('#wf-test-result');

      button.disabled = true;
      button.innerHTML = 'Calling…';
      output.innerHTML = '';

      try {
        const payload = await this.api('/actions/test', {
          method: 'POST',
          body: JSON.stringify({
            config: node.data,
            variables: this.testValues[node.id] || {},
            workflowId: this.workflowId,
            nodeId: node.id
          })
        });

        const result = payload.result;

        if (!result) {
          output.innerHTML = '<div class="alert alert-danger py-2 px-3 small mb-0">The test could not run</div>';
          return;
        }

        const mapped = Object.entries(result.variables || {});

        output.innerHTML = `
          <div class="alert alert-${result.ok ? 'success' : 'danger'} py-2 px-3 small mb-0">
            <div class="fw-semibold">
              ${result.ok ? 'Worked' : 'Failed'}
              ${result.status ? `· HTTP ${result.status}` : ''}
              ${result.durationMs ? `· ${result.durationMs}ms` : ''}
            </div>
            ${result.error ? `<div class="mt-1">${escapeHtml(result.error)}</div>` : ''}
            ${mapped.length ? `
              <dl class="row mb-0 mt-2">
                ${mapped.map(([name, value]) => `
                  <dt class="col-5 text-truncate">{{${escapeHtml(name)}}}</dt>
                  <dd class="col-7 text-truncate mb-0">${escapeHtml(value) || '<em>empty</em>'}</dd>`).join('')}
              </dl>` : ''}
            ${result.body ? `
              <details class="mt-2">
                <summary>Response</summary>
                <pre class="small mb-0 mt-1" style="max-height:200px;overflow:auto">${escapeHtml(result.body)}</pre>
              </details>` : ''}
          </div>`;
      } catch (error) {
        output.innerHTML = `<div class="alert alert-danger py-2 px-3 small mb-0">${escapeHtml(error.message)}</div>`;
      } finally {
        button.disabled = false;
        button.innerHTML = 'Test this call';
      }
    });

    this.el.properties.querySelector('#wf-delete-node')?.addEventListener('click', () => {
      this.selectedNodeId = node.id;
      this.deleteSelection();
    });

    this.el.properties.querySelector('#wf-add-condition')?.addEventListener('click', () => {
      node.data.conditions = node.data.conditions || [];
      node.data.conditions.push({ id: this.uid('cond'), type: 'intent', value: '' });
      this.markDirty();
      this.pushHistory();
      this.render();
    });

    this.el.properties.querySelectorAll('[data-remove-condition]').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.removeCondition, 10);
        const removed = node.data.conditions[index];
        node.data.conditions.splice(index, 1);
        // Drop edges that hung off the removed output, otherwise they point
        // at a handle that no longer exists.
        this.edges = this.edges.filter(e =>
          !(e.source === node.id && e.sourceHandle === (removed.id || `cond_${index}`)));
        this.markDirty();
        this.pushHistory();
        this.render();
      });
    });

    this.el.properties.querySelectorAll('.wf-condition').forEach(row => {
      const index = parseInt(row.dataset.conditionIndex, 10);
      row.querySelectorAll('[data-condition-field]').forEach(input => {
        input.addEventListener('input', e => {
          const field = e.target.dataset.conditionField;
          node.data.conditions[index][field] = e.target.value;
          this.markDirty();
          this.renderNodes();

          // Switching type changes the placeholder and the guidance, so the
          // panel has to be redrawn.
          if (field === 'type') {
            this.renderProperties();
          }
        });
        this.commitOnChange(input);
      });
    });
  }

  // -- preview ----------------------------------------------------------

  openPreview() {
    this.el.preview.hidden = false;

    if (!this.el.previewTranscript.children.length) {
      this.addPreviewNote(
        'Say something a visitor might say. The nodes it passes through light up on the canvas.'
      );
    }

    this.el.previewMessage.focus();
  }

  restartPreview() {
    this.previewState = null;
    this.el.previewTranscript.innerHTML = '';
    this.clearPath();
    this.addPreviewNote('Started again from the top.');
  }

  addPreviewMessage(text, who) {
    const el = document.createElement('div');
    el.className = `wf-preview-msg ${who}`;
    el.textContent = text;
    this.el.previewTranscript.appendChild(el);
    this.el.previewTranscript.scrollTop = this.el.previewTranscript.scrollHeight;
    return el;
  }

  addPreviewNote(text) {
    const el = document.createElement('div');
    el.className = 'wf-preview-note-line';
    el.textContent = text;
    this.el.previewTranscript.appendChild(el);
    this.el.previewTranscript.scrollTop = this.el.previewTranscript.scrollHeight;
  }

  /**
   * Buttons a choices node offered, so they can be tapped rather than typed.
   *
   * Tapping is how a visitor will answer, so testing by typing the label
   * would be testing a path most people never take.
   */
  addPreviewChoices(choices) {
    const group = document.createElement('div');
    group.className = 'wf-preview-choices';

    choices.forEach(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wf-preview-choice';
      button.textContent = choice.label;
      button.addEventListener('click', () => {
        group.remove();
        this.sendPreview(choice.label);
      });
      group.appendChild(button);
    });

    this.el.previewTranscript.appendChild(group);
    this.el.previewTranscript.scrollTop = this.el.previewTranscript.scrollHeight;
  }

  clearPath(forget = true) {
    if (forget) {
      this.lastPath = null;
    }
    this.el.nodeLayer.querySelectorAll('.wf-visited, .wf-visited-last').forEach(el => {
      el.classList.remove('wf-visited', 'wf-visited-last');
    });
  }

  /** Re-apply the last run's path after the node layer has been rebuilt. */
  repaintPath() {
    if (this.lastPath && !this.el.preview.hidden) {
      this.showPath(this.lastPath);
    }
  }

  /**
   * Light up the nodes the run passed through.
   *
   * The reason to try a flow here rather than in the widget: seeing which
   * branch it actually took answers "why did it say that" without reading
   * the graph backwards.
   */
  showPath(path) {
    // Remembered because renderNodes rebuilds the layer from scratch — after
    // dragging a node the highlight would otherwise vanish mid-conversation,
    // which reads as the preview having lost its place.
    this.clearPath(false);
    this.lastPath = path;

    path.forEach((nodeId, index) => {
      const el = this.el.nodeLayer.querySelector(`[data-node-id="${nodeId}"]`);
      if (el) {
        el.classList.add(index === path.length - 1 ? 'wf-visited-last' : 'wf-visited');
      }
    });

    this.followRun(path[path.length - 1]);
  }

  /**
   * Keep the node the run just reached in view.
   *
   * A flow reads left to right and ends on the right, which is exactly where
   * the preview panel sits — without this, the interesting node is behind the
   * panel for the last half of every conversation. Only pans when the node is
   * actually out of sight, so the canvas does not lurch on every turn.
   */
  followRun(nodeId) {
    const node = this.nodeById(nodeId);

    if (!node) {
      return;
    }

    const rect = this.el.canvas.getBoundingClientRect();
    const panelWidth = this.el.preview.hidden
      ? 0
      : this.el.preview.getBoundingClientRect().width + 32;

    // Where the node currently sits in the viewport.
    const x = node.position.x * this.view.zoom + this.view.x;
    const y = node.position.y * this.view.zoom + this.view.y;
    const width = NODE_WIDTH * this.view.zoom;
    const height = NODE_HEIGHT * this.view.zoom;

    const margin = 40;
    const visibleRight = rect.width - panelWidth - margin;

    let dx = 0;
    let dy = 0;

    if (x + width > visibleRight) {
      dx = visibleRight - (x + width);
    } else if (x < margin) {
      dx = margin - x;
    }

    if (y + height > rect.height - margin) {
      dy = (rect.height - margin) - (y + height);
    } else if (y < margin) {
      dy = margin - y;
    }

    if (dx === 0 && dy === 0) {
      return;
    }

    this.view.x += dx;
    this.view.y += dy;
    this.applyTransform();
  }

  async sendPreview(text) {
    const message = (text !== undefined ? text : this.el.previewMessage.value).trim();

    if (!message) {
      return;
    }

    this.addPreviewMessage(message, 'visitor');
    this.el.previewMessage.value = '';

    const thinking = this.addPreviewMessage('…', 'bot');

    try {
      const result = await this.api('/preview', {
        method: 'POST',
        body: JSON.stringify({
          // The canvas as it stands, saved or not — trying the unsaved thing
          // is the whole point.
          nodes: this.nodes,
          edges: this.edges,
          message,
          state: this.previewState || {}
        })
      });

      thinking.remove();

      if (result.invalid) {
        this.addPreviewNote(`Cannot run yet: ${result.errors.join(' · ')}`);
        return;
      }

      this.addPreviewMessage(result.response || '(the flow ended without saying anything)', 'bot');
      this.previewState = result.state;

      (result.simulated || []).forEach(note => {
        this.addPreviewNote(`Would have: ${note.description}${note.detail ? ` — ${note.detail}` : ''}`);
      });

      if (result.escalation) {
        this.addPreviewNote('The conversation would now go to an operator.');
      }

      if (result.choices && result.choices.length) {
        this.addPreviewChoices(result.choices);
      }

      this.showPath(result.path || []);
    } catch (error) {
      thinking.remove();
      this.addPreviewNote(error.message);
    }
  }

  // -- templates --------------------------------------------------------

  /**
   * Offer the flows somebody was going to build anyway.
   *
   * Loaded on demand rather than at start-up: most sessions are edits to an
   * existing workflow and never open this.
   */
  /**
   * The contract, and which parts of it this tenant has built.
   *
   * Loaded once at start-up rather than per node, and failing quietly: a
   * tenant with no connector still has a fully working editor, they simply
   * do not see the Use Your Data node offering anything.
   */
  async loadCapabilities() {
    try {
      const response = await fetch('/api/companies/me/connector', {
        headers: { 'x-auth-token': this.token }
      });

      if (!response.ok) {
        return;
      }

      const body = await response.json();
      workflowCapabilities.contract = body.contract || [];
      workflowCapabilities.connector = (body.connector && body.connector.capabilities) || [];
    } catch {
      workflowCapabilities.contract = [];
      workflowCapabilities.connector = [];
    }
  }

  async openTemplates() {
    this.el.templatePicker.hidden = false;
    this.el.templateList.innerHTML = '<p class="text-muted">Loading…</p>';

    try {
      const { templates } = await this.api('/templates');

      this.el.templateList.innerHTML = templates.map(template => `
        <button type="button" class="wf-template-card" data-template="${escapeHtml(template.id)}">
          <span class="wf-template-industry">${escapeHtml(template.industry)}</span>
          <span class="wf-template-name">${escapeHtml(template.name)}</span>
          <span class="wf-template-summary">${escapeHtml(template.summary)}</span>
          <span class="wf-template-requires">Needs: ${escapeHtml(template.requires)}</span>
        </button>`).join('');

      this.el.templateList.querySelectorAll('[data-template]').forEach(card => {
        card.addEventListener('click', () => this.applyTemplate(card.dataset.template));
      });
    } catch (error) {
      this.el.templateList.innerHTML =
        `<p class="text-danger">${escapeHtml(error.message)}</p>`;
    }
  }

  /**
   * Load a template onto the canvas.
   *
   * Replaces what is there, so an author with unsaved work is asked first —
   * losing a half-built flow to a misclick is not recoverable through undo
   * once the page has moved on.
   */
  async applyTemplate(id) {
    if (this.nodes.length > 0 &&
        !confirm('This replaces everything on the canvas. Continue?')) {
      return;
    }

    try {
      const { template } = await this.api(`/templates/${encodeURIComponent(id)}`);

      // Ids are regenerated so two templates loaded in one session cannot
      // collide, and so a saved workflow never shares ids with the template
      // it came from.
      const idMap = new Map();
      this.nodes = template.nodes.map(node => {
        const fresh = this.uid('node');
        idMap.set(node.id, fresh);
        return {
          id: fresh,
          type: node.type,
          position: { ...node.position },
          data: JSON.parse(JSON.stringify(node.data))
        };
      });

      this.edges = template.edges.map(edge => ({
        id: this.uid('edge'),
        source: idMap.get(edge.source),
        target: idMap.get(edge.target),
        sourceHandle: edge.sourceHandle || null
      })).filter(edge => edge.source && edge.target);

      if (!this.workflow.name || this.workflow.name === 'Untitled workflow') {
        this.workflow.name = template.name;
        this.el.title.textContent = template.name;
      }

      this.el.templatePicker.hidden = true;
      this.selectedNodeId = null;
      this.markDirty();
      this.pushHistory();
      this.render();
      this.fitView();
      this.applyTransform();

      this.toast(`Loaded "${template.name}". Change the wording to suit you, then publish.`, 'success');
    } catch (error) {
      this.toast(error.message, 'danger');
    }
  }

  // -- toolbar actions --------------------------------------------------

  bindToolbar() {
    const on = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);

    on('wf-try', () => this.openPreview());
    on('wf-preview-close', () => {
      this.el.preview.hidden = true;
      this.clearPath();
    });
    on('wf-preview-restart', () => this.restartPreview());
    on('wf-preview-send', () => this.sendPreview());

    this.el.previewMessage?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.sendPreview();
      }
    });

    on('wf-open-templates', () => this.openTemplates());
    on('wf-template-close', () => {
      this.el.templatePicker.hidden = true;
    });
    on('wf-templates', () => this.openTemplates());

    on('wf-save', () => this.save());
    on('wf-publish', () => this.publish());
    on('wf-validate', () => this.validate(true));
    on('wf-versions', () => this.showVersions());
    on('wf-duplicate', () => this.duplicateWorkflow());
    on('wf-delete', () => this.deleteWorkflow());
    on('wf-undo', () => this.undo());
    on('wf-redo', () => this.redo());
    on('wf-fit', () => {
      this.fitView(); this.applyTransform();
    });
    on('wf-zoom-in', () => this.zoomBy(1.2));
    on('wf-zoom-out', () => this.zoomBy(1 / 1.2));
    on('wf-rename', () => this.rename());
    on('wf-back', () => {
      if (!this.dirty || confirm('You have unsaved changes. Leave anyway?')) {
        location.href = '/admin/';
      }
    });
  }

  bindKeyboard() {
    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
        return;
      }
      if (typing) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.duplicateSelectedNode();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelection();
      }
      if (e.key === 'Escape') {
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.render();
      }
    });
  }

  zoomBy(factor) {
    this.view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
    this.applyTransform();
  }

  fitView() {
    if (!this.nodes.length) {
      this.view = { x: 40, y: 40, zoom: 1 };
      return;
    }

    const xs = this.nodes.map(n => n.position.x);
    const ys = this.nodes.map(n => n.position.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + NODE_WIDTH;
    const maxY = Math.max(...ys) + NODE_HEIGHT;

    const rect = this.el.canvas.getBoundingClientRect();
    const padding = 60;

    // Floored well above MIN_ZOOM. A wide flow fitted to the window lands
    // around 35%, where the node titles are unreadable and "fit to view"
    // shows you a diagram of something you cannot read. Better to show the
    // start of it at a legible size and let the canvas be panned — a
    // workflow is read left to right anyway.
    const READABLE_ZOOM = 0.6;

    const fitted = Math.min(
      (rect.width - padding * 2) / (maxX - minX),
      (rect.height - padding * 2) / (maxY - minY)
    );

    const zoom = Math.min(MAX_ZOOM, Math.max(READABLE_ZOOM, fitted));
    const fitsWhole = fitted >= READABLE_ZOOM;

    this.view = {
      zoom,
      // Centred when the whole thing fits; otherwise anchored to the entry
      // point, because that is where reading starts.
      x: fitsWhole
        ? (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom
        : padding - minX * zoom,
      y: fitsWhole
        ? (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom
        : padding - minY * zoom
    };
    this.applyTransform();
  }

  /** @returns {boolean} whether a name was given (false when cancelled). */
  rename() {
    const name = prompt('Workflow name', this.workflow?.name || '');
    if (name && name.trim()) {
      this.workflow.name = name.trim();
      this.markDirty();
      this.render();
      return true;
    }
    return false;
  }

  /** @returns {Promise<boolean>} true once saved, false if cancelled or failed. */
  async save() {
    if (!this.workflow?.name?.trim()) {
      this.toast('Give the workflow a name first', 'warning');
      if (!this.rename()) {
        return false;
      }
    }

    this.setBusy(true);
    try {
      const payload = {
        name: this.workflow.name,
        description: this.workflow.description || '',
        ...this.serialise()
      };

      const result = this.workflowId
        ? await this.api(`/${encodeURIComponent(this.workflowId)}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await this.api('', { method: 'POST', body: JSON.stringify(payload) });

      this.workflow = result.workflow;
      const isNew = !this.workflowId;
      this.workflowId = result.workflow._id;
      this.markSaved();
      this.render();
      this.toast('Workflow saved', 'success');

      if (isNew) {
        // Put the id in the URL so a refresh reopens the same workflow.
        history.replaceState({}, '', `?id=${encodeURIComponent(this.workflowId)}`);
        this.loadWorkflowList();
      }
      return true;
    } catch (error) {
      this.toast(`Save failed: ${error.message}`, 'danger');
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  async validate(showSuccess = false) {
    try {
      const result = await this.api('/validate', {
        method: 'POST',
        body: JSON.stringify(this.serialise())
      });

      this.validationErrors = (result.errors || []).map(message => ({
        message,
        nodeId: this.nodes.find(n => message.includes(n.data.label) || message.includes(n.id))?.id || null
      }));

      this.renderProblems(result);
      this.renderNodes();
      if (feather) {
        feather.replace();
      }

      if (result.valid && showSuccess) {
        this.toast('Workflow is valid', 'success');
      }
      return result.valid;
    } catch (error) {
      this.toast(`Validation failed: ${error.message}`, 'danger');
      return false;
    }
  }

  renderProblems(result) {
    const errors = result.errors || [];
    const warnings = result.warnings || [];
    const total = errors.length + warnings.length;

    this.el.problemCount.textContent = total;
    this.el.problemCount.className = `badge ${errors.length ? 'bg-danger' : warnings.length ? 'bg-warning text-dark' : 'bg-success'}`;

    if (total === 0) {
      this.el.problems.innerHTML = '<div class="text-success small px-3 py-2">No problems found.</div>';
      return;
    }

    this.el.problems.innerHTML = [
      ...errors.map(e => `<div class="wf-problem error"><i data-feather="alert-circle"></i>${escapeHtml(e)}</div>`),
      ...warnings.map(w => `<div class="wf-problem warning"><i data-feather="alert-triangle"></i>${escapeHtml(w)}</div>`)
    ].join('');
  }

  async publish() {
    // A workflow that has never been saved has nothing to publish yet, so
    // save it first even when nothing on the canvas has changed.
    if (this.dirty || !this.workflowId) {
      const saved = await this.save();
      if (!saved) {
        this.toast(this.workflow?.name?.trim()
          ? 'Publishing cancelled: the workflow could not be saved'
          : 'Publishing cancelled: the workflow needs a name', 'warning');
        return;
      }
    }
    if (!this.workflowId) {
      return;
    }

    // Publishing swaps the workflow serving live conversations, so validate
    // first rather than letting a broken graph reach visitors.
    const valid = await this.validate();
    if (!valid) {
      this.toast('Fix the problems listed before publishing', 'warning');
      return;
    }

    if (!confirm('Publish this workflow? It will immediately handle live conversations.')) {
      return;
    }

    this.setBusy(true);
    try {
      const result = await this.api(`/${encodeURIComponent(this.workflowId)}/publish`, { method: 'POST' });
      this.workflow = result.workflow;
      this.render();
      this.toast(result.message || 'Workflow published', 'success');
      this.loadWorkflowList();
    } catch (error) {
      this.toast(`Publish failed: ${error.message}`, 'danger');
    } finally {
      this.setBusy(false);
    }
  }

  async showVersions() {
    if (!this.workflowId) {
      this.toast('Save the workflow first', 'warning');
      return;
    }

    try {
      const { versions } = await this.api(`/${encodeURIComponent(this.workflowId)}/versions`);
      const body = document.getElementById('wf-version-list');

      body.innerHTML = versions.length
        ? versions.map(v => `
            <div class="d-flex justify-content-between align-items-center border-bottom py-2 gap-3">
              <div>
                <div class="fw-semibold">Version ${escapeHtml(v.version)}</div>
                <div class="small text-muted">
                  ${escapeHtml(new Date(v.createdAt).toLocaleString())}
                  ${v.changeDescription ? ` · ${escapeHtml(v.changeDescription)}` : ''}
                </div>
              </div>
              <button class="btn btn-sm btn-outline-primary" data-rollback="${escapeHtml(v.version)}">
                Restore
              </button>
            </div>`).join('')
        : '<p class="text-muted mb-0">No saved versions yet.</p>';

      body.querySelectorAll('[data-rollback]').forEach(btn => {
        btn.addEventListener('click', () => this.rollback(btn.dataset.rollback));
      });

      bootstrap.Modal.getOrCreateInstance(document.getElementById('wf-versions-modal')).show();
    } catch (error) {
      this.toast(`Could not load versions: ${error.message}`, 'danger');
    }
  }

  async rollback(version) {
    if (!confirm(`Restore version ${version}? The current graph will be replaced.`)) {
      return;
    }

    try {
      await this.api(`/${encodeURIComponent(this.workflowId)}/rollback/${encodeURIComponent(version)}`, { method: 'POST' });
      bootstrap.Modal.getOrCreateInstance(document.getElementById('wf-versions-modal')).hide();
      await this.openWorkflow(this.workflowId);
      this.toast(`Restored version ${version}`, 'success');
    } catch (error) {
      this.toast(`Rollback failed: ${error.message}`, 'danger');
    }
  }

  async duplicateWorkflow() {
    if (!this.workflow) {
      return;
    }
    try {
      const result = await this.api('', {
        method: 'POST',
        body: JSON.stringify({
          name: `${this.workflow.name} (copy)`,
          description: this.workflow.description || '',
          ...this.serialise()
        })
      });
      this.toast('Workflow duplicated', 'success');
      // The copy holds everything on the canvas, so leaving is not losing
      // work; clear the flag or beforeunload asks anyway.
      this.dirty = false;
      location.href = `?id=${encodeURIComponent(result.workflow._id)}`;
    } catch (error) {
      this.toast(`Duplicate failed: ${error.message}`, 'danger');
    }
  }

  async deleteWorkflow() {
    if (!this.workflowId) {
      return;
    }
    if (!confirm(`Delete "${this.workflow.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await this.api(`/${encodeURIComponent(this.workflowId)}`, { method: 'DELETE' });
      this.dirty = false;
      location.href = '/admin/workflow-editor.html';
    } catch (error) {
      this.toast(`Delete failed: ${error.message}`, 'danger');
    }
  }

  // -- chrome -----------------------------------------------------------

  setBusy(busy) {
    document.getElementById('wf-loading').style.display = busy ? 'flex' : 'none';
  }

  /**
   * @param {number} [delay] milliseconds. Longer for anything that tells the
   *        author what to do next — a four-second toast carrying setup
   *        instructions is a toast nobody finishes reading.
   */
  toast(message, variant = 'info', delay = 4000) {
    const container = document.querySelector('.toast-container');
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${variant} border-0`;
    el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
    container.appendChild(el);
    const toast = new bootstrap.Toast(el, { delay });
    toast.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new WorkflowEditor().init();
});
