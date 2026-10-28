/**
 * The bot, from the dashboard: try it, see what it could not answer, teach it,
 * and keep the answers it already gets right.
 *
 * "Test your bot" asks the live bot a question. The workflow editor could
 * already preview a graph on the canvas, but that is the draft, not what
 * visitors get. A tenant who imported their site and wrote a persona had no
 * way to ask "what will my bot actually say to this?" short of opening their
 * own website and chatting as a customer - which created a real conversation,
 * counted against their plan, showed up in the operators' queue and fired
 * their webhooks.
 *
 * It runs the same reply path a visitor's message takes
 * (`services/reply.js#generate`: the published workflow, otherwise canned
 * replies and the assistant) with none of that. No conversation is created or
 * saved, no usage is recorded, and a workflow runs in the preview's simulate
 * mode, so a GET to the tenant's API happens but a task, a tag, an email, a
 * POST or a handoff is declined.
 *
 * The rest is the loop that makes a bot better: the questions it could not
 * answer (`/gaps`), the way to fix one (`/teach`), and saved test questions
 * (`/tests`) that are re-run whenever something is taught, so a fix that
 * breaks another answer is found by the admin rather than by a customer.
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { auth, admin } = require('../middleware/auth');
const Company = require('../models/company');
const TestCase = require('../models/test-case');
const replyService = require('../services/reply');
const gaps = require('../services/gaps');
const teachService = require('../services/teach');
const testCases = require('../services/test-cases');
const availability = require('../services/availability');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { getVectorStore } = require('../services/vector-store');
const audit = require('../services/audit');
const { logger } = require('../services/logging');

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_CONTEXT = 10;

/** Passages shown under a test answer: what retrieval found, best first. */
const PASSAGES_SHOWN = 5;

/**
 * What a visitor is told when the bot cannot write an answer at all.
 *
 * The live conversation path never shows an error: it hands over with the
 * tenant's own hand-over line when they wrote one, and otherwise with this.
 * When nobody can be reached it asks for an email address instead.
 */
// What a visitor is told when the bot cannot reply and hands over; one
// sentence, owned by the notices the widget gets, so this screen shows exactly
// what the visitor would.
const DEFAULT_HANDOVER = require('../services/visitor-notices').notice('reply_failed').message;
const NOBODY_AVAILABLE = 'Sorry, I can\'t answer that right now, and nobody from the team is free at the moment. ' +
  'Leave your email address and we\'ll get back to you.';

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
 * The company, or an answer saying why there is none. Every route here is
 * about one tenant's bot.
 */
function requireCompany(req, res) {
  const companyId = companyFor(req);

  if (!companyId) {
    res.status(400).json({
      error: req.user.role === 'superadmin'
        ? 'Name a company: every bot belongs to a tenant'
        : 'Your account is not attached to a company'
    });
    return null;
  }
  if (!mongoose.isValidObjectId(companyId)) {
    res.status(400).json({ error: 'That is not a company id' });
    return null;
  }

  return String(companyId);
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
 * A pretend customer for "test as a verified customer".
 *
 * Verified-only actions are not even offered to an unverified visitor, so
 * without this an admin could never see one used before a real customer did.
 * It exists only for the length of one simulated reply: no Contact is created,
 * and in simulate mode every write is declined anyway. The id is whatever the
 * admin types (a real customer of theirs, to try a real lookup) or an obvious
 * placeholder.
 */
function standInContact(companyId, customer = {}) {
  const field = (value, max) => String(value || '').trim().slice(0, max);
  return {
    _id: null,
    company: companyId,
    identityLevel: 'verified',
    name: field(customer.name, 120) || 'Test Customer',
    email: field(customer.email, 254) || 'test.customer@example.com',
    externalId: field(customer.externalId, 120) || 'test-customer'
  };
}

/**
 * The passages retrieval found for this question, with how well each matched.
 *
 * The same search the assistant makes, run again here so the admin can see
 * scores and text - the reply only carries which sources were cited. A
 * search failure costs the panel, never the answer.
 */
async function passagesFor(companyId, message) {
  try {
    const results = await getVectorStore().search(message, { companyId, limit: PASSAGES_SHOWN });
    return results.map(result => {
      const metadata = result.metadata instanceof Map
        ? Object.fromEntries(result.metadata)
        : (result.metadata || {});
      return {
        sourceId: result.sourceId || null,
        title: metadata.title || metadata.filename || metadata.url || 'Knowledge base',
        url: /^https?:\/\//i.test(String(metadata.url || '')) ? metadata.url : null,
        score: Number(Number(result.score || 0).toFixed(3)),
        excerpt: String(result.content || '').slice(0, 400)
      };
    });
  } catch (error) {
    logger.warn('Could not list the passages for a bot test', { error: error.message });
    return [];
  }
}

/**
 * What a visitor would be shown, right now, if the model failed on their
 * message: the hand-over line, and whether anyone could actually take it.
 */
async function whatVisitorSees(companyId, noModel) {
  const [status, handover] = await Promise.all([
    availability.status(companyId).catch(() => ({ canReachOperator: false })),
    new ResponseTemplateService({ cacheTtl: 0, recordUse: false }).getByRole(companyId, 'handoff').catch(() => null)
  ]);

  const why = noModel
    ? 'No AI model is configured (OPENAI_API_KEY is not set), so the bot cannot write an answer.'
    : 'The AI model could not be reached for this message.';

  if (status && status.canReachOperator) {
    return { kind: 'handover', text: handover || DEFAULT_HANDOVER, why };
  }

  return {
    kind: 'leave_message',
    text: NOBODY_AVAILABLE,
    why: `${why} Nobody from your team is available right now, so the visitor is asked for an email address.`
  };
}

/**
 * Record that the admin has tried their bot (contract: the Home checklist's
 * "tried it" step reads it). Written at most once a day, so a long test
 * session is not a write per message. A superadmin testing a tenant's bot is
 * not the tenant trying it.
 */
function markTested(req, companyId) {
  if (req.user.role === 'superadmin') {
    return;
  }
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  Company.updateOne(
    {
      _id: companyId,
      $or: [
        { 'onboarding.botTestedAt': { $exists: false } },
        { 'onboarding.botTestedAt': null },
        { 'onboarding.botTestedAt': { $lt: dayAgo } }
      ]
    },
    { $set: { 'onboarding.botTestedAt': new Date() } }
  ).catch(error => logger.warn('Could not record that the bot was tested', { error: error.message }));
}

/**
 * Ask the bot something.
 *
 * Body `{ message, history: [{role: 'user'|'assistant', content}],
 * useWorkflow = true, state?, asVerified?, customer?: {name, email,
 * externalId} }`. `state` is the `state` this endpoint returned last time, so
 * a workflow that asked a question can be answered on the next turn, as it
 * would be in a real conversation. `asVerified` runs the turn as a signed-in
 * customer (see standInContact).
 *
 * Answers `{ reply, sources, path, knowledgeMatched, unanswered, failed,
 * passages?, toolCalls?, choices?, cards?, escalate?, state?, visitorWouldSee?,
 * warning? }`:
 *
 *   path            what answered: the published workflow, a canned reply,
 *                   the assistant, or a fallback line
 *   knowledgeMatched whether anything from the knowledge base was used
 *   passages        what retrieval found, with scores, for an assistant answer
 *   unanswered      the bot said it did not know (a visitor is offered a person)
 *   failed          the model could not answer at all; `reply` is then what
 *                   the visitor would see instead, and `visitorWouldSee` says
 *                   which of hand-over or leave-a-message, and why
 */
router.post('/test', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { message, history, useWorkflow = true, state, asVerified, customer } = req.body;

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Ask the bot something' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    // Shaped like a conversation, because that is what the reply path reads,
    // but never a Conversation: there is nothing here to save, and nothing
    // that could be saved by accident. No contact either, so a workflow sees
    // an unverified visitor - the honest default for an admin typing as one -
    // unless the admin asked to test as a verified customer.
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
      useWorkflow: useWorkflow !== false,
      testContact: asVerified ? standInContact(companyId, customer) : null
    });

    const noModel = !process.env.OPENAI_API_KEY;
    const sources = Array.isArray(reply.sources) ? reply.sources : [];
    const path = reply.path || reply.source || 'assistant';
    // Without a key every assistant answer is a failure, whether or not the
    // AI service reports it as one: an older one returns an apology string.
    const failed = reply.failed === true || (noModel && reply.source === 'assistant' && path === 'fallback');

    const body = {
      reply: reply.text,
      sources,
      path,
      knowledgeMatched: sources.length > 0,
      unanswered: !failed && reply.unanswered === true,
      failed
    };

    if (reply.source !== 'workflow' && path !== 'canned') {
      body.passages = await passagesFor(companyId, message.trim());
    }
    if (Array.isArray(reply.toolCalls) && reply.toolCalls.length) {
      body.toolCalls = reply.toolCalls;
    }
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
    if (failed) {
      body.visitorWouldSee = await whatVisitorSees(companyId, noModel);
      body.reply = body.visitorWouldSee.text;
    }
    if (asVerified) {
      body.asVerified = true;
    }
    if (noModel) {
      // The answer above is still exactly what a visitor would get today,
      // which is the point; this says why it is an apology.
      body.warning = 'OPENAI_API_KEY is not set';
    }

    markTested(req, companyId);
    res.json(body);
  } catch (error) {
    logger.error('Bot test failed', { error: error.message });
    res.status(500).json({ error: 'The bot could not answer' });
  }
});

// -------------------------------------------------------- unanswered questions

/**
 * The questions the bot could not answer, grouped.
 *
 * `?days=30&limit=50`. Answers `{ groups: [{ key, question, count, lastAt,
 * reasons: {unanswered, thumbs_down, handoff, failed}, examples: [{sessionId,
 * messageId, question, answer, at}] }], total, occurrences, days }`.
 */
router.get('/gaps', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    res.json(await gaps.list(companyId, { days: req.query.days, limit: req.query.limit }));
  } catch (error) {
    logger.error('Could not list unanswered questions', { error: error.message });
    res.status(500).json({ error: 'Could not load the unanswered questions' });
  }
});

/** "Not worth answering": hide a group until it is asked again. */
router.post('/gaps/:key/dismiss', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const key = String(req.params.key || '');
    if (!/^[a-f0-9]{8,40}$/.test(key)) {
      return res.status(400).json({ error: 'That is not a question group' });
    }

    const dismissal = await gaps.dismiss(companyId, key, { by: req.user.id });
    if (!dismissal) {
      return res.status(404).json({ error: 'That question is no longer on the list' });
    }

    await audit.record({
      req,
      action: 'bot.gap_dismissed',
      company: companyId,
      target: { type: 'gap', id: key, label: dismissal.question }
    });

    res.json({ ok: true, key });
  } catch (error) {
    logger.error('Could not dismiss an unanswered question', { error: error.message });
    res.status(500).json({ error: 'Could not dismiss that question' });
  }
});

// ------------------------------------------------------------------- teaching

/**
 * Save the answer the bot should have given.
 *
 * Body `{ question, answer, kind: 'knowledge'|'canned', title?, sessionId?,
 * messageId?, gapKey? }`. Answers `{ ok, kind, refId, title, corrected,
 * tests?: {passed, failed, total, failures} }`; `tests` is present when the
 * company has saved tests, which are all re-run.
 */
router.post('/teach', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { question, answer, kind, title, sessionId, messageId, gapKey } = req.body;

    const result = await teachService.teach({
      companyId,
      user: { id: req.user.id, role: req.user.role },
      question,
      answer,
      kind,
      title,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      messageId: typeof messageId === 'string' ? messageId : undefined,
      gapKey: typeof gapKey === 'string' ? gapKey : undefined
    });

    await audit.record({
      req,
      action: 'bot.taught',
      company: companyId,
      target: { type: kind === 'canned' ? 'template' : 'knowledge', id: result.refId, label: result.title },
      details: {
        kind,
        sessionId: sessionId || undefined,
        corrected: result.corrected,
        fromGap: Boolean(gapKey),
        ...(result.tests ? { testsPassed: result.tests.passed, testsFailed: result.tests.failed } : {})
      }
    });

    res.status(201).json(result);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    if (error.status === 402) {
      return res.status(402).json({
        error: error.message, code: error.code, meter: error.meter, limit: error.limit, used: error.used
      });
    }
    logger.error('Could not teach the bot', { error: error.message });
    res.status(500).json({ error: 'Could not save that answer' });
  }
});

// -------------------------------------------------------------- saved tests

const EXPECT_TYPES = new Set(['contains', 'handover', 'cites']);

/**
 * A test's fields from a request body, checked.
 *
 * @returns {{value?: object, error?: string}}
 */
function testFields(body = {}) {
  const question = String(body.question || '').trim();
  const expect = body.expect && typeof body.expect === 'object' ? body.expect : {};
  const type = String(expect.type || '');
  const value = String(expect.value || '').trim();

  if (!question) {
    return { error: 'Write the question to test' };
  }
  if (question.length > 500) {
    return { error: 'The question must be 500 characters or fewer' };
  }
  if (!EXPECT_TYPES.has(type)) {
    return { error: 'Say what a good answer looks like: mentions something, hands over, or uses a source' };
  }
  if (type === 'contains' && !value) {
    return { error: 'Say what the answer should mention' };
  }
  if (value.length > 300) {
    return { error: 'Keep what to look for under 300 characters' };
  }

  return { value: { question, expect: { type, value: type === 'handover' ? '' : value } } };
}

function publicTest(test) {
  return {
    id: String(test._id),
    question: test.question,
    expect: { type: test.expect.type, value: test.expect.value || '' },
    lastRun: test.lastRun && test.lastRun.at ? test.lastRun : null,
    createdAt: test.createdAt
  };
}

/** The company's saved tests, oldest first, with their last result. */
router.get('/tests', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const tests = await TestCase.find({ company: companyId }).sort({ createdAt: 1 }).lean();
    res.json({ tests: tests.map(publicTest), limit: TestCase.LIMIT });
  } catch (error) {
    logger.error('Could not list saved tests', { error: error.message });
    res.status(500).json({ error: 'Could not load your tests' });
  }
});

/** Save a question as a test. At most TestCase.LIMIT per company. */
router.post('/tests', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const fields = testFields(req.body);
    if (fields.error) {
      return res.status(400).json({ error: fields.error });
    }

    if (await TestCase.countDocuments({ company: companyId }) >= TestCase.LIMIT) {
      return res.status(409).json({
        error: `You already have ${TestCase.LIMIT} saved tests, the most a company can keep. Delete one first.`,
        code: 'TEST_LIMIT_REACHED',
        limit: TestCase.LIMIT
      });
    }

    const test = await TestCase.create({ company: companyId, ...fields.value, createdBy: req.user.id });
    res.status(201).json({ test: publicTest(test) });
  } catch (error) {
    logger.error('Could not save a test', { error: error.message });
    res.status(500).json({ error: 'Could not save that test' });
  }
});

/**
 * Run the company's tests, or the ones named in `{ ids }`. Each is a full
 * reply, so this takes a few seconds for a long list.
 */
router.post('/tests/run', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.filter(id => mongoose.isValidObjectId(id)).map(String)
      : undefined;

    res.json(await testCases.runAll(companyId, { ids }));
  } catch (error) {
    logger.error('Could not run saved tests', { error: error.message });
    res.status(500).json({ error: 'Could not run your tests' });
  }
});

/** One test, by id, scoped to the company. */
async function findTest(req, res, companyId) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'No such test' });
    return null;
  }
  const test = await TestCase.findOne({ _id: req.params.id, company: companyId });
  if (!test) {
    res.status(404).json({ error: 'No such test' });
    return null;
  }
  return test;
}

router.put('/tests/:id', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const test = await findTest(req, res, companyId);
    if (!test) {
      return;
    }

    const fields = testFields(req.body);
    if (fields.error) {
      return res.status(400).json({ error: fields.error });
    }

    test.question = fields.value.question;
    test.expect = fields.value.expect;
    // The last result was for a different test.
    test.lastRun = undefined;
    await test.save();

    res.json({ test: publicTest(test) });
  } catch (error) {
    logger.error('Could not update a test', { error: error.message });
    res.status(500).json({ error: 'Could not update that test' });
  }
});

router.delete('/tests/:id', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const test = await findTest(req, res, companyId);
    if (!test) {
      return;
    }

    await test.deleteOne();
    res.json({ ok: true, id: String(test._id) });
  } catch (error) {
    logger.error('Could not delete a test', { error: error.message });
    res.status(500).json({ error: 'Could not delete that test' });
  }
});

router.post('/tests/:id/run', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const test = await findTest(req, res, companyId);
    if (!test) {
      return;
    }

    res.json(await testCases.runOne(test.toObject(), companyId));
  } catch (error) {
    logger.error('Could not run a test', { error: error.message });
    res.status(500).json({ error: 'Could not run that test' });
  }
});

// The persona builder and the prompt preview (Persona & replies).
router.use(require('./bot-persona'));

module.exports = router;
module.exports.standInContact = standInContact;
module.exports.DEFAULT_HANDOVER = DEFAULT_HANDOVER;
