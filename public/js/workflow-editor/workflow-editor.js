/**
 * Visual Workflow Editor - Main JavaScript Class
 * Uses React Flow for graph visualization and management
 */

class WorkflowEditor {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentWorkflow = null;
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.reactFlowInstance = null;
    this.autoSaveInterval = null;
    this.hasUnsavedChanges = false;
    
    // Node type definitions
    this.nodeTypes = {
      persona: {
        label: 'Persona',
        icon: 'user',
        color: '#28a745',
        defaultData: {
          prompt: '',
          tone: 'professional',
          personality: 'helpful'
        }
      },
      knowledge: {
        label: 'Knowledge Source',
        icon: 'database', 
        color: '#17a2b8',
        defaultData: {
          sourceType: 'google_sheets',
          config: {}
        }
      },
      moderation: {
        label: 'Moderation',
        icon: 'shield',
        color: '#ffc107',
        defaultData: {
          strictness: 'medium',
          filters: []
        }
      },
      router: {
        label: 'Router',
        icon: 'git-branch',
        color: '#fd7e14',
        defaultData: {
          conditions: [],
          defaultRoute: null
        }
      },
      fallback: {
        label: 'Fallback',
        icon: 'help-circle',
        color: '#dc3545',
        defaultData: {
          message: 'I apologize, but I don\'t understand your request. Could you please rephrase it?',
          escalation: {
            enabled: false,
            type: 'operator'
          }
        }
      }
    };
    
    this.init();
  }
  
  init() {
    this.setupReactFlow();
    this.setupEventListeners();
    this.setupDragAndDrop();
    this.setupAutoSave();
    this.loadWorkflow();
  }
  
  setupReactFlow() {
    // Since we're using React Flow in vanilla JS, we need to work with React elements
    const { ReactFlow, Controls, MiniMap, Background, useNodesState, useEdgesState } = window.ReactFlow;
    
    // Create custom node components
    const nodeTypes = {
      persona: this.createPersonaNode.bind(this),
      knowledge: this.createKnowledgeNode.bind(this),
      moderation: this.createModerationNode.bind(this),
      router: this.createRouterNode.bind(this),
      fallback: this.createFallbackNode.bind(this)
    };
    
    // Initialize React Flow with vanilla JS approach
    this.initializeCanvas();
  }
  
  initializeCanvas() {
    // For now, we'll use a simplified canvas approach
    // In a full implementation, you'd properly integrate React Flow
    this.container.innerHTML = `
      <div class="canvas-placeholder">
        <div class="text-center py-5">
          <i data-feather="activity" style="width: 48px; height: 48px; opacity: 0.3;"></i>
          <div class="mt-3 text-muted">
            <h5>Visual Workflow Canvas</h5>
            <p>Drag nodes from the palette to start building your workflow</p>
          </div>
        </div>
      </div>
    `;
    
    // Add basic canvas styling
    this.container.style.position = 'relative';
    this.container.style.background = 'linear-gradient(90deg, #f1f1f1 1px, transparent 1px), linear-gradient(#f1f1f1 1px, transparent 1px)';
    this.container.style.backgroundSize = '20px 20px';
    
    feather.replace();
  }
  
  setupEventListeners() {
    // Listen for node selection changes
    document.addEventListener('node-selected', (event) => {
      this.onNodeSelect(event.detail);
    });
    
    // Listen for workflow changes
    document.addEventListener('workflow-changed', () => {
      this.hasUnsavedChanges = true;
      this.updateUI();
    });
    
    // Listen for property changes
    document.addEventListener('change', (event) => {
      if (event.target.closest('#node-properties, #workflow-properties')) {
        this.onPropertyChange(event);
      }
    });
    
    // Prevent page refresh if there are unsaved changes
    window.addEventListener('beforeunload', (event) => {
      if (this.hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }
  
  setupDragAndDrop() {
    const nodeItems = document.querySelectorAll('.node-item');
    
    nodeItems.forEach(item => {
      item.addEventListener('dragstart', (event) => {
        const nodeType = event.target.closest('.node-item').dataset.nodeType;
        event.dataTransfer.setData('application/reactflow', nodeType);
        event.dataTransfer.effectAllowed = 'move';
      });
    });
    
    // Setup drop zone
    this.container.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    
    this.container.addEventListener('drop', (event) => {
      event.preventDefault();
      
      const nodeType = event.dataTransfer.getData('application/reactflow');
      if (nodeType && this.nodeTypes[nodeType]) {
        const rect = this.container.getBoundingClientRect();
        const position = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        };
        
        this.addNode(nodeType, position);
      }
    });
  }
  
  setupAutoSave() {
    // Auto-save every 30 seconds
    this.autoSaveInterval = setInterval(() => {
      if (this.hasUnsavedChanges && this.currentWorkflow) {
        this.saveWorkflow(true); // Silent save
      }
    }, 30000);
  }
  
  addNode(type, position) {
    const nodeData = this.nodeTypes[type];
    if (!nodeData) return;
    
    const newNode = {
      id: this.generateId(),
      type: type,
      position: position,
      data: {
        label: nodeData.label,
        ...nodeData.defaultData
      }
    };
    
    this.nodes.push(newNode);
    this.hasUnsavedChanges = true;
    this.updateCanvas();
    this.updateUI();
    
    // Show success feedback
    this.showToast(`${nodeData.label} node added`, 'success');
  }
  
  removeNode(nodeId) {
    this.nodes = this.nodes.filter(node => node.id !== nodeId);
    this.edges = this.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
    
    if (this.selectedNode === nodeId) {
      this.selectedNode = null;
      this.updatePropertiesPanel();
    }
    
    this.hasUnsavedChanges = true;
    this.updateCanvas();
    this.updateUI();
  }
  
  addEdge(source, target) {
    const newEdge = {
      id: `edge_${source}_${target}`,
      source: source,
      target: target,
      type: 'default'
    };
    
    this.edges.push(newEdge);
    this.hasUnsavedChanges = true;
    this.updateCanvas();
  }
  
  onNodeSelect(nodeId) {
    this.selectedNode = nodeId;
    this.updatePropertiesPanel();
  }
  
  onPropertyChange(event) {
    if (!this.selectedNode && !event.target.closest('#workflow-properties')) return;
    
    this.hasUnsavedChanges = true;
    
    if (event.target.closest('#workflow-properties')) {
      // Update workflow properties
      this.updateWorkflowProperties();
    } else {
      // Update node properties
      this.updateNodeProperties();
    }
  }
  
  updateCanvas() {
    // For now, just update the placeholder
    // In a full implementation, this would update the React Flow instance
    if (this.nodes.length === 0) {
      this.initializeCanvas();
    } else {
      this.container.innerHTML = `
        <div class="canvas-with-nodes">
          <div class="text-center py-3">
            <div class="text-muted">
              <h6>Workflow Canvas</h6>
              <p>Nodes: ${this.nodes.length} | Edges: ${this.edges.length}</p>
            </div>
          </div>
          <div class="node-list">
            ${this.nodes.map(node => `
              <div class="canvas-node" data-node-id="${node.id}" style="
                position: absolute;
                left: ${node.position.x}px;
                top: ${node.position.y}px;
                background: white;
                border: 2px solid ${this.nodeTypes[node.type]?.color || '#dee2e6'};
                border-radius: 8px;
                padding: 10px;
                min-width: 120px;
                cursor: pointer;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              ">
                <div class="node-header" style="font-weight: 600; margin-bottom: 5px;">
                  <i data-feather="${this.nodeTypes[node.type]?.icon || 'box'}" style="width: 16px; height: 16px; margin-right: 5px;"></i>
                  ${node.data.label}
                </div>
                <div class="node-content" style="font-size: 11px; color: #6c757d;">
                  ${this.getNodePreview(node)}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      
      // Add event listeners to nodes
      this.container.querySelectorAll('.canvas-node').forEach(nodeEl => {
        nodeEl.addEventListener('click', () => {
          const nodeId = nodeEl.dataset.nodeId;
          this.onNodeSelect(nodeId);
          
          // Visual selection feedback
          this.container.querySelectorAll('.canvas-node').forEach(n => n.classList.remove('selected'));
          nodeEl.classList.add('selected');
        });
      });
      
      feather.replace();
    }
  }
  
  getNodePreview(node) {
    switch (node.type) {
      case 'persona':
        return node.data.prompt ? node.data.prompt.substring(0, 50) + '...' : 'No prompt set';
      case 'knowledge':
        return `Source: ${node.data.sourceType || 'Not configured'}`;
      case 'moderation':
        return `Level: ${node.data.strictness || 'medium'}`;
      case 'router':
        return `Conditions: ${(node.data.conditions || []).length}`;
      case 'fallback':
        return node.data.message ? node.data.message.substring(0, 50) + '...' : 'No message set';
      default:
        return 'Node configuration';
    }
  }
  
  updatePropertiesPanel() {
    const noSelection = document.getElementById('no-selection');
    const nodeProperties = document.getElementById('node-properties');
    
    if (!this.selectedNode) {
      noSelection.style.display = 'block';
      nodeProperties.style.display = 'none';
      return;
    }
    
    const node = this.nodes.find(n => n.id === this.selectedNode);
    if (!node) return;
    
    noSelection.style.display = 'none';
    nodeProperties.style.display = 'block';
    
    // Generate property form based on node type
    nodeProperties.innerHTML = this.generatePropertyForm(node);
  }
  
  generatePropertyForm(node) {
    const nodeType = this.nodeTypes[node.type];
    let form = `
      <h6>${nodeType.label} Properties</h6>
      <div class="property-group">
        <label class="form-label">Node ID</label>
        <input type="text" class="form-control form-control-sm" value="${node.id}" readonly>
      </div>
    `;
    
    switch (node.type) {
      case 'persona':
        form += `
          <div class="property-group">
            <label class="form-label">Persona Prompt</label>
            <textarea class="form-control form-control-sm" data-property="prompt" rows="4" placeholder="Define the chatbot's personality and behavior...">${node.data.prompt || ''}</textarea>
          </div>
          <div class="property-group">
            <label class="form-label">Tone</label>
            <select class="form-select form-select-sm" data-property="tone">
              <option value="professional" ${node.data.tone === 'professional' ? 'selected' : ''}>Professional</option>
              <option value="friendly" ${node.data.tone === 'friendly' ? 'selected' : ''}>Friendly</option>
              <option value="casual" ${node.data.tone === 'casual' ? 'selected' : ''}>Casual</option>
              <option value="formal" ${node.data.tone === 'formal' ? 'selected' : ''}>Formal</option>
            </select>
          </div>
          <div class="property-group">
            <label class="form-label">Personality</label>
            <select class="form-select form-select-sm" data-property="personality">
              <option value="helpful" ${node.data.personality === 'helpful' ? 'selected' : ''}>Helpful</option>
              <option value="empathetic" ${node.data.personality === 'empathetic' ? 'selected' : ''}>Empathetic</option>
              <option value="analytical" ${node.data.personality === 'analytical' ? 'selected' : ''}>Analytical</option>
              <option value="creative" ${node.data.personality === 'creative' ? 'selected' : ''}>Creative</option>
            </select>
          </div>
        `;
        break;
        
      case 'knowledge':
        form += `
          <div class="property-group">
            <label class="form-label">Source Type</label>
            <select class="form-select form-select-sm" data-property="sourceType" onchange="updateKnowledgeConfig(this)">
              <option value="google_sheets" ${node.data.sourceType === 'google_sheets' ? 'selected' : ''}>Google Sheets</option>
              <option value="pdf" ${node.data.sourceType === 'pdf' ? 'selected' : ''}>PDF Document</option>
              <option value="url" ${node.data.sourceType === 'url' ? 'selected' : ''}>Web URL</option>
              <option value="vector_store" ${node.data.sourceType === 'vector_store' ? 'selected' : ''}>Vector Store</option>
            </select>
          </div>
          <div id="knowledge-config">
            ${this.generateKnowledgeConfig(node.data.sourceType, node.data.config)}
          </div>
        `;
        break;
        
      case 'router':
        form += `
          <div class="property-group">
            <label class="form-label">Routing Conditions</label>
            <div id="router-conditions">
              ${(node.data.conditions || []).map((condition, index) => `
                <div class="condition-item mb-2 p-2 border rounded">
                  <div class="row g-2">
                    <div class="col-4">
                      <select class="form-select form-select-sm" data-condition-index="${index}" data-property="type">
                        <option value="contains" ${condition.type === 'contains' ? 'selected' : ''}>Contains</option>
                        <option value="intent" ${condition.type === 'intent' ? 'selected' : ''}>Intent</option>
                        <option value="keyword" ${condition.type === 'keyword' ? 'selected' : ''}>Keyword</option>
                      </select>
                    </div>
                    <div class="col-6">
                      <input type="text" class="form-control form-control-sm" data-condition-index="${index}" data-property="value" value="${condition.value || ''}" placeholder="Condition value">
                    </div>
                    <div class="col-2">
                      <button class="btn btn-outline-danger btn-sm" onclick="removeCondition(${index})">×</button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
            <button class="btn btn-outline-primary btn-sm" onclick="addCondition()">Add Condition</button>
          </div>
        `;
        break;
        
      case 'fallback':
        form += `
          <div class="property-group">
            <label class="form-label">Fallback Message</label>
            <textarea class="form-control form-control-sm" data-property="message" rows="3" placeholder="Message to show when no other response is available">${node.data.message || ''}</textarea>
          </div>
          <div class="property-group">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" data-property="escalation.enabled" ${node.data.escalation?.enabled ? 'checked' : ''}>
              <label class="form-check-label">Enable operator escalation</label>
            </div>
          </div>
        `;
        break;
        
      case 'moderation':
        form += `
          <div class="property-group">
            <label class="form-label">Strictness Level</label>
            <select class="form-select form-select-sm" data-property="strictness">
              <option value="low" ${node.data.strictness === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${node.data.strictness === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${node.data.strictness === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>
          <div class="property-group">
            <label class="form-label">Custom Filters</label>
            <textarea class="form-control form-control-sm" data-property="filters" rows="3" placeholder="Custom content filters (one per line)">${(node.data.filters || []).join('\\n')}</textarea>
          </div>
        `;
        break;
    }
    
    form += `
      <div class="mt-3">
        <button class="btn btn-danger btn-sm" onclick="deleteSelectedNode()">Delete Node</button>
      </div>
    `;
    
    return form;
  }
  
  generateKnowledgeConfig(sourceType, config = {}) {
    switch (sourceType) {
      case 'google_sheets':
        return `
          <div class="property-group">
            <label class="form-label">Sheet ID</label>
            <input type="text" class="form-control form-control-sm" data-config="sheetId" value="${config.sheetId || ''}" placeholder="Google Sheets ID">
          </div>
          <div class="property-group">
            <label class="form-label">Range</label>
            <input type="text" class="form-control form-control-sm" data-config="range" value="${config.range || 'A:Z'}" placeholder="A:Z">
          </div>
        `;
      case 'pdf':
      case 'url':
        return `
          <div class="property-group">
            <label class="form-label">URL</label>
            <input type="url" class="form-control form-control-sm" data-config="url" value="${config.url || ''}" placeholder="https://example.com/document.pdf">
          </div>
        `;
      case 'vector_store':
        return `
          <div class="property-group">
            <label class="form-label">Collection Name</label>
            <input type="text" class="form-control form-control-sm" data-config="collectionName" value="${config.collectionName || ''}" placeholder="collection_name">
          </div>
        `;
      default:
        return '<div class="text-muted">Select a source type to configure</div>';
    }
  }
  
  updateNodeProperties() {
    if (!this.selectedNode) return;
    
    const node = this.nodes.find(n => n.id === this.selectedNode);
    if (!node) return;
    
    // Update node data from form inputs
    const propertyInputs = document.querySelectorAll('#node-properties [data-property]');
    propertyInputs.forEach(input => {
      const property = input.dataset.property;
      let value = input.type === 'checkbox' ? input.checked : input.value;
      
      if (property.includes('.')) {
        // Handle nested properties
        const [parent, child] = property.split('.');
        if (!node.data[parent]) node.data[parent] = {};
        node.data[parent][child] = value;
      } else {
        node.data[property] = value;
      }
    });
    
    // Update config properties for knowledge nodes
    const configInputs = document.querySelectorAll('#node-properties [data-config]');
    configInputs.forEach(input => {
      const config = input.dataset.config;
      if (!node.data.config) node.data.config = {};
      node.data.config[config] = input.value;
    });
    
    this.updateCanvas();
  }
  
  updateWorkflowProperties() {
    const nameInput = document.getElementById('workflow-name-input');
    const descInput = document.getElementById('workflow-description-input');
    const moderationInput = document.getElementById('moderation-level');
    
    if (this.currentWorkflow) {
      this.currentWorkflow.name = nameInput?.value || this.currentWorkflow.name;
      this.currentWorkflow.description = descInput?.value || this.currentWorkflow.description;
      // Moderation level is enforced by platform, but can be noted
    }
    
    this.updateUI();
  }
  
  updateWorkflowName(newName) {
    if (!newName.trim()) return;
    
    if (this.currentWorkflow) {
      this.currentWorkflow.name = newName.trim();
    } else {
      this.currentWorkflow = { name: newName.trim() };
    }
    
    document.getElementById('workflow-title').textContent = newName;
    document.getElementById('workflow-name-input').value = newName;
    this.hasUnsavedChanges = true;
  }
  
  async saveWorkflow(silent = false) {
    this.showLoading();
    
    try {
      const workflowData = {
        name: this.currentWorkflow?.name || 'Untitled Workflow',
        description: this.currentWorkflow?.description || '',
        nodes: this.nodes,
        edges: this.edges
      };
      
      const url = this.currentWorkflow?.id ? `/api/workflows/${this.currentWorkflow.id}` : '/api/workflows';
      const method = this.currentWorkflow?.id ? 'PUT' : 'POST';
      
      const response = await fetch(url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': localStorage.getItem('chatbot-auth-token')
        },
        body: JSON.stringify(workflowData)
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.currentWorkflow = result.workflow;
        this.hasUnsavedChanges = false;
        
        if (!silent) {
          this.showToast('Workflow saved successfully', 'success');
        }
        
        this.updateUI();
      } else {
        throw new Error(result.error || 'Failed to save workflow');
      }
    } catch (error) {
      console.error('Error saving workflow:', error);
      this.showToast('Failed to save workflow: ' + error.message, 'error');
    } finally {
      this.hideLoading();
    }
  }
  
  async publishWorkflow() {
    if (!this.currentWorkflow?.id) {
      this.showToast('Please save the workflow before publishing', 'warning');
      return;
    }
    
    this.showLoading();
    
    try {
      const response = await fetch(`/api/workflows/${this.currentWorkflow.id}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': localStorage.getItem('chatbot-auth-token')
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.currentWorkflow = result.workflow;
        this.showToast('Workflow published successfully', 'success');
        this.updateUI();
      } else {
        throw new Error(result.error || 'Failed to publish workflow');
      }
    } catch (error) {
      console.error('Error publishing workflow:', error);
      this.showToast('Failed to publish workflow: ' + error.message, 'error');
    } finally {
      this.hideLoading();
    }
  }
  
  async validateWorkflow() {
    try {
      const response = await fetch('/api/workflows/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': localStorage.getItem('chatbot-auth-token')
        },
        body: JSON.stringify({
          nodes: this.nodes,
          edges: this.edges
        })
      });
      
      const result = await response.json();
      
      if (result.valid) {
        this.showToast('Workflow is valid', 'success');
      } else {
        this.showToast('Validation failed: ' + result.error, 'error');
      }
    } catch (error) {
      console.error('Error validating workflow:', error);
      this.showToast('Validation error: ' + error.message, 'error');
    }
  }
  
  clearWorkflow() {
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.hasUnsavedChanges = true;
    
    this.updateCanvas();
    this.updatePropertiesPanel();
    this.updateUI();
    
    this.showToast('Workflow cleared', 'info');
  }
  
  fitView() {
    // For now, just center the view
    // In a full React Flow implementation, this would use the fitView function
    this.showToast('Fit to view (coming soon)', 'info');
  }
  
  loadWorkflow() {
    // Check if there's a workflow ID in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const workflowId = urlParams.get('id');
    
    if (workflowId) {
      this.loadWorkflowById(workflowId);
    } else {
      // Create new workflow
      this.currentWorkflow = {
        name: 'New Workflow',
        description: '',
        status: 'draft',
        version: 1
      };
      this.updateUI();
    }
  }
  
  async loadWorkflowById(workflowId) {
    this.showLoading();
    
    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        headers: {
          'x-auth-token': localStorage.getItem('chatbot-auth-token')
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.currentWorkflow = result.workflow;
        this.nodes = result.workflow.nodes || [];
        this.edges = result.workflow.edges || [];
        
        this.updateCanvas();
        this.updateUI();
        this.updatePropertiesPanel();
        
        this.showToast('Workflow loaded successfully', 'success');
      } else {
        throw new Error(result.error || 'Failed to load workflow');
      }
    } catch (error) {
      console.error('Error loading workflow:', error);
      this.showToast('Failed to load workflow: ' + error.message, 'error');
    } finally {
      this.hideLoading();
    }
  }
  
  updateUI() {
    // Update header
    document.getElementById('workflow-title').textContent = this.currentWorkflow?.name || 'New Workflow';
    document.getElementById('workflow-status').textContent = this.currentWorkflow?.status || 'Draft';
    document.getElementById('workflow-status').className = `status-badge status-${this.currentWorkflow?.status || 'draft'}`;
    document.getElementById('workflow-version').textContent = `v${this.currentWorkflow?.version || 1}`;
    document.getElementById('last-saved').textContent = this.hasUnsavedChanges ? 'Unsaved changes' : 'Saved';
    
    // Update publish button
    const publishBtn = document.getElementById('publish-btn');
    publishBtn.disabled = !this.currentWorkflow?.id || this.nodes.length === 0;
    
    // Update property inputs
    if (this.currentWorkflow) {
      const nameInput = document.getElementById('workflow-name-input');
      const descInput = document.getElementById('workflow-description-input');
      
      if (nameInput) nameInput.value = this.currentWorkflow.name || '';
      if (descInput) descInput.value = this.currentWorkflow.description || '';
    }
  }
  
  showLoading() {
    document.getElementById('loading-overlay').style.display = 'flex';
  }
  
  hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
  }
  
  showToast(message, type = 'info') {
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `alert alert-${type === 'error' ? 'danger' : type} alert-dismissible fade show position-fixed`;
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    toast.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    document.body.appendChild(toast);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 5000);
  }
  
  generateId() {
    return 'node_' + Math.random().toString(36).substr(2, 9);
  }
  
  // Cleanup
  destroy() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
  }
}

// Global helper functions for the HTML
window.updateKnowledgeConfig = function(select) {
  const sourceType = select.value;
  const configContainer = document.getElementById('knowledge-config');
  const editor = window.workflowEditor;
  
  if (configContainer && editor && editor.selectedNode) {
    const node = editor.nodes.find(n => n.id === editor.selectedNode);
    if (node) {
      configContainer.innerHTML = editor.generateKnowledgeConfig(sourceType, {});
    }
  }
};

window.deleteSelectedNode = function() {
  if (window.workflowEditor && window.workflowEditor.selectedNode) {
    window.workflowEditor.removeNode(window.workflowEditor.selectedNode);
  }
};

window.addCondition = function() {
  // Add routing condition functionality
  console.log('Add condition - to be implemented');
};

window.removeCondition = function(index) {
  // Remove routing condition functionality
  console.log('Remove condition', index, '- to be implemented');
};
