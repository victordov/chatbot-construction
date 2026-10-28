/**
 * The reply result contract: what services/reply.js#generate tells its
 * callers besides the text.
 *
 *   failed      the model could not answer; the caller hands over instead of
 *               showing an error
 *   unanswered  there was an answer and it was "I don't know"
 *   metered     a model wrote the visible text (assistant, AI Reply step);
 *               canned replies, fixed workflow replies and failures are free
 *
 * The AI service's flags (lastFailed, lastUnanswered) are read defensively,
 * and a stand-in "verified customer" is only ever honoured in a dry run.
 */

const mongoose = require('mongoose');

const AIService = require('../services/ai');
const assistantTools = require('../services/assistant-tools');
const runtimeRegistry = require('../services/runtime-registry');
const reply = require('../services/reply');

const companyId = new mongoose.Types.ObjectId();
const conversation = () => ({ company: companyId, sessionId: 'reply-result', _id: null, contact: null, workflowState: {} });

/** An AI service that answers once, with the given flags. */
function assistantSays({ text = 'An answer.', path = 'assistant', sources = [], flags = {} } = {}) {
  return jest.spyOn(AIService, 'forCompany').mockImplementation(async () => ({
    openai: null,
    async generateResponse() {
      this.lastPath = path;
      this.lastSources = sources;
      Object.assign(this, flags);
      return text;
    }
  }));
}

/** A runtime with one live workflow that answers with `result`. */
function workflowSays(result) {
  const runtime = {
    ensureWorkflowLoaded: jest.fn().mockResolvedValue({ id: 'wf-1', version: 3 }),
    executeWorkflow: jest.fn().mockResolvedValue(result)
  };
  jest.spyOn(runtimeRegistry, 'getRuntimeService').mockReturnValue(runtime);
  return runtime;
}

/** No live workflow, so the assistant answers. */
function noWorkflow() {
  const error = new Error('none');
  error.code = 'NO_ACTIVE_WORKFLOW';
  jest.spyOn(runtimeRegistry, 'getRuntimeService').mockReturnValue({
    ensureWorkflowLoaded: jest.fn().mockResolvedValue(null),
    executeWorkflow: jest.fn().mockRejectedValue(error)
  });
}

describe('reply result', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('from the assistant', () => {
    beforeEach(noWorkflow);

    test('an answer from knowledge is metered and cites its sources', async () => {
      assistantSays({ text: 'Kettles are £25.', sources: [{ title: 'Pricing', url: null }] });

      const result = await reply.generate({ conversation: conversation(), message: 'kettles?' });

      expect(result).toMatchObject({
        text: 'Kettles are £25.', source: 'assistant', path: 'assistant',
        sources: [{ title: 'Pricing', url: null }],
        failed: false, unanswered: false, metered: true
      });
    });

    test('"I don\'t know" is unanswered, and still metered: a model wrote it', async () => {
      assistantSays({ text: 'I do not have that information.', flags: { lastUnanswered: true } });

      const result = await reply.generate({ conversation: conversation(), message: 'Ireland?' });

      expect(result).toMatchObject({ failed: false, unanswered: true, metered: true });
    });

    test('a failure has no text and no sources, and is not metered', async () => {
      assistantSays({ text: null, sources: [{ title: 'Retrieved before it failed' }], flags: { lastFailed: true } });

      const result = await reply.generate({ conversation: conversation(), message: 'hours?' });

      expect(result).toMatchObject({ text: null, failed: true, unanswered: false, metered: false, sources: [] });
    });

    test('no text is a failure even without the flag', async () => {
      assistantSays({ text: null });

      expect(await reply.generate({ conversation: conversation(), message: 'hours?' }))
        .toMatchObject({ failed: true, metered: false });
    });

    test('canned replies and fallback lines are free', async () => {
      assistantSays({ text: 'Refunds take five days.', path: 'canned' });
      expect(await reply.generate({ conversation: conversation(), message: 'refund' }))
        .toMatchObject({ path: 'canned', failed: false, metered: false });

      jest.restoreAllMocks();
      noWorkflow();
      assistantSays({ text: 'That is outside what I can help with here.', path: 'fallback' });
      expect(await reply.generate({ conversation: conversation(), message: 'weather?' }))
        .toMatchObject({ path: 'fallback', failed: false, metered: false });
    });
  });

  describe('from a workflow', () => {
    test('an AI Reply step is metered; a fixed reply is not', async () => {
      workflowSays({ response: 'Written by a model.', state: {}, metadata: { llmUsed: true } });
      expect(await reply.generate({ conversation: conversation(), message: 'hi' }))
        .toMatchObject({ source: 'workflow', failed: false, unanswered: false, metered: true });

      jest.restoreAllMocks();
      workflowSays({ response: 'Thanks for getting in touch!', state: {}, metadata: { llmUsed: false } });
      expect(await reply.generate({ conversation: conversation(), message: 'hi' }))
        .toMatchObject({ source: 'workflow', metered: false });
    });

    test('ending on the fallback step is unanswered', async () => {
      workflowSays({ response: 'Sorry, I did not catch that.', state: {}, metadata: { fellBack: true } });

      expect(await reply.generate({ conversation: conversation(), message: '???' }))
        .toMatchObject({ unanswered: true, metered: false });
    });
  });

  describe('a stand-in verified customer', () => {
    const standIn = { identityLevel: 'verified', name: 'Test Customer', email: 't@example.com', externalId: 'cus_42' };

    test('reaches a workflow in a dry run', async () => {
      const runtime = workflowSays({ response: 'Your order shipped.', state: {} });

      await reply.generate({ conversation: conversation(), message: 'order?', simulate: true, testContact: standIn });

      expect(runtime.executeWorkflow.mock.calls[0][3].variables).toEqual({
        contact_verified: 'true', contact_name: 'Test Customer', contact_email: 't@example.com', contact_external_id: 'cus_42'
      });
    });

    test('is ignored on a live conversation', async () => {
      const runtime = workflowSays({ response: 'Who are you?', state: {} });

      await reply.generate({ conversation: conversation(), message: 'order?', testContact: standIn });

      expect(runtime.executeWorkflow.mock.calls[0][3].variables).toEqual({ contact_verified: 'false' });
    });

    test('is offered to the assistant\'s tools only in a dry run', async () => {
      noWorkflow();
      assistantSays();
      const prepare = jest.spyOn(assistantTools, 'prepare').mockResolvedValue(null);

      await reply.generate({ conversation: conversation(), message: 'order?', simulate: true, testContact: standIn });
      expect(prepare.mock.calls[0][0].contact).toEqual(standIn);

      await reply.generate({ conversation: conversation(), message: 'order?', testContact: standIn });
      expect(prepare.mock.calls[1][0].contact).toBeUndefined();
    });
  });
});
