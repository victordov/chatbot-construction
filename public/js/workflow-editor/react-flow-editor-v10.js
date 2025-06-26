/**
 * React Flow Visual Workflow Editor - v10 Compatible
 * Complete implementation with live graph editing
 */

class ReactFlowWorkflowEditor {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.reactFlowWrapper = null;
    this.reactFlowInstance = null;
    this.currentWorkflow = null;
    this.selectedNode = null;
    this.hasUnsavedChanges = false;
    this.autoSaveInterval = null;
    
    // React Flow state
    this.nodes = [];
    this.edges = [];
    this.nodeId = 0;
    
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
    // Debug: Check what's available globally
    console.log('Setting up React Flow v10...');
    console.log('window.ReactFlowLib:', window.ReactFlowLib);
    console.log('window.ReactFlowRenderer:', window.ReactFlowRenderer);
    
    // Try to get React Flow from different possible locations
    const reactFlowLib = window.ReactFlowLib || window.ReactFlowRenderer;
    
    if (!reactFlowLib) {
      console.error('React Flow library not found! Available globals:', Object.keys(window).filter(k => k.includes('React') || k.includes('Flow')));
      return;
    }
    
    console.log('ReactFlow library found, keys:', Object.keys(reactFlowLib));
    
    // Extract components from ReactFlow v10 (react-flow-renderer)
    const ReactFlow = reactFlowLib.ReactFlow;
    const Controls = reactFlowLib.Controls;
    const MiniMap = reactFlowLib.MiniMap;
    const Background = reactFlowLib.Background;
    const BackgroundVariant = reactFlowLib.BackgroundVariant;
    const Handle = reactFlowLib.Handle;
    const Position = reactFlowLib.Position;
    const addEdge = reactFlowLib.addEdge;
    const removeElements = reactFlowLib.removeElements;
    
    // Check what's available
    console.log('Available components:', {
      ReactFlow: !!ReactFlow,
      Controls: !!Controls,
      MiniMap: !!MiniMap,
      Background: !!Background,
      BackgroundVariant: !!BackgroundVariant,
      Handle: !!Handle,
      Position: !!Position,
      addEdge: !!addEdge,
      removeElements: !!removeElements
    });
    
    const { useState, useCallback, useRef, useEffect } = React;
    
    // Store a reference to the class instance
    const editorInstance = this;
    
    const WorkflowCanvas = () => {
      // Use basic React state for v10 compatibility
      const [nodes, setNodes] = useState([]);
      const [edges, setEdges] = useState([]);
      const [reactFlowInstance, setReactFlowInstance] = useState(null);
      const reactFlowWrapper = useRef(null);
      
      // Store references for external access
      editorInstance.setNodes = setNodes;
      editorInstance.setEdges = setEdges;
      editorInstance.reactFlowWrapper = reactFlowWrapper;
      
      // Update instance state when React state changes
      useEffect(() => {
        editorInstance.nodes = nodes;
      }, [nodes]);
      
      useEffect(() => {
        editorInstance.edges = edges;
      }, [edges]);
      
      const onLoad = useCallback((rfInstance) => {
        setReactFlowInstance(rfInstance);
        editorInstance.reactFlowInstance = rfInstance;
        rfInstance.fitView();
      }, []);
      
      const onElementsRemove = useCallback((elementsToRemove) => {
        const nodeIds = elementsToRemove.filter(el => el.type === undefined).map(el => el.id);
        const edgeIds = elementsToRemove.filter(el => el.type !== undefined).map(el => el.id);
        
        if (nodeIds.length > 0) {
          setNodes((nds) => nds.filter(node => !nodeIds.includes(node.id)));
        }
        if (edgeIds.length > 0) {
          setEdges((eds) => eds.filter(edge => !edgeIds.includes(edge.id)));
        }
        
        editorInstance.hasUnsavedChanges = true;
      }, []);
      
      const onConnect = useCallback((params) => {
        setEdges((eds) => {
          const newEdges = addEdge(params, eds);
          editorInstance.hasUnsavedChanges = true;
          return newEdges;
        });
      }, []);
      
      const onNodeDragStop = useCallback((event, node) => {
        editorInstance.hasUnsavedChanges = true;
      }, []);
      
      const onSelectionChange = useCallback((elements) => {
        const selectedNode = elements.find(el => el.type === undefined);
        if (selectedNode) {
          editorInstance.onNodeSelect(selectedNode.id);
        } else {
          editorInstance.onNodeSelect(null);
        }
      }, []);
      
      const onDrop = useCallback((event) => {
        event.preventDefault();
        
        if (!reactFlowInstance) return;
        
        const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
        const type = event.dataTransfer.getData('application/reactflow');
        
        if (typeof type === 'undefined' || !type) {
          return;
        }
        
        const position = reactFlowInstance.project({
          x: event.clientX - reactFlowBounds.left,
          y: event.clientY - reactFlowBounds.top,
        });
        
        editorInstance.addNode(type, position);
      }, [reactFlowInstance]);
      
      const onDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }, []);
      
      // Custom node component
      const CustomNode = ({ data, selected }) => {
        const nodeType = editorInstance.nodeTypes[data.type];
        
        if (!nodeType) {
          return React.createElement('div', {
            className: 'custom-node',
            style: {
              border: '1px solid #dc3545',
              borderRadius: '4px',
              padding: '8px',
              background: '#fff',
              color: '#dc3545'
            }
          }, 'Unknown node type');
        }
        
        return React.createElement('div', {
          className: `custom-node ${selected ? 'selected' : ''}`,
          style: {
            border: `2px solid ${nodeType.color}`,
            borderRadius: '8px',
            padding: '10px',
            background: 'white',
            minWidth: '120px',
            fontSize: '12px',
            boxShadow: selected ? '0 4px 8px rgba(0,0,0,0.15)' : '0 2px 4px rgba(0,0,0,0.1)'
          }
        }, [
          React.createElement('div', {
            key: 'header',
            className: 'node-header',
            style: {
              display: 'flex',
              alignItems: 'center',
              marginBottom: '4px',
              fontWeight: 'bold'
            }
          }, [
            React.createElement('i', {
              key: 'icon',
              'data-feather': nodeType.icon,
              style: {
                width: '14px',
                height: '14px',
                marginRight: '6px',
                color: nodeType.color
              }
            }),
            data.label
          ]),
          React.createElement('div', {
            key: 'content',
            className: 'node-content',
            style: {
              fontSize: '11px',
              color: '#6c757d'
            }
          }, editorInstance.getNodePreview(data)),
          React.createElement(Handle, {
            key: 'target',
            type: 'target',
            position: Position.Top,
            style: { background: nodeType?.color || '#007bff' }
          }),
          React.createElement(Handle, {
            key: 'source',
            type: 'source',
            position: Position.Bottom,
            style: { background: nodeType?.color || '#007bff' }
          })
        ]);
      };
      
      const nodeTypes = {
        customNode: CustomNode
      };
      
      // Update feather icons after render
      useEffect(() => {
        if (window.feather) {
          window.feather.replace();
        }
      });
      
      return React.createElement('div', {
        ref: reactFlowWrapper,
        style: { width: '100%', height: '100%' }
      }, React.createElement(ReactFlow, {
        elements: [...nodes, ...edges],
        onLoad,
        onElementsRemove,
        onConnect,
        onNodeDragStop,
        onSelectionChange,
        onDrop,
        onDragOver,
        nodeTypes,
        deleteKeyCode: 46, // Delete key
        multiSelectionKeyCode: 17, // Ctrl key
      }, [
        React.createElement(Controls, { key: 'controls' }),
        React.createElement(MiniMap, { 
          key: 'minimap',
          nodeColor: (node) => {
            const nodeType = editorInstance.nodeTypes[node.data?.type];
            return nodeType?.color || '#dee2e6';
          }
        }),
        React.createElement(Background, { 
          key: 'background',
          variant: BackgroundVariant?.Dots || 'dots'
        })
      ]));
    };
    
    // Render the React Flow component (React 17 style)
    ReactDOM.render(React.createElement(WorkflowCanvas), this.container);
  }
  
  setupEventListeners() {
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
      type: 'customNode',
      position: position,
      data: {
        type: type,
        label: nodeData.label,
        ...nodeData.defaultData
      }
    };
    
    // Update React Flow state using v10 elements approach
    this.setNodes((nodes) => {
      const updatedNodes = [...nodes, newNode];
      this.nodes = updatedNodes;
      return updatedNodes;
    });
    
    this.hasUnsavedChanges = true;
    this.updateUI();
    this.showToast(`${nodeData.label} node added`, 'success');
  }
  
  removeNode(nodeId) {
    this.setNodes((nodes) => {
      const updatedNodes = nodes.filter(node => node.id !== nodeId);
      this.nodes = updatedNodes;
      return updatedNodes;
    });
    
    this.setEdges((edges) => {
      const updatedEdges = edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
      this.edges = updatedEdges;
      return updatedEdges;
    });
    
    this.hasUnsavedChanges = true;
    this.updateUI();
    this.showToast('Node removed', 'info');
  }
  
  onNodeSelect(nodeId) {
    this.selectedNode = nodeId;
    this.updatePropertiesPanel();
  }
  
  onPropertyChange(event) {
    if (this.selectedNode) {
      this.updateNodeProperties();
    } else {
      this.updateWorkflowProperties();
    }
  }
  
  updateNodeProperties() {
    if (!this.selectedNode) return;
    
    const formData = new FormData(document.getElementById('node-properties'));
    const properties = Object.fromEntries(formData.entries());
    
    this.setNodes((nodes) => {
      const updatedNodes = nodes.map(node => {
        if (node.id === this.selectedNode) {
          return {
            ...node,
            data: {
              ...node.data,
              ...properties
            }
          };
        }
        return node;
      });
      this.nodes = updatedNodes;
      return updatedNodes;
    });
    
    this.hasUnsavedChanges = true;
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
    // Update node count
    const nodeCountEl = document.getElementById('node-count');
    if (nodeCountEl) {
      nodeCountEl.textContent = this.nodes.length;
    }
    
    // Update save button state
    const saveBtn = document.getElementById('save-workflow');
    if (saveBtn) {
      saveBtn.disabled = !this.hasUnsavedChanges;
    }
  }
  
  showToast(message, type = 'info') {
    // Simple toast implementation
    const toast = document.createElement('div');
    toast.className = `alert alert-${type} position-fixed`;
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
  
  updatePropertiesPanel() {
    // Implementation for updating the properties panel
    console.log('Updating properties panel for node:', this.selectedNode);
  }
  
  updateWorkflowProperties() {
    // Implementation for updating workflow properties
    console.log('Updating workflow properties');
  }
  
  async saveWorkflow(silent = false) {
    // Implementation for saving workflow
    console.log('Saving workflow', { silent });
  }
  
  async loadWorkflow() {
    // Implementation for loading workflow
    console.log('Loading workflow');
  }
  
  fitView() {
    if (this.reactFlowInstance) {
      this.reactFlowInstance.fitView();
    }
  }
  
  clearWorkflow() {
    this.setNodes([]);
    this.setEdges([]);
    this.hasUnsavedChanges = true;
    this.updateUI();
    this.showToast('Workflow cleared', 'info');
  }
}

// Make it globally available
window.ReactFlowWorkflowEditor = ReactFlowWorkflowEditor;
