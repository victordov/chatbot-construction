const express = require('express');
const Conversation = require('../models/conversation');
const socketManager = require('../socketManager');
const tenantService = require('../services/tenant');
const { logger } = require('../services/logging');
const usageService = require('../services/usage');
const contactService = require('../services/contacts');
const replyService = require('../services/reply');
const sessionToken = require('../services/session-token');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_CONTEXT = 10;

/**
 * Which conversation a request is about, and whether it may touch it.
 *
 * The session id comes from the cookie session by default; a client that
 * cannot hold a cookie (the reason this REST path exists) may name one in the
 * body or query instead. Either way the id alone proves nothing - it appears
 * in dashboard URLs and exports - so a conversation that has a token demands
 * it. One without a token predates tokens; it is accepted and upgraded on the
 * spot, so the next request has something to present.
 *
 * @returns {Promise<{sessionId: string, conversation: object|null,
 *                    issuedToken: string|null, forbidden: boolean}>}
 */
async function resolveSession(req) {
  const supplied = req.body?.sessionId || req.query?.sessionId;
  const sessionId = typeof supplied === 'string' && supplied
    ? supplied
    : (req.session && req.session.sessionId);

  if (!sessionId) {
    return { sessionId: null, conversation: null, issuedToken: null, forbidden: false };
  }

  const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');

  if (!conversation) {
    return { sessionId, conversation: null, issuedToken: null, forbidden: false };
  }

  const presented = req.body?.sessionToken || req.query?.sessionToken;

  if (conversation.sessionTokenHash) {
    return {
      sessionId,
      conversation,
      issuedToken: null,
      forbidden: !sessionToken.verify(conversation.sessionTokenHash, presented)
    };
  }

  // Legacy conversation: accept this once and issue a token for next time.
  const issued = sessionToken.issue();
  conversation.sessionTokenHash = sessionToken.hash(issued);
  await conversation.save();

  return { sessionId, conversation, issuedToken: issued, forbidden: false };
}

// Get chat history for the current session
router.get('/history', async (req, res) => {
  try {
    const { sessionId, conversation, issuedToken, forbidden } = await resolveSession(req);

    if (!sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }

    if (forbidden) {
      return res.status(403).json({ error: 'Invalid session token' });
    }

    if (!conversation) {
      return res.json({ messages: [] });
    }

    res.json({
      sessionToken: issuedToken || undefined,
      messages: (conversation.messages || []).map(msg => ({
        id: msg._id ? msg._id.toString() : undefined,
        content: msg.content,
        sender: msg.sender,
        operatorName: msg.operatorName || undefined,
        // Attachments either side sent, so a REST client can link them the
        // same way the socket history does.
        fileId: msg.fileId || undefined,
        fileName: msg.fileId ? msg.fileName : undefined,
        fileUrl: msg.fileId ? `/api/upload/${msg.fileId}` : undefined,
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
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    const resolved = await resolveSession(req);
    const { sessionId, forbidden } = resolved;
    let { conversation, issuedToken } = resolved;

    if (!sessionId) {
      return res.status(400).json({ error: 'No active session' });
    }

    if (forbidden) {
      return res.status(403).json({ error: 'Invalid session token' });
    }

    const origin = req.get('Origin') || req.get('Referer');
    const text = message.trim();

    if (!conversation) {
      // Attribute the conversation to a tenant, otherwise it is invisible to
      // every company dashboard.
      const companyId = await tenantService.resolveCompanyId({
        widgetKey: req.body.widgetKey || req.query.key,
        origin
      });

      // A tenant over their conversation allowance, or with a lapsed plan,
      // gets no new conversation. The visitor is told the chat is unavailable
      // rather than being shown a quota, which is the tenant's business.
      const quota = await usageService.check(companyId, 'conversationsPerMonth');
      if (!quota.allowed) {
        logger.warn('Conversation refused by plan', { companyId: String(companyId), reason: quota.reason });
        usageService.recordLimitHit(companyId);
        return res.json({
          success: true,
          unavailable: true,
          message: { content: usageService.UNAVAILABLE_MESSAGE, sender: 'bot', timestamp: new Date() }
        });
      }

      // The token is shown to the client exactly once, in this response.
      issuedToken = sessionToken.issue();

      conversation = new Conversation({
        sessionId,
        sessionTokenHash: sessionToken.hash(issuedToken),
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
      content: text,
      sender: 'user',
      timestamp: new Date()
    });
    conversation.lastActivity = new Date();
    await conversation.save();

    const companyId = conversation.company ? conversation.company.toString() : null;

    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId,
      message: text,
      sender: 'user',
      timestamp: new Date()
    });

    usageService.record(companyId, { messages: 1 });

    // A human has the conversation: don't talk over them.
    if (conversation.hasOperator || conversation.botEnabled === false) {
      return res.json({
        success: true,
        pendingOperator: true,
        message: null,
        sessionToken: issuedToken || undefined
      });
    }

    /** Store and deliver a bot message, whoever composed it. */
    const deliverBotMessage = async (content, extra = {}) => {
      conversation.messages.push({ content, sender: 'bot', timestamp: new Date() });
      conversation.lastActivity = new Date();
      await conversation.save();

      socketManager.emitToSession(sessionId, 'bot-message', {
        id: conversation.messages.at(-1)._id.toString(),
        text: content,
        ...extra,
        timestamp: new Date()
      });

      socketManager.emitToOperators(companyId, 'new-message', {
        sessionId,
        message: content,
        sender: 'bot',
        timestamp: new Date()
      });

      return {
        content,
        sender: 'bot',
        ...extra,
        timestamp: new Date()
      };
    };

    // Checked before the model is called, not after: a refused reply that had
    // already been generated would be paid for and thrown away.
    const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
    if (!quota.allowed) {
      logger.warn('Automated reply refused by plan', { companyId: String(companyId), reason: quota.reason });
      usageService.recordLimitHit(companyId);
      const unavailable = await deliverBotMessage(usageService.UNAVAILABLE_MESSAGE);
      return res.json({ success: true, unavailable: true, message: unavailable, sessionToken: issuedToken || undefined });
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
    let reply;
    try {
      reply = await replyService.generate({ conversation, message: text, history });
    } catch (error) {
      logger.error('Failed to generate a reply', { sessionId, error: error.message });
      const apology = await deliverBotMessage(usageService.REPLY_FAILED_MESSAGE);
      return res.json({ success: true, failed: true, message: apology, sessionToken: issuedToken || undefined });
    }

    const delivered = await deliverBotMessage(reply.text, {
      choices: reply.choices || undefined,
      cards: reply.cards || undefined
    });

    // Only an assistant reply is a model call; a workflow that answered from a
    // template or a lookup did not use one.
    usageService.record(companyId, reply.source === 'workflow'
      ? { messages: 1 }
      : { aiResponses: 1, messages: 1 });

    res.json({
      success: true,
      sessionToken: issuedToken || undefined,
      message: delivered
    });
  } catch (error) {
    logger.error('Failed to process chat message', { error });
    res.status(500).json({ error: 'Failed to process message' });
  }
});

module.exports = router;
