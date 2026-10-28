/**
 * The workflow editor's wiring rules and the compiler fixes behind them: one
 * connection per output, problems named by label and pinned by id, results
 * offered as buttons that wait for the tap, moderation strictness that means
 * something, a persona that defers to the Persona screen, and failures that
 * are reported rather than passed off as success.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const WorkflowCompilerService = require('../services/workflow-compiler');
const connector = require('../services/connector');
const assistantConfig = require('../services/assistant-config');

/** The editor's graph module, an ES module, loaded the way the build reads it. */
function loadGraphModule() {
  const source = fs.readFileSync(path.join(__dirname, '../client/workflow-editor/graph.js'), 'utf8');
  const { code } = esbuild.transformSync(source, { format: 'cjs', loader: 'js' });
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

const persona = (data = {}) => ({ id: 'p1', type: 'persona', data: { type: 'persona', prompt: 'You are the test bot.', ...data } });
const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });

/** A compiled chain by hand, the shape the executor consumes. */
const chain = (steps, extra = {}) => ({
  tenantId: '64b7f0000000000000000001',
  entryPoint: Object.keys(steps)[0],
  prompts: { moderation: { enabled: false } },
  knowledge: { sources: [] },
  routing: { conditions: [], fallback: null },
  steps,
  ...extra
});

describe('workflow editor wiring (WS3)', () => {
  const { connectEdge, wouldCycle, describeTrigger } = loadGraphModule();

  test('each output keeps its own connection', () => {
    let edges = [];
    ({ edges } = connectEdge(edges, { source: 'a1', target: 'ok', sourceHandle: 'success', id: 'e1' }));
    ({ edges } = connectEdge(edges, { source: 'a1', target: 'fail', sourceHandle: 'error', id: 'e2' }));

    // Wiring Failed used to delete Worked.
    expect(edges.map(edge => `${edge.sourceHandle}->${edge.target}`)).toEqual(['success->ok', 'error->fail']);

    // Reconnecting an output moves that one connection only.
    ({ edges } = connectEdge(edges, { source: 'a1', target: 'other', sourceHandle: 'success', id: 'e3' }));
    expect(edges.map(edge => `${edge.sourceHandle}->${edge.target}`)).toEqual(['error->fail', 'success->other']);

    // A single-output step has one connection.
    ({ edges } = connectEdge(edges, { source: 'r1', target: 'x', id: 'e4' }));
    ({ edges } = connectEdge(edges, { source: 'r1', target: 'y', id: 'e5' }));
    expect(edges.filter(edge => edge.source === 'r1').map(edge => edge.target)).toEqual(['y']);

    // The same connection twice changes nothing.
    expect(connectEdge(edges, { source: 'r1', target: 'y', id: 'e6' }).changed).toBe(false);
  });

  test('a connection back up the flow is a loop', () => {
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    expect(wouldCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCycle(edges, 'a', 'c')).toBe(false);
  });

  test('a trigger reads as a sentence', () => {
    expect(describeTrigger({ type: 'intent', description: 'where is my order' })).toBe('Runs when the visitor wants: where is my order');
    expect(describeTrigger({ type: 'keywords', keywords: ['refund'] })).toBe('Runs when a message mentions "refund"');
    expect(describeTrigger(undefined)).toBe('Answers every message');
  });

  test('the editor no longer drops a branching step\'s other outputs, nor puts ids into HTML unescaped', () => {
    const editor = fs.readFileSync(path.join(__dirname, '../client/workflow-editor/editor.js'), 'utf8');
    expect(editor).toMatch(/connectEdge\(this\.edges/);
    expect(editor).not.toMatch(/data-node-id="\$\{node\.id\}"/);
    expect(editor).not.toMatch(/data-edge-id="\$\{edge\.id\}"/);
    expect(editor).not.toMatch(/querySelector\(`\[data-node-id="\$\{node\.id\}"\]`\)/);
  });
});

describe('validation (WS3)', () => {
  const compiler = new WorkflowCompilerService();

  test('a branching step may have one connection per output, not two on one', () => {
    const nodes = [persona(), node('s1', 'start'), node('c1', 'condition', { label: 'Has it shipped?', left: '{{x}}', right: 'y' }),
      node('yes', 'response', { template: 'Yes' }), node('no', 'response', { template: 'No' })];

    const fine = compiler.validateWorkflow(nodes, [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'c1', target: 'no', sourceHandle: 'false' }
    ]);
    expect(fine.errors).toEqual([]);

    const doubled = compiler.validateWorkflow(nodes, [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'c1', target: 'no', sourceHandle: 'true' }
    ]);
    const problem = doubled.problems.find(p => /same output/.test(p.message));
    expect(problem).toMatchObject({ nodeId: 'c1', level: 'error' });
    expect(problem.message).toContain('"Has it shipped?"');
  });

  test('problems name the step by label, never by internal id', () => {
    const result = compiler.validateWorkflow(
      [persona(), node('s1', 'start'), node('llm_lq3k9_x81bz2', 'llm', { prompt: 'Answer' }), node('tag_zz9', 'tag', { tags: ['a'] })],
      [{ id: 'e1', source: 's1', target: 'llm_lq3k9_x81bz2' }]
    );
    const orphan = result.problems.find(p => /not connected/.test(p.message));
    expect(orphan).toMatchObject({ nodeId: 'tag_zz9' });
    expect(orphan.message).toBe('"Add a Tag" is not connected to anything');
    expect(result.errors.join(' ')).not.toMatch(/tag_zz9|llm_lq3k9/);
  });

  test('a flow that writes its own answers without a Knowledge step is warned about, not refused', () => {
    const bare = compiler.validateWorkflow(
      [persona(), node('s1', 'start'), node('l1', 'llm', { prompt: 'Answer' })],
      [{ id: 'e1', source: 's1', target: 'l1' }]
    );
    expect(bare.valid).toBe(true);
    expect(bare.problems).toEqual([expect.objectContaining({ level: 'warning', nodeId: 'l1', message: expect.stringMatching(/no Knowledge step/) })]);

    const grounded = compiler.validateWorkflow(
      [persona(), node('s1', 'start'), node('k1', 'knowledge', { sourceType: 'vector_store' }), node('l1', 'llm', { prompt: 'Answer' })],
      [{ id: 'e1', source: 's1', target: 'k1' }, { id: 'e2', source: 'k1', target: 'l1' }]
    );
    expect(grounded.warnings).toEqual([]);
  });

  test('unsafe ids are structural problems', () => {
    expect(compiler.structuralProblems([node('ok-1_A', 'start')], [])).toEqual([]);
    expect(compiler.structuralProblems([node('bad"id', 'start')], [])[0].message).toMatch(/not allowed/);
    expect(compiler.structuralProblems(
      [node('b1', 'buttons', { choices: [{ id: '<x>', label: 'X' }] })], []
    )[0].message).toMatch(/output with an id/);
    expect(compiler.structuralProblems([], [{ id: 'e 1', source: 'a', target: 'b' }])[0].message).toMatch(/not allowed/);
  });
});

describe('execution (WS3)', () => {
  let compiler;

  beforeEach(() => {
    jest.restoreAllMocks();
    compiler = new WorkflowCompilerService();
  });

  test('results offered as buttons wait for the tap, then carry on down Found something', async () => {
    jest.spyOn(connector, 'call').mockResolvedValue({
      ok: true,
      value: [{ id: 'sku-1', title: 'Red bike' }, { id: 'sku-2', title: 'Blue bike' }]
    });

    const steps = {
      s1: { type: 'start', data: {}, next: [{ target: 'c1', handle: null }] },
      c1: {
        type: 'capability',
        data: { capability: 'catalog.search', input: { query: '{{user_input}}' }, offerAsChoices: 'yes', question: 'Which bike?' },
        next: [{ target: 'ok', handle: 'success' }, { target: 'none', handle: 'error' }]
      },
      ok: { type: 'response', data: { template: 'You picked {{selected_label}} ({{selected}}).' }, next: [] },
      none: { type: 'response', data: { template: 'Nothing found.' }, next: [] }
    };

    const first = await compiler.executeWorkflow(chain(steps), 'bikes', [], {});
    expect(first.response).toBe('Which bike?');
    expect(first.choices.map(choice => choice.label)).toEqual(['Red bike', 'Blue bike']);
    expect(first.state.awaiting).toMatchObject({ nodeId: 'c1', kind: 'choice', next: 'success' });
    // It stopped: nothing down either branch has spoken yet.
    expect(first.response).not.toMatch(/picked|Nothing/);

    const second = await compiler.executeWorkflow(chain(steps), 'Blue bike', [], { state: first.state });
    expect(second.response).toBe('You picked Blue bike (sku-2).');
  });

  test('moderation strictness changes what is blocked', () => {
    const mild = { flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.6 } };
    const severe = { flagged: true, categories: { 'violence/graphic': true }, category_scores: { 'violence/graphic': 0.9 } };
    const borderline = { flagged: false, categories: {}, category_scores: { hate: 0.3 } };

    expect(compiler.judgeModeration(mild, 'low').flagged).toBe(false);
    expect(compiler.judgeModeration(severe, 'low').flagged).toBe(true);
    expect(compiler.judgeModeration(mild, 'medium').flagged).toBe(true);
    expect(compiler.judgeModeration(borderline, 'medium').flagged).toBe(false);
    expect(compiler.judgeModeration(borderline, 'high').flagged).toBe(true);
    expect(compiler.compileModerationNode({ data: { strictness: 'high' } }).level).toBe('high');
  });

  test('an AI Reply step that fails is reported as a failed run, not a silent success', async () => {
    compiler.openai = { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('model down')) } } };
    const steps = {
      s1: { type: 'start', data: {}, next: [{ target: 'l1', handle: null }] },
      l1: { type: 'llm', data: { prompt: 'Answer', systemPrompt: 'root' }, next: [] }
    };

    const result = await compiler.executeWorkflow(chain(steps), 'hi', [], {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('model down');
    expect(result.metadata.failures).toEqual([{ node: 'l1', error: 'model down' }]);
  });

  test('a step that fails without stopping the reply is still reported', async () => {
    jest.spyOn(compiler, 'runNode').mockResolvedValueOnce({ failed: 'database unreachable' });
    const steps = {
      s1: { type: 'start', data: {}, next: [{ target: 't1', handle: null }] },
      t1: { type: 'tag', data: { tags: ['x'] }, next: [{ target: 'r1', handle: null }] },
      r1: { type: 'response', data: { template: 'Done' }, next: [] }
    };

    const result = await compiler.executeWorkflow(chain(steps), 'hi', [], {});
    expect(result.success).toBe(true);
    expect(result.response).toBe('Done');
    expect(result.errors).toEqual([{ node: 't1', error: 'database unreachable' }]);
  });

  test('a persona that defers uses the Persona screen at run time', async () => {
    jest.spyOn(assistantConfig, 'resolve').mockResolvedValue({ persona: 'You are the Persona-screen bot.', source: 'company' });
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'Hello' } }] });

    const compiled = await compiler.compileWorkflow(
      [persona({ inheritPersona: true, prompt: 'You are a helpful assistant.' }),
        node('s1', 'start'), node('l1', 'llm', { prompt: 'Answer: {{user_input}}' })],
      [{ id: 'e1', source: 's1', target: 'l1' }],
      '64b7f0000000000000000001'
    );
    expect(compiled.compiledChain.prompts.persona.inherit).toBe(true);

    compiler.openai = { chat: { completions: { create } } };
    const result = await compiler.executeWorkflow(compiled.compiledChain, 'hi', [], {});

    expect(result.response).toBe('Hello');
    expect(result.metadata.llmUsed).toBe(true);
    const system = create.mock.calls[0][0].messages[0].content;
    expect(system).toContain('You are the Persona-screen bot.');
    expect(system).not.toContain('You are a helpful assistant.');
  });
});
