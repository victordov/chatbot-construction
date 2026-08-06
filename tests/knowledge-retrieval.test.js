/**
 * Knowledge retrieval and intent routing.
 *
 * Both were placeholders: storeInVectorDB wrote nothing while reporting
 * success, searchVectorStore always returned an empty array, and an `intent`
 * router condition hit an empty switch case and never matched.
 *
 * These tests use the local embedding fallback (OPENAI_API_KEY is blank in the
 * test environment), so they assert on ranking and plumbing rather than on
 * semantic quality, which depends on the model.
 */

const mongoose = require('mongoose');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const { VectorStoreService } = require('../services/vector-store');
const { EmbeddingService, cosineSimilarity } = require('../services/embeddings');
const { IntentClassifier } = require('../services/intent-classifier');
const WorkflowCompilerService = require('../services/workflow-compiler');

describe('Knowledge retrieval', () => {
  let company;
  let other;
  let store;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'Knowledge Co' });
    other = await Company.create({ name: 'Knowledge Other Co' });
    store = new VectorStoreService();
  });

  afterAll(async () => {
    await KnowledgeChunk.deleteMany({});
    await Company.deleteMany({ name: /^Knowledge / });
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({});
  });

  test('uses the in-process backend when no vector database is configured', () => {
    expect(store.backend).toBe('mongo');
  });

  test('stores chunks and reports how many landed', async () => {
    const result = await store.store([
      { content: 'Refunds are available within 30 days of purchase.' },
      { content: 'Shipping takes three to five business days.' }
    ], { companyId: company._id, sourceId: 'faq' });

    expect(result.stored).toBe(2);
    // The old implementation claimed success without writing anything.
    expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(2);
  });

  test('every stored chunk carries an embedding', async () => {
    await store.store([{ content: 'Refunds are available within 30 days.' }],
      { companyId: company._id, sourceId: 'faq' });

    const chunk = await KnowledgeChunk.findOne({ company: company._id });
    expect(Array.isArray(chunk.embedding)).toBe(true);
    expect(chunk.embedding.length).toBeGreaterThan(0);
    expect(chunk.embeddingSignature).toBeTruthy();
  });

  test('search returns the most relevant chunk first', async () => {
    await store.store([
      { content: 'Refunds are available within 30 days of purchase.' },
      { content: 'Shipping takes three to five business days.' },
      { content: 'Our office is open Monday to Friday.' }
    ], { companyId: company._id, sourceId: 'faq' });

    const results = await store.search('refunds purchase', { companyId: company._id, limit: 2 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('Refunds');
    // Scores must be ordered.
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('one tenant never sees another tenant\'s knowledge', async () => {
    await store.store([{ content: 'Acme confidential refund policy.' }],
      { companyId: company._id, sourceId: 'faq' });

    const results = await store.search('refund policy', { companyId: other._id });

    expect(results).toHaveLength(0);
  });

  test('re-importing a source replaces its chunks instead of duplicating them', async () => {
    await store.store([
      { content: 'Refunds within 30 days.' },
      { content: 'Shipping in 5 days.' }
    ], { companyId: company._id, sourceId: 'faq' });

    await store.store([{ content: 'Refunds within 60 days.' }],
      { companyId: company._id, sourceId: 'faq' });

    expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(1);
  });

  test('re-importing one source leaves other sources alone', async () => {
    await store.store([{ content: 'From the handbook.' }],
      { companyId: company._id, sourceId: 'handbook' });
    await store.store([{ content: 'From the FAQ.' }],
      { companyId: company._id, sourceId: 'faq' });

    await store.store([{ content: 'Updated FAQ.' }],
      { companyId: company._id, sourceId: 'faq' });

    expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(2);
    expect(await KnowledgeChunk.countDocuments({ company: company._id, sourceId: 'handbook' })).toBe(1);
  });

  test('refuses to store knowledge with no tenant', async () => {
    await expect(store.store([{ content: 'x' }], { sourceId: 'faq' }))
      .rejects.toThrow(/company is required/i);
  });

  test('vectors from a different model are never ranked against the query', async () => {
    await store.store([{ content: 'Refunds within 30 days.' }],
      { companyId: company._id, sourceId: 'faq' });

    // Simulate a model change: the stored vectors are now incomparable.
    await KnowledgeChunk.updateMany({}, { $set: { embeddingSignature: 'some-other-model' } });

    const results = await store.search('refunds', { companyId: company._id });
    expect(results).toHaveLength(0);
  });
});

describe('Embeddings', () => {
  test('produces unit-length vectors so cosine similarity is a dot product', async () => {
    const service = new EmbeddingService({ apiKey: null });
    const vector = await service.embed('hello world refunds');

    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  test('similar text scores higher than unrelated text', async () => {
    const service = new EmbeddingService({ apiKey: null });
    const [query, related, unrelated] = await service.embedBatch([
      'refund my order',
      'I would like a refund for my order',
      'the weather forecast for tomorrow'
    ]);

    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  test('embedding the same text twice gives the same vector', async () => {
    const service = new EmbeddingService({ apiKey: null });
    expect(await service.embed('stable input')).toEqual(await service.embed('stable input'));
  });
});

describe('Intent routing', () => {
  const classifier = new IntentClassifier({
    embeddings: new EmbeddingService({ apiKey: null })
  });

  test('parses example phrases from comma and newline separated text', () => {
    expect(IntentClassifier.parseExamples('refund, cancel order\nmoney back'))
      .toEqual(['refund', 'cancel order', 'money back']);
  });

  test('matches a message against the closest intent', async () => {
    const result = await classifier.classify('I need a refund for my order', [
      { id: 'refund', label: 'refund', value: 'refund order, refund my purchase' },
      { id: 'shipping', label: 'shipping', value: 'shipping delivery tracking parcel' }
    ]);

    expect(result.matched).toBe(true);
    expect(result.intent.id).toBe('refund');
  });

  test('reports no match for an unrelated message', async () => {
    const result = await classifier.classify('completely unrelated gibberish topic', [
      { id: 'refund', label: 'refund', value: 'refund order, refund my purchase' }
    ]);

    expect(result.matched).toBe(false);
  });

  test('an intent with no examples cannot match', async () => {
    const result = await classifier.classify('refund please', [
      { id: 'empty', label: 'empty', value: '' }
    ]);

    expect(result.matched).toBe(false);
  });

  describe('through a compiled workflow', () => {
    const compiler = new WorkflowCompilerService();

    const nodes = [
      { id: 'persona', data: { type: 'persona', prompt: 'You are support.' } },
      { id: 'start', data: { type: 'start', label: 'Start' } },
      {
        id: 'router',
        data: {
          type: 'router', label: 'Router',
          conditions: [{ id: 'refund', label: 'refund', type: 'intent', value: 'refund order, refund purchase' }]
        }
      },
      { id: 'human', data: { type: 'operator-handoff', label: 'Human', message: 'Refunds team here.' } },
      { id: 'reply', data: { type: 'response', label: 'Reply', template: 'Generic answer.' } }
    ];

    const edges = [
      { id: 'e1', source: 'start', target: 'router' },
      { id: 'e2', source: 'router', target: 'human', sourceHandle: 'refund' },
      { id: 'e3', source: 'router', target: 'reply', sourceHandle: 'default' }
    ];

    test('a matching message takes the intent branch', async () => {
      const compiled = await compiler.compileWorkflow(nodes, edges, 'tenant-intent');
      const result = await compiler.executeWorkflow(compiled.compiledChain, 'refund my purchase please', []);

      expect(result.metadata.path).toContain('human');
      expect(result.response).toBe('Refunds team here.');
    });

    test('an unmatched message takes the Otherwise branch, not the first edge', async () => {
      // Previously this fell through to edges[0] - whichever condition was
      // wired first - so an unrelated question was answered as if it had
      // matched that rule.
      const compiled = await compiler.compileWorkflow(nodes, edges, 'tenant-intent');
      const result = await compiler.executeWorkflow(compiled.compiledChain, 'what colours are available', []);

      expect(result.metadata.path).toContain('reply');
      expect(result.response).toBe('Generic answer.');
    });
  });
});
