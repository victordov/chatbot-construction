/**
 * Simple Canvas-based Workflow Editor
 * Fallback implementation that doesn't rely on React Flow
 */

class SimpleWorkflowEditor {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.canvas = null;
    this.ctx = null;
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.draggedNode = null;
    this.nodeId = 0;
    this.isConnecting = false;
    this.connectionStart = null;
    
    // Node type definitions
    this.nodeTypes = {
      persona: {
        label: 'Persona',
        icon: '👤',
        color: '#28a745',
        defaultData: {
          prompt: '',
          tone: 'professional',
          personality: 'helpful'
        }
      },
      knowledge: {
        label: 'Knowledge Source',
        icon: '📊', 
        color: '#17a2b8',
        defaultData: {
          sourceType: 'google_sheets',
          config: {}
        }
      },
      moderation: {
        label: 'Moderation',
        icon: '🛡️',
        color: '#ffc107',
        defaultData: {
          strictness: 'medium',
          filters: []
        }
      },
      router: {
        label: 'Router',
        icon: '🔀',
        color: '#fd7e14',
        defaultData: {
          conditions: [],
          defaultRoute: null
        }
      },
      fallback: {
        label: 'Fallback',
        icon: '❓',
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
    this.setupCanvas();
    this.setupEventListeners();
    this.setupDragAndDrop();
    this.render();
    console.log('✅ Simple Workflow Editor initialized');
  }
  
  setupCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.container.offsetWidth;
    this.canvas.height = this.container.offsetHeight;
    this.canvas.style.border = '1px solid #dee2e6';
    this.canvas.style.borderRadius = '8px';
    this.canvas.style.background = '#fafafa';
    this.ctx = this.canvas.getContext('2d');
    
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);
    
    // Add controls
    const controls = document.createElement('div');
    controls.style.cssText = 'position: absolute; top: 10px; left: 10px; z-index: 10;';
    controls.innerHTML = `
      <button class="btn btn-sm btn-outline-primary me-2" onclick="window.workflowEditor.clearCanvas()">
        <i data-feather="trash-2" class="me-1"></i>Clear
      </button>
      <button class="btn btn-sm btn-outline-success me-2" onclick="window.workflowEditor.fitView()">
        <i data-feather="maximize" class="me-1"></i>Fit View
      </button>
      <span class="badge bg-info">Nodes: <span id="node-count">0</span></span>
    `;
    this.container.style.position = 'relative';
    this.container.appendChild(controls);
    
    // Update feather icons
    if (window.feather) {
      window.feather.replace();
    }
  }
  
  setupEventListeners() {
    this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.canvas.addEventListener('click', this.onClick.bind(this));
    
    // Handle window resize
    window.addEventListener('resize', () => {
      this.canvas.width = this.container.offsetWidth;
      this.canvas.height = this.container.offsetHeight;
      this.render();
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selectedNode) {
        this.removeNode(this.selectedNode.id);
      }
    });
  }
  
  setupDragAndDrop() {
    const nodeItems = document.querySelectorAll('.node-item');
    
    nodeItems.forEach(item => {
      item.addEventListener('dragstart', (event) => {
        const nodeType = event.target.closest('.node-item').dataset.nodeType;
        event.dataTransfer.setData('application/workflow', nodeType);
        event.dataTransfer.effectAllowed = 'move';
      });
    });
    
    this.canvas.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    
    this.canvas.addEventListener('drop', (event) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData('application/workflow');
      if (nodeType) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        this.addNode(nodeType, { x, y });
      }
    });
  }
  
  addNode(type, position) {
    const nodeData = this.nodeTypes[type];
    if (!nodeData) return;
    
    const newNode = {
      id: this.generateId(),
      type: type,
      position: position,
      data: {
        type: type,
        label: nodeData.label,
        ...nodeData.defaultData
      },
      width: 140,
      height: 80
    };
    
    this.nodes.push(newNode);
    this.updateUI();
    this.render();
    this.showToast(`${nodeData.label} node added`, 'success');
  }
  
  removeNode(nodeId) {
    this.nodes = this.nodes.filter(node => node.id !== nodeId);
    this.edges = this.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
    this.selectedNode = null;
    this.updateUI();
    this.render();
    this.showToast('Node removed', 'info');
  }
  
  onMouseDown(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    const node = this.getNodeAt(x, y);
    if (node) {
      this.draggedNode = node;
      this.selectedNode = node;
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.selectedNode = null;
    }
    this.render();
  }
  
  onMouseMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    if (this.draggedNode) {
      this.draggedNode.position.x = x - this.draggedNode.width / 2;
      this.draggedNode.position.y = y - this.draggedNode.height / 2;
      this.render();
    } else {
      // Update cursor based on hover
      const node = this.getNodeAt(x, y);
      this.canvas.style.cursor = node ? 'grab' : 'default';
    }
  }
  
  onMouseUp(event) {
    this.draggedNode = null;
    this.canvas.style.cursor = 'default';
  }
  
  onClick(event) {
    // Handle selection
    this.render();
  }
  
  getNodeAt(x, y) {
    for (let node of this.nodes) {
      if (x >= node.position.x && 
          x <= node.position.x + node.width &&
          y >= node.position.y && 
          y <= node.position.y + node.height) {
        return node;
      }
    }
    return null;
  }
  
  render() {
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Draw grid background
    this.drawGrid();
    
    // Draw edges
    this.edges.forEach(edge => this.drawEdge(edge));
    
    // Draw nodes
    this.nodes.forEach(node => this.drawNode(node));
  }
  
  drawGrid() {
    const gridSize = 20;
    this.ctx.strokeStyle = '#e2e8f0';
    this.ctx.lineWidth = 1;
    
    for (let x = 0; x < this.canvas.width; x += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.canvas.height);
      this.ctx.stroke();
    }
    
    for (let y = 0; y < this.canvas.height; y += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }
  }
  
  drawNode(node) {
    const nodeType = this.nodeTypes[node.type];
    const isSelected = this.selectedNode && this.selectedNode.id === node.id;
    
    // Draw node background
    this.ctx.fillStyle = '#ffffff';
    this.ctx.strokeStyle = isSelected ? '#007bff' : nodeType.color;
    this.ctx.lineWidth = isSelected ? 3 : 2;
    
    // Round rectangle
    this.drawRoundRect(
      node.position.x, 
      node.position.y, 
      node.width, 
      node.height, 
      8
    );
    this.ctx.fill();
    this.ctx.stroke();
    
    // Draw icon and label
    this.ctx.fillStyle = nodeType.color;
    this.ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    
    // Icon
    this.ctx.fillText(
      nodeType.icon, 
      node.position.x + 10, 
      node.position.y + 25
    );
    
    // Label
    this.ctx.fillStyle = '#1a202c';
    this.ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    this.ctx.fillText(
      nodeType.label, 
      node.position.x + 35, 
      node.position.y + 25
    );
    
    // Preview text
    this.ctx.fillStyle = '#718096';
    this.ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const preview = this.getNodePreview(node.data);
    this.ctx.fillText(
      preview, 
      node.position.x + 10, 
      node.position.y + 45
    );
    
    // Connection points
    this.drawConnectionPoint(node.position.x + node.width / 2, node.position.y, nodeType.color); // Top
    this.drawConnectionPoint(node.position.x + node.width / 2, node.position.y + node.height, nodeType.color); // Bottom
  }
  
  drawConnectionPoint(x, y, color) {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, 4, 0, 2 * Math.PI);
    this.ctx.fill();
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }
  
  drawEdge(edge) {
    const sourceNode = this.nodes.find(n => n.id === edge.source);
    const targetNode = this.nodes.find(n => n.id === edge.target);
    
    if (!sourceNode || !targetNode) return;
    
    const startX = sourceNode.position.x + sourceNode.width / 2;
    const startY = sourceNode.position.y + sourceNode.height;
    const endX = targetNode.position.x + targetNode.width / 2;
    const endY = targetNode.position.y;
    
    this.ctx.strokeStyle = '#64748b';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(startX, startY);
    this.ctx.lineTo(endX, endY);
    this.ctx.stroke();
    
    // Arrow head
    const angle = Math.atan2(endY - startY, endX - startX);
    const arrowLength = 10;
    
    this.ctx.beginPath();
    this.ctx.moveTo(endX, endY);
    this.ctx.lineTo(
      endX - arrowLength * Math.cos(angle - Math.PI / 6),
      endY - arrowLength * Math.sin(angle - Math.PI / 6)
    );
    this.ctx.moveTo(endX, endY);
    this.ctx.lineTo(
      endX - arrowLength * Math.cos(angle + Math.PI / 6),
      endY - arrowLength * Math.sin(angle + Math.PI / 6)
    );
    this.ctx.stroke();
  }
  
  drawRoundRect(x, y, width, height, radius) {
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }
  
  getNodePreview(nodeData) {
    switch (nodeData.type) {
      case 'persona':
        return nodeData.tone || 'Professional';
      case 'knowledge':
        return nodeData.sourceType || 'Google Sheets';
      case 'moderation':
        return nodeData.strictness || 'Medium';
      case 'router':
        return `${nodeData.conditions?.length || 0} conditions`;
      case 'fallback':
        return nodeData.escalation?.enabled ? 'With escalation' : 'Simple fallback';
      default:
        return 'Node';
    }
  }
  
  generateId() {
    return `node_${++this.nodeId}`;
  }
  
  updateUI() {
    const nodeCountEl = document.getElementById('node-count');
    if (nodeCountEl) {
      nodeCountEl.textContent = this.nodes.length;
    }
  }
  
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type} position-fixed`;
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
  
  clearCanvas() {
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.updateUI();
    this.render();
    this.showToast('Canvas cleared', 'info');
  }
  
  fitView() {
    // Simple implementation - just re-render
    this.render();
    this.showToast('View fitted', 'info');
  }
}

// Make it globally available
window.SimpleWorkflowEditor = SimpleWorkflowEditor;
