/**
 * What the assistant reports about its own reply, and the small rules around
 * it: a greeting that is really a greeting, an "I don't know" the server can
 * recognise, a failure that is not dressed up as text, and the codes a
 * visitor's widget translates.
 */

const AIService = require('../services/ai');
const { PromptEngineeringService, NO_ANSWER_MARKER } = require('../services/promptEngineering');
const { notice, CODES, handoffChoice, wantsAPerson } = require('../services/visitor-notices');
const lifecycle = require('../services/conversation-lifecycle');

/** A model that says `content`, and records what it was sent. */
function fakeModel(content) {
  return {
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } }
  };
}

function service({ model, chunks = [] } = {}) {
  return new AIService({
    openai: model || null,
    companyId: 'company-1',
    templateService: { getByRole: jest.fn().mockResolvedValue(null), match: jest.fn().mockResolvedValue(null) },
    vectorStore: { search: jest.fn().mockResolvedValue(chunks) }
  });
}

describe('WS1: the assistant\'s reply', () => {
  describe('greetings', () => {
    const ai = new AIService({ openai: null });

    it.each([
      'hi', 'Hello there', 'hey!', 'Good morning all', 'hiya', 'morning'
    ])('"%s" is a greeting', message => {
      expect(ai.isGreeting(message)).toBe(true);
    });

    it.each([
      // Every one of these used to be a greeting, because each contains "hi".
      'this', 'which shipping options do you have?', 'Is this in stock?', 'shipping',
      // Short, but saying something besides hello.
      'hi, shipping cost?', 'hello I need help with my order', 'good'
    ])('"%s" is not', message => {
      expect(ai.isGreeting(message)).toBe(false);
    });
  });

  describe('an answer it does not have', () => {
    it('is marked by the model, stripped, and reported', async () => {
      const ai = service({ model: fakeModel(`${NO_ANSWER_MARKER} I do not have information about that.`) });

      const reply = await ai.generateResponse('Do you ship to Mars?');

      expect(reply).toBe('I do not have information about that.');
      expect(ai.lastUnanswered).toBe(true);
      expect(ai.lastFailed).toBe(false);
    });

    it('is recognised in words when there was nothing in the knowledge base to answer from', async () => {
      const ai = service({ model: fakeModel('I\'m not sure about that, sorry.') });

      expect(await ai.generateResponse('Do you ship to Mars?')).toBe('I\'m not sure about that, sorry.');
      expect(ai.lastUnanswered).toBe(true);
    });

    it('is not assumed when the material was there and the model answered from it', async () => {
      const ai = service({
        model: fakeModel('I don\'t know your order number, but delivery takes three days.'),
        chunks: [{ content: 'Delivery takes three days.', metadata: { title: 'Delivery' } }]
      });

      await ai.generateResponse('How long is delivery?');

      expect(ai.lastUnanswered).toBe(false);
      expect(ai.lastSources).toHaveLength(1);
    });

    it('still says something when the model sent the marker and nothing else', async () => {
      const ai = service({ model: fakeModel(NO_ANSWER_MARKER) });

      expect(await ai.generateResponse('Anything?')).toMatch(/do not have that information/);
      expect(ai.lastUnanswered).toBe(true);
    });

    it('is asked for in every strategy prompt the assistant sends', () => {
      const prompts = new PromptEngineeringService();
      prompts.getPromptTypes().forEach(type => {
        expect(prompts.createSystemMessage(type)).toContain(NO_ANSWER_MARKER);
      });
    });

    it('is stripped however the model spaced it', () => {
      expect(AIService.stripNoAnswerMarker('[NO ANSWER]: no idea')).toEqual({ text: 'no idea', marked: true });
      expect(AIService.stripNoAnswerMarker('[[ no_answer ]] nope')).toEqual({ text: 'nope', marked: true });
      expect(AIService.stripNoAnswerMarker('A real answer')).toEqual({ text: 'A real answer', marked: false });
    });
  });

  describe('a canned reply', () => {
    const cannedService = (text, extra = {}) => new AIService({
      openai: null,
      companyId: 'company-1',
      templateService: {
        getByRole: jest.fn().mockResolvedValue(null),
        match: jest.fn().mockResolvedValue({ text })
      },
      vectorStore: { search: jest.fn().mockResolvedValue([]) },
      ...extra
    });

    it('has the visitor\'s and the company\'s names filled in', async () => {
      const ai = cannedService('Hi {name}, thanks for contacting {company}.');

      expect(await ai.generateResponse('price?', [], { visitorName: 'Jo', companyName: 'Acme' }))
        .toBe('Hi Jo, thanks for contacting Acme.');
      expect(ai.lastPath).toBe('canned');
    });

    it('reads naturally when nobody gave a name', async () => {
      const ai = cannedService('Hi {name}, thanks for contacting {company}.');

      expect(await ai.generateResponse('price?', [], { companyName: 'Acme' }))
        .toBe('Hi, thanks for contacting Acme.');
    });

    it('takes the name from the conversation when that is what the caller has', async () => {
      const ai = cannedService('{name}, we open at nine.');

      expect(await ai.generateResponse('hours?', [], { conversation: { metadata: new Map([['name', 'Sam']]) }, companyName: 'Acme' }))
        .toBe('Sam, we open at nine.');
      expect(await cannedService('{name}, we open at nine.').generateResponse('hours?', [], { companyName: 'Acme' }))
        .toBe('we open at nine.');
    });
  });

  describe('a failure', () => {
    it('returns no text at all, and says it failed', async () => {
      const model = { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('429')) } } };
      const ai = service({ model });

      expect(await ai.generateResponse('Hello?')).toBeNull();
      expect(ai.lastFailed).toBe(true);
      expect(ai.lastUnanswered).toBe(false);
      expect(ai.lastSources).toEqual([]);
    });

    it('is an empty completion too', async () => {
      const ai = service({ model: fakeModel('   ') });

      expect(await ai.generateResponse('Hello?')).toBeNull();
      expect(ai.lastFailed).toBe(true);
    });

    it('is forgotten on the next reply', async () => {
      const model = fakeModel('Fine.');
      model.chat.completions.create.mockRejectedValueOnce(new Error('timeout'));
      const ai = service({ model });

      await ai.generateResponse('first');
      expect(ai.lastFailed).toBe(true);
      await ai.generateResponse('second');
      expect(ai.lastFailed).toBe(false);
    });

    it('drafts no suggestion for an operator, rather than an error sentence', async () => {
      const model = { chat: { completions: { create: jest.fn().mockRejectedValue(new Error('down')) } } };
      const ai = service({ model });

      expect(await ai.generateOperatorSuggestion('Where is my order?')).toBeNull();
      expect(ai.lastFailed).toBe(true);
    });
  });
});

describe('WS1: what a reply result means', () => {
  it('treats no text as a failure, whatever else it says', () => {
    expect(lifecycle.replyOutcome({ text: null, path: 'assistant' })).toMatchObject({ failed: true, metered: false });
    expect(lifecycle.replyOutcome({ text: '   ', path: 'assistant' }).failed).toBe(true);
    expect(lifecycle.replyOutcome({ failed: true, text: 'stale' }).failed).toBe(true);
    expect(lifecycle.replyOutcome(undefined).failed).toBe(true);
  });

  it('stores only a path the conversation model allows', () => {
    expect(lifecycle.replyOutcome({ text: 'x', path: 'tool-call' }).path).toBe('assistant');
    expect(lifecycle.replyOutcome({ text: 'x', path: 'odd', source: 'workflow' }).path).toBe('workflow');
    expect(lifecycle.replyOutcome({ text: 'x', path: 'canned' }).path).toBe('canned');
  });

  it('meters what a model wrote, when the reply service does not say', () => {
    expect(lifecycle.replyOutcome({ text: 'x', path: 'assistant' }).metered).toBe(true);
    expect(lifecycle.replyOutcome({ text: 'x', path: 'workflow', source: 'workflow' }).metered).toBe(true);
    expect(lifecycle.replyOutcome({ text: 'x', path: 'canned' }).metered).toBe(false);
    expect(lifecycle.replyOutcome({ text: 'x', path: 'fallback' }).metered).toBe(false);
  });

  it('believes the reply service when it does say', () => {
    expect(lifecycle.replyOutcome({ text: 'x', path: 'workflow', metered: false }).metered).toBe(false);
    expect(lifecycle.replyOutcome({ text: 'x', path: 'canned', metered: true }).metered).toBe(true);
  });

  it('lets a visitor rate answers, not hand-over lines or "I don\'t know"', () => {
    expect(lifecycle.canRate({ sender: 'bot', path: 'assistant' })).toBe(true);
    expect(lifecycle.canRate({ sender: 'bot', path: 'workflow' })).toBe(true);
    expect(lifecycle.canRate({ sender: 'bot', path: 'canned' })).toBe(true);
    expect(lifecycle.canRate({ sender: 'bot', path: 'assistant', unanswered: true })).toBe(false);
    expect(lifecycle.canRate({ sender: 'bot', path: 'handoff' })).toBe(false);
    expect(lifecycle.canRate({ sender: 'operator', path: 'assistant' })).toBe(false);
  });

  it('keeps transcript events out of what the model sees', () => {
    const history = lifecycle.modelHistory([
      { sender: 'user', content: 'hi' },
      { sender: 'system', content: 'Ada joined' },
      { sender: 'operator', content: 'Hello, Ada here' }
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello, Ada here' }
    ]);
  });
});

describe('WS1: what a visitor is told', () => {
  it('every notice has a code, its parameters and an English sentence', () => {
    expect(CODES).toEqual(expect.arrayContaining([
      'unavailable', 'reply_failed', 'operator_joined', 'operator_left', 'handed_back',
      'queued', 'queued_offline', 'followup_saved', 'chat_ended', 'handoff_offer'
    ]));
    CODES.forEach(code => {
      const shaped = notice(code, { operatorName: 'Ada', email: 'jo@example.com' });
      expect(shaped.code).toBe(code);
      expect(typeof shaped.message).toBe('string');
      expect(shaped.message.length).toBeGreaterThan(0);
    });
  });

  it('carries only plain parameters', () => {
    expect(notice('operator_joined', { operatorName: 'Ada', extra: { nested: true } }).params)
      .toEqual({ operatorName: 'Ada' });
    expect(notice('operator_joined', { operatorName: 'Ada' }).message).toMatch(/^Ada has joined/);
  });

  it('refuses a code the widget would not know', () => {
    expect(() => notice('made_up')).toThrow(/Unknown visitor notice/);
  });

  it('offers a person in the shape the widget already renders as a button', () => {
    // `action: 'handoff'` is what the widget acts on; the value is what an
    // older widget would send back as text, and is understood as a request.
    expect(handoffChoice()).toMatchObject({
      label: 'Talk to a person', action: 'handoff', value: '__handoff__', code: 'handoff_offer'
    });
    expect(wantsAPerson('__handoff__')).toBe(true);
  });

  it('records consent once, as the widget sends it, and keeps the visitor\'s time only if it is not in the future', () => {
    const conversation = { metadata: new Map() };
    const at = new Date(Date.now() - 60000).toISOString();

    expect(lifecycle.recordConsent(conversation, { given: true, at, text: 'I agree to the privacy policy' })).toBe(true);
    expect(Object.fromEntries(conversation.metadata)).toEqual({
      consent: 'true', consentAt: at, consentText: 'I agree to the privacy policy'
    });
    // Not overwritten by a later event.
    expect(lifecycle.recordConsent(conversation, true)).toBe(false);

    const future = { metadata: new Map() };
    lifecycle.recordConsent(future, { given: true, at: new Date(Date.now() + 3600000).toISOString() });
    expect(new Date(future.metadata.get('consentAt')).getTime()).toBeLessThanOrEqual(Date.now());

    expect(lifecycle.recordConsent({ metadata: new Map() }, undefined)).toBe(false);
    expect(lifecycle.recordConsent({ metadata: new Map() }, { given: false })).toBe(false);
  });

  describe('asking for a person in words', () => {
    it.each([
      'Can I talk to a person?', 'talk to a person', 'I want to speak to a human', 'human please',
      'agent', 'Can you connect me to an agent?', 'I\'d like to speak with someone', 'real person',
      'Can I chat with someone from support'
    ])('"%s" is a request', message => {
      expect(wantsAPerson(message)).toBe(true);
    });

    it.each([
      'my manager asked me to check the invoice', 'what time do you open?', 'the person who delivered it was rude',
      'I spoke to someone yesterday and they said my refund would arrive within five working days',
      ''
    ])('"%s" is not', message => {
      expect(wantsAPerson(message)).toBe(false);
    });
  });
});
