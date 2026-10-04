/**
 * "Test your bot": ask the live bot a question from the dashboard.
 *
 * The workflow editor could already preview a graph on the canvas, but that
 * is the draft, not what visitors get. A tenant who imported their site and
 * wrote a persona had no way to ask "what will my bot actually say to this?"
 * short of opening their own website and chatting as a customer - which
 * created a real conversation, counted against their plan, showed up in the
 * operators' queue and fired their webhooks.
 *
 * This runs the same reply path a visitor's message takes
 * (`services/reply.js#generate`: the published workflow, otherwise canned
 * replies and the assistant) with none of that. No conversation is created or
 * saved, no usage is recorded, and a workflow runs in the preview's simulate
 * mode, so a GET to the tenant's API happens but a task, a tag, an email, a
 * POST or a handoff is declined.
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { auth, admin } = require('../middleware/auth');
const replyService = require('../services/reply');
const { logger } = require('../services/logging');

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_CONTEXT = 10;

/**
 * The tenant whose bot is being tested. A superadmin has no bot of their own
 * and names the company, as on the knowledge routes.
 */
function companyFor(req) {
  if (req.user.role === 'superadmin') {
    return req.body.companyId || req.query.companyId || null;
  }
  return req.user.company ? req.user.company.id : null;
}

/**
 * Identity variables the reply path computes itself. A test may not carry them
 * in through `state`: `contact_verified` is what gates account lookups, and
 * an admin token must not be a way to read any account through the flow.
 */
const RESERVED_VARIABLES = new Set([
  'contact_verified', 'contact_external_id', 'contact_name', 'contact_email'
]);

/** The workflow state a client sent back, minus anything it may not assert. */
function cleanState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }
  const variables = state.variables && typeof state.variables === 'object' && !Array.isArray(state.variables)
    ? Object.fromEntries(Object.entries(state.variables).filter(([key]) => !RESERVED_VARIABLES.has(key)))
    : {};
  return {
    workflowId: state.workflowId,
    version: state.version,
    awaiting: state.awaiting || null,
    variables
  };
}

/** Prior turns as the reply path takes them, ignoring anything malformed. */
function cleanHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(entry => entry && (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' && entry.content.trim())
    .slice(-HISTORY_CONTEXT)
    .map(entry => ({ role: entry.role, content: entry.content.slice(0, MAX_MESSAGE_LENGTH) }));
}

/**
 * Ask the bot something.
 *
 * Body `{ message, history: [{role: 'user'|'assistant', content}],
 * useWorkflow = true, state? }`. `state` is the `state` this endpoint returned
 * last time, so a workflow that asked a question can be answered on the next
 * turn, as it would be in a real conversation.
 *
 * Answers `{ reply, sources, path, choices?, cards?, escalate?, state?,
 * warning? }`, where `path` says what answered: the published workflow, a
 * canned reply, the assistant, or a fallback line (off-topic with no canned
 * reply, or an apology because the model could not be reached).
 */
router.post('/test', auth, admin, async (req, res) => {
  try {
    const companyId = companyFor(req);
    if (!companyId) {
      return res.status(400).json({
        error: req.user.role === 'superadmin'
          ? 'Name a company: every bot belongs to a tenant'
          : 'Your account is not attached to a company'
      });
    }
    if (!mongoose.isValidObjectId(companyId)) {
      return res.status(400).json({ error: 'That is not a company id' });
    }

    const { message, history, useWorkflow = true, state } = req.body;

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Ask the bot something' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    // Shaped like a conversation, because that is what the reply path reads,
    // but never a Conversation: there is nothing here to save, and nothing
    // that could be saved by accident. No contact either, so a workflow sees
    // an unverified visitor - the honest default for an admin typing as one.
    const conversation = {
      company: companyId,
      sessionId: null,
      _id: null,
      contact: null,
      workflowState: cleanState(state)
    };

    const reply = await replyService.generate({
      conversation,
      message: message.trim(),
      history: cleanHistory(history),
      simulate: true,
      useWorkflow: useWorkflow !== false
    });

    const body = {
      reply: reply.text,
      sources: Array.isArray(reply.sources) ? reply.sources : [],
      path: reply.path || reply.source || 'assistant'
    };

    if (reply.choices) {
      body.choices = reply.choices;
    }
    if (reply.cards) {
      body.cards = reply.cards;
    }
    if (reply.escalate) {
      body.escalate = reply.escalate;
    }
    if (reply.source === 'workflow') {
      body.state = conversation.workflowState;
    }
    if (!process.env.OPENAI_API_KEY) {
      // The answer above is still exactly what a visitor would get today,
      // which is the point; this says why it is an apology.
      body.warning = 'OPENAI_API_KEY is not set';
    }

    res.json(body);
  } catch (error) {
    logger.error('Bot test failed', { error: error.message });
    res.status(500).json({ error: 'The bot could not answer' });
  }
});

module.exports = router;
