/**
 * React Flow Visual Workflow Editor
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
    console.log('Setting up React Flow...');
    console.log('window.ReactFlowLib:', window.ReactFlowLib);
    console.log('window.ReactFlow:', window.ReactFlow);
    
    // Try to get React Flow from different possible locations
    const reactFlowLib = window.ReactFlowLib || window.ReactFlow;
    
    if (!reactFlowLib) {
      console.error('React Flow library not found! Available globals:', Object.keys(window).filter(k => k.includes('React') || k.includes('Flow')));
      return;
    }
    
    console.log('ReactFlow library found, keys:', Object.keys(reactFlowLib));
    
    // Extract components from ReactFlow v11
    const ReactFlow = reactFlowLib.ReactFlow;
    const ReactFlowProvider = reactFlowLib.ReactFlowProvider;
    const Controls = reactFlowLib.Controls;
    const MiniMap = reactFlowLib.MiniMap;
    const Background = reactFlowLib.Background;
    const BackgroundVariant = reactFlowLib.BackgroundVariant;
    const Handle = reactFlowLib.Handle;
    const Position = reactFlowLib.Position;
    const addEdge = reactFlowLib.addEdge;
    const applyNodeChanges = reactFlowLib.applyNodeChanges;
    const applyEdgeChanges = reactFlowLib.applyEdgeChanges;
    const useNodesState = reactFlowLib.useNodesState;
    const useEdgesState = reactFlowLib.useEdgesState;
    
    // Check what's available
    console.log('Available components:', {
      ReactFlow: !!ReactFlow,
      ReactFlowProvider: !!ReactFlowProvider,
      Controls: !!Controls,
      MiniMap: !!MiniMap,
      Background: !!Background,
      BackgroundVariant: !!BackgroundVariant,
      Handle: !!Handle,
      Position: !!Position,
      addEdge: !!addEdge,
      applyNodeChanges: !!applyNodeChanges,
      applyEdgeChanges: !!applyEdgeChanges,
      useNodesState: !!useNodesState,
      useEdgesState: !!useEdgesState
    });
    
    const { useState, useCallback, useRef, useEffect } = React;
    
    // Store a reference to the class instance
    const editorInstance = this;
    
    const WorkflowCanvas = () => {
      // Use ReactFlow v11 hooks for state management
      const [nodes, setNodes, onNodesChange] = useNodesState([]);
      const [edges, setEdges, onEdgesChange] = useEdgesState([]);
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
      
      const onInit = useCallback((rfInstance) => {
        setReactFlowInstance(rfInstance);
        editorInstance.reactFlowInstance = rfInstance;
      }, []);
      
      const handleNodesChange = useCallback((changes) => {
        onNodesChange(changes);
        editorInstance.hasUnsavedChanges = true;
      }, [onNodesChange]);
      
      const handleEdgesChange = useCallback((changes) => {
        onEdgesChange(changes);
        editorInstance.hasUnsavedChanges = true;
      }, [onEdgesChange]);
      
      const onConnect = useCallback((connection) => {
        setEdges((eds) => {
          const newEdges = addEdge(connection, eds);
          editorInstance.hasUnsavedChanges = true;
          return newEdges;
        });
      }, []);
      
      const onNodeClick = useCallback((event, node) => {
        editorInstance.onNodeSelect(node.id);
      }, []);
      
      const onPaneClick = useCallback((event) => {
        editorInstance.onNodeSelect(null);
      }, []);
      
      const onDrop = useCallback((event) => {
        event.preventDefault();
        
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
        feather.replace();
      });
      
      return React.createElement(ReactFlowProvider, {},
        React.createElement('div', {
          ref: reactFlowWrapper,
          style: { width: '100%', height: '100%' }
        }, React.createElement(ReactFlow, {
          nodes,
          edges,
          onNodesChange: handleNodesChange,
          onEdgesChange: handleEdgesChange,
          onConnect,
          onInit,
          onNodeClick,
          onPaneClick,
          onDrop,
          onDragOver,
          nodeTypes,
          fitView: true,
          attributionPosition: 'bottom-left'
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
            variant: BackgroundVariant.Dots 
          })
        ]))
      );
    };
    
    // Render the React Flow component (React 17 style)
    ReactDOM.render(React.createElement(WorkflowCanvas), this.container);
  }
  
  setupEventListeners() {
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
    console.log('Setting up React Flow...');
    console.log('window.ReactFlowLib:', window.ReactFlowLib);
    console.log('window.ReactFlow:', window.ReactFlow);
    
    // Try to get React Flow from different possible locations
    const reactFlowLib = window.ReactFlowLib || window.ReactFlow;
    
    if (!reactFlowLib) {
      console.error('React Flow library not found! Available globals:', Object.keys(window).filter(k => k.includes('React') || k.includes('Flow')));
      return;
    }
    
    console.log('ReactFlow library found, keys:', Object.keys(reactFlowLib));
    
    // Extract components from ReactFlow v11
    const ReactFlow = reactFlowLib.ReactFlow;
    const ReactFlowProvider = reactFlowLib.ReactFlowProvider;
    const Controls = reactFlowLib.Controls;
    const MiniMap = reactFlowLib.MiniMap;
    const Background = reactFlowLib.Background;
    const BackgroundVariant = reactFlowLib.BackgroundVariant;
    const Handle = reactFlowLib.Handle;
    const Position = reactFlowLib.Position;
    const addEdge = reactFlowLib.addEdge;
    const applyNodeChanges = reactFlowLib.applyNodeChanges;
    const applyEdgeChanges = reactFlowLib.applyEdgeChanges;
    const useNodesState = reactFlowLib.useNodesState;
    const useEdgesState = reactFlowLib.useEdgesState;
    
    // Check what's available
    console.log('Available components:', {
      ReactFlow: !!ReactFlow,
      ReactFlowProvider: !!ReactFlowProvider,
      Controls: !!Controls,
      MiniMap: !!MiniMap,
      Background: !!Background,
      BackgroundVariant: !!BackgroundVariant,
      Handle: !!Handle,
      Position: !!Position,
      addEdge: !!addEdge,
      applyNodeChanges: !!applyNodeChanges,
      applyEdgeChanges: !!applyEdgeChanges,
      useNodesState: !!useNodesState,
      useEdgesState: !!useEdgesState
    });
    
    const { useState, useCallback, useRef, useEffect } = React;
    
    // Store a reference to the class instance
    const editorInstance = this;
    
    const WorkflowCanvas = () => {
      // Use ReactFlow v11 hooks for state management
      const [nodes, setNodes, onNodesChange] = useNodesState([]);
      const [edges, setEdges, onEdgesChange] = useEdgesState([]);
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
      
      const onInit = useCallback((rfInstance) => {
        setReactFlowInstance(rfInstance);
        editorInstance.reactFlowInstance = rfInstance;
      }, []);
      
      const handleNodesChange = useCallback((changes) => {
        onNodesChange(changes);
        editorInstance.hasUnsavedChanges = true;
      }, [onNodesChange]);
      
      const handleEdgesChange = useCallback((changes) => {
        onEdgesChange(changes);
        editorInstance.hasUnsavedChanges = true;
      }, [onEdgesChange]);
      
      const onConnect = useCallback((connection) => {
        setEdges((eds) => {
          const newEdges = addEdge(connection, eds);
          editorInstance.hasUnsavedChanges = true;
          return newEdges;
        });
      }, []);
      
      const onNodeClick = useCallback((event, node) => {
        editorInstance.onNodeSelect(node.id);
      }, []);
      
      const onPaneClick = useCallback((event) => {
        editorInstance.onNodeSelect(null);
      }, []);
      
      const onDrop = useCallback((event) => {
        event.preventDefault();
        
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
        feather.replace();
      });
      
      return React.createElement(ReactFlowProvider, {},
        React.createElement('div', {
          ref: reactFlowWrapper,
          style: { width: '100%', height: '100%' }
        }, React.createElement(ReactFlow, {
          nodes,
          edges,
          onNodesChange: handleNodesChange,
          onEdgesChange: handleEdgesChange,
          onConnect,
          onInit,
          onNodeClick,
          onPaneClick,
          onDrop,
          onDragOver,
          nodeTypes,
          fitView: true,
          attributionPosition: 'bottom-left'
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
            variant: BackgroundVariant.Dots 
          })
        ]))
      );
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
    
    // Update React Flow state
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
    
    if (this.selectedNode === nodeId) {
      this.selectedNode = null;
      this.updatePropertiesPanel();
    }
    
    this.hasUnsavedChanges = true;
    this.updateUI();
  }
  
  onNodeSelect(nodeId) {
    this.selectedNode = nodeId;
    this.updatePropertiesPanel();
    
    // Update visual selection
    this.setNodes((nodes) => {
      return nodes.map(node => ({
        ...node,
        selected: node.id === nodeId
      }));
    });
  }
  
  onPropertyChange(event) {
    if (!this.selectedNode && !event.target.closest('#workflow-properties')) return;
    
    this.hasUnsavedChanges = true;
    
    if (event.target.closest('#workflow-properties')) {
      this.updateWorkflowProperties();
    } else {
      this.updateNodeProperties();
    }
  }
  
  updateNodeProperties() {
    if (!this.selectedNode) return;
    
    // Update node data from form inputs
    const propertyInputs = document.querySelectorAll('#node-properties [data-property]');
    const configInputs = document.querySelectorAll('#node-properties [data-config]');
    
    this.setNodes((nodes) => {
      return nodes.map(node => {
        if (node.id !== this.selectedNode) return node;
        
        const updatedNode = { ...node };
        
        // Update properties
        propertyInputs.forEach(input => {
          const property = input.dataset.property;
          let value = input.type === 'checkbox' ? input.checked : input.value;
          
          if (property.includes('.')) {
            const [parent, child] = property.split('.');
            if (!updatedNode.data[parent]) updatedNode.data[parent] = {};
            updatedNode.data[parent][child] = value;
          } else {
            updatedNode.data[property] = value;
          }
        });
        
        // Update config properties
        configInputs.forEach(input => {
          const config = input.dataset.config;
          if (!updatedNode.data.config) updatedNode.data.config = {};
          updatedNode.data.config[config] = input.value;
        });
        
        this.nodes = this.nodes.map(n => n.id === node.id ? updatedNode : n);
        return updatedNode;
      });
    });
  }
  
  updateWorkflowProperties() {
    const nameInput = document.getElementById('workflow-name-input');
    const descInput = document.getElementById('workflow-description-input');
    
    if (this.currentWorkflow) {
      this.currentWorkflow.name = nameInput?.value || this.currentWorkflow.name;
      this.currentWorkflow.description = descInput?.value || this.currentWorkflow.description;
    }
    
    this.updateUI();
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
    
    nodeProperties.innerHTML = this.generatePropertyForm(node);
  }
  
  generatePropertyForm(node) {
    const nodeType = this.nodeTypes[node.data.type];
    let form = `
      <h6>${nodeType.label} Properties</h6>
      <div class="property-group mb-3">
        <label class="form-label">Node ID</label>
        <input type="text" class="form-control form-control-sm" value="${node.id}" readonly>
      </div>
    `;
    
    switch (node.data.type) {
      case 'persona':
        form += `
          <div class="property-group mb-3">
            <label class="form-label">Persona Prompt</label>
            <textarea class="form-control form-control-sm" data-property="prompt" rows="4" placeholder="Define the chatbot's personality and behavior...">${node.data.prompt || ''}</textarea>
          </div>
          <div class="property-group mb-3">
            <label class="form-label">Tone</label>
            <select class="form-select form-select-sm" data-property="tone">
              <option value="professional" ${node.data.tone === 'professional' ? 'selected' : ''}>Professional</option>
              <option value="friendly" ${node.data.tone === 'friendly' ? 'selected' : ''}>Friendly</option>
              <option value="casual" ${node.data.tone === 'casual' ? 'selected' : ''}>Casual</option>
              <option value="formal" ${node.data.tone === 'formal' ? 'selected' : ''}>Formal</option>
            </select>
          </div>
          <div class="property-group mb-3">
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
          <div class="property-group mb-3">
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
          <div class="property-group mb-3">
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
          <div class="property-group mb-3">
            <label class="form-label">Fallback Message</label>
            <textarea class="form-control form-control-sm" data-property="message" rows="3" placeholder="Message to show when no other response is available">${node.data.message || ''}</textarea>
          </div>
          <div class="property-group mb-3">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" data-property="escalation.enabled" ${node.data.escalation?.enabled ? 'checked' : ''}>
              <label class="form-check-label">Enable operator escalation</label>
            </div>
          </div>
        `;
        break;
        
      case 'moderation':
        form += `
          <div class="property-group mb-3">
            <label class="form-label">Strictness Level</label>
            <select class="form-select form-select-sm" data-property="strictness">
              <option value="low" ${node.data.strictness === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${node.data.strictness === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${node.data.strictness === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>
          <div class="property-group mb-3">
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
          <div class="property-group mb-3">
            <label class="form-label">Sheet ID</label>
            <input type="text" class="form-control form-control-sm" data-config="sheetId" value="${config.sheetId || ''}" placeholder="Google Sheets ID">
          </div>
          <div class="property-group mb-3">
            <label class="form-label">Range</label>
            <input type="text" class="form-control form-control-sm" data-config="range" value="${config.range || 'A:Z'}" placeholder="A:Z">
          </div>
        `;
      case 'pdf':
      case 'url':
        return `
          <div class="property-group mb-3">
            <label class="form-label">URL</label>
            <input type="url" class="form-control form-control-sm" data-config="url" value="${config.url || ''}" placeholder="https://example.com/document.pdf">
          </div>
        `;
      case 'vector_store':
        return `
          <div class="property-group mb-3">
            <label class="form-label">Collection Name</label>
            <input type="text" class="form-control form-control-sm" data-config="collectionName" value="${config.collectionName || ''}" placeholder="collection_name">
          </div>
        `;
      default:
        return '<div class="text-muted">Select a source type to configure</div>';
    }
  }
  
  getNodePreview(nodeData) {
    switch (nodeData.type) {
      case 'persona':
        return nodeData.prompt ? nodeData.prompt.substring(0, 50) + '...' : 'No prompt set';
      case 'knowledge':
        return `Source: ${nodeData.sourceType || 'Not configured'}`;
      case 'moderation':
        return `Level: ${nodeData.strictness || 'medium'}`;
      case 'router':
        return `Conditions: ${(nodeData.conditions || []).length}`;
      case 'fallback':
        return nodeData.message ? nodeData.message.substring(0, 50) + '...' : 'No message set';
      default:
        return 'Node configuration';
    }
  }
  
  async saveWorkflow(silent = false) {
    if (!silent) this.showLoading();
    
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
      if (!silent) this.hideLoading();
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
    this.setNodes([]);
    this.setEdges([]);
    this.nodes = [];
    this.edges = [];
    this.selectedNode = null;
    this.hasUnsavedChanges = true;
    
    this.updatePropertiesPanel();
    this.updateUI();
    
    this.showToast('Workflow cleared', 'info');
  }
  
  fitView() {
    if (this.reactFlowInstance) {
      this.reactFlowInstance.fitView();
    }
  }
  
  loadWorkflow() {
    const urlParams = new URLSearchParams(window.location.search);
    const workflowId = urlParams.get('id');
    
    if (workflowId) {
      this.loadWorkflowById(workflowId);
    } else {
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
        
        // Update React Flow state
        this.setNodes(this.nodes);
        this.setEdges(this.edges);
        
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
    if (publishBtn) {
      publishBtn.disabled = !this.currentWorkflow?.id || this.nodes.length === 0;
    }
    
    // Update property inputs
    if (this.currentWorkflow) {
      const nameInput = document.getElementById('workflow-name-input');
      const descInput = document.getElementById('workflow-description-input');
      
      if (nameInput) nameInput.value = this.currentWorkflow.name || '';
      if (descInput) descInput.value = this.currentWorkflow.description || '';
    }
  }
  
  showLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'flex';
  }
  
  hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
  
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type === 'error' ? 'danger' : type} alert-dismissible fade show position-fixed`;
    toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    toast.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 5000);
  }
  
  generateId() {
    return 'node_' + (++this.nodeId);
  }
  
  destroy() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
  }
}

// Global helper functions
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
  console.log('Add condition - to be implemented');
};

window.removeCondition = function(index) {
  console.log('Remove condition', index, '- to be implemented');
};

// Export for global access
window.ReactFlowWorkflowEditor = ReactFlowWorkflowEditor;
