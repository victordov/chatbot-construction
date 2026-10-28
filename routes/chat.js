const express = require('express');
const Conversation = require('../models/conversation');
const socketManager = require('../socketManager');
const tenantService = require('../services/tenant');
const { logger } = require('../services/logging');
const usageService = require('../services/usage');
const replyService = require('../services/reply');
const sessionToken = require('../services/session-token');
const lifecycle = require('../services/conversation-lifecycle');
const { notice, handoffChoice, wantsAPerson } = require('../services/visitor-notices');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_CONTEXT = 10;
/** The widget's own id for a message; see websockets.js. */
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
      // Transcript events are for operators, not the visitor.
      messages: (conversation.messages || []).filter(msg => msg.sender !== 'system').map(msg => ({
        id: msg._id ? msg._id.toString() : undefined,
        content: msg.content,
        sender: msg.sender,
        operatorName: msg.operatorName || undefined,
        clientMessageId: msg.sender === 'user' && msg.messageId && CLIENT_MESSAGE_ID.test(msg.messageId)
          ? msg.messageId
          : undefined,
        path: msg.sender === 'bot' ? (msg.path || undefined) : undefined,
        canRate: msg.sender === 'bot' ? lifecycle.canRate(msg) : undefined,
        feedback: msg.feedback && msg.feedback.rating ? { rating: msg.feedback.rating, at: msg.feedback.at } : undefined,
        // Citations on a grounded bot reply, so a reload shows them again.
        sources: msg.sources && msg.sources.length ? msg.sources : undefined,
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

/** What the response says about a hand-over, for a client to show. */
function describeHandover(conversation, outcome) {
  return {
    reason: outcome.reason,
    assigned: outcome.assigned,
    queued: outcome.queued,
    offline: outcome.offline,
    operatorName: outcome.operatorName || undefined,
    // Nobody can answer now: the client should ask for an email address.
    followUpRequested: outcome.offline && !(conversation.followUp && conversation.followUp.email)
  };
}

/** The line a client should show for a hand-over: the bot's, or the status. */
function handoverMessage(outcome) {
  if (outcome.line) {
    return {
      id: outcome.line.id,
      content: outcome.line.text,
      sender: 'bot',
      path: 'handoff',
      ...(outcome.line.code ? { code: outcome.line.code, params: outcome.line.params, message: outcome.line.message } : {}),
      timestamp: new Date()
    };
  }

  return { content: outcome.notice.message, sender: 'bot', path: 'handoff', ...outcome.notice, timestamp: new Date() };
}

/**
 * REST fallback for clients that cannot hold a WebSocket open.
 *
 * This previously replied with `Echo: <message>` and ignored the AI service
 * entirely, so any visitor on the REST path got a placeholder instead of a real
 * answer. It now follows the same path as the socket handler: create the
 * conversation on the first message, persist, hand off to a live operator if
 * one is attached, otherwise generate a bot reply - and when the bot cannot
 * answer, hand over to the team rather than apologise and stop.
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
    const clientMessageId = typeof req.body.clientMessageId === 'string' && CLIENT_MESSAGE_ID.test(req.body.clientMessageId)
      ? req.body.clientMessageId
      : undefined;
    let created = false;

    if (!conversation) {
      // Attribute the conversation to a tenant, otherwise it is invisible to
      // every company dashboard.
      const companyId = await tenantService.resolveCompanyId({
        widgetKey: req.body.widgetKey || req.query.key,
        origin
      });

      // The token is shown to the client exactly once, in this response.
      issuedToken = sessionToken.issue();

      // A tenant over their conversation allowance, or with a lapsed plan,
      // gets no new conversation. The visitor is told the chat is unavailable
      // rather than being shown a quota, which is the tenant's business.
      const result = await lifecycle.createConversation({
        sessionId,
        companyId,
        domain: origin || 'unknown',
        sessionTokenHash: sessionToken.hash(issuedToken),
        identity: { externalId: req.body.externalId, userHash: req.body.userHash }
      });

      if (result.refused) {
        const unavailable = notice('unavailable');
        return res.json({
          success: true,
          unavailable: true,
          message: { content: unavailable.message, sender: 'bot', ...unavailable, timestamp: new Date() }
        });
      }

      if (result.duplicate) {
        // Started by another request a moment ago, under a token this client
        // was never given.
        return res.status(409).json({ error: 'This session was started elsewhere. Start a new one.' });
      }

      conversation = result.conversation;
      created = true;
    }

    const companyId = conversation.company ? conversation.company.toString() : null;

    const emit = {
      visitor: (event, payload) => socketManager.emitToVisitor(sessionId, event, payload),
      operators: (event, payload) => socketManager.emitToOperators(companyId, event, payload)
    };

    // A client retrying a request it never saw the answer to sends the same
    // id again. It is acknowledged, not stored or answered twice.
    if (clientMessageId && conversation.messages.some(
      stored => stored.sender === 'user' && stored.messageId === clientMessageId
    )) {
      return res.json({ success: true, duplicate: true, message: null, sessionToken: issuedToken || undefined });
    }

    if (conversation.status === 'ended') {
      conversation.status = 'active';
      conversation.endedAt = null;

      // As on the socket: a reopened conversation nobody holds is answerable
      // again, rather than left with the bot switched off for it.
      if (!conversation.operatorId) {
        conversation.hasOperator = false;
        conversation.botEnabled = true;
        conversation.awaitingOperatorSince = undefined;
      }
    }

    lifecycle.recordConsent(conversation, req.body.consent);

    conversation.messages.push({
      content: text,
      sender: 'user',
      messageId: clientMessageId,
      timestamp: new Date()
    });
    const visitorMessage = conversation.messages[conversation.messages.length - 1];
    conversation.lastActivity = new Date();
    await conversation.save();

    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId,
      message: text,
      sender: 'user',
      messageId: String(visitorMessage._id),
      clientMessageId,
      timestamp: new Date()
    });
    lifecycle.announceMessages(conversation, [visitorMessage], emit);

    usageService.record(companyId, { messages: 1 });

    if (created) {
      await lifecycle.announceStart(conversation, { preview: text, emit });
    }

    // A human has the conversation: don't talk over them.
    if (conversation.hasOperator || conversation.botEnabled === false) {
      return res.json({
        success: true,
        pendingOperator: true,
        message: null,
        sessionToken: issuedToken || undefined
      });
    }

    /** Hand over, and answer the request with what happened. */
    const handOver = async (reason, extra = {}) => {
      const outcome = await lifecycle.handOver(conversation, reason, { emit });
      return res.json({
        success: true,
        ...extra,
        handoff: describeHandover(conversation, outcome),
        message: handoverMessage(outcome),
        sessionToken: issuedToken || undefined
      });
    };

    if (wantsAPerson(text)) {
      return handOver('visitor_request');
    }

    // Checked before the model is called, not after: a refused reply that had
    // already been generated would be paid for and thrown away. A spent
    // allowance goes to the team rather than leaving the visitor with
    // "unavailable".
    const quota = await usageService.check(companyId, 'aiResponsesPerMonth');
    if (!quota.allowed) {
      logger.warn('Automated reply refused by plan; handing over', { companyId: String(companyId), reason: quota.reason });
      usageService.recordLimitHit(companyId);
      return handOver('quota');
    }

    const history = lifecycle.modelHistory(conversation.messages, HISTORY_CONTEXT);

    // The same path the socket handler takes: the tenant's published workflow
    // if they have one, otherwise their assistant. Two entry points answering
    // the same message differently is how a REST fallback quietly stops
    // behaving like the product.
    let reply;
    try {
      reply = await replyService.generate({ conversation, message: text, history });
    } catch (error) {
      logger.error('Failed to generate a reply', { sessionId, error: error.message });
      reply = { failed: true };
    }

    const outcome = lifecycle.replyOutcome(reply);

    if (outcome.failed) {
      return handOver('model_error', { failed: true });
    }

    let content = outcome.text;
    let path = outcome.path;
    const sources = outcome.unanswered ? [] : (Array.isArray(reply.sources) ? reply.sources : []);
    const choices = Array.isArray(reply.choices) ? [...reply.choices] : [];

    if (outcome.unanswered) {
      const fallback = await lifecycle.cannedText(companyId, 'fallback', conversation);
      if (fallback) {
        content = fallback;
        path = 'fallback';
      }
      choices.push(handoffChoice());
    }

    conversation.messages.push({
      content,
      sender: 'bot',
      path,
      sources: sources.length ? sources : undefined,
      unanswered: outcome.unanswered || undefined,
      timestamp: new Date()
    });
    const stored = conversation.messages[conversation.messages.length - 1];
    conversation.lastActivity = new Date();
    await conversation.save();

    const delivered = {
      id: String(stored._id),
      text: content,
      path,
      canRate: lifecycle.canRate(stored),
      unanswered: outcome.unanswered || undefined,
      choices: choices.length ? choices : undefined,
      cards: reply.cards || undefined,
      sources,
      timestamp: new Date()
    };

    socketManager.emitToVisitor(sessionId, 'bot-message', delivered);

    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId,
      message: content,
      sender: 'bot',
      messageId: String(stored._id),
      sources,
      path,
      timestamp: new Date()
    });
    lifecycle.announceMessages(conversation, [stored], emit);

    // Metered when a model wrote the text; a canned reply or a fixed
    // workflow message did not use one.
    usageService.record(companyId, outcome.metered
      ? { aiResponses: 1, messages: 1 }
      : { messages: 1 });

    if (reply.escalate && reply.escalate.enabled !== false) {
      await lifecycle.handOver(conversation, 'workflow', { emit, line: false });
    }

    res.json({
      success: true,
      sessionToken: issuedToken || undefined,
      message: { content, sender: 'bot', ...delivered }
    });
  } catch (error) {
    logger.error('Failed to process chat message', { error });
    res.status(500).json({ error: 'Failed to process message' });
  }
});

module.exports = router;
