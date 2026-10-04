/**
 * Uploaded files, and what happens to them when their owner goes.
 *
 * The property under test throughout: removing one company's data touches
 * exactly that company. A purge that reaches a neighbour's files or rows is
 * worse than no purge, because it runs on the day a tenant leaves and nobody
 * is watching the others.
 */

const fs = require('fs');
const mongoose = require('mongoose');

const uploads = require('../services/uploads');
const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Task = require('../models/task');
const WebhookDelivery = require('../models/webhook-delivery');
const KnowledgeChunk = require('../models/knowledge-chunk');
const Usage = require('../models/usage');
const Subscription = require('../models/subscription');

const FILE_A = 'e'.repeat(32);
const FILE_B = 'f'.repeat(32);

const storeFile = (companyId, fileId) => {
  const target = uploads.filePath(companyId, fileId);
  fs.mkdirSync(require('path').dirname(target), { recursive: true });
  fs.writeFileSync(target, `contents of ${fileId}`);
  return target;
};

describe('Uploads service', () => {
  let leaving;
  let staying;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    leaving = await Company.create({ name: 'Uploads Leaving Co' });
    staying = await Company.create({ name: 'Uploads Staying Co' });
  });

  afterAll(async () => {
    const both = { company: { $in: [leaving._id, staying._id] } };
    await Promise.all([
      Conversation.deleteMany(both),
      Contact.deleteMany(both),
      Task.deleteMany(both),
      WebhookDelivery.deleteMany(both),
      KnowledgeChunk.deleteMany(both),
      Usage.deleteMany(both),
      Subscription.deleteMany(both),
      Company.deleteMany({ _id: { $in: [leaving._id, staying._id] } })
    ]);
    await uploads.deleteCompanyFiles(leaving._id);
    await uploads.deleteCompanyFiles(staying._id);
    await mongoose.connection.close();
  });

  describe('where files live', () => {
    it('keeps every tenant under its own directory beneath one root', () => {
      expect(uploads.companyDir(leaving._id).startsWith(uploads.UPLOAD_ROOT)).toBe(true);
      expect(uploads.companyDir(leaving._id)).not.toBe(uploads.companyDir(staying._id));
      expect(uploads.companyDir(null)).toBe(uploads.companyDir(undefined));
    });

    it('refuses to build a path from anything that is not a file id', () => {
      // A fileId comes from the database, and the database is not a trust
      // boundary: a message document with `../../.env` in it must not become
      // a path.
      expect(uploads.filePath(leaving._id, '../../.env')).toBeNull();
      expect(uploads.filePath(leaving._id, '')).toBeNull();
      expect(uploads.filePath(leaving._id, FILE_A)).toContain(FILE_A);
    });
  });

  describe('deleting a conversation\'s files', () => {
    it('removes each file a message refers to and reports how many', async () => {
      const a = storeFile(leaving._id, FILE_A);
      const b = storeFile(leaving._id, FILE_B);

      const removed = await uploads.deleteFilesForConversation({
        company: leaving._id,
        messages: [{ fileId: FILE_A }, { content: 'no file' }, { fileId: FILE_B }]
      });

      expect(removed).toBe(2);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
    });

    it('is not an error when the file is already gone', async () => {
      const removed = await uploads.deleteFilesForConversation({
        company: leaving._id,
        messages: [{ fileId: FILE_A }]
      });

      expect(removed).toBe(0);
    });

    it('finds a session\'s files only within the company given', async () => {
      const target = storeFile(leaving._id, FILE_A);
      await Conversation.create({
        sessionId: 'uploads-session', company: leaving._id,
        messages: [{ content: 'file', sender: 'user', fileId: FILE_A }]
      });

      // The wrong tenant, even with the right session id, reaches nothing.
      expect(await uploads.deleteFilesForSession(staying._id, 'uploads-session')).toBe(0);
      expect(fs.existsSync(target)).toBe(true);

      expect(await uploads.deleteFilesForSession(leaving._id, 'uploads-session')).toBe(1);
      expect(fs.existsSync(target)).toBe(false);

      await Conversation.deleteOne({ sessionId: 'uploads-session' });
    });
  });

  describe('purging a company', () => {
    const seed = async company => {
      const suffix = String(company._id).slice(-6);
      const conversation = await Conversation.create({
        sessionId: `uploads-purge-${suffix}`, company: company._id,
        messages: [{ content: 'hello', sender: 'user', fileId: FILE_A }]
      });
      await Contact.create({ company: company._id, email: `${suffix}@purge.example` });
      await Task.create({
        title: 'Purge task', description: 'x', dueDate: new Date(),
        company: company._id, conversationId: conversation._id
      });
      await WebhookDelivery.create({
        webhook: new mongoose.Types.ObjectId(), company: company._id,
        event: 'conversation.started', payload: { sessionId: conversation.sessionId }
      });
      await KnowledgeChunk.create({
        company: company._id, sourceId: 'purge-source', collectionName: 'purge',
        content: 'some knowledge', embedding: [0.1, 0.2], embeddingSignature: 'sig'
      });
      await Usage.create({ company: company._id, period: Usage.currentPeriod(), conversations: 3 });
      await Subscription.forCompany(company._id);
      return storeFile(company._id, FILE_A);
    };

    const countAll = async company => {
      const scope = { company: company._id };
      const counts = await Promise.all([
        Conversation.countDocuments(scope),
        Contact.countDocuments(scope),
        Task.countDocuments(scope),
        WebhookDelivery.countDocuments(scope),
        KnowledgeChunk.countDocuments(scope),
        Usage.countDocuments(scope),
        Subscription.countDocuments(scope)
      ]);
      return counts.reduce((total, count) => total + count, 0);
    };

    it('removes everything one company left behind, and nothing of its neighbour', async () => {
      const leavingFile = await seed(leaving);
      const stayingFile = await seed(staying);

      const result = await uploads.purgeCompanyData(leaving._id);

      expect(result).toMatchObject({
        files: true,
        conversations: 1,
        contacts: 1,
        tasks: 1,
        webhookDeliveries: 1,
        knowledgeChunks: 1,
        usage: 1,
        subscriptions: 1
      });
      expect(await countAll(leaving)).toBe(0);
      expect(fs.existsSync(leavingFile)).toBe(false);

      // The neighbour is untouched: seven rows and its file.
      expect(await countAll(staying)).toBe(7);
      expect(fs.existsSync(stayingFile)).toBe(true);

      // The company document is the caller's decision, not this function's.
      expect(await Company.findById(leaving._id)).not.toBeNull();
    });

    it('refuses to purge without a company, which would mean the shared directory', async () => {
      await expect(uploads.purgeCompanyData(null)).rejects.toThrow(/company id/i);
    });
  });
});
