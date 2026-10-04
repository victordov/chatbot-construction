/**
 * Citations: which of the tenant's sources an assistant reply drew on.
 *
 * The contract other parts of the product read is `reply.generate()` ->
 * `sources: [{title, url}]`: deduplicated by source, at most three, only the
 * chunks actually placed in the prompt, and `url` null where there is no web
 * address to link to.
 */

const AIService = require('../services/ai');
const { citationsFrom } = require('../services/ai');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { PromptEngineeringService } = require('../services/promptEngineering');

function answeringClient() {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'an answer' } }] })
      }
    }
  };
}

/** No canned replies, so every question reaches the model. */
function noTemplates() {
  const service = new ResponseTemplateService();
  service.load = jest.fn().mockResolvedValue([]);
  return service;
}

function serviceWith(results, options = {}) {
  return new AIService({
    openai: answeringClient(),
    companyId: 'company-1',
    templateService: noTemplates(),
    promptService: new PromptEngineeringService(),
    vectorStore: { search: jest.fn().mockResolvedValue(results) },
    ...options
  });
}

const chunk = (sourceId, metadata, content = `text from ${sourceId}`) => ({
  content, score: 0.5, sourceId, sourceType: 'url', metadata
});

describe('citationsFrom', () => {
  test('one citation per source, best first, at most three', () => {
    const citations = citationsFrom([
      chunk('url:https://a.test/returns', { url: 'https://a.test/returns', title: 'Returns' }),
      chunk('url:https://a.test/returns', { url: 'https://a.test/returns', title: 'Returns' }, 'second chunk'),
      chunk('file:prices.csv', { filename: 'prices.csv', title: 'Price list' }),
      chunk('text:abc', { title: 'Opening hours', source: 'manual' }),
      chunk('url:https://a.test/delivery', { url: 'https://a.test/delivery' })
    ]);

    expect(citations).toEqual([
      { title: 'Returns', url: 'https://a.test/returns' },
      { title: 'Price list', url: null },
      { title: 'Opening hours', url: null }
    ]);
  });

  test('falls back to the file name, then the address, for a title', () => {
    expect(citationsFrom([
      chunk('file:a.pdf', { filename: 'a.pdf' }),
      chunk('url:https://a.test/x', { url: 'https://a.test/x' })
    ])).toEqual([
      { title: 'a.pdf', url: null },
      { title: 'https://a.test/x', url: 'https://a.test/x' }
    ]);
  });

  test('never offers a link that is not a web address', () => {
    expect(citationsFrom([chunk('x', { title: 'X', url: 'javascript:alert(1)' })]))
      .toEqual([{ title: 'X', url: null }]);
  });
});

describe('the assistant reports what it used', () => {
  test('an answer grounded in knowledge lists its sources', async () => {
    const service = serviceWith([
      chunk('url:https://a.test/returns', { url: 'https://a.test/returns', title: 'Returns' }),
      chunk('file:policy.pdf', { filename: 'policy.pdf', title: 'policy.pdf' })
    ]);

    const answer = await service.generateResponse('what is the returns policy?');

    expect(answer).toBe('an answer');
    expect(service.lastPath).toBe('assistant');
    expect(service.lastSources).toEqual([
      { title: 'Returns', url: 'https://a.test/returns' },
      { title: 'policy.pdf', url: null }
    ]);
  });

  test('a chunk with no text is not in the prompt, so it is not cited', async () => {
    const service = serviceWith([
      chunk('url:https://a.test/empty', { url: 'https://a.test/empty', title: 'Empty' }, '   '),
      chunk('url:https://a.test/full', { url: 'https://a.test/full', title: 'Full' })
    ]);

    await service.generateResponse('anything');

    expect(service.lastSources).toEqual([{ title: 'Full', url: 'https://a.test/full' }]);
  });

  test('an apology cites nothing, even when retrieval found material', async () => {
    const service = serviceWith(
      [chunk('url:https://a.test/returns', { url: 'https://a.test/returns', title: 'Returns' })],
      { openai: null }
    );
    service.openai = null;

    const answer = await service.generateResponse('what is the returns policy?');

    expect(answer).toMatch(/sorry/i);
    expect(service.lastPath).toBe('fallback');
    expect(service.lastSources).toEqual([]);
  });

  test('a canned reply is labelled as one and cites nothing', async () => {
    const service = serviceWith([chunk('url:https://a.test/x', { url: 'https://a.test/x' })]);
    service.checkForTemplateMatch = jest.fn().mockResolvedValue('We open at nine.');

    expect(await service.generateResponse('when do you open?')).toBe('We open at nine.');
    expect(service.lastPath).toBe('canned');
    expect(service.lastSources).toEqual([]);
  });

  test('state from one reply does not leak into the next', async () => {
    const results = [chunk('url:https://a.test/x', { url: 'https://a.test/x', title: 'X' })];
    const service = serviceWith(results);

    await service.generateResponse('first');
    expect(service.lastSources).toHaveLength(1);

    service.vectorStore.search.mockResolvedValue([]);
    await service.generateResponse('second');
    expect(service.lastSources).toEqual([]);
  });
});

describe('reply.generate', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns the assistant\'s sources and path alongside the text', async () => {
    const replyService = require('../services/reply');
    const service = serviceWith([
      chunk('url:https://a.test/returns', { url: 'https://a.test/returns', title: 'Returns' })
    ]);
    jest.spyOn(AIService, 'forCompany').mockResolvedValue(service);

    // No company, so no workflow is looked for: straight to the assistant.
    const reply = await replyService.generate({ conversation: {}, message: 'returns?' });

    expect(reply).toMatchObject({
      text: 'an answer',
      source: 'assistant',
      path: 'assistant',
      sources: [{ title: 'Returns', url: 'https://a.test/returns' }]
    });
  });
});
