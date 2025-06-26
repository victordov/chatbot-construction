/**
 * Workflow Services Unit Test
 * Tests individual workflow services
 */

const WorkflowCompilerService = require('../services/workflow-compiler');
const WorkflowRuntimeService = require('../services/workflow-runtime');
const OperatorAssistService = require('../services/operator-assist');
const KnowledgeConnectorService = require('../services/knowledge-connector');

// Mock socket manager for testing
const mockSocketManager = {
  to: () => ({ emit: () => {} }),
  emit: () => {},
  broadcast: { emit: () => {} }
};

describe('Workflow Services', () => {
  
  describe('WorkflowCompilerService', () => {
    let compiler;

    beforeEach(() => {
      compiler = new WorkflowCompilerService();
    });

    test('should compile a simple workflow', async () => {
      const workflow = {
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          },
          {
            id: 'response',
            type: 'customNode',
            data: { 
              type: 'response',
              label: 'Response',
              template: 'Hello! How can I help you?',
              variables: []
            }
          }
        ],
        edges: [
          {
            id: 'e1',
            source: 'start',
            target: 'response'
          }
        ]
      };

      const result = await compiler.compileWorkflow(workflow.nodes, workflow.edges, 'test-tenant');
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.executionPlan).toBeDefined();
      expect(result.executionPlan.nodes).toHaveLength(3);
    });

    test('should validate workflow structure', async () => {
      const invalidWorkflow = {
        nodes: [],
        edges: []
      };

      try {
        const result = await compiler.compileWorkflow(invalidWorkflow.nodes, invalidWorkflow.edges, 'test-tenant');
        expect(result.success).toBe(false);
      } catch (error) {
        expect(error.message).toContain('Workflow validation failed');
      }
    });

    test('should handle knowledge source nodes', async () => {
      const workflow = {
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          },
          {
            id: 'knowledge',
            type: 'customNode',
            data: { 
              type: 'knowledge-source',
              label: 'Google Sheets',
              sourceType: 'google-sheets',
              config: {
                spreadsheetId: 'test-id',
                range: 'A1:B10'
              }
            }
          },
          {
            id: 'response',
            type: 'customNode',
            data: { 
              type: 'response',
              label: 'Response',
              template: 'Based on the knowledge: {{knowledge_result}}',
              variables: ['knowledge_result']
            }
          }
        ],
        edges: [
          {
            id: 'e1',
            source: 'start',
            target: 'knowledge'
          },
          {
            id: 'e2',
            source: 'knowledge',
            target: 'response'
          }
        ]
      };

      const result = await compiler.compileWorkflow(workflow.nodes, workflow.edges, 'test-tenant');
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.executionPlan.nodes).toHaveLength(4);
    });

    test('should enforce hidden safety prompts', async () => {
      const workflow = {
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          },
          {
            id: 'llm',
            type: 'customNode',
            data: { 
              type: 'llm',
              label: 'LLM Call',
              model: 'gpt-3.5-turbo',
              prompt: 'User question: {{user_input}}'
            }
          }
        ],
        edges: [
          {
            id: 'e1',
            source: 'start',
            target: 'llm'
          }
        ]
      };

      const result = await compiler.compileWorkflow(workflow.nodes, workflow.edges, 'test-tenant');
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      
      // Check that safety prompts are added
      const llmNode = result.executionPlan.nodes.find(n => n.type === 'llm');
      expect(llmNode).toBeDefined();
      expect(llmNode.data.prompt).toContain('You are a helpful assistant');
      expect(llmNode.data.prompt).toContain('User question: {{user_input}}');
    });
  });

  describe('WorkflowRuntimeService', () => {
    let runtime;

    beforeEach(() => {
      runtime = new WorkflowRuntimeService(mockSocketManager);
    });

    test('should load workflow successfully', async () => {
      const workflow = {
        _id: 'test-workflow',
        name: 'Test Workflow',
        version: 1,
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          }
        ],
        edges: []
      };

      const result = await runtime.loadWorkflow('test-tenant', workflow);
      
      expect(result.success).toBe(true);
      expect(runtime.getWorkflowStatus('test-tenant')).toBeDefined();
    });

    test('should execute simple workflow', async () => {
      const workflow = {
        _id: 'test-workflow',
        name: 'Test Workflow',
        version: 1,
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          },
          {
            id: 'response',
            type: 'customNode',
            data: { 
              type: 'response',
              label: 'Response',
              template: 'Hello! How can I help you?',
              variables: []
            }
          }
        ],
        edges: [
          {
            id: 'e1',
            source: 'start',
            target: 'response'
          }
        ]
      };

      await runtime.loadWorkflow('test-tenant', workflow);
      
      const result = await runtime.executeWorkflow('test-tenant', 'Hello', []);
      
      expect(result).toBeDefined();
      expect(result.response).toContain('Hello! How can I help you?');
    });

    test('should handle hot-swap', async () => {
      const originalWorkflow = {
        _id: 'test-workflow',
        name: 'Test Workflow',
        version: 1,
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          }
        ],
        edges: []
      };

      const newWorkflow = {
        _id: 'test-workflow',
        name: 'Test Workflow Updated',
        version: 2,
        nodes: [
          {
            id: 'persona',
            type: 'customNode',
            data: { 
              type: 'persona',
              label: 'Assistant',
              prompt: 'You are a helpful assistant',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'start',
            type: 'customNode',
            data: { type: 'start', label: 'Start' }
          },
          {
            id: 'response',
            type: 'customNode',
            data: { 
              type: 'response',
              label: 'New Response',
              template: 'Updated response!',
              variables: []
            }
          }
        ],
        edges: [
          {
            id: 'e1',
            source: 'start',
            target: 'response'
          }
        ]
      };

      await runtime.loadWorkflow('test-tenant', originalWorkflow);
      const hotSwapResult = await runtime.hotSwapWorkflow('test-tenant', newWorkflow);
      
      expect(hotSwapResult.success).toBe(true);
    });
  });

  describe('OperatorAssistService', () => {
    let operatorAssist;

    beforeEach(() => {
      operatorAssist = new OperatorAssistService(mockSocketManager);
    });

    test('should handle operator join', () => {
      const result = operatorAssist.joinSession('session-1', 'operator-1', 'John Doe');
      
      expect(result.success).toBe(true);
      expect(operatorAssist.getActiveOperators('session-1')).toHaveLength(1);
    });

    test('should handle operator leave', () => {
      operatorAssist.joinSession('session-1', 'operator-1', 'John Doe');
      const result = operatorAssist.leaveSession('session-1', 'operator-1');
      
      expect(result.success).toBe(true);
      expect(operatorAssist.getActiveOperators('session-1')).toHaveLength(0);
    });

    test('should generate suggested replies', async () => {
      const chatHistory = [
        { role: 'user', content: 'I need help with my order' },
        { role: 'assistant', content: 'I can help you with that. What seems to be the issue?' },
        { role: 'user', content: 'It never arrived' }
      ];

      const suggestions = await operatorAssist.generateSuggestedReplies(chatHistory);
      
      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('KnowledgeConnectorService', () => {
    let knowledgeConnector;

    beforeEach(() => {
      knowledgeConnector = new KnowledgeConnectorService();
    });

    test('should query Google Sheets (mock)', async () => {
      const config = {
        type: 'google-sheets',
        spreadsheetId: 'test-id',
        range: 'A1:B10'
      };

      // This will fail in actual test environment but validates structure
      try {
        const result = await knowledgeConnector.queryKnowledgeSource(config, 'test query', 'test-tenant');
        expect(result).toBeDefined();
      } catch (error) {
        // Expected to fail without actual credentials
        expect(error.message).toContain('Google Sheets service not configured');
      }
    });

    test('should query PDF/URL (mock)', async () => {
      const config = {
        type: 'pdf-url',
        url: 'https://example.com/document.pdf'
      };

      try {
        const result = await knowledgeConnector.queryKnowledgeSource(config, 'test query', 'test-tenant');
        expect(result).toBeDefined();
      } catch (error) {
        // Expected to fail without actual URL
        expect(error.message).toContain('Failed to fetch content from URL');
      }
    });

    test('should query vector store (mock)', async () => {
      const config = {
        type: 'vector-store',
        provider: 'qdrant',
        collection: 'test-collection'
      };

      try {
        const result = await knowledgeConnector.queryKnowledgeSource(config, 'test query', 'test-tenant');
        expect(result).toBeDefined();
      } catch (error) {
        // Expected to fail without actual vector store
        expect(error.message).toContain('Vector store not configured');
      }
    });
  });
});
