/**
 * Saved test questions: run them, and say whether each still passes.
 *
 * A run goes through exactly the path "Test your bot" does - the live
 * workflow, canned replies, knowledge and read-only actions, in simulate mode
 * - so a test passing means a visitor asking the same thing gets the same
 * kind of answer. Nothing is saved but the verdict: no conversation, no usage,
 * no canned-reply use counted, no write to the tenant's systems.
 */

const TestCase = require('../models/test-case');
const { logger } = require('./logging');

/** Tests run at once. Each is a model call, so not all fifty in parallel. */
const CONCURRENCY = 4;

function normalise(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether an answer meets a test's expectation.
 *
 * @param {object} test a TestCase (or its plain shape)
 * @param {object} result what services/reply.js#generate returned
 * @returns {{passed: boolean, reason: string}} the reason is shown beside the
 *          verdict, so it says what was looked for and what happened
 */
function evaluate(test, result) {
  const expect = test.expect || {};
  const value = String(expect.value || '').trim();
  const answer = String((result && result.text) || '');

  switch (expect.type) {
  case 'contains': {
    if (!value) {
      return { passed: false, reason: 'The test does not say what the answer should mention' };
    }
    const passed = normalise(answer).includes(normalise(value));
    return { passed, reason: passed ? `Mentions "${value}"` : `Does not mention "${value}"` };
  }

  case 'handover': {
    // A handover is the bot passing the conversation on, or being unable to
    // answer - in which case the visitor is offered a person. Both are what
    // a test like "I want to cancel my contract" is asking for.
    const handsOver = Boolean(result && result.escalate && result.escalate.enabled !== false);
    const offers = Boolean(result && (result.failed || result.unanswered));
    if (handsOver) {
      return { passed: true, reason: 'Hands over to a person' };
    }
    if (offers) {
      return { passed: true, reason: 'Could not answer, so a person is offered' };
    }
    return { passed: false, reason: 'Answered by itself instead of handing over' };
  }

  case 'cites': {
    const sources = (result && Array.isArray(result.sources)) ? result.sources : [];
    if (!value) {
      return sources.length
        ? { passed: true, reason: `Drew on ${sources[0].title || sources[0].url || 'your knowledge'}` }
        : { passed: false, reason: 'Nothing from your knowledge was used' };
    }
    const wanted = normalise(value);
    const hit = sources.find(source =>
      normalise(source.title).includes(wanted) || normalise(source.url).includes(wanted));
    if (hit) {
      return { passed: true, reason: `Drew on ${hit.title || hit.url}` };
    }
    return {
      passed: false,
      reason: sources.length
        ? `Drew on ${sources.map(source => source.title || source.url).join(', ')} instead of "${value}"`
        : `Did not draw on "${value}" or anything else in your knowledge`
    };
  }

  default:
    return { passed: false, reason: 'Unknown kind of test' };
  }
}

/**
 * Run one test and record the verdict on it.
 *
 * @returns {Promise<{id, question, expect, passed, answer, path, reason, at}>}
 */
async function runOne(test, companyId) {
  // Required here rather than at the top: reply pulls in the AI service and
  // the workflow runtime, which a model file loading this module never needs.
  const reply = require('./reply');

  // Shaped like a conversation, as in "Test your bot", and never saved.
  const conversation = { company: companyId, sessionId: null, _id: null, contact: null, workflowState: {} };

  let result;
  try {
    result = await reply.generate({ conversation, message: test.question, history: [], simulate: true });
  } catch (error) {
    logger.error('A saved test could not run', { companyId: String(companyId), error: error.message });
    result = { text: null, failed: true, path: 'fallback', sources: [] };
  }

  const verdict = evaluate(test, result);
  const lastRun = {
    passed: verdict.passed,
    answer: String(result.text || '').slice(0, 2000),
    path: result.path || result.source || 'assistant',
    reason: verdict.reason,
    at: new Date()
  };

  await TestCase.updateOne({ _id: test._id }, { $set: { lastRun } }).catch(error =>
    logger.warn('Could not record a test result', { error: error.message }));

  return {
    id: String(test._id),
    question: test.question,
    expect: test.expect,
    ...lastRun
  };
}

/**
 * Run a company's tests - all of them, or the ones named.
 *
 * @param {string} companyId
 * @param {object} [options]
 * @param {string[]} [options.ids] only these
 * @returns {Promise<{total: number, passed: number, failed: number, results: Array}>}
 */
async function runAll(companyId, { ids } = {}) {
  const filter = { company: companyId };
  if (Array.isArray(ids) && ids.length) {
    filter._id = { $in: ids };
  }

  const tests = await TestCase.find(filter).sort({ createdAt: 1 }).limit(TestCase.LIMIT).lean();
  const results = new Array(tests.length);
  let next = 0;

  const worker = async () => {
    while (next < tests.length) {
      const index = next;
      next += 1;
      results[index] = await runOne(tests[index], companyId);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tests.length) }, worker));

  const passed = results.filter(result => result.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

module.exports = {
  evaluate,
  runOne,
  runAll,
  CONCURRENCY
};
