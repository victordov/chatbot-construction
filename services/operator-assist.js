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

      // Notify other operators of this tenant.
      this.notifyOperators(tenantId, 'operator:joined', {
        operatorId,
        conversationId,
        sessionId,
        timestamp: new Date().toISOString()
      });

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

      this.notifyOperators(tenantId, 'operator:left', {
        operatorId,
        conversationId,
        sessionId,
        timestamp: new Date().toISOString()
      });

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
   * Emit to a tenant's operators if the injected socket manager supports it.
   */
  notifyOperators(tenantId, event, payload) {
    if (this.socketManager && typeof this.socketManager.emitToOperators === 'function') {
      this.socketManager.emitToOperators(tenantId, event, payload);
    }
  }

  /**
   * Emit to a single conversation room if supported.
   */
  notifySession(conversationId, event, payload) {
    if (this.socketManager && typeof this.socketManager.emitToSession === 'function') {
      this.socketManager.emitToSession(conversationId, event, payload);
    }
  }

  /**
   * Synchronous convenience wrapper over joinConversation, keyed by
   * conversation rather than by generated session id. This is what the chat UI
   * calls when an operator opens a conversation.
   */
  joinSession(conversationId, operatorId, operatorName, tenantId = null) {
    const sessionId = this.generateSessionId();

    this.operatorSessions.set(sessionId, {
      operatorId,
      operatorName,
      conversationId,
      tenantId,
      sessionId,
      joinedAt: new Date(),
      isActive: true,
      responsesSuggested: 0
    });

    this.assistedConversations.set(conversationId, {
      operatorId,
      operatorName,
      sessionId,
      startedAt: new Date(),
      mode: 'assist',
      isActive: true
    });

    if (tenantId) {
      this.updateOperatorPresence(tenantId, operatorId, true);
      this.notifyOperators(tenantId, 'operator:joined', {
        operatorId,
        operatorName,
        conversationId,
        timestamp: new Date().toISOString()
      });
    }

    logger.info(`Operator ${operatorName || operatorId} joined conversation ${conversationId}`);

    return { success: true, sessionId, mode: 'assist' };
  }

  /**
   * Remove one operator from a conversation.
   */
  leaveSession(conversationId, operatorId) {
    let removed = false;

    for (const [sessionId, info] of this.operatorSessions) {
      if (info.conversationId === conversationId &&
          String(info.operatorId) === String(operatorId)) {
        this.operatorSessions.delete(sessionId);
        removed = true;

        if (info.tenantId) {
          this.updateOperatorPresence(info.tenantId, operatorId, false);
          this.notifyOperators(info.tenantId, 'operator:left', {
            operatorId,
            conversationId,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    // Only drop the assisted flag once the last operator has gone, so a
    // conversation with two operators does not fall back to the bot when one
    // of them closes their tab.
    if (this.getActiveOperators(conversationId).length === 0) {
      this.assistedConversations.delete(conversationId);
      this.emit('operator:left', { conversationId, operatorId });
    }

    return { success: removed };
  }

  /**
   * Operators currently attached to a conversation.
   */
  getActiveOperators(conversationId) {
    return Array.from(this.operatorSessions.values())
      .filter(info => info.conversationId === conversationId && info.isActive)
      .map(info => ({
        operatorId: info.operatorId,
        operatorName: info.operatorName,
        sessionId: info.sessionId,
        joinedAt: info.joinedAt
      }));
  }

  /**
   * Offer an operator a few ready-to-send replies for the current conversation.
   *
   * Falls back to generic prompts when no model is configured so the operator
   * UI always has something to show rather than an empty panel.
   */
  async generateSuggestedReplies(chatHistory = [], options = {}) {
    const fallbackReplies = [
      'Thanks for reaching out - let me look into that for you.',
      'I understand, and I\'m sorry for the trouble. Could you share a bit more detail?',
      'Let me check on this and get back to you shortly.'
    ];

    if (!process.env.OPENAI_API_KEY) {
      return fallbackReplies;
    }

    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are helping a human support operator. Given the conversation so far, suggest three short, distinct replies the operator could send next. Return one reply per line with no numbering or quotes.'
          },
          ...chatHistory.slice(-10),
          { role: 'user', content: 'Suggest three replies.' }
        ],
        temperature: 0.7,
        max_tokens: 300
      });

      const suggestions = (completion.choices[0].message.content || '')
        .split('\n')
        .map(line => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);

      return suggestions.length > 0 ? suggestions : fallbackReplies;
    } catch (error) {
      logger.error('Error generating suggested replies', { error: error.message });
      return fallbackReplies;
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

      this.notifySession(conversationId, 'operator:suggestion', {
        suggestion: suggestion.response,
        confidence: suggestion.metadata?.confidence || 0.5,
        userMessage,
        timestamp: new Date().toISOString()
      });

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
    if (!tenantPresence) {
      return [];
    }

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
    if (!operatorInfo) {
      return;
    }

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
