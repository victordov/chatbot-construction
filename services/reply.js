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
 * The order is: a published workflow if the tenant has one, otherwise the
 * assistant. A workflow that fails falls back to the assistant rather than
 * leaving the visitor with silence.
 */

const runtimeRegistry = require('./runtime-registry');
const AIService = require('./ai');
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
 * @returns {Promise<{text: string, choices?: Array, escalate?: object,
 *                    source: 'workflow'|'assistant'}>}
 */
async function generate({ conversation, message, history = [] }) {
  const companyId = conversation.company ? String(conversation.company) : null;

  if (companyId) {
    const fromWorkflow = await tryWorkflow({ conversation, companyId, message, history });
    if (fromWorkflow) {
      return fromWorkflow;
    }
  }

  const aiService = await AIService.forCompany(companyId);
  const text = await aiService.generateResponse(message, history);

  return { text, source: 'assistant' };
}

/**
 * Run the tenant's published workflow, if they have one.
 *
 * @returns {Promise<object|null>} null when there is no workflow, or when it
 *          could not produce an answer — in both cases the assistant takes over.
 */
async function tryWorkflow({ conversation, companyId, message, history }) {
  try {
    const runtime = runtimeRegistry.getRuntimeService();

    const result = await runtime.executeWorkflow(companyId, message, history, {
      sessionId: conversation.sessionId,
      conversationId: conversation._id,
      // Who we are talking to, so a flow can refuse to discuss an account with
      // somebody whose identity was merely typed into a form. Read here rather
      // than inside a node, because every node needs the same answer and it
      // must not be something the browser can assert.
      variables: await contactVariables(conversation),
      // Where the last turn stopped. This is what makes a question possible.
      state: conversation.workflowState || {}
    });

    if (!result || !result.response) {
      return null;
    }

    // Written back so the next message resumes rather than restarting. Kept on
    // the document the caller is about to save, so this costs no extra write.
    conversation.workflowState = {
      workflowId: conversation.workflowState?.workflowId,
      awaiting: result.state?.awaiting || null,
      variables: result.state?.variables || {},
      updatedAt: new Date()
    };

    return {
      text: result.response,
      choices: result.choices || null,
      escalate: result.escalation || null,
      source: 'workflow',
      metadata: result.metadata
    };
  } catch (error) {
    if (error.code === 'NO_ACTIVE_WORKFLOW') {
      // The common case for most tenants, and not worth logging as a problem.
      return null;
    }

    // A broken workflow must not take the conversation with it: the visitor
    // gets an assistant answer, and the tenant gets a log entry to act on.
    logger.error('Published workflow failed; falling back to the assistant', {
      companyId,
      error: error.message
    });
    return null;
  }
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

module.exports = { generate, clearState };
