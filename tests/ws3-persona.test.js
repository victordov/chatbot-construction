/**
 * Persona & replies: the guided builder's answers, the prompt in effect, a
 * persona drafted from the tenant's own material, canned replies whose test
 * does not count as use, and an audit trail of who changed what the bot says.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const AuditLog = require('../models/audit-log');
const AssistantProfile = require('../models/assistant-profile');
const ResponseTemplate = require('../models/response-template');
const KnowledgeChunk = require('../models/knowledge-chunk');
const KnowledgeSource = require('../models/knowledge-source');
const assistantConfig = require('../services/assistant-config');
const knowledgeText = require('../services/knowledge-text');
const botPersona = require('../routes/bot-persona');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/templates', require('../routes/templates'));
  app.use('/api/bot', botPersona);
  return app;
};

describe('persona and replies', () => {
  let app;
  let company;
  let token;

  const as = () => ({ 'x-auth-token': token });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    company = await Company.create({ name: 'WS3 Persona Co' });
    await User.create({
      username: 'ws3p-dana', email: 'dana@ws3p.example', password: 'TestPassword123!',
      role: 'company_admin', company: company._id, displayName: 'Dana'
    });
    token = (await request(app).post('/api/auth/login')
      .send({ username: 'ws3p-dana', password: 'TestPassword123!' })).body.token;
  });

  afterAll(async () => {
    botPersona.__setClientFactoryForTests(null);
    await Promise.all([
      User.deleteMany({ email: /@ws3p\.example$/ }),
      Company.deleteOne({ _id: company._id }),
      AuditLog.deleteMany({ company: company._id }),
      AssistantProfile.deleteMany({ company: company._id }),
      ResponseTemplate.deleteMany({ company: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id }),
      KnowledgeSource.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    botPersona.__setClientFactoryForTests(null);
    assistantConfig.invalidate(company._id);
  });

  describe('the persona', () => {
    test('saves the builder\'s answers and audits which fields changed, not their text', async () => {
      const builder = {
        businessName: 'Bloom Dental',
        whatYouDo: 'a family dental practice in Leeds',
        tone: 'professional',
        neverGuess: ['prices', 'medical advice', 'not-an-option'],
        neverGuessOther: 'insurance cover',
        handover: 'someone is in pain'
      };

      const saved = await request(app).put('/api/templates/assistant/config').set(as())
        .send({ persona: 'You are the assistant for Bloom Dental.', scope: '', builder });
      expect(saved.status).toBe(200);

      const config = await request(app).get('/api/templates/assistant/config').set(as());
      expect(config.body.persona).toBe('You are the assistant for Bloom Dental.');
      expect(config.body.builder).toEqual({
        businessName: 'Bloom Dental',
        whatYouDo: 'a family dental practice in Leeds',
        tone: 'professional',
        // Only the offered choices are kept.
        neverGuess: ['prices', 'medical advice'],
        neverGuessOther: 'insurance cover',
        handover: 'someone is in pain'
      });
      expect(config.body.builderOptions.tones).toEqual(['friendly', 'professional', 'brief']);

      const entry = await AuditLog.findOne({ company: company._id, action: 'assistant.updated' }).sort({ at: -1 }).lean();
      expect(entry.details).toEqual({ changed: ['persona'] });
      expect(JSON.stringify(entry)).not.toContain('Bloom Dental');

      // Saving the same text again records nothing new.
      const before = await AuditLog.countDocuments({ company: company._id, action: 'assistant.updated' });
      await request(app).put('/api/templates/assistant/config').set(as())
        .send({ persona: 'You are the assistant for Bloom Dental.', scope: '' });
      expect(await AuditLog.countDocuments({ company: company._id, action: 'assistant.updated' })).toBe(before);
    });

    test('the prompt preview shows the persona in effect, where it came from, and the knowledge wrapper', async () => {
      await request(app).put('/api/templates/assistant/config').set(as())
        .send({ persona: 'You are the assistant for Bloom Dental, a practice in Leeds.', scope: 'dental care and appointments' });

      const preview = await request(app).get('/api/bot/prompt-preview').set(as());
      expect(preview.status).toBe(200);
      expect(preview.body.persona).toMatchObject({ source: 'company', text: expect.stringContaining('Bloom Dental') });
      expect(preview.body.scope.text).toBe('dental care and appointments');
      expect(preview.body.strategy).toBe('informational');
      expect(preview.body.systemPrompt).toContain('You are the assistant for Bloom Dental');
      expect(preview.body.knowledge.appended).toContain('<knowledge>');
      expect(preview.body.knowledge.appended).toMatch(/say plainly that you do not have that information/);
      expect(preview.body.order.length).toBeGreaterThanOrEqual(3);

      const complaint = await request(app).get('/api/bot/prompt-preview')
        .query({ message: 'I have a problem with my filling' }).set(as());
      expect(complaint.body.strategy).toBe('concernResolution');
    });

    test('without a model, drafting says so plainly', async () => {
      botPersona.__setClientFactoryForTests(() => null);
      const response = await request(app).post('/api/bot/persona-draft').set(as()).send({});
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('NO_MODEL');
      expect(response.body.error).toMatch(/OPENAI_API_KEY/);
    });

    test('with nothing in the knowledge base, there is nothing to draft from', async () => {
      await KnowledgeChunk.deleteMany({ company: company._id });
      botPersona.__setClientFactoryForTests(() => ({ chat: { completions: { create: jest.fn() } } }));

      const response = await request(app).post('/api/bot/persona-draft').set(as()).send({});
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('NO_KNOWLEDGE');
    });

    test('drafts from the tenant\'s own material, one draft at a time', async () => {
      await knowledgeText.storeText({
        companyId: company._id,
        title: 'About us',
        text: 'Bloom Dental is a family dental practice in Leeds. We offer check-ups, hygiene and whitening.',
        enforceQuota: false
      });

      let release;
      const create = jest.fn(() => new Promise(resolve => {
        release = () => resolve({ choices: [{ message: { content: 'You are the assistant for Bloom Dental.' } }] });
      }));
      botPersona.__setClientFactoryForTests(() => ({ chat: { completions: { create } } }));

      const first = request(app).post('/api/bot/persona-draft').set(as())
        .send({ builder: { tone: 'friendly' } }).then(response => response);
      // Wait until the first call is with the model.
      for (let attempt = 0; attempt < 100 && !release; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const second = await request(app).post('/api/bot/persona-draft').set(as()).send({});
      expect(second.status).toBe(429);

      release();
      const response = await first;
      expect(response.status).toBe(200);
      expect(response.body.persona).toBe('You are the assistant for Bloom Dental.');
      expect(response.body.basedOn).toContain('About us');

      const [{ messages }] = create.mock.calls[0];
      expect(messages[1].content).toContain('family dental practice');
      expect(messages[1].content).toContain('friendly');
      // The material is fenced as data, not instructions.
      expect(messages[1].content).toContain('<knowledge>');
    });
  });

  describe('canned replies', () => {
    test('trying a message does not count as a use; changes are audited', async () => {
      const created = await request(app).post('/api/templates').set(as()).send({
        name: 'Opening hours',
        triggers: ['what are your opening hours'],
        responses: ['We are open 9 to 5.']
      });
      expect(created.status).toBe(201);
      const id = created.body.template._id;

      const preview = await request(app).post('/api/templates/preview').set(as())
        .send({ message: 'what are your opening hours' });
      expect(preview.status).toBe(200);
      expect(preview.body.matched).toBe(true);
      expect(preview.body.response).toBe('We are open 9 to 5.');

      // Give a fire-and-forget increment, had there been one, time to land.
      await new Promise(resolve => setTimeout(resolve, 50));
      const stored = await ResponseTemplate.findById(id).lean();
      expect(stored.useCount).toBe(0);
      expect(stored.lastUsedAt).toBeUndefined();

      const updated = await request(app).put(`/api/templates/${id}`).set(as()).send({
        name: 'Opening hours', triggers: ['when are you open'], responses: ['9 to 5, Monday to Friday.']
      });
      expect(updated.status).toBe(200);

      const removed = await request(app).delete(`/api/templates/${id}`).set(as());
      expect(removed.status).toBe(200);

      // Audit entries are written without holding up the response.
      let actions = [];
      for (let attempt = 0; attempt < 50 && actions.length < 3; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        actions = (await AuditLog.find({ company: company._id, 'target.id': String(id) }).lean())
          .map(entry => entry.action);
      }
      expect(actions.sort()).toEqual(['template.created', 'template.deleted', 'template.updated']);
    });

    test('the list says when each reply was last used', async () => {
      const lastUsedAt = new Date(Date.now() - 60 * 60 * 1000);
      await ResponseTemplate.create({
        company: company._id, name: 'Parking', triggers: ['parking'], responses: ['Free parking at the back.'],
        useCount: 7, lastUsedAt
      });

      const listing = await request(app).get('/api/templates').set(as());
      const parking = listing.body.templates.find(template => template.name === 'Parking');
      expect(parking.useCount).toBe(7);
      expect(new Date(parking.lastUsedAt).getTime()).toBe(lastUsedAt.getTime());
    });
  });
});
