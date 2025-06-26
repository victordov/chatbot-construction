/**
 * Workflow Editor Integration Test
 * Tests the complete workflow from design to execution
 */

const request = require('supertest');
const mongoose = require('mongoose');
const express = require('express');
const User = require('../models/user');
const Company = require('../models/company');
const Workflow = require('../models/workflow');
const WorkflowCompilerService = require('../services/workflow-compiler');
const WorkflowRuntimeService = require('../services/workflow-runtime');

// Mock socket manager for testing
const mockSocketManager = {
  to: () => ({ emit: () => {} }),
  emit: () => {},
  broadcast: { emit: () => {} }
};

// Create a test app
const createTestApp = () => {
  const app = express();
  app.use(express.json());
  
  // Import and setup routes
  const authRoutes = require('../routes/auth');
  const workflowRoutes = require('../routes/workflow');
  const workflowExecutionRoutes = require('../routes/workflow-execution');
  
  // Initialize services for workflow execution routes
  const workflowExecutionRouter = require('../routes/workflow-execution');
  // Find and call initializeServices if it exists
  if (workflowExecutionRouter.initializeServices) {
    workflowExecutionRouter.initializeServices(mockSocketManager);
  }
  
  // Setup routes
  app.use('/api/auth', authRoutes);
  app.use('/api/workflows', workflowRoutes);
  app.use('/api/workflow-execution', workflowExecutionRoutes);
  
  return app;
};

describe('Visual Workflow Editor Integration', () => {
  let authToken;
  let testUser;
  let testCompany;
  let testWorkflow;
  let app;

  beforeAll(async () => {
    // Only connect if not already connected
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/chatbot_test');
    }
    
    // Create test app
    app = createTestApp();

    // Create test company
    testCompany = await Company.create({
      name: 'Test Workflow Company',
      subdomain: 'test-workflow',
      settings: {}
    });

    // Create test user
    testUser = await User.create({
      email: 'workflow-test@example.com',
      password: 'TestPassword123!',
      role: 'admin',
      company: testCompany._id
    });

    // Login to get auth token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'workflow-test@example.com',
        password: 'TestPassword123!'
      });

    authToken = loginResponse.body.token;
  });

  afterAll(async () => {
    // Clean up test data
    await User.deleteMany({ email: 'workflow-test@example.com' });
    await Company.deleteMany({ name: 'Test Workflow Company' });
    await Workflow.deleteMany({ name: { $regex: /Test Workflow/ } });
    await mongoose.connection.close();
  });

  describe('Workflow CRUD Operations', () => {
    test('should create a new workflow', async () => {
      const workflowData = {
        name: 'Test Workflow - Basic',
        description: 'A test workflow with persona and knowledge nodes',
        nodes: [
          {
            id: 'node_1',
            type: 'customNode',
            position: { x: 100, y: 100 },
            data: {
              type: 'persona',
              label: 'Persona',
              prompt: 'You are a helpful customer service assistant.',
              tone: 'professional',
              personality: 'helpful'
            }
          },
          {
            id: 'node_2',
            type: 'customNode',
            position: { x: 300, y: 100 },
            data: {
              type: 'knowledge',
              label: 'Knowledge Source',
              sourceType: 'google_sheets',
              config: {
                sheetId: '1234567890',
                range: 'A:Z'
              }
            }
          },
          {
            id: 'node_3',
            type: 'customNode',
            position: { x: 500, y: 100 },
            data: {
              type: 'moderation',
              label: 'Moderation',
              strictness: 'medium',
              filters: []
            }
          }
        ],
        edges: [
          {
            id: 'edge_1_2',
            source: 'node_1',
            target: 'node_2',
            type: 'default'
          },
          {
            id: 'edge_2_3',
            source: 'node_2',
            target: 'node_3',
            type: 'default'
          }
        ]
      };

      const response = await request(app)
        .post('/api/workflows')
        .set('x-auth-token', authToken)
        .send(workflowData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.workflow.name).toBe(workflowData.name);
      expect(response.body.workflow.nodes).toHaveLength(3);
      expect(response.body.workflow.edges).toHaveLength(2);
      expect(response.body.workflow.compiledChain).toBeDefined();

      testWorkflow = response.body.workflow;
    });

    test('should update workflow nodes and edges', async () => {
      const updateData = {
        nodes: [
          ...testWorkflow.nodes,
          {
            id: 'node_4',
            type: 'customNode',
            position: { x: 700, y: 100 },
            data: {
              type: 'fallback',
              label: 'Fallback',
              message: 'I apologize, but I need more information to help you.',
              escalation: { enabled: true, type: 'operator' }
            }
          }
        ],
        edges: [
          ...testWorkflow.edges,
          {
            id: 'edge_3_4',
            source: 'node_3',
            target: 'node_4',
            type: 'default'
          }
        ]
      };

      const response = await request(app)
        .put(`/api/workflows/${testWorkflow._id}`)
        .set('x-auth-token', authToken)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.workflow.nodes).toHaveLength(4);
      expect(response.body.workflow.edges).toHaveLength(3);
      expect(response.body.workflow.version).toBe(testWorkflow.version + 1);

      testWorkflow = response.body.workflow;
    });

    test('should validate workflow structure', async () => {
      const response = await request(app)
        .post('/api/workflows/validate')
        .set('x-auth-token', authToken)
        .send({
          nodes: testWorkflow.nodes,
          edges: testWorkflow.edges
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
    });

    test('should publish workflow and trigger hot-swap', async () => {
      const response = await request(app)
        .post(`/api/workflows/${testWorkflow._id}/publish`)
        .set('x-auth-token', authToken);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.workflow.status).toBe('published');
      expect(response.body.workflow.publishedAt).toBeDefined();

      testWorkflow = response.body.workflow;
    });
  });

  describe('Workflow Compilation', () => {
    test('should compile workflow to executable format', async () => {
      const compiler = new WorkflowCompilerService();
      
      const compilationResult = await compiler.compileWorkflow(
        testWorkflow.nodes,
        testWorkflow.edges,
        testCompany._id.toString()
      );

      expect(compilationResult.success).toBe(true);
      expect(compilationResult.executionPlan).toBeDefined();
      expect(compilationResult.compiledChain).toBeDefined();
      expect(compilationResult.compiledChain.prompts.persona).toBeDefined();
      expect(compilationResult.compiledChain.knowledge.sources).toHaveLength(1);
      expect(compilationResult.compiledChain.prompts.moderation.enabled).toBe(true);
    });

    test('should validate workflow compilation', async () => {
      const compiler = new WorkflowCompilerService();
      
      const validation = compiler.validateWorkflow(
        testWorkflow.nodes,
        testWorkflow.edges
      );

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  describe('Workflow Runtime', () => {
    let runtimeService;

    beforeEach(() => {
      runtimeService = new WorkflowRuntimeService();
    });

    afterEach(() => {
      if (runtimeService) {
        runtimeService.shutdown();
      }
    });

    test('should load workflow into runtime', async () => {
      const result = await runtimeService.loadWorkflow(
        testCompany._id.toString(),
        testWorkflow
      );

      expect(result).toBe(true);

      const status = runtimeService.getWorkflowStatus(testCompany._id.toString());
      expect(status.status).toBe('active');
      expect(status.workflow.id).toBe(testWorkflow._id.toString());
    });

    test('should execute workflow for user message', async () => {
      await runtimeService.loadWorkflow(
        testCompany._id.toString(),
        testWorkflow
      );

      const result = await runtimeService.executeWorkflow(
        testCompany._id.toString(),
        'Hello, I need help with my account',
        [],
        { conversationId: 'test_conv_1' }
      );

      expect(result.response).toBeDefined();
      expect(result.metadata.tenantId).toBe(testCompany._id.toString());
      expect(result.metadata.workflowVersion).toBe(testWorkflow.version);
    });

    test('should handle hot-swap of workflow', async () => {
      await runtimeService.loadWorkflow(
        testCompany._id.toString(),
        testWorkflow
      );

      // Create updated workflow version
      const updatedWorkflow = {
        ...testWorkflow,
        version: testWorkflow.version + 1,
        nodes: testWorkflow.nodes.map(node => 
          node.data.type === 'persona' 
            ? { ...node, data: { ...node.data, prompt: 'Updated persona prompt' } }
            : node
        )
      };

      const swapResult = await runtimeService.hotSwapWorkflow(
        testCompany._id.toString(),
        updatedWorkflow
      );

      expect(swapResult.success).toBe(true);
      expect(swapResult.newVersion).toBe(testWorkflow.version + 1);

      const status = runtimeService.getWorkflowStatus(testCompany._id.toString());
      expect(status.workflow.version).toBe(testWorkflow.version + 1);
    });
  });

  describe('Workflow Execution API', () => {
    test('should execute workflow via API', async () => {
      const response = await request(app)
        .post('/api/workflow-execution/execute')
        .set('x-auth-token', authToken)
        .send({
          message: 'I need help with my order',
          chatHistory: [],
          context: { conversationId: 'test_api_conv' }
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBeDefined();
      expect(response.body.mode).toBe('automated');
    });

    test('should get workflow runtime status', async () => {
      const response = await request(app)
        .get('/api/workflow-execution/status')
        .set('x-auth-token', authToken);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBeDefined();
    });

    test('should reload workflow via API', async () => {
      const response = await request(app)
        .post('/api/workflow-execution/reload')
        .set('x-auth-token', authToken)
        .send({ workflowId: testWorkflow._id });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Knowledge Source Integration', () => {
    test('should handle Google Sheets knowledge source', async () => {
      const knowledgeNode = testWorkflow.nodes.find(n => n.data.type === 'knowledge');
      expect(knowledgeNode).toBeDefined();
      expect(knowledgeNode.data.sourceType).toBe('google_sheets');
      expect(knowledgeNode.data.config.sheetId).toBe('1234567890');
    });

    test('should validate knowledge source configuration', async () => {
      const response = await request(app)
        .get('/api/workflows/knowledge-sources')
        .set('x-auth-token', authToken);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.sources).toContain('google_sheets');
      expect(response.body.sources).toContain('pdf');
      expect(response.body.sources).toContain('vector_store');
    });
  });

  describe('Security and Multi-tenancy', () => {
    test('should enforce company isolation', async () => {
      // Create another company and user
      const otherCompany = await Company.create({
        name: 'Other Test Company',
        subdomain: 'other-test',
        settings: {}
      });

      const otherUser = await User.create({
        email: 'other-user@example.com',
        password: 'TestPassword123!',
        role: 'admin',
        company: otherCompany._id
      });

      const otherLoginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'other-user@example.com',
          password: 'TestPassword123!'
        });

      const otherAuthToken = otherLoginResponse.body.token;

      // Try to access workflow from different company
      const response = await request(app)
        .get(`/api/workflows/${testWorkflow._id}`)
        .set('x-auth-token', otherAuthToken);

      expect(response.status).toBe(404); // Should not find workflow from other company

      // Clean up
      await User.deleteOne({ _id: otherUser._id });
      await Company.deleteOne({ _id: otherCompany._id });
    });

    test('should validate workflow structure for security', async () => {
      const invalidWorkflow = {
        nodes: [], // No persona node
        edges: []
      };

      const response = await request(app)
        .post('/api/workflows/validate')
        .set('x-auth-token', authToken)
        .send(invalidWorkflow);

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.errors).toContain('Workflow must include at least one Persona node');
    });
  });

  describe('Performance and Health Checks', () => {
    test('should provide health status', async () => {
      const response = await request(app)
        .get('/api/workflow-execution/health');

      expect(response.status).toBe(200);
      expect(response.body.healthy).toBe(true);
      expect(response.body.activeWorkflows).toBeDefined();
    });

    test('should handle multiple workflow executions', async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          request(app)
            .post('/api/workflow-execution/execute')
            .set('x-auth-token', authToken)
            .send({
              message: `Test message ${i}`,
              context: { conversationId: `perf_test_${i}` }
            })
        );
      }

      const responses = await Promise.all(promises);
      
      responses.forEach((response, index) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.response).toBeDefined();
      });
    });
  });
});
