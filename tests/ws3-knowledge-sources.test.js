/**
 * The knowledge list as a tenant manages it: editing a pasted note, the weekly
 * refresh switch, how often each source was used, which source a search
 * passage came from, and the Google Sheets card staying hidden unless asked
 * for.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const KnowledgeChunk = require('../models/knowledge-chunk');
const KnowledgeSource = require('../models/knowledge-source');
const KnowledgeConnectorService = require('../services/knowledge-connector');
const knowledgeText = require('../services/knowledge-text');
const { getVectorStore } = require('../services/vector-store');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/knowledge', require('../routes/knowledge'));
  return app;
};

describe('managing knowledge sources', () => {
  let app;
  let acme;
  let rival;
  let acmeToken;
  let rivalToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  const as = token => ({ 'x-auth-token': token });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'WS3 Knowledge Acme' });
    rival = await Company.create({ name: 'WS3 Knowledge Rival' });
    await User.create({
      username: 'ws3k-dana', email: 'dana@ws3k.example', password: 'TestPassword123!',
      role: 'company_admin', company: acme._id, displayName: 'Dana'
    });
    await User.create({
      username: 'ws3k-rex', email: 'rex@ws3k.example', password: 'TestPassword123!',
      role: 'company_admin', company: rival._id, displayName: 'Rex'
    });
    acmeToken = await login('ws3k-dana');
    rivalToken = await login('ws3k-rex');
  });

  afterAll(async () => {
    const ids = [acme._id, rival._id];
    await Promise.all([
      User.deleteMany({ email: /@ws3k\.example$/ }),
      Company.deleteMany({ _id: { $in: ids } }),
      KnowledgeChunk.deleteMany({ company: { $in: ids } }),
      KnowledgeSource.deleteMany({ company: { $in: ids } }),
      Conversation.deleteMany({ company: { $in: ids } })
    ]);
    delete process.env.GOOGLE_SHEETS_UI;
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await KnowledgeSource.deleteMany({ company: { $in: [acme._id, rival._id] } });
  });

  const paste = (body, token = acmeToken) => request(app).post('/api/knowledge/sources').set(as(token)).send(body);

  describe('editing a pasted note', () => {
    test('comes back exactly as typed, and saving replaces it in one step', async () => {
      const original = 'Opening hours: Monday to Friday, 9am to 5pm.\n\nClosed on bank holidays.';
      const created = await paste({ title: 'Opening hours', text: original });
      expect(created.status).toBe(201);
      const { sourceId } = created.body;

      const read = await request(app).get(`/api/knowledge/sources/${encodeURIComponent(sourceId)}/text`).set(as(acmeToken));
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ sourceId, title: 'Opening hours', text: original });

      const before = await KnowledgeChunk.findOne({ company: acme._id, sourceId }).lean();

      const saved = await request(app)
        .put(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`)
        .set(as(acmeToken))
        .send({ title: 'Opening hours (summer)', text: 'Open every day in August, 10am to 4pm.' });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ sourceId, title: 'Opening hours (summer)', chunks: 1 });

      const chunks = await KnowledgeChunk.find({ company: acme._id, sourceId }).lean();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toContain('August');
      expect(chunks[0].content).not.toContain('bank holidays');
      // A new import replaced the old one rather than editing it in place.
      expect(chunks[0].importId).not.toBe(before.importId);
      expect(chunks[0].metadata.title).toBe('Opening hours (summer)');

      const reread = await request(app).get(`/api/knowledge/sources/${encodeURIComponent(sourceId)}/text`).set(as(acmeToken));
      expect(reread.body.text).toBe('Open every day in August, 10am to 4pm.');
    });

    test('a note from before the text was kept is put back together without the overlaps', async () => {
      const sentence = index => `Sentence number ${index} explains one more detail of the returns policy.`;
      const original = Array.from({ length: 60 }, (_, index) => sentence(index)).join(' ');
      const chunks = new KnowledgeConnectorService().splitIntoChunks(original, 1000);
      expect(chunks.length).toBeGreaterThan(2);

      // Stored straight into the vector store, as older notes were: no text kept.
      await getVectorStore().store(
        chunks.map((content, index) => ({ content, chunkIndex: index, metadata: { title: 'Returns', source: 'manual' } })),
        { companyId: acme._id, sourceId: 'text:legacy-note', sourceType: 'manual' }
      );

      const note = await knowledgeText.readText(acme._id, 'text:legacy-note');
      expect(note.title).toBe('Returns');
      expect(note.text).toBe(original);
    });

    test('another company cannot read or overwrite it', async () => {
      const { sourceId } = (await paste({ title: 'Secret', text: 'Our supplier is Widgets Ltd.' })).body;

      const read = await request(app).get(`/api/knowledge/sources/${encodeURIComponent(sourceId)}/text`).set(as(rivalToken));
      expect(read.status).toBe(404);

      const write = await request(app)
        .put(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`)
        .set(as(rivalToken))
        .send({ text: 'Overwritten' });
      expect(write.status).toBe(404);

      const chunks = await KnowledgeChunk.find({ sourceId }).lean();
      expect(chunks.every(chunk => String(chunk.company) === String(acme._id))).toBe(true);
      expect(chunks[0].content).toContain('Widgets Ltd');
      expect(await KnowledgeChunk.countDocuments({ company: rival._id })).toBe(0);
    });

    test('only pasted text can be edited, and not to nothing', async () => {
      await getVectorStore().store([{ content: 'A web page.', metadata: { url: 'https://example.com/a' } }],
        { companyId: acme._id, sourceId: 'url:https://example.com/a', sourceType: 'url' });

      const page = encodeURIComponent('url:https://example.com/a');
      expect((await request(app).get(`/api/knowledge/sources/${page}/text`).set(as(acmeToken))).status).toBe(400);
      expect((await request(app).put(`/api/knowledge/sources/${page}`).set(as(acmeToken)).send({ text: 'x' })).status).toBe(400);

      const { sourceId } = (await paste({ title: 'Note', text: 'Something.' })).body;
      const empty = await request(app).put(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`)
        .set(as(acmeToken)).send({ text: '   ' });
      expect(empty.status).toBe(400);
    });

    test('removing a note forgets its text too', async () => {
      const { sourceId } = (await paste({ title: 'Gone', text: 'Soon removed.' })).body;
      expect(await KnowledgeSource.countDocuments({ company: acme._id, sourceId })).toBe(1);

      const removed = await request(app).delete(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`).set(as(acmeToken));
      expect(removed.status).toBe(200);
      expect(await KnowledgeSource.countDocuments({ company: acme._id, sourceId })).toBe(0);
    });
  });

  describe('the weekly refresh switch', () => {
    test('is offered for web pages and remembered on the list', async () => {
      const sourceId = 'url:https://example.com/prices';
      await getVectorStore().store([{ content: 'Kettles cost £25.', metadata: { url: 'https://example.com/prices', title: 'Prices' } }],
        { companyId: acme._id, sourceId, sourceType: 'url' });

      const response = await request(app)
        .patch(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`)
        .set(as(acmeToken))
        .send({ refreshWeekly: true });
      expect(response.status).toBe(200);
      expect(response.body.refreshWeekly).toBe(true);
      // The week starts from now, not from "never", so it is not due at once.
      expect(response.body.lastRefreshedAt).toBeTruthy();

      const listing = await request(app).get('/api/knowledge').set(as(acmeToken));
      const prices = listing.body.sources.find(source => source.sourceId === sourceId);
      expect(prices).toMatchObject({ refreshWeekly: true, refreshable: true, editable: false });
    });

    test('is refused for a note, a missing source or another company\'s page', async () => {
      const { sourceId } = (await paste({ title: 'Note', text: 'Text.' })).body;
      expect((await request(app).patch(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`)
        .set(as(acmeToken)).send({ refreshWeekly: true })).status).toBe(400);

      expect((await request(app).patch(`/api/knowledge/sources/${encodeURIComponent('url:https://nowhere.example/')}`)
        .set(as(acmeToken)).send({ refreshWeekly: true })).status).toBe(404);

      const page = 'url:https://example.com/acme-only';
      await getVectorStore().store([{ content: 'Acme only.' }], { companyId: acme._id, sourceId: page, sourceType: 'url' });
      expect((await request(app).patch(`/api/knowledge/sources/${encodeURIComponent(page)}`)
        .set(as(rivalToken)).send({ refreshWeekly: true })).status).toBe(404);
    });
  });

  describe('what the list says about each source', () => {
    test('counts the answers that cited it over the last 30 days', async () => {
      await paste({ title: 'Opening hours', text: 'Open 9 to 5.' });
      const pageId = 'url:https://example.com/delivery';
      await getVectorStore().store([{ content: 'Delivery takes three days.', metadata: { url: 'https://example.com/delivery', title: 'Delivery' } }],
        { companyId: acme._id, sourceId: pageId, sourceType: 'url' });

      const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const bot = (sources, timestamp = new Date()) => ({ sender: 'bot', content: 'An answer.', sources, timestamp });

      await Conversation.create({
        sessionId: `ws3k-${Date.now()}-1`,
        company: acme._id,
        lastActivity: new Date(),
        messages: [
          { sender: 'user', content: 'When are you open?' },
          bot([{ title: 'Opening hours', url: null }]),
          bot([{ title: 'Opening hours', url: null }, { title: 'Delivery', url: 'https://example.com/delivery' }]),
          // Too long ago to count.
          bot([{ title: 'Opening hours', url: null }], old)
        ]
      });
      // Another tenant citing a source with the same title does not count here.
      await Conversation.create({
        sessionId: `ws3k-${Date.now()}-2`,
        company: rival._id,
        lastActivity: new Date(),
        messages: [bot([{ title: 'Opening hours', url: null }])]
      });

      const listing = await request(app).get('/api/knowledge').set(as(acmeToken));
      const hours = listing.body.sources.find(source => source.title === 'Opening hours');
      const delivery = listing.body.sources.find(source => source.sourceId === pageId);

      expect(listing.body.usageWindowDays).toBe(30);
      expect(hours.usedInAnswers).toBe(2);
      expect(delivery.usedInAnswers).toBe(1);
      expect(delivery.url).toBe('https://example.com/delivery');
    });

    test('a search result says which source it came from', async () => {
      await paste({ title: 'Returns policy', text: 'Returns are accepted within thirty days of delivery.' });
      await getVectorStore().store([{ content: 'Returns of opened items need a receipt.', metadata: { url: 'https://example.com/returns', title: 'Returns page' } }],
        { companyId: acme._id, sourceId: 'url:https://example.com/returns', sourceType: 'url' });

      const response = await request(app).post('/api/knowledge/search').set(as(acmeToken)).send({ query: 'returns' });
      expect(response.status).toBe(200);

      const titles = response.body.results.map(result => result.title);
      expect(titles).toEqual(expect.arrayContaining(['Returns policy', 'Returns page']));
      const page = response.body.results.find(result => result.title === 'Returns page');
      expect(page.url).toBe('https://example.com/returns');
      const note = response.body.results.find(result => result.title === 'Returns policy');
      expect(note.url).toBeNull();
    });

    test('the Google Sheets card is offered only when switched on', async () => {
      delete process.env.GOOGLE_SHEETS_UI;
      expect((await request(app).get('/api/knowledge').set(as(acmeToken))).body.features).toEqual({ googleSheets: false });

      process.env.GOOGLE_SHEETS_UI = 'true';
      expect((await request(app).get('/api/knowledge').set(as(acmeToken))).body.features).toEqual({ googleSheets: true });
      delete process.env.GOOGLE_SHEETS_UI;
    });
  });
});
