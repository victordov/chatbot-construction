/**
 * Workflows that hold a conversation.
 *
 * The tests that matter here are about the thing that did not exist before: a
 * workflow that asks a question, waits, and uses the answer. Everything else in
 * the editor was already a single-shot reply.
 */

const WorkflowCompilerService = require('../services/workflow-compiler');
const nodes = require('../services/workflow-nodes');
const templates = require('../config/workflow-templates');
const workflowService = require('../services/workflow');

const compiler = new WorkflowCompilerService();

/** Build a compiled chain by hand, the shape the executor consumes. */
const chain = steps => ({
  tenantId: null,
  entryPoint: Object.keys(steps)[0],
  prompts: { moderation: { enabled: false } },
  knowledge: { sources: [] },
  routing: { conditions: [], fallback: null },
  steps
});

describe('asking a question', () => {
  const askChain = chain({
    ask: {
      type: 'ask',
      data: { question: 'What is your order number?', variable: 'order_id', validate: 'reference' },
      next: [{ target: 'ok', handle: 'next' }, { target: 'giveup', handle: 'invalid' }]
    },
    ok: { type: 'response', data: { template: 'Looking up {{order_id}}.' }, next: [] },
    giveup: { type: 'response', data: { template: 'Let me get a colleague.' }, next: [] }
  });

  test('the question is asked and the walk stops', async () => {
    const result = await compiler.executeWorkflow(askChain, 'where is my order');

    expect(result.response).toBe('What is your order number?');
    expect(result.state.awaiting.variable).toBe('order_id');
  });

  test('the answer is used on the next message', async () => {
    // The whole point: without state the walk restarts and the same question
    // is asked forever.
    const first = await compiler.executeWorkflow(askChain, 'where is my order');
    const second = await compiler.executeWorkflow(askChain, 'HC-8812', [], { state: first.state });

    expect(second.response).toBe('Looking up HC-8812.');
    expect(second.state.awaiting).toBeNull();
    expect(second.state.variables.order_id).toBe('HC-8812');
  });

  test('an answer in the wrong format is asked for again', async () => {
    const first = await compiler.executeWorkflow(askChain, 'where is my order');
    const second = await compiler.executeWorkflow(askChain, '?!', [], { state: first.state });

    expect(second.response).toMatch(/does not look like a reference/);
    expect(second.state.awaiting.attempts).toBe(1);
  });

  test('it gives up rather than looping forever', async () => {
    // Somebody who cannot answer three times over is not going to answer on
    // the fourth; trapping them is how a bot becomes a complaint.
    let state = (await compiler.executeWorkflow(askChain, 'hello')).state;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      state = (await compiler.executeWorkflow(askChain, '?!', [], { state })).state;
    }

    const final = await compiler.executeWorkflow(askChain, '?!', [], { state });
    expect(final.response).toBe('Let me get a colleague.');
  });

  test('a question whose node was deleted starts again rather than hanging', async () => {
    const stale = { awaiting: { nodeId: 'node-that-is-gone', variable: 'x', kind: 'any' } };
    const result = await compiler.executeWorkflow(askChain, 'hello', [], { state: stale });

    expect(result.response).toBe('What is your order number?');
  });

  test('collected values survive to later turns but the message does not', async () => {
    const first = await compiler.executeWorkflow(askChain, 'where is my order');
    const second = await compiler.executeWorkflow(askChain, 'HC-8812', [], { state: first.state });

    expect(second.state.variables.order_id).toBe('HC-8812');
    // Keeping the message would mean a later step silently referring to the
    // wrong one.
    expect(second.state.variables.user_input).toBeUndefined();
  });
});

describe('offering choices', () => {
  const buttonChain = chain({
    ask: {
      type: 'buttons',
      data: {
        question: 'What do you need?',
        variable: 'topic',
        choices: [
          { id: 'billing', label: 'Billing', value: 'billing' },
          { id: 'tech', label: 'Something is broken', value: 'technical' }
        ]
      },
      next: [
        { target: 'toBilling', handle: 'billing' },
        { target: 'toTech', handle: 'tech' },
        { target: 'toOther', handle: 'other' }
      ]
    },
    toBilling: { type: 'response', data: { template: 'Billing it is.' }, next: [] },
    toTech: { type: 'response', data: { template: 'Sorry to hear that.' }, next: [] },
    toOther: { type: 'response', data: { template: 'Let me pass you on.' }, next: [] }
  });

  test('the choices come back for the widget to render', async () => {
    const result = await compiler.executeWorkflow(buttonChain, 'hello');

    expect(result.choices.map(choice => choice.label))
      .toEqual(['Billing', 'Something is broken']);
  });

  test('tapping a button takes its branch', async () => {
    const first = await compiler.executeWorkflow(buttonChain, 'hello');
    const second = await compiler.executeWorkflow(buttonChain, 'Billing', [], { state: first.state });

    expect(second.response).toBe('Billing it is.');
    expect(second.state.variables.topic).toBe('billing');
  });

  test.each([
    ['Billing', 'Billing it is.'],
    ['billing', 'Billing it is.'],
    ['2', 'Sorry to hear that.'],
    ['the second one, something is broken', 'Sorry to hear that.']
  ])('%p is understood', async (reply, expected) => {
    // A visitor may tap, type the label, or type the number. Rejecting two of
    // those three makes the flow feel broken for no benefit.
    const first = await compiler.executeWorkflow(buttonChain, 'hello');
    const second = await compiler.executeWorkflow(buttonChain, reply, [], { state: first.state });

    expect(second.response).toBe(expected);
  });

  test('an answer that matches nothing eventually takes the other branch', async () => {
    let state = (await compiler.executeWorkflow(buttonChain, 'hello')).state;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      state = (await compiler.executeWorkflow(buttonChain, 'none of those', [], { state })).state;
    }

    const final = await compiler.executeWorkflow(buttonChain, 'none of those', [], { state });
    expect(final.response).toBe('Let me pass you on.');
  });
});

describe('checking a value', () => {
  const conditionChain = left => chain({
    check: {
      type: 'condition',
      data: { left, operator: 'equals', right: 'shipped' },
      next: [{ target: 'yes', handle: 'true' }, { target: 'no', handle: 'false' }]
    },
    yes: { type: 'response', data: { template: 'On its way.' }, next: [] },
    no: { type: 'response', data: { template: 'Not yet.' }, next: [] }
  });

  test('a matching value takes the true branch', async () => {
    const result = await compiler.executeWorkflow(conditionChain('shipped'), 'hi');
    expect(result.response).toBe('On its way.');
  });

  test('a value from an earlier step is filled in first', async () => {
    const result = await compiler.executeWorkflow(
      conditionChain('{{order_status}}'), 'hi', [], { variables: { order_status: 'shipped' } }
    );
    expect(result.response).toBe('On its way.');
  });

  test('anything else takes the false branch', async () => {
    const result = await compiler.executeWorkflow(conditionChain('refunded'), 'hi');
    expect(result.response).toBe('Not yet.');
  });

  test.each([
    ['contains', 'part shipped', 'shipped', true],
    ['not_equals', 'refunded', 'shipped', true],
    ['starts_with', 'shipped today', 'shipped', true],
    ['is_empty', '', '', true],
    ['is_not_empty', 'x', '', true],
    ['greater_than', '5', '3', true],
    ['less_than', '5', '3', false],
    ['matches', 'HC-8812', '^HC-', true]
  ])('%s works', (operator, left, right, expected) => {
    expect(nodes.COMPARATORS[operator](left, right)).toBe(expected);
  });

  test('a broken regular expression is false rather than an exception', () => {
    // Authored by an admin, but a typo must not take the conversation down.
    expect(nodes.COMPARATORS.matches('anything', '([')).toBe(false);
  });
});

describe('setting values', () => {
  test('values are computed from what came before', async () => {
    const result = await compiler.executeWorkflow(chain({
      set: {
        type: 'set',
        data: { assignments: [{ variable: 'greeting', value: 'Hello {{name}}' }] },
        next: [{ target: 'say', handle: null }]
      },
      say: { type: 'response', data: { template: '{{greeting}}!' }, next: [] }
    }), 'hi', [], { variables: { name: 'Priya' } });

    expect(result.response).toBe('Hello Priya!');
  });
});

describe('answer validation', () => {
  test.each([
    ['email', 'someone@example.com', true],
    ['email', 'not an email', false],
    ['phone', '07700 900123', true],
    ['phone', 'call me', false],
    ['number', '42', true],
    ['number', '1,000', true],
    ['number', 'lots', false],
    ['reference', 'HC-8812', true],
    ['reference', '??', false],
    ['any', 'whatever', true]
  ])('%s accepts %p: %p', (kind, value, expected) => {
    expect(nodes.validateAnswer(value, kind).valid).toBe(expected);
  });

  test('an empty answer is never valid, whatever the format', () => {
    expect(nodes.validateAnswer('   ', 'any').valid).toBe(false);
  });
});

describe('the shipped templates', () => {
  test('there is at least one for each of the common shapes', () => {
    const ids = templates.summaries().map(template => template.id);

    expect(ids).toEqual(expect.arrayContaining([
      'order-status', 'returns', 'triage', 'lead-qualification', 'booking', 'account-lookup'
    ]));
  });

  test.each(templates.templates.map(template => [template.id, template]))(
    '%s is a valid workflow',
    (id, template) => {
      // A template that does not validate is worse than no template: the first
      // thing it does is show the tenant an error they did not cause.
      const result = compiler.validateWorkflow(template.nodes, template.edges);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  );

  test.each(templates.templates.map(template => [template.id, template]))(
    '%s has every node configured',
    (id, template) => {
      template.nodes.forEach(node => {
        expect(() => workflowService.validateNodeData(node)).not.toThrow();
      });
    }
  );

  test.each(templates.templates.map(template => [template.id, template]))(
    '%s says what it needs before it will work',
    (id, template) => {
      expect(template.requires).toBeTruthy();
      expect(template.summary).toBeTruthy();
    }
  );

  test('every edge points at a node that exists', () => {
    templates.templates.forEach(template => {
      const ids = new Set(template.nodes.map(node => node.id));
      template.edges.forEach(edge => {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
      });
    });
  });

  test('every template offers a way out to a person', () => {
    // A flow with no escape is how somebody ends up repeating themselves to a
    // machine until they leave.
    templates.templates.forEach(template => {
      const escapes = template.nodes.some(node =>
        node.type === 'operator-handoff' || node.type === 'task');
      expect(escapes).toBe(true);
    });
  });
});

describe('checking several values at once', () => {
  // The deliberate answer to "do we need scripting": most real conditions are
  // two or three comparisons combined, and a clause list covers that without
  // evaluating tenant-supplied code.
  const clauseChain = (clauses, match) => chain({
    check: {
      type: 'condition',
      data: { clauses, match },
      next: [{ target: 'yes', handle: 'true' }, { target: 'no', handle: 'false' }]
    },
    yes: { type: 'response', data: { template: 'Yes.' }, next: [] },
    no: { type: 'response', data: { template: 'No.' }, next: [] }
  });

  test('all clauses must hold by default', async () => {
    const result = await compiler.executeWorkflow(
      clauseChain([
        { left: '{{status}}', operator: 'equals', right: 'shipped' },
        { left: '{{days_late}}', operator: 'greater_than', right: '3' }
      ]),
      'hi', [], { variables: { status: 'shipped', days_late: '5' } }
    );
    expect(result.response).toBe('Yes.');
  });

  test('one failing clause fails the lot', async () => {
    const result = await compiler.executeWorkflow(
      clauseChain([
        { left: '{{status}}', operator: 'equals', right: 'shipped' },
        { left: '{{days_late}}', operator: 'greater_than', right: '3' }
      ]),
      'hi', [], { variables: { status: 'shipped', days_late: '1' } }
    );
    expect(result.response).toBe('No.');
  });

  test('any lets one clause carry it', async () => {
    const result = await compiler.executeWorkflow(
      clauseChain([
        { left: '{{status}}', operator: 'equals', right: 'refunded' },
        { left: '{{status}}', operator: 'equals', right: 'cancelled' }
      ], 'any'),
      'hi', [], { variables: { status: 'cancelled' } }
    );
    expect(result.response).toBe('Yes.');
  });

  test('the old single-comparison shape still works untouched', async () => {
    // Workflows saved before clauses existed carry left/operator/right at the
    // top level; a migration that broke them would break published bots.
    const result = await compiler.executeWorkflow(chain({
      check: {
        type: 'condition',
        data: { left: 'shipped', operator: 'equals', right: 'shipped' },
        next: [{ target: 'yes', handle: 'true' }, { target: 'no', handle: 'false' }]
      },
      yes: { type: 'response', data: { template: 'Yes.' }, next: [] },
      no: { type: 'response', data: { template: 'No.' }, next: [] }
    }), 'hi');
    expect(result.response).toBe('Yes.');
  });

  test('no usable clause takes the false branch rather than guessing', async () => {
    const result = await compiler.executeWorkflow(clauseChain([]), 'hi');
    expect(result.response).toBe('No.');
  });
});

describe('emailing the team', () => {
  const emailChannel = require('../services/email-channel');
  const notifyChain = data => chain({
    tell: { type: 'notify', data, next: [{ target: 'done', handle: null }] },
    done: { type: 'response', data: { template: 'All done.' }, next: [] }
  });

  afterEach(() => jest.restoreAllMocks());

  test('the email goes out with the placeholders filled in', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(emailChannel, 'buildTransport').mockReturnValue({ sendMail });

    const result = await compiler.executeWorkflow(
      notifyChain({ to: 'team@example.com', subject: 'Complaint from {{name}}', body: 'They said: {{complaint}}' }),
      'hi', [], { variables: { name: 'Priya', complaint: 'the wheel fell off' } }
    );

    expect(result.response).toBe('All done.');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'team@example.com',
      subject: 'Complaint from Priya',
      text: 'They said: the wheel fell off'
    }));
  });

  test('no SMTP means the flow carries on, not that it breaks', async () => {
    // The tag/task nodes are the durable record; the email is the courtesy
    // copy. A visitor's conversation must never stall on a mail server.
    jest.spyOn(emailChannel, 'buildTransport').mockReturnValue(null);

    const result = await compiler.executeWorkflow(
      notifyChain({ to: 'team@example.com', subject: 'x', body: 'y' }), 'hi'
    );
    expect(result.response).toBe('All done.');
  });

  test('a failing send is swallowed loudly, not thrown', async () => {
    jest.spyOn(emailChannel, 'buildTransport').mockReturnValue({
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP said no'))
    });

    const result = await compiler.executeWorkflow(
      notifyChain({ to: 'team@example.com', subject: 'x', body: 'y' }), 'hi'
    );
    expect(result.response).toBe('All done.');
  });

  test('a rendered recipient that is not an email is refused', async () => {
    const sendMail = jest.fn();
    jest.spyOn(emailChannel, 'buildTransport').mockReturnValue({ sendMail });

    await compiler.executeWorkflow(
      notifyChain({ to: '{{missing_variable}}', subject: 'x', body: 'y' }), 'hi'
    );
    expect(sendMail).not.toHaveBeenCalled();
  });
});
