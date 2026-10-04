/**
 * An LLM node inside a workflow answers from the tenant's knowledge.
 *
 * `runLlmNode` built a system prompt containing the safety preamble, the
 * tenant's persona and the retrieved knowledge - and then sent
 * `step.data.systemPrompt || systemPrompt` instead. Because the compiler writes
 * `data.systemPrompt` onto every LLM node, the left branch always won and the
 * knowledge was silently discarded. An author who wired Knowledge into an LLM
 * node got an ungrounded answer with nothing to indicate why.
 */

const WorkflowCompilerService = require('../services/workflow-compiler');

function compilerWithFakeModel() {
  const compiler = new WorkflowCompilerService();
  const calls = [];

  compiler.openai = {
    chat: {
      completions: {
        create: async request => {
          calls.push(request);
          return { choices: [{ message: { content: 'an answer' } }] };
        }
      }
    }
  };

  return { compiler, calls };
}

/** The system message the model was actually sent. */
function systemMessage(calls) {
  return calls[calls.length - 1].messages.find(message => message.role === 'system').content;
}

describe('an LLM node in a workflow', () => {
  const knowledge = 'Refunds are issued within five working days.';

  it('is given the retrieved knowledge', async () => {
    const { compiler, calls } = compilerWithFakeModel();

    await compiler.runLlmNode(
      { data: { systemPrompt: 'Compiled preamble.', userPrompt: 'Answer the question.' } },
      'when will I get my refund?',
      [],
      knowledge,
      {}
    );

    expect(systemMessage(calls)).toContain('Relevant Knowledge:');
    expect(systemMessage(calls)).toContain(knowledge);
  });

  it('still carries the safety preamble and persona', async () => {
    const { compiler, calls } = compilerWithFakeModel();

    await compiler.runLlmNode(
      { data: { systemPrompt: 'ignored', userPrompt: 'Answer.' } },
      'hello',
      [],
      knowledge,
      {},
      {
        rootSystem: 'SAFETY RULES HERE',
        persona: { compiled: { systemPrompt: 'You are Acme Support.' } }
      }
    );

    const prompt = systemMessage(calls);
    expect(prompt).toContain('SAFETY RULES HERE');
    expect(prompt).toContain('You are Acme Support.');
    expect(prompt).toContain(knowledge);

    // The compiled per-node prompt must not be able to displace the hierarchy.
    expect(prompt).not.toBe('ignored');
  });

  it('says nothing about knowledge when a node retrieved none', async () => {
    const { compiler, calls } = compilerWithFakeModel();

    await compiler.runLlmNode(
      { data: { systemPrompt: 'Compiled preamble.', userPrompt: 'Answer.' } },
      'hello',
      [],
      '',
      {}
    );

    expect(systemMessage(calls)).not.toContain('Relevant Knowledge:');
  });
});
