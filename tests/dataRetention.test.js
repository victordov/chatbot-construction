/**
 * Data retention.
 *
 * The previous suite mocked the Conversation model, which meant it asserted
 * that the service called the mocks it had been given - and the service had
 * been written to satisfy them, down to a branch that returned "the first two
 * conversations" when the ids were literally `conversation1` and
 * `conversation2`. None of it touched a database, and `anonymize()` did not
 * exist on the model at all, so the anonymisation path would have thrown the
 * first time it ran in production.
 *
 * These run against the real model, and cover the property that matters now
 * that policies are per tenant: one company's policy must never reach another
 * company's data.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const DataRetentionService = require('../services/dataRetention');
const uploads = require('../services/uploads');
const Conversation = require('../models/conversation');
const Company = require('../models/company');
const User = require('../models/user');

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** A conversation with an upload, and the file on disk the upload route would have written. */
const conversationWithFile = async (company, sessionId, ageInDays, fileId) => {
  const conversation = await conversationFor(company, sessionId, ageInDays, {
    messages: [
      { content: '[File uploaded: id.png]', sender: 'user', fileId, fileName: 'id.png', timestamp: daysAgo(ageInDays) }
    ]
  });
  const target = uploads.filePath(company._id, fileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'a scan of a passport');
  return { conversation, target };
};

const conversationFor = (company, sessionId, ageInDays, extra = {}) => Conversation.create({
  sessionId,
  company: company ? company._id : undefined,
  lastActivity: daysAgo(ageInDays),
  startedAt: daysAgo(ageInDays),
  messages: [
    { content: 'my email is bea@example.com', sender: 'user', timestamp: daysAgo(ageInDays) },
    { content: 'thanks, I have it', sender: 'operator', timestamp: daysAgo(ageInDays) }
  ],
  ...extra
});

describe('Data retention', () => {
  let acme;
  let globex;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({ name: 'Acme Retention' });
    globex = await Company.create({ name: 'Globex Retention' });
  });

  afterEach(async () => {
    await Conversation.deleteMany({ sessionId: /^retention-/ });
    await Company.updateMany(
      { _id: { $in: [acme._id, globex._id] } },
      { $unset: { dataRetention: 1 } }
    );
  });

  afterAll(async () => {
    await User.deleteMany({ email: /@retention\.example$/ });
    await Company.deleteMany({ name: /Retention$/ });
    await uploads.deleteCompanyFiles(acme._id);
    await uploads.deleteCompanyFiles(globex._id);
    await mongoose.connection.close();
  });

  describe('the policy', () => {
    it('uses the platform default when a company has not chosen', () => {
      const service = new DataRetentionService({ anonymizeAfterDays: 90, deleteAfterDays: 365 });

      expect(service.policyFor({ name: 'nobody' })).toMatchObject({
        anonymizeAfterDays: 90,
        deleteAfterDays: 365,
        source: { anonymizeAfterDays: 'platform', deleteAfterDays: 'platform' }
      });
    });

    it('lets a company be stricter than the platform', () => {
      const service = new DataRetentionService({ anonymizeAfterDays: 90, deleteAfterDays: 365 });
      const policy = service.policyFor({ dataRetention: { anonymizeAfterDays: 30, deleteAfterDays: 60 } });

      expect(policy.anonymizeAfterDays).toBe(30);
      expect(policy.deleteAfterDays).toBe(60);
      expect(policy.source.deleteAfterDays).toBe('company');
    });

    it('treats 0 as "never", not as "unset"', () => {
      const service = new DataRetentionService({ deleteAfterDays: 365 });
      const policy = service.policyFor({ dataRetention: { deleteAfterDays: 0 } });

      // Falling back here would delete the data of a tenant who had explicitly
      // said not to.
      expect(policy.deleteAfterDays).toBe(0);
      expect(policy.source.deleteAfterDays).toBe('company');
    });

    it('keeps everything when nothing is configured anywhere', () => {
      const service = new DataRetentionService();

      expect(service.policyFor(null)).toMatchObject({ anonymizeAfterDays: 0, deleteAfterDays: 0 });
    });
  });

  describe('the sweep', () => {
    it('applies one company policy to that company only', async () => {
      await conversationFor(acme, 'retention-acme-old', 100);
      await conversationFor(globex, 'retention-globex-old', 100);

      const service = new DataRetentionService();
      await service.sweepCompany(acme._id, { anonymizeAfterDays: 0, deleteAfterDays: 30 });

      expect(await Conversation.findOne({ sessionId: 'retention-acme-old' })).toBeNull();
      // The whole point of a per-tenant policy: Globex kept theirs.
      expect(await Conversation.findOne({ sessionId: 'retention-globex-old' })).not.toBeNull();
    });

    it('leaves conversations inside the window alone', async () => {
      await conversationFor(acme, 'retention-recent', 10);

      const service = new DataRetentionService();
      await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 90 });

      const conversation = await Conversation.findOne({ sessionId: 'retention-recent' });
      expect(conversation.anonymizedAt).toBeUndefined();
      expect(conversation.messages[0].content).toBe('my email is bea@example.com');
    });

    it('anonymises the middle of the window and deletes past the end of it', async () => {
      await conversationFor(acme, 'retention-middle', 60);
      await conversationFor(acme, 'retention-ancient', 400);

      const service = new DataRetentionService();
      const result = await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 365 });

      expect(result).toMatchObject({ deleted: 1, anonymized: 1 });
      expect(await Conversation.findOne({ sessionId: 'retention-ancient' })).toBeNull();

      const scrubbed = await Conversation.findOne({ sessionId: 'retention-middle' });
      expect(scrubbed.messages.map(m => m.content)).toEqual(['[removed]', '[removed]']);
      expect(scrubbed.anonymizedAt).toBeInstanceOf(Date);
    });

    it('does not anonymise the same conversation twice', async () => {
      await conversationFor(acme, 'retention-once', 60);

      const service = new DataRetentionService();
      const first = await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 0 });
      const second = await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 0 });

      expect(first.anonymized).toBe(1);
      expect(second.anonymized).toBe(0);
    });

    it('sweeps every tenant with its own policy in one run', async () => {
      await Company.updateOne({ _id: acme._id }, { dataRetention: { deleteAfterDays: 30 } });
      await Company.updateOne({ _id: globex._id }, { dataRetention: { deleteAfterDays: 0 } });

      await conversationFor(acme, 'retention-acme-sweep', 100);
      await conversationFor(globex, 'retention-globex-sweep', 100);

      const service = new DataRetentionService({ deleteAfterDays: 365 });
      const summary = await service.runCleanup();

      expect(summary.deleted).toBe(1);
      expect(await Conversation.findOne({ sessionId: 'retention-acme-sweep' })).toBeNull();
      expect(await Conversation.findOne({ sessionId: 'retention-globex-sweep' })).not.toBeNull();
    });

    it('carries on with the other tenants when one fails', async () => {
      await Company.updateMany(
        { _id: { $in: [acme._id, globex._id] } },
        { dataRetention: { deleteAfterDays: 30 } }
      );
      await conversationFor(globex, 'retention-survivor', 100);

      const service = new DataRetentionService();
      const original = service.sweepCompany.bind(service);
      let firstCall = true;
      service.sweepCompany = async (companyId, policy) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('database hiccup');
        }
        return original(companyId, policy);
      };

      const summary = await service.runCleanup();
      expect(summary.deleted).toBe(1);
    });

    it('applies the platform policy to conversations that belong to no company', async () => {
      await conversationFor(null, 'retention-orphan', 500);

      const service = new DataRetentionService({ deleteAfterDays: 365 });
      await service.runCleanup();

      expect(await Conversation.findOne({ sessionId: 'retention-orphan' })).toBeNull();
    });

    it('deletes the files of a conversation it deletes', async () => {
      const { target } = await conversationWithFile(acme, 'retention-file-delete', 400, 'c'.repeat(32));
      expect(fs.existsSync(target)).toBe(true);

      const service = new DataRetentionService();
      await service.sweepCompany(acme._id, { anonymizeAfterDays: 0, deleteAfterDays: 365 });

      // A deleted conversation with its attachment still on disk is not
      // deleted; it is merely unfindable.
      expect(await Conversation.findOne({ sessionId: 'retention-file-delete' })).toBeNull();
      expect(fs.existsSync(target)).toBe(false);
    });

    it('deletes the files of a conversation it anonymises', async () => {
      const { target } = await conversationWithFile(acme, 'retention-file-scrub', 60, 'd'.repeat(32));

      const service = new DataRetentionService();
      await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 0 });

      const scrubbed = await Conversation.findOne({ sessionId: 'retention-file-scrub' });
      expect(scrubbed.messages[0].fileId).toBeUndefined();
      expect(fs.existsSync(target)).toBe(false);
    });

    it('stops at the per-run ceiling rather than holding the database open', async () => {
      for (let i = 0; i < 5; i += 1) {
        await conversationFor(acme, `retention-many-${i}`, 100);
      }

      const service = new DataRetentionService({ batchSize: 2, maxPerRun: 3 });
      const result = await service.sweepCompany(acme._id, { anonymizeAfterDays: 30, deleteAfterDays: 0 });

      expect(result.anonymized).toBe(3);
      expect(await Conversation.countDocuments({
        sessionId: /^retention-many-/,
        anonymizedAt: { $exists: false }
      })).toBe(2);
    });
  });

  describe('anonymising', () => {
    it('removes what identifies the person and keeps what a report needs', async () => {
      const conversation = await conversationFor(acme, 'retention-scrub', 100, {
        userId: 'crm-4471',
        domain: 'https://acme.test',
        email: { from: 'bea@example.com', to: 'help@acme.test', subject: 'My order', messageIds: ['<a@b>'] },
        rating: { score: 4, comment: 'Bea was great, call me on 07700 900123', ratedAt: new Date(), handledBy: 'operator' }
      });

      await conversation.anonymize();
      const stored = await Conversation.findById(conversation._id);

      expect(stored.userId).toBeUndefined();
      expect(stored.domain).toBeUndefined();
      expect(stored.email.from).toBeUndefined();
      expect(stored.email.messageIds).toEqual([]);
      expect(stored.rating.comment).toBeUndefined();

      // What every report is built from survives.
      expect(stored.rating.score).toBe(4);
      expect(stored.messages).toHaveLength(2);
      expect(stored.messages[0].sender).toBe('user');
      expect(stored.startedAt).toBeInstanceOf(Date);
    });

    it('is idempotent, so a second sweep is not a second rewrite', async () => {
      const conversation = await conversationFor(acme, 'retention-idempotent', 100);

      await conversation.anonymize();
      const firstPass = (await Conversation.findById(conversation._id)).anonymizedAt;

      await (await Conversation.findById(conversation._id)).anonymize();
      const secondPass = (await Conversation.findById(conversation._id)).anonymizedAt;

      expect(secondPass.getTime()).toBe(firstPass.getTime());
    });
  });

  describe('the API', () => {
    let app;
    let token;

    beforeAll(async () => {
      app = express();
      app.use(express.json());
      app.use('/api/auth', require('../routes/auth'));
      app.use('/api/companies', require('../routes/company'));

      await User.create({
        username: 'retention-admin',
        email: 'admin@retention.example',
        password: 'TestPassword123!',
        role: 'company_admin',
        company: acme._id
      });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'retention-admin', password: 'TestPassword123!' });
      token = login.body.token;
    });

    it('reports the effective policy and what it would cost to apply', async () => {
      await conversationFor(acme, 'retention-api-old', 200);
      await Company.updateOne({ _id: acme._id }, { dataRetention: { deleteAfterDays: 30 } });

      const response = await request(app)
        .get('/api/companies/me/retention')
        .set('x-auth-token', token);

      expect(response.status).toBe(200);
      expect(response.body.effective.deleteAfterDays).toBe(30);
      // An admin should see the damage before the sweep does it.
      expect(response.body.impact.toDelete).toBe(1);
    });

    it('saves a policy of the tenant\'s own', async () => {
      const response = await request(app)
        .put('/api/companies/me/retention')
        .set('x-auth-token', token)
        .send({ anonymizeAfterDays: 30, deleteAfterDays: 90 });

      expect(response.status).toBe(200);

      const stored = await Company.findById(acme._id).lean();
      expect(stored.dataRetention.anonymizeAfterDays).toBe(30);
      expect(stored.dataRetention.updatedBy).toBe('retention-admin');
    });

    it('refuses a policy that would delete conversations before anonymising them', async () => {
      const response = await request(app)
        .put('/api/companies/me/retention')
        .set('x-auth-token', token)
        .send({ anonymizeAfterDays: 90, deleteAfterDays: 30 });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/before they are anonymised/);
    });

    it('accepts 0 as never, and null as "follow the platform"', async () => {
      await request(app)
        .put('/api/companies/me/retention')
        .set('x-auth-token', token)
        .send({ anonymizeAfterDays: 0, deleteAfterDays: null });

      const stored = await Company.findById(acme._id).lean();
      expect(stored.dataRetention.anonymizeAfterDays).toBe(0);
      expect(stored.dataRetention.deleteAfterDays ?? null).toBeNull();
    });

    it('rejects nonsense rather than storing it', async () => {
      const response = await request(app)
        .put('/api/companies/me/retention')
        .set('x-auth-token', token)
        .send({ deleteAfterDays: 'soon' });

      expect(response.status).toBe(400);
    });

    it('is closed to operators, who cannot change what the company keeps', async () => {
      await User.create({
        username: 'retention-operator',
        email: 'op@retention.example',
        password: 'TestPassword123!',
        role: 'operator',
        company: acme._id
      });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'retention-operator', password: 'TestPassword123!' });

      const response = await request(app)
        .put('/api/companies/me/retention')
        .set('x-auth-token', login.body.token)
        .send({ deleteAfterDays: 1 });

      expect(response.status).toBe(403);
    });
  });
});
