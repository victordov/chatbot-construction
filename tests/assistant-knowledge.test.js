/**
 * The assistant answering from the tenant's own material.
 *
 * Retrieval used to be reachable only from a workflow's knowledge node, so a
 * company that imported a price list and never drew a graph had an assistant
 * that ignored it. These tests pin the wiring: what was imported reaches the
 * model, and a retrieval that fails still produces a reply.
 */

const AIService = require('../services/ai');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { PromptEngineeringService } = require('../services/promptEngineering');

/** A client that records what it was asked, and answers with a fixed string. */
function recordingClient() {
  const calls = [];

  return {
    calls,
    chat: {
      completions: {
        create: async request => {
          calls.push(request);
          return { choices: [{ message: { content: 'an answer' } }] };
        }
      }
    }
  };
}

function serviceWith(store, options = {}) {
  const client = recordingClient();

  const service = new AIService({
    openai: client,
    companyId: 'company-1',
    templateService: new ResponseTemplateService(),
    promptService: new PromptEngineeringService(),
    vectorStore: store,
    ...options
  });

  return { service, client };
}

/** The system prompt the model was actually sent. */
function systemPrompt(client) {
  const request = client.calls[client.calls.length - 1];
  return request.messages.find(message => message.role === 'system').content;
}

describe('the assistant answers from the knowledge base', () => {
  it('puts retrieved material in the system prompt', async () => {
    const store = {
      search: jest.fn().mockResolvedValue([
        { content: 'Returns are accepted within 30 days of delivery.', score: 0.8 },
        { content: 'Refunds are issued to the original payment method.', score: 0.7 }
      ])
    };

    const { service, client } = serviceWith(store);

    await service.generateEngineeredResponse('what is your returns policy?');

    expect(store.search).toHaveBeenCalledWith('what is your returns policy?', {
      companyId: 'company-1',
      limit: 5
    });

    const prompt = systemPrompt(client);
    expect(prompt).toContain('Relevant Knowledge:');
    expect(prompt).toContain('Returns are accepted within 30 days of delivery.');
    expect(prompt).toContain('Refunds are issued to the original payment method.');
  });

  it('tells the model not to invent what the material does not cover', async () => {
    const store = { search: jest.fn().mockResolvedValue([{ content: 'We ship on Tuesdays.' }]) };
    const { service, client } = serviceWith(store);

    await service.generateEngineeredResponse('when do you ship?');

    expect(systemPrompt(client)).toMatch(/do not have that information/i);
  });

  it('says nothing about knowledge when the tenant has none', async () => {
    const store = { search: jest.fn().mockResolvedValue([]) };
    const { service, client } = serviceWith(store);

    await service.generateEngineeredResponse('hello');

    expect(systemPrompt(client)).not.toContain('Relevant Knowledge:');
  });

  it('does not search without a tenant, because chunks are tenant-scoped', async () => {
    const store = { search: jest.fn() };
    const { service } = serviceWith(store, { companyId: null });

    await service.generateEngineeredResponse('anything');

    expect(store.search).not.toHaveBeenCalled();
  });

  it('still answers when retrieval fails', async () => {
    const store = { search: jest.fn().mockRejectedValue(new Error('vector store is down')) };
    const { service, client } = serviceWith(store);

    const answer = await service.generateEngineeredResponse('what is your returns policy?');

    expect(answer).toBe('an answer');
    expect(systemPrompt(client)).not.toContain('Relevant Knowledge:');
  });

  it('can be turned off', async () => {
    const store = { search: jest.fn().mockResolvedValue([{ content: 'something' }]) };
    const { service } = serviceWith(store, { useKnowledge: false });

    await service.generateEngineeredResponse('what is your returns policy?');

    expect(store.search).not.toHaveBeenCalled();
  });

  it('grounds an operator suggestion in the same material', async () => {
    const store = {
      search: jest.fn().mockResolvedValue([{ content: 'Engineers visit on weekdays only.' }])
    };
    const { service, client } = serviceWith(store);

    await service.generateOperatorSuggestion('can someone come out on Saturday?');

    expect(systemPrompt(client)).toContain('Engineers visit on weekdays only.');
  });
});

describe('the client the service was given', () => {
  it('is the one the reply path uses', async () => {
    const store = { search: jest.fn().mockResolvedValue([]) };
    const { service, client } = serviceWith(store);

    const answer = await service.generateEngineeredResponse('hello');

    // Before this was fixed the injected client was ignored here: the reply
    // went through a module-level client built from the environment when the
    // file was first required, so this returned a canned mock string.
    expect(client.calls).toHaveLength(1);
    expect(answer).toBe('an answer');
  });
});
