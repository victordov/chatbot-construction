/**
 * Knowledge, end to end: a tenant puts something in and the bot can find it.
 *
 * This is the loop that did not close. Ingestion, embedding, storage and
 * retrieval were all implemented and none of them were reachable: no route in
 * the product called `processKnowledgeSource`, so `KnowledgeChunk` stayed empty
 * in every real deployment and both readers - the assistant and the workflow
 * knowledge node - searched nothing and found nothing without ever erroring.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const AIService = require('../services/ai');
const { getVectorStore } = require('../services/vector-store');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/knowledge', require('../routes/knowledge'));
  return app;
};

describe('the knowledge base', () => {
  let app;
  let company;
  let adminToken;
  let operatorToken;

  const login = async username => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'TestPassword123!' });
    return response.body.token;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = buildApp();

    // Suites share one in-memory MongoDB and run concurrently, so this one
    // only ever creates and removes its own documents. A blanket
    // `User.deleteMany({})` here takes every other suite's fixtures with it.
    company = await Company.create({ name: 'Knowledge Test Co', description: 'test tenant' });

    await User.create({
      username: 'knowledge-admin',
      displayName: 'Knowledge Admin',
      email: 'admin@knowledge.test',
      password: 'TestPassword123!',
      role: 'company_admin',
      company: company._id
    });

    await User.create({
      username: 'knowledge-operator',
      displayName: 'Knowledge Operator',
      email: 'op@knowledge.test',
      password: 'TestPassword123!',
      role: 'operator',
      company: company._id
    });

    adminToken = await login('knowledge-admin');
    operatorToken = await login('knowledge-operator');
  });

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ company: company._id }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: company._id });
  });

  describe('putting something in', () => {
    it('stores pasted text as searchable chunks', async () => {
      const response = await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({
          title: 'Returns policy',
          text: 'Returns are accepted within 30 days of delivery. ' +
            'Refunds go back to the original payment method within five working days.'
        });

      expect(response.status).toBe(201);
      expect(response.body.chunks).toBeGreaterThan(0);

      const stored = await KnowledgeChunk.find({ company: company._id });
      expect(stored.length).toBe(response.body.chunks);
      expect(stored[0].content).toContain('30 days');
      // Every chunk carries a vector, or retrieval has nothing to compare.
      expect(stored[0].embedding.length).toBeGreaterThan(0);
    });

    it('refuses an empty submission rather than storing nothing quietly', async () => {
      const response = await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({ title: 'Nothing' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/URL or some text/i);
    });

    it('will not fetch a private address', async () => {
      const response = await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({ url: 'http://169.254.169.254/latest/meta-data/' });

      expect(response.status).toBe(400);
      // The URL is one a tenant typed, so it goes through the same
      // address-checked transport as workflow actions and webhooks.
      expect(response.body.error).toMatch(/private|reserved|https/i);
    });

    it('is closed to plain operators', async () => {
      const response = await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', operatorToken)
        .send({ title: 'Sneaky', text: 'something' });

      expect(response.status).toBe(403);
    });
  });

  describe('seeing what is in', () => {
    beforeEach(async () => {
      await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({ title: 'Opening hours', text: 'We are open from nine until five, Monday to Friday.' });
    });

    it('lists the sources with their sizes', async () => {
      const response = await request(app)
        .get('/api/knowledge')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.sources).toHaveLength(1);
      // A random id per note, with the title kept for display.
      expect(response.body.sources[0].sourceId).toMatch(/^text:[0-9a-f-]{36}$/);
      expect(response.body.sources[0].title).toBe('Opening hours');
      expect(response.body.sources[0].chunks).toBeGreaterThan(0);
      expect(response.body.chunks).toBeGreaterThan(0);
    });

    it('says plainly when matching is lexical rather than semantic', async () => {
      // The suite runs with no API key, so the embedding service is on its
      // hashed-bag-of-words fallback. Claiming semantic search here would be a
      // lie a tenant could only discover from a bad answer.
      const response = await request(app)
        .get('/api/knowledge')
        .set('x-auth-token', adminToken);

      expect(response.body.semantic).toBe(false);
      expect(response.body.note).toMatch(/wording rather than meaning/i);
    });

    it('answers a test question from the material', async () => {
      const response = await request(app)
        .post('/api/knowledge/search')
        .set('x-auth-token', adminToken)
        .send({ query: 'what are your opening hours' });

      expect(response.status).toBe(200);
      expect(response.body.results.length).toBeGreaterThan(0);
      expect(response.body.results[0].content).toContain('nine until five');
    });
  });

  describe('taking something out', () => {
    it('removes every chunk that came from the source', async () => {
      const created = await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({ title: 'Temporary', text: 'This should not survive.' });

      const response = await request(app)
        .delete(`/api/knowledge/sources/${encodeURIComponent(created.body.sourceId)}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.removed).toBeGreaterThan(0);
      expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(0);
    });

    it('reports a source that was never there', async () => {
      const response = await request(app)
        .delete('/api/knowledge/sources/text:never-existed')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(404);
    });
  });

  describe('re-importing', () => {
    it('replaces a source rather than duplicating it', async () => {
      // Re-import is by source id, not by title: two pastes with the same
      // title are two notes (see knowledge-import.test.js), but storing under
      // an existing id replaces exactly that source.
      const store = getVectorStore();
      const send = text => store.store(
        [{ content: text, metadata: { title: 'Policy', source: 'manual' } }],
        { companyId: company._id, sourceId: 'text:policy', sourceType: 'manual' }
      );

      await send('The old policy said fourteen days.');
      const before = await KnowledgeChunk.countDocuments({ company: company._id });

      await send('The new policy says thirty days.');
      const after = await KnowledgeChunk.countDocuments({ company: company._id });

      expect(after).toBe(before);

      const chunks = await KnowledgeChunk.find({ company: company._id });
      expect(chunks.map(chunk => chunk.content).join(' ')).toContain('thirty days');
      expect(chunks.map(chunk => chunk.content).join(' ')).not.toContain('fourteen days');
    });
  });

  describe('the assistant reads what was imported', () => {
    it('grounds its answer in the tenant\'s own material', async () => {
      await request(app)
        .post('/api/knowledge/sources')
        .set('x-auth-token', adminToken)
        .send({
          title: 'Delivery',
          text: 'Standard delivery takes three working days. Next-day delivery costs four pounds.'
        });

      const calls = [];
      const service = new AIService({
        companyId: company._id,
        vectorStore: getVectorStore(),
        openai: {
          chat: {
            completions: {
              create: async request_ => {
                calls.push(request_);
                return { choices: [{ message: { content: 'Three working days.' } }] };
              }
            }
          }
        }
      });

      await service.generateEngineeredResponse('how long does delivery take?');

      const system = calls[0].messages.find(message => message.role === 'system').content;

      // The whole point: what the tenant imported reached the model, without
      // anybody having to draw a workflow.
      expect(system).toContain('Relevant Knowledge:');
      expect(system).toContain('three working days');
    });
  });
});
