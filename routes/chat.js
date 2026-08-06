const express = require('express');
const Conversation = require('../models/conversation');
const socketManager = require('../socketManager');
const AIService = require('../services/ai');
const tenantService = require('../services/tenant');
const { logger } = require('../services/logging');
const usageService = require('../services/usage');
const contactService = require('../services/contacts');
const replyService = require('../services/reply');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_CONTEXT = 10;

// Get chat history for the current session
router.get('/history', async (req, res) => {
  try {
    if (!req.session || !req.session.sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }

    const conversation = await Conversation.findOne(
      { sessionId: req.session.sessionId },
      { messages: 1 }
    ).lean();

    if (!conversation) {
      return res.json({ messages: [] });
    }

    res.json({
      messages: (conversation.messages || []).map(msg => ({
        content: msg.content,
        sender: msg.sender,
        timestamp: msg.timestamp
      }))
    });
  } catch (error) {
    logger.error('Failed to retrieve chat history', { error });
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

/**
 * REST fallback for clients that cannot hold a WebSocket open.
 *
 * This previously replied with `Echo: <message>` and ignored the AI service
 * entirely, so any visitor on the REST path got a placeholder instead of a real
 * answer. It now follows the same path as the socket handler: persist the
 * message, hand off to a live operator if one is attached, otherwise generate a
 * bot reply.
 */
router.post('/message', async (req, res) => {
  try {
    if (!req.session || !req.session.sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }

    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    const sessionId = req.session.sessionId;
    const origin = req.get('Origin') || req.get('Referer');
    let conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      // Attribute the conversation to a tenant, otherwise it is invisible to
      // every company dashboard.
      const companyId = await tenantService.resolveCompanyId({
        widgetKey: req.body.widgetKey || req.query.key,
        origin
      });

      conversation = new Conversation({
        sessionId,
        company: companyId || undefined,
        domain: origin || 'unknown',
        messages: []
      });

      usageService.record(companyId, { conversations: 1 });

      const contact = await contactService.resolve({
        companyId,
        sessionId,
        externalId: req.body.externalId,
        userHash: req.body.userHash
      });
      if (contact) {
        await contactService.linkConversation(contact, conversation);
      }
    }

    if (conversation.status === 'ended') {
      conversation.status = 'active';
      conversation.endedAt = null;
    }

    conversation.messages.push({
      content: message.trim(),
      sender: 'user',
      timestamp: new Date()
    });
    conversation.lastActivity = new Date();
    await conversation.save();

    const companyId = conversation.company ? conversation.company.toString() : null;

    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId,
      message: message.trim(),
      sender: 'user',
      timestamp: new Date()
    });

    usageService.record(companyId, { messages: 1 });

    // A human has the conversation: don't talk over them.
    if (conversation.hasOperator) {
      return res.json({ success: true, pendingOperator: true, message: null });
    }

    if (conversation.botEnabled === false) {
      return res.json({ success: true, pendingOperator: true, message: null });
    }

    const history = conversation.messages
      .slice(-HISTORY_CONTEXT)
      .map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.content
      }));

    // The same path the socket handler takes: the tenant's published workflow
    // if they have one, otherwise their assistant. Two entry points answering
    // the same message differently is how a REST fallback quietly stops
    // behaving like the product.
    const reply = await replyService.generate({
      conversation,
      message: message.trim(),
      history
    });

    const botResponse = reply.text;

    conversation.messages.push({
      content: botResponse,
      sender: 'bot',
      timestamp: new Date()
    });
    conversation.lastActivity = new Date();
    await conversation.save();

    socketManager.emitToSession(sessionId, 'bot-message', {
      text: botResponse,
      choices: reply.choices || undefined,
      timestamp: new Date()
    });

    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId,
      message: botResponse,
      sender: 'bot',
      timestamp: new Date()
    });

    // Only an assistant reply is a model call; a workflow that answered from a
    // template or a lookup did not use one.
    usageService.record(companyId, reply.source === 'workflow'
      ? { messages: 1 }
      : { aiResponses: 1, messages: 1 });

    res.json({
      success: true,
      message: {
        content: botResponse,
        sender: 'bot',
        choices: reply.choices || undefined,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Failed to process chat message', { error });
    res.status(500).json({ error: 'Failed to process message' });
  }
});

module.exports = router;
