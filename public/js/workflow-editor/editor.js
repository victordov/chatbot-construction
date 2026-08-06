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

(function() {
  'use strict';

  const AUTH_TOKEN_KEY = 'chatbot-auth-token';
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
          options: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'] },
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
    'operator-handoff': { label: 'Human Handoff', message: 'Let me connect you with a colleague.' }
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
      this.validationErrors = [];

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

      this.cacheElements();
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
        emptyHint: byId('wf-empty-hint')
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
      this.dirty = false;
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
        this.dirty = false;
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
      const { nodes, edges } = JSON.parse(this.history[index]);
      this.nodes = nodes;
      this.edges = edges;
      this.historyIndex = index;
      this.selectedNodeId = null;
      this.selectedEdgeId = null;
      this.markDirty();
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
        'Control flow': ['router', 'fallback', 'operator-handoff'],
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

      if (window.feather) {
        window.feather.replace();
      }
    }

    addNodeAtCentre(type) {
      const rect = this.el.canvas.getBoundingClientRect();
      const centre = this.toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 3);
      this.addNode(type, { x: centre.x - NODE_WIDTH / 2, y: centre.y });
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

      canvas.addEventListener('mousedown', e => {
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

      window.addEventListener('mousemove', e => {
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

      window.addEventListener('mouseup', e => {
        if (this.linking) {
          const port = e.target.closest('[data-port="in"]');
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
      });

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
      if (window.feather) {
        window.feather.replace();
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
          // Routers get one labelled port per condition plus a default port.
          const handles = node.type === 'router'
            ? [...(node.data.conditions || []).map((c, i) => ({ handle: c.id || `cond_${i}`, label: c.label || c.value || `Rule ${i + 1}` })),
              { handle: 'default', label: 'Otherwise' }]
            : [{ handle: null, label: '' }];

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
      if (node.type === 'router') {
        const handles = [...(node.data.conditions || []).map((c, i) => c.id || `cond_${i}`), 'default'];
        const index = handles.indexOf(handle || 'default');
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

      default:
        control = `<input class="form-control form-control-sm" id="${id}" data-field="${field.key}"
            value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || '')}">`;
      }

      return `<div class="mb-3">
        <label class="form-label" for="${id}">${escapeHtml(field.label)}${required}</label>
        ${control}${help}
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
                ${['contains', 'keyword', 'regex'].map(t =>
    `<option value="${t}" ${t === c.type ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
              <input class="form-control form-control-sm" data-condition-field="value"
                     value="${escapeHtml(c.value || '')}" placeholder="refund, cancel">
              <button class="btn btn-sm btn-outline-danger" data-remove-condition="${i}" title="Remove">
                <i data-feather="x"></i>
              </button>
            </div>`).join('')}
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
          if (['label', 'sourceType', 'prompt', 'template', 'message', 'strictness'].includes(e.target.dataset.field)) {
            this.renderNodes();
            if (window.feather) {
              window.feather.replace();
            }
          }
          if (e.target.dataset.field === 'sourceType') {
            this.renderProperties();
          }
        };
        input.addEventListener('input', handler);
        input.addEventListener('change', handler);
      });

      this.el.properties.querySelector('#wf-delete-node')?.addEventListener('click', () => {
        this.selectedNodeId = node.id;
        this.deleteSelection();
      });

      this.el.properties.querySelector('#wf-add-condition')?.addEventListener('click', () => {
        node.data.conditions = node.data.conditions || [];
        node.data.conditions.push({ id: this.uid('cond'), type: 'contains', value: '' });
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
            node.data.conditions[index][e.target.dataset.conditionField] = e.target.value;
            this.markDirty();
            this.renderNodes();
          });
        });
      });
    }

    // -- toolbar actions --------------------------------------------------

    bindToolbar() {
      const on = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);

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
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          this.duplicateSelectedNode();
          return;
        }

        if (typing) {
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
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM,
          Math.min((rect.width - padding * 2) / (maxX - minX), (rect.height - padding * 2) / (maxY - minY)))
      );

      this.view = {
        zoom,
        x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
        y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom
      };
      this.applyTransform();
    }

    rename() {
      const name = prompt('Workflow name', this.workflow?.name || '');
      if (name && name.trim()) {
        this.workflow.name = name.trim();
        this.markDirty();
        this.render();
      }
    }

    async save() {
      if (!this.workflow?.name?.trim()) {
        this.toast('Give the workflow a name first', 'warning');
        this.rename();
        return;
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
        this.dirty = false;
        this.render();
        this.toast('Workflow saved', 'success');

        if (isNew) {
          // Put the id in the URL so a refresh reopens the same workflow.
          history.replaceState({}, '', `?id=${encodeURIComponent(this.workflowId)}`);
          this.loadWorkflowList();
        }
      } catch (error) {
        this.toast(`Save failed: ${error.message}`, 'danger');
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
        if (window.feather) {
          window.feather.replace();
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
      if (this.dirty) {
        await this.save();
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

    toast(message, variant = 'info') {
      const container = document.querySelector('.toast-container');
      const el = document.createElement('div');
      el.className = `toast align-items-center text-bg-${variant} border-0`;
      el.setAttribute('role', 'alert');
      el.innerHTML = `<div class="d-flex">
        <div class="toast-body">${escapeHtml(message)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>`;
      container.appendChild(el);
      const toast = new bootstrap.Toast(el, { delay: 4000 });
      toast.show();
      el.addEventListener('hidden.bs.toast', () => el.remove());
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.workflowEditor = new WorkflowEditor();
    window.workflowEditor.init();
  });
})();
