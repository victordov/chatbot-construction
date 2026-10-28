/**
 * "Teach the bot": turn a question it got wrong into one it gets right.
 *
 * The answer is saved one of two ways, and the admin chooses, because they do
 * different jobs:
 *
 *   knowledge  a note in the knowledge base, titled from the question. The
 *              assistant reads it and answers in its own words, so it also
 *              covers the same question asked differently.
 *   canned     a canned reply whose example question is the visitor's own. It
 *              is sent word for word, with no model involved - right for
 *              wording that must not drift (a policy, a price, a legal line).
 *
 * Then the conversation's message is marked as corrected, so the inbox can
 * show it was dealt with and the unanswered-questions list drops it, and the
 * saved tests are run again: a fix that breaks another answer should be found
 * out now, by the person who made it.
 */

const Conversation = require('../models/conversation');
const ResponseTemplate = require('../models/response-template');
const TestCase = require('../models/test-case');
const knowledgeText = require('./knowledge-text');
const { getResponseTemplateService } = require('./responseTemplates');
const gaps = require('./gaps');
const testCases = require('./test-cases');
const { logger } = require('./logging');

const MAX_QUESTION = 500;
const MAX_ANSWER = 5000;

/** A short name for what was taught: the question, trimmed to fit a list. */
function titleFrom(question) {
  const flat = String(question || '').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * Check a teach request, and say what is wrong in words the dialog can show.
 *
 * @returns {string|null} the problem, or null when it is fine
 */
function problemWith({ question, answer, kind }) {
  if (!String(question || '').trim()) {
    return 'Say what the visitor asked';
  }
  if (!String(answer || '').trim()) {
    return 'Write the answer the bot should give';
  }
  if (String(question).length > MAX_QUESTION) {
    return `The question must be ${MAX_QUESTION} characters or fewer`;
  }
  if (String(answer).length > MAX_ANSWER) {
    return `The answer must be ${MAX_ANSWER} characters or fewer`;
  }
  if (kind !== 'knowledge' && kind !== 'canned') {
    return 'Choose whether to save it as knowledge or as a canned reply';
  }
  return null;
}

/**
 * Mark the message that was wrong as corrected.
 *
 * `messageId` is whichever id the caller has: the message's own `_id` (what
 * the inbox and the unanswered-questions list hold) or its client-side
 * `messageId`. Scoped to the company, so an id from another tenant's
 * conversation matches nothing.
 *
 * @returns {Promise<boolean>} whether a message was found and marked
 */
async function markCorrected({ companyId, sessionId, messageId, kind, refId, by }) {
  if (!sessionId || !messageId) {
    return false;
  }

  const conversation = await Conversation.findOne({ company: companyId, sessionId: String(sessionId) })
    .select('messages._id messages.messageId messages.sender')
    .lean();
  if (!conversation) {
    return false;
  }

  const messages = conversation.messages || [];
  const index = messages.findIndex(message =>
    String(message._id) === String(messageId) || (message.messageId && message.messageId === String(messageId)));
  if (index === -1) {
    return false;
  }

  // Teaching from an operator's reply ("Save as the bot's answer") fixes the
  // bot's own attempt at the same question too: the bot messages between the
  // visitor's question and the reply. Otherwise the unanswered-questions list
  // keeps showing a question somebody has already answered.
  const ids = [messages[index]._id];
  if (messages[index].sender !== 'bot') {
    for (let i = index - 1; i >= 0 && messages[i].sender !== 'user'; i -= 1) {
      if (messages[i].sender === 'bot') {
        ids.push(messages[i]._id);
      }
    }
  }

  const result = await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { 'messages.$[fixed].correction': { kind, refId: String(refId), at: new Date(), by: by || undefined } } },
    { arrayFilters: [{ 'fixed._id': { $in: ids } }] }
  );

  return result.modifiedCount > 0;
}

/**
 * Save what the bot should have said.
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {object} options.user the signed-in admin (`id`, `role`)
 * @param {string} options.question what the visitor asked
 * @param {string} options.answer what the bot should say
 * @param {'knowledge'|'canned'} options.kind
 * @param {string} [options.title] defaults to the question
 * @param {string} [options.sessionId] the conversation it came from
 * @param {string} [options.messageId] the bot message being corrected
 * @param {string} [options.gapKey] the unanswered-questions group it answers,
 *        which is then cleared from the list
 * @returns {Promise<{ok: true, kind, refId, title, corrected: boolean,
 *                    tests?: {passed: number, failed: number, total: number,
 *                    failures: Array<{id, question, reason}>}}>}
 * @throws {Error} with `status` 400 for a bad request, 402 at the plan's
 *         knowledge limit
 */
async function teach(options) {
  const { companyId, user = {}, sessionId, messageId, gapKey } = options;
  const question = String(options.question || '').trim();
  const answer = String(options.answer || '').trim();
  const kind = options.kind;

  const problem = problemWith({ question, answer, kind });
  if (problem) {
    const error = new Error(problem);
    error.status = 400;
    throw error;
  }

  const title = String(options.title || '').trim().slice(0, 200) || titleFrom(question);
  let refId;

  if (kind === 'knowledge') {
    // Question and answer together, so the note is found by the question
    // being asked again, in other words, and read as an answer to it.
    const stored = await knowledgeText.storeText({
      companyId,
      title,
      text: `Question: ${question}\nAnswer: ${answer}`,
      metadata: { taught: 'true', ...(sessionId ? { taughtFrom: String(sessionId) } : {}) },
      // A superadmin acting for a tenant is not subject to its plan.
      enforceQuota: user.role !== 'superadmin'
    });
    refId = stored.sourceId;
  } else {
    const template = await ResponseTemplate.create({
      company: companyId,
      name: title,
      triggers: [question],
      responses: [answer],
      createdBy: user.id || undefined
    });
    // The shared service caches a company's templates for a minute; the
    // admin expects the next visitor to get this one.
    getResponseTemplateService().invalidate(companyId);
    refId = String(template._id);
  }

  // The group is cleared before the message is marked: marking it removes
  // that example from the group, which can change the words the group is
  // recognised by and so its key.
  if (gapKey) {
    await gaps.dismiss(companyId, String(gapKey), {
      by: user.id || null, reason: 'taught', question
    }).catch(error => logger.warn('Could not clear the taught question from the list', { error: error.message }));
  }

  const corrected = await markCorrected({
    companyId, sessionId, messageId, kind, refId, by: user.id
  }).catch(error => {
    logger.warn('Could not mark the corrected message', { error: error.message });
    return false;
  });

  const result = { ok: true, kind, refId, title, corrected };

  if (await TestCase.exists({ company: companyId })) {
    const run = await testCases.runAll(companyId);
    result.tests = {
      passed: run.passed,
      failed: run.failed,
      total: run.total,
      failures: run.results
        .filter(entry => !entry.passed)
        .map(entry => ({ id: entry.id, question: entry.question, reason: entry.reason }))
    };
  }

  return result;
}

module.exports = {
  teach,
  markCorrected,
  titleFrom,
  problemWith
};
