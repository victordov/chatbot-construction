/**
 * What the bot says next.
 *
 * This exists because the visual workflow editor was not connected to
 * anything. A tenant could build a workflow, validate it, publish it, watch the
 * runtime hot-swap it — and every visitor conversation went on being answered
 * by `AIService.generateResponse`, which knows nothing about workflows. Routers
 * routed nothing, handoff nodes handed nothing off, and the whole subsystem was
 * reachable only from a preview endpoint.
 *
 * Both entry points into a conversation — the socket handler and the REST
 * fallback — now come through here, so there is one answer to "what replies to
 * this message" rather than two that disagree.
 *
 * The order is: a live workflow whose trigger matches the message (or that is
 * part-way through asking this visitor something), otherwise the assistant.
 * A workflow that fails falls back to the assistant rather than leaving the
 * visitor with silence.
 */

const runtimeRegistry = require('./runtime-registry');
const AIService = require('./ai');
const assistantTools = require('./assistant-tools');
const { logger } = require('./logging');

/**
 * Generate the reply to a visitor's message.
 *
 * @param {object} options
 * @param {object} options.conversation the conversation document; its
 *        `workflowState` is read and updated in place, but not saved — the
 *        caller owns persistence, because it is already saving the message
 * @param {string} options.message
 * @param {Array} [options.history] prior messages as {role, content}
 * @param {boolean} [options.simulate] a dry run ("test your bot"): workflow
 *        nodes read but do not write, exactly as in the editor's preview, and
 *        canned-reply use is not counted. Metering is the caller's, so a
 *        caller that does not record usage has none.
 * @param {boolean} [options.useWorkflow=true] false skips the published
 *        workflow and asks the assistant directly
 * @param {object} [options.testContact] a stand-in contact for a dry run
 *        ("test as a verified customer"). Ignored unless `simulate` is set, so
 *        a live conversation can only ever be the person it belongs to.
 * @returns {Promise<{text: string|null, choices?: Array, cards?: object,
 *                    escalate?: object, toolCalls?: Array<{name, status}>,
 *                    source: 'workflow'|'assistant',
 *                    path: 'workflow'|'assistant'|'canned'|'fallback',
 *                    sources: Array<{title: string, url: string|null}>,
 *                    failed: boolean, unanswered: boolean, metered: boolean}>}
 *          `sources` are the knowledge sources whose chunks were placed in
 *          the prompt: deduplicated, at most three, empty for a workflow
 *          reply, a canned reply or an apology.
 *
 *          `failed`: the model could not be reached, so there is no answer to
 *          send; `text` may be null. The caller hands over rather than showing
 *          an error.
 *          `unanswered`: there was an answer, and it was "I don't know" — the
 *          assistant said so, or a workflow ended on its fallback. What the
 *          unanswered-questions list is built from.
 *          `metered`: a model wrote the visible text (the assistant, or a
 *          workflow's AI Reply step). Canned replies, fixed workflow replies
 *          and failures cost the tenant nothing.
 */
async function generate({
  conversation, message, history = [], simulate = false, useWorkflow = true, testContact = null
}) {
  const companyId = conversation.company ? String(conversation.company) : null;
  // Only a dry run may pretend to be somebody.
  const standIn = simulate && testContact ? testContact : null;

  if (companyId && useWorkflow) {
    const fromWorkflow = await tryWorkflow({
      conversation, companyId, message, history, simulate, testContact: standIn
    });
    if (fromWorkflow) {
      return fromWorkflow;
    }
  }

  const options = {};
  if (simulate) {
    // A fresh, uncached template service that does not count matches: the
    // admin sees the canned replies they saved a second ago, and trying a
    // question ten times does not skew the usage figures.
    const { ResponseTemplateService } = require('./responseTemplates');
    options.templateService = new ResponseTemplateService({ cacheTtl: 0, recordUse: false });
  }

  const aiService = await AIService.forCompany(companyId, options);

  // The tenant's actions and connector capabilities, offered to the model as
  // tools. Null without a model client or with nothing to offer, in which case
  // this is the plain assistant it always was. A simulated run may read but
  // never write, the same promise the workflow preview makes.
  const toolSession = await assistantTools.prepare({
    conversation,
    companyId,
    client: aiService.openai,
    message,
    simulate,
    ...(standIn ? { contact: standIn } : {})
  });

  // The conversation goes along so a canned reply can greet the visitor by
  // the name they gave ({name}).
  const text = await aiService.generateResponse(message, history, { toolSession, conversation });

  return {
    ...assistantOutcome(aiService, text),
    // `cards`, `choices` and `toolCalls` only when a tool produced them.
    ...(toolSession ? toolSession.outcome() : {})
  };
}

/**
 * What the assistant's last answer was, in the shape every caller reads.
 *
 * The flags come from the AIService instance (`lastFailed`, `lastUnanswered`)
 * and are read defensively: an older AIService sets neither, and a missing
 * flag must read as "no" rather than throw. A null answer is a failure whether
 * or not the flag says so, because there is nothing to send.
 */
function assistantOutcome(aiService, text) {
  const path = aiService.lastPath || 'assistant';
  const failed = aiService.lastFailed === true || text === null || text === undefined;

  return {
    text: failed && !text ? null : text,
    source: 'assistant',
    path,
    // An apology cites nothing, whatever was retrieved before it failed.
    sources: !failed && Array.isArray(aiService.lastSources) ? aiService.lastSources : [],
    failed,
    unanswered: !failed && aiService.lastUnanswered === true,
    // Canned and fallback lines are fixed text, and a failure produced none.
    metered: !failed && path === 'assistant'
  };
}

/**
 * Run whichever of the tenant's live workflows should answer this message.
 *
 * In order:
 *   1. a workflow this conversation is part-way through - it asked a question
 *      and this is the answer - carries on, whatever the message says;
 *   2. otherwise the first live workflow whose trigger matches: keywords
 *      first (free), then intent (one classifier call for all of them), then
 *      the one that answers everything, if there is one;
 *   3. otherwise nothing, and the assistant answers.
 *
 * A workflow that finished last turn does not hold the conversation: the next
 * message is matched afresh, so a visitor who had their order looked up can
 * go on to ask about opening hours and get the assistant.
 *
 * @returns {Promise<object|null>} null when no workflow answers, or when it
 *          could not produce an answer — in both cases the assistant takes over.
 */
async function tryWorkflow({ conversation, companyId, message, history, simulate = false, testContact = null }) {
  const previous = conversation.workflowState || {};

  try {
    const runtime = runtimeRegistry.getRuntimeService();
    const live = await liveWorkflows(runtime, companyId);

    if (live.length === 0) {
      return null;
    }

    const chosen = await chooseWorkflow(live, previous, message, { companyId, sessionId: conversation.sessionId });
    if (!chosen) {
      return null;
    }

    // State carries on only within the same release of the same workflow. A
    // conversation that stopped at a question in one release must not resume
    // against the node ids of another: the node may be gone, or - worse - be
    // a different question with the same id.
    const state = sameWorkflow(previous, chosen) ? previous : {};

    const result = await runtime.executeWorkflow(companyId, message, history, {
      workflowId: chosen.id,
      sessionId: conversation.sessionId,
      conversationId: conversation._id,
      // Who we are talking to, so a flow can refuse to discuss an account with
      // somebody whose identity was merely typed into a form. Read here rather
      // than inside a node, because every node needs the same answer and it
      // must not be something the browser can assert.
      variables: testContact ? standInVariables(testContact) : await contactVariables(conversation),
      // Where the last turn stopped. This is what makes a question possible.
      state,
      // The editor preview's mode: GETs happen, tasks, tags, emails, POSTs
      // and handoffs are declined and reported as "would have".
      ...(simulate ? { simulate: true } : {})
    });

    if (result && result.success === false) {
      // The flow reported that a step it could not do without failed. Treated
      // exactly like a thrown error below.
      const error = new Error(result.error || 'A workflow step failed');
      error.reported = true;
      throw error;
    }

    if (!result || !result.response) {
      return null;
    }

    // Written back so the next message resumes rather than restarting. Kept on
    // the document the caller is about to save, so this costs no extra write.
    // The workflow's identity travels with it, so the check above has
    // something to compare against next time.
    conversation.workflowState = {
      workflowId: chosen.id,
      version: chosen.version,
      awaiting: result.state?.awaiting || null,
      variables: result.state?.variables || {},
      updatedAt: new Date()
    };

    return {
      text: result.response,
      choices: result.choices || null,
      cards: result.cards || null,
      escalate: result.escalation || null,
      source: 'workflow',
      path: 'workflow',
      // The compiler does not report which chunks its knowledge node used, and
      // a citation we cannot stand behind is worse than none.
      sources: [],
      metadata: result.metadata,
      // A workflow that could not run fell back to the assistant above, so a
      // reply from here was produced. It did not know the answer when it
      // ended on its fallback step, and a model wrote it only when an AI
      // Reply step ran: a fixed reply is free.
      failed: false,
      unanswered: Boolean(result.metadata && result.metadata.fellBack),
      metered: Boolean(result.metadata && result.metadata.llmUsed)
    };
  } catch (error) {
    if (error.code === 'NO_ACTIVE_WORKFLOW') {
      // The common case for most tenants, and not worth logging as a problem.
      return null;
    }

    // A broken workflow must not take the conversation with it: the visitor
    // gets an assistant answer, and the tenant gets a log entry to act on.
    //
    // The saved state goes too. If the failure was in resuming a question,
    // keeping the state would fail the same way on every later message, and
    // the visitor would be stuck for good.
    logger.error('Published workflow failed; falling back to the assistant', {
      companyId,
      error: error.message
    });
    clearState(conversation);
    return null;
  }
}

/**
 * The tenant's live workflows as runtime entries.
 *
 * A runtime that predates several live workflows (or a test double of one)
 * offers only `ensureWorkflowLoaded`; its one workflow is treated as live and
 * answering everything, which is what it was.
 */
async function liveWorkflows(runtime, companyId) {
  if (typeof runtime.ensureWorkflowsLoaded === 'function') {
    return (await runtime.ensureWorkflowsLoaded(companyId)) || [];
  }
  if (typeof runtime.ensureWorkflowLoaded === 'function') {
    const only = await runtime.ensureWorkflowLoaded(companyId);
    return only ? [only] : [];
  }
  // Nothing to ask which workflow is live: let the runtime run its own.
  return [{ id: null, version: undefined, trigger: { type: 'always' } }];
}

/**
 * Which live workflow answers this message, if any.
 */
async function chooseWorkflow(live, previous, message, { companyId, sessionId } = {}) {
  if (previous && previous.awaiting) {
    if (!previous.workflowId) {
      // Saved before workflows were identified on the state, when only one
      // could be live: that one carries on, so a deploy of this does not
      // restart everybody who was mid-question.
      const primary = live.find(entry => triggerOf(entry).type === 'always') || (live.length === 1 ? live[0] : null);
      if (primary) {
        return primary;
      }
    } else {
      const same = live.find(entry => entry.id !== null && String(entry.id) === String(previous.workflowId));
      if (same && sameWorkflow(previous, same)) {
        return same;
      }
      logger.info('Workflow was republished or unpublished mid-conversation; matching the message afresh', {
        companyId, sessionId
      });
    }
  }

  // Keywords: free, so tried first, and literal, so they win when they hit.
  const byKeyword = live.find(entry => {
    const trigger = triggerOf(entry);
    return trigger.type === 'keywords' && matchesKeywords(message, trigger.keywords);
  });
  if (byKeyword) {
    return byKeyword;
  }

  // Intent: one classifier call with every description at once.
  const intents = live.filter(entry => triggerOf(entry).type === 'intent' && triggerOf(entry).description);
  if (intents.length > 0) {
    try {
      const { getIntentClassifier } = require('./intent-classifier');
      const pick = await getIntentClassifier().pickWorkflow(
        message,
        intents.map(entry => triggerOf(entry).description)
      );
      if (pick && Number.isInteger(pick.index) && intents[pick.index]) {
        return intents[pick.index];
      }
    } catch (error) {
      // The classifier never throws by design; if it somehow did, the visitor
      // still gets the catch-all workflow or the assistant.
      logger.warn('Choosing a workflow by intent failed', { companyId, error: error.message });
    }
  }

  return live.find(entry => triggerOf(entry).type === 'always') || null;
}

/** An entry's trigger, where none means "always" (a workflow from before triggers). */
function triggerOf(entry) {
  const trigger = entry && entry.trigger;
  return trigger && trigger.type ? trigger : { type: 'always', keywords: [], description: '' };
}

/**
 * Whether a message contains any of the keywords, as whole words and
 * ignoring case: "refund" matches "Refund please" but not "refunded" - a
 * keyword is the word the author typed, not a stem of it. A keyword of
 * several words matches as a phrase.
 */
function matchesKeywords(message, keywords = []) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  return keywords.some(keyword => {
    const words = String(keyword || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return words.length > 0 && text.includes(` ${words} `);
  });
}

/**
 * Whether saved state belongs to the workflow now being served.
 *
 * State saved before workflow identity was recorded (no `workflowId`) is
 * trusted, so a deploy of this change does not restart every conversation
 * that happened to be mid-question.
 */
function sameWorkflow(state, active) {
  if (!state || !state.workflowId) {
    return true;
  }

  if (active.id === null || String(state.workflowId) !== String(active.id)) {
    return false;
  }

  return state.version === undefined || state.version === null ||
    state.version === active.version;
}

/**
 * Facts about the person, for a workflow to branch on.
 *
 * `contact_verified` is the important one: it is true only when the tenant's
 * own backend signed this person's id, never because a visitor typed an email
 * address. A template that reads account details gates on it.
 */
async function contactVariables(conversation) {
  if (!conversation.contact) {
    return { contact_verified: 'false' };
  }

  try {
    const Contact = require('../models/contact');
    const contact = await Contact.findById(conversation.contact)
      .select('name email externalId identityLevel')
      .lean();

    if (!contact) {
      return { contact_verified: 'false' };
    }

    return {
      contact_verified: contact.identityLevel === 'verified' ? 'true' : 'false',
      contact_name: contact.name || '',
      contact_email: contact.email || '',
      // Only exposed for a verified contact: an unverified externalId is not
      // something the tenant vouched for, so a flow must not look an account
      // up with it.
      contact_external_id: contact.identityLevel === 'verified' ? (contact.externalId || '') : ''
    };
  } catch {
    // Failing closed: unknown identity is treated as unverified.
    return { contact_verified: 'false' };
  }
}

/**
 * The same facts for a stand-in contact in a dry run, so an admin can try a
 * flow that gates on `contact_verified` without a real customer to sign in as.
 */
function standInVariables(contact) {
  const verified = contact.identityLevel === 'verified';
  return {
    contact_verified: verified ? 'true' : 'false',
    contact_name: contact.name || '',
    contact_email: contact.email || '',
    contact_external_id: verified ? (contact.externalId || '') : ''
  };
}

/**
 * Forget where a workflow got to.
 *
 * Called when a conversation ends or an operator takes over — otherwise a
 * visitor returning days later would be answered as though they were still
 * halfway through answering a question.
 */
function clearState(conversation) {
  if (conversation && conversation.workflowState) {
    conversation.workflowState = { awaiting: null, variables: {}, updatedAt: new Date() };
  }
}

module.exports = { generate, clearState, chooseWorkflow, matchesKeywords };
