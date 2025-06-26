/**
 * Operator Assist Workflow Service
 * Handles human operator hand-off and presence detection
 */

const EventEmitter = require('events');
const { logger } = require('./logging');

class OperatorAssistService extends EventEmitter {
  constructor(socketManager) {
    super();
    this.socketManager = socketManager;
    this.operatorSessions = new Map(); // sessionId -> operator info
    this.assistedConversations = new Map(); // conversationId -> assist info
    this.presenceTracking = new Map(); // tenantId -> operator presence
  }

  /**
   * Operator joins a conversation
   */
  async joinConversation(operatorId, conversationId, tenantId) {
    try {
      const sessionId = this.generateSessionId();
      
      const operatorInfo = {
        operatorId,
        conversationId,
        tenantId,
        sessionId,
        joinedAt: new Date(),
        isActive: true,
        responsesSuggested: 0
      };

      // Store operator session
      this.operatorSessions.set(sessionId, operatorInfo);
      
      // Mark conversation as assisted
      this.assistedConversations.set(conversationId, {
        operatorId,
        sessionId,
        startedAt: new Date(),
        mode: 'assist', // 'assist' or 'takeover'
        isActive: true
      });

      // Update presence tracking
      this.updateOperatorPresence(tenantId, operatorId, true);

      // Join WebSocket room for real-time communication
      if (this.socketManager) {
        this.socketManager.joinRoom(operatorId, `conversation_${conversationId}`);
        this.socketManager.joinRoom(operatorId, `tenant_${tenantId}_operators`);
        
        // Notify other operators
        this.socketManager.broadcastToRoom(`tenant_${tenantId}_operators`, 'operator:joined', {
          operatorId,
          conversationId,
          sessionId,
          timestamp: new Date().toISOString()
        });
      }

      logger.info(`Operator ${operatorId} joined conversation ${conversationId}`);
      
      return {
        success: true,
        sessionId,
        mode: 'assist'
      };
    } catch (error) {
      logger.error('Error in operator join conversation:', error);
      throw error;
    }
  }

  /**
   * Operator leaves a conversation
   */
  async leaveConversation(sessionId) {
    try {
      const operatorInfo = this.operatorSessions.get(sessionId);
      if (!operatorInfo) {
        throw new Error('Session not found');
      }

      const { operatorId, conversationId, tenantId } = operatorInfo;
      
      // Remove session
      this.operatorSessions.delete(sessionId);
      
      // Remove conversation assistance
      const assistInfo = this.assistedConversations.get(conversationId);
      if (assistInfo && assistInfo.sessionId === sessionId) {
        this.assistedConversations.delete(conversationId);
      }

      // Update presence
      this.updateOperatorPresence(tenantId, operatorId, false);

      // Leave WebSocket rooms
      if (this.socketManager) {
        this.socketManager.leaveRoom(operatorId, `conversation_${conversationId}`);
        
        // Notify other operators
        this.socketManager.broadcastToRoom(`tenant_${tenantId}_operators`, 'operator:left', {
          operatorId,
          conversationId,
          sessionId,
          timestamp: new Date().toISOString()
        });
      }

      logger.info(`Operator ${operatorId} left conversation ${conversationId}`);
      
      // Emit event for workflow routing to fall back to bot
      this.emit('operator:left', {
        conversationId,
        operatorId,
        tenantId
      });

      return { success: true };
    } catch (error) {
      logger.error('Error in operator leave conversation:', error);
      throw error;
    }
  }

  /**
   * Check if a conversation has operator assistance
   */
  isConversationAssisted(conversationId) {
    return this.assistedConversations.has(conversationId);
  }

  /**
   * Get operator assistance info for a conversation
   */
  getAssistanceInfo(conversationId) {
    return this.assistedConversations.get(conversationId);
  }

  /**
   * Generate suggested response for operator
   */
  async generateSuggestedResponse(conversationId, userMessage, chatHistory, workflowChain) {
    try {
      const assistInfo = this.assistedConversations.get(conversationId);
      if (!assistInfo || !assistInfo.isActive) {
        throw new Error('No active operator assistance for this conversation');
      }

      // Use the workflow compiler to generate a suggested response
      // But mark it as a suggestion, not an automatic response
      const WorkflowCompilerService = require('./workflow-compiler');
      const compiler = new WorkflowCompilerService();
      
      const suggestion = await compiler.executeWorkflow(
        workflowChain,
        userMessage,
        chatHistory,
        { mode: 'suggestion' }
      );

      // Track suggestion
      const operatorInfo = this.operatorSessions.get(assistInfo.sessionId);
      if (operatorInfo) {
        operatorInfo.responsesSuggested++;
      }

      // Send suggestion to operator via WebSocket
      if (this.socketManager) {
        this.socketManager.sendToRoom(`conversation_${conversationId}`, 'operator:suggestion', {
          suggestion: suggestion.response,
          confidence: suggestion.metadata?.confidence || 0.5,
          userMessage,
          timestamp: new Date().toISOString()
        });
      }

      logger.info(`Generated suggestion for conversation ${conversationId}`);
      
      return {
        success: true,
        suggestion: suggestion.response,
        metadata: suggestion.metadata
      };
    } catch (error) {
      logger.error('Error generating suggested response:', error);
      throw error;
    }
  }

  /**
   * Operator sends a response
   */
  async sendOperatorResponse(sessionId, message, conversationId) {
    try {
      const operatorInfo = this.operatorSessions.get(sessionId);
      if (!operatorInfo) {
        throw new Error('Invalid operator session');
      }

      // Send response via WebSocket to the user
      if (this.socketManager) {
        this.socketManager.sendToRoom(`conversation_${conversationId}`, 'message:operator', {
          message,
          operatorId: operatorInfo.operatorId,
          timestamp: new Date().toISOString(),
          type: 'operator_response'
        });
      }

      // Emit event for message storage/handling
      this.emit('operator:response', {
        conversationId,
        operatorId: operatorInfo.operatorId,
        message,
        timestamp: new Date()
      });

      logger.info(`Operator ${operatorInfo.operatorId} sent response to conversation ${conversationId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('Error sending operator response:', error);
      throw error;
    }
  }

  /**
   * Update operator presence for a tenant
   */
  updateOperatorPresence(tenantId, operatorId, isOnline) {
    if (!this.presenceTracking.has(tenantId)) {
      this.presenceTracking.set(tenantId, new Map());
    }

    const tenantPresence = this.presenceTracking.get(tenantId);
    
    if (isOnline) {
      tenantPresence.set(operatorId, {
        lastSeen: new Date(),
        status: 'online'
      });
    } else {
      tenantPresence.delete(operatorId);
    }

    // Broadcast presence update
    if (this.socketManager) {
      this.socketManager.broadcastToRoom(`tenant_${tenantId}_operators`, 'operator:presence', {
        operatorId,
        isOnline,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get online operators for a tenant
   */
  getOnlineOperators(tenantId) {
    const tenantPresence = this.presenceTracking.get(tenantId);
    if (!tenantPresence) return [];

    return Array.from(tenantPresence.entries()).map(([operatorId, info]) => ({
      operatorId,
      ...info
    }));
  }

  /**
   * Handle operator timeout (auto-leave after inactivity)
   */
  handleOperatorTimeout(sessionId) {
    const operatorInfo = this.operatorSessions.get(sessionId);
    if (!operatorInfo) return;

    const now = new Date();
    const inactiveTime = now - operatorInfo.lastActivity || operatorInfo.joinedAt;
    const timeoutThreshold = 30 * 60 * 1000; // 30 minutes

    if (inactiveTime > timeoutThreshold) {
      logger.info(`Operator session ${sessionId} timed out due to inactivity`);
      this.leaveConversation(sessionId);
    }
  }

  /**
   * Update operator activity timestamp
   */
  updateOperatorActivity(sessionId) {
    const operatorInfo = this.operatorSessions.get(sessionId);
    if (operatorInfo) {
      operatorInfo.lastActivity = new Date();
    }
  }

  /**
   * Get statistics about operator assistance
   */
  getOperatorStats(tenantId) {
    const activeSessions = Array.from(this.operatorSessions.values())
      .filter(session => session.tenantId === tenantId && session.isActive);
    
    const assistedConversations = Array.from(this.assistedConversations.values())
      .filter(conv => conv.isActive);

    const onlineOperators = this.getOnlineOperators(tenantId);

    return {
      tenantId,
      activeSessions: activeSessions.length,
      assistedConversations: assistedConversations.length,
      onlineOperators: onlineOperators.length,
      totalSuggestions: activeSessions.reduce((sum, session) => sum + session.responsesSuggested, 0)
    };
  }

  /**
   * Generate unique session ID
   */
  generateSessionId() {
    return `operator_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up expired sessions and timeouts
   */
  cleanup() {
    const now = new Date();
    const sessions = Array.from(this.operatorSessions.entries());
    
    sessions.forEach(([sessionId, info]) => {
      const lastActivity = info.lastActivity || info.joinedAt;
      const inactiveTime = now - lastActivity;
      
      if (inactiveTime > 30 * 60 * 1000) { // 30 minutes
        this.handleOperatorTimeout(sessionId);
      }
    });
  }

  /**
   * Shutdown the service
   */
  shutdown() {
    // Clean up all sessions
    Array.from(this.operatorSessions.keys()).forEach(sessionId => {
      this.leaveConversation(sessionId);
    });

    this.operatorSessions.clear();
    this.assistedConversations.clear();
    this.presenceTracking.clear();
    this.removeAllListeners();
    
    logger.info('Operator assist service shut down');
  }
}

module.exports = OperatorAssistService;
