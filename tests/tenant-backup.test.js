/**
 * Per-tenant backup and restore.
 *
 * The property under test throughout: a restore touches exactly one company.
 * A recovery tool that reaches a neighbour's data is worse than no recovery
 * tool, because it is used on the worst day somebody is having.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const TenantBackupService = require('../services/tenant-backup');
const Company = require('../models/company');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const Workflow = require('../models/workflow');
const Task = require('../models/task');
const Comment = require('../models/comment');

describe('Per-tenant backup', () => {
  let service;
  let backupDir;
  let acme;
  let globex;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-backup-'));
    service = new TenantBackupService({ backupDir });

    acme = await Company.create({ name: 'Acme Backup' });
    globex = await Company.create({ name: 'Globex Backup' });
  });

  afterEach(async () => {
    await Conversation.deleteMany({ sessionId: /^backup-/ });
    await Workflow.deleteMany({ name: /^Backup / });
    await Comment.deleteMany({ content: /^backup-/ });
    await Task.deleteMany({ title: /^Backup / });
  });

  afterAll(async () => {
    await User.deleteMany({ email: /@backup\.example$/ });
    await Company.deleteMany({ name: /Backup$/ });
    fs.rmSync(backupDir, { recursive: true, force: true });
    await mongoose.connection.close();
  });

  describe('what it covers', () => {
    it('finds tenant-scoped collections from the schemas rather than a list', () => {
      const { direct } = service.plan();
      const names = direct.map(entry => entry.name);

      expect(names).toEqual(expect.arrayContaining(['Company', 'Conversation', 'Task', 'Workflow', 'User']));
    });

    it('says what it does not cover instead of quietly omitting it', async () => {
      const manifest = await service.backupCompany(acme._id);

      expect(Array.isArray(manifest.notCovered.collections)).toBe(true);
      expect(manifest.notCovered.notes.join(' ')).toMatch(/uploads/i);
    });
  });

  describe('backing up', () => {
    it('writes one company\'s documents and none of another\'s', async () => {
      await Conversation.create({ sessionId: 'backup-acme-1', company: acme._id, messages: [{ content: 'hello', sender: 'user' }] });
      await Conversation.create({ sessionId: 'backup-globex-1', company: globex._id, messages: [{ content: 'private', sender: 'user' }] });

      const manifest = await service.backupCompany(acme._id);
      const written = service.read(service.directoryFor(acme._id, manifest.timestamp), 'Conversation');

      expect(written.map(doc => doc.sessionId)).toEqual(['backup-acme-1']);
    });

    it('keeps ids and dates as themselves, so a restore is not a pile of strings', async () => {
      const conversation = await Conversation.create({
        sessionId: 'backup-types', company: acme._id, messages: [{ content: 'x', sender: 'user' }]
      });

      const manifest = await service.backupCompany(acme._id);
      const [restoredShape] = service.read(service.directoryFor(acme._id, manifest.timestamp), 'Conversation')
        .filter(doc => doc.sessionId === 'backup-types');

      expect(restoredShape._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(restoredShape._id.equals(conversation._id)).toBe(true);
      expect(restoredShape.startedAt).toBeInstanceOf(Date);
    });

    it('collects what hangs off a parent, not only what carries a company field', async () => {
      const task = await Task.create({
        title: 'Backup Task',
        description: 'A task with a comment hanging off it',
        dueDate: new Date(),
        company: acme._id,
        createdBy: new mongoose.Types.ObjectId()
      });
      await Comment.create({
        taskId: task._id,
        content: 'backup-comment',
        author: new mongoose.Types.ObjectId(),
        authorName: 'tester'
      });

      const manifest = await service.backupCompany(acme._id);

      expect(manifest.collections.Comment).toBe(1);
    });

    it('lists a company\'s backups newest first', async () => {
      const first = await service.backupCompany(acme._id);
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await service.backupCompany(acme._id);

      const listed = service.listBackups(acme._id).map(entry => entry.timestamp);
      expect(listed.indexOf(second.timestamp)).toBeLessThan(listed.indexOf(first.timestamp));
    });
  });

  describe('restoring', () => {
    it('brings back what was deleted', async () => {
      await Conversation.create({ sessionId: 'backup-restore-me', company: acme._id, messages: [{ content: 'important', sender: 'user' }] });

      const manifest = await service.backupCompany(acme._id);
      await Conversation.deleteOne({ sessionId: 'backup-restore-me' });

      await service.restoreCompany(acme._id, manifest.timestamp);

      const restored = await Conversation.findOne({ sessionId: 'backup-restore-me' });
      expect(restored.messages[0].content).toBe('important');
    });

    it('leaves other tenants entirely alone', async () => {
      await Conversation.create({ sessionId: 'backup-acme-2', company: acme._id, messages: [{ content: 'a', sender: 'user' }] });
      const manifest = await service.backupCompany(acme._id);

      await Conversation.create({ sessionId: 'backup-globex-2', company: globex._id, messages: [{ content: 'b', sender: 'user' }] });
      await service.restoreCompany(acme._id, manifest.timestamp, { mode: 'replace' });

      // Globex's conversation was created after Acme's backup and must survive
      // even the destructive mode.
      expect(await Conversation.findOne({ sessionId: 'backup-globex-2' })).not.toBeNull();
    });

    it('merges by default, so a restore cannot itself delete anything', async () => {
      const manifest = await service.backupCompany(acme._id);
      await Conversation.create({ sessionId: 'backup-newer', company: acme._id, messages: [{ content: 'since', sender: 'user' }] });

      await service.restoreCompany(acme._id, manifest.timestamp);

      expect(await Conversation.findOne({ sessionId: 'backup-newer' })).not.toBeNull();
    });

    it('drops what happened since when asked to replace', async () => {
      const manifest = await service.backupCompany(acme._id);
      await Conversation.create({ sessionId: 'backup-newer-2', company: acme._id, messages: [{ content: 'since', sender: 'user' }] });

      const result = await service.restoreCompany(acme._id, manifest.timestamp, { mode: 'replace' });

      expect(await Conversation.findOne({ sessionId: 'backup-newer-2' })).toBeNull();
      expect(result.removed.Conversation).toBe(1);
    });

    it('puts an edited document back as it was', async () => {
      const workflow = await Workflow.create({
        name: 'Backup Flow',
        company: acme._id,
        nodes: [],
        edges: [],
        createdBy: new mongoose.Types.ObjectId()
      });
      const manifest = await service.backupCompany(acme._id);

      await Workflow.updateOne({ _id: workflow._id }, { name: 'Backup Flow ruined' });
      await service.restoreCompany(acme._id, manifest.timestamp);

      expect((await Workflow.findById(workflow._id)).name).toBe('Backup Flow');
    });

    it('carries the credentials a model hides, so a restore does not wipe them', async () => {
      const ChannelAccount = require('../models/channel-account');
      // Written straight to the collection: the point is the hidden fields,
      // not the account's validation.
      const { insertedId } = await ChannelAccount.collection.insertOne({
        company: acme._id, provider: 'whatsapp', phoneNumberId: 'backup-hidden-1',
        accessToken: 'encrypted-token-value', appSecret: 'encrypted-secret-value'
      });
      try {
        const manifest = await service.backupCompany(acme._id);

        // A replace restore rewrites each document whole.
        await service.restoreCompany(acme._id, manifest.timestamp, { mode: 'replace' });

        const restored = await ChannelAccount.findById(insertedId).select('+accessToken +appSecret').lean();
        expect(restored).toMatchObject({ accessToken: 'encrypted-token-value', appSecret: 'encrypted-secret-value' });
      } finally {
        await ChannelAccount.collection.deleteOne({ _id: insertedId });
      }
    });

    it('refuses a backup belonging to another company', async () => {
      const manifest = await service.backupCompany(globex._id);

      // The directory is addressed by company, so getting here means somebody
      // moved files around - which is exactly when a wrong restore becomes a
      // breach rather than a mistake.
      const wrongPlace = service.directoryFor(acme._id, manifest.timestamp);
      fs.mkdirSync(wrongPlace, { recursive: true });
      fs.copyFileSync(
        path.join(service.directoryFor(globex._id, manifest.timestamp), 'manifest.json'),
        path.join(wrongPlace, 'manifest.json')
      );

      await expect(service.restoreCompany(acme._id, manifest.timestamp))
        .rejects.toThrow(/different company/);
    });

    it('never restores the audit log, which would let a restore rewrite the record', async () => {
      const manifest = await service.backupCompany(acme._id);
      const result = await service.restoreCompany(acme._id, manifest.timestamp);

      expect(result.restored.AuditLog).toBeUndefined();
    });

    it('rejects a backup id that tries to climb out of the backup directory', async () => {
      await expect(service.restoreCompany(acme._id, '../../../etc'))
        .rejects.toThrow(/Invalid backup id/);
    });
  });

  describe('housekeeping', () => {
    it('removes backups past the retention window', async () => {
      const short = new TenantBackupService({ backupDir, retentionDays: 0 });
      const manifest = await short.backupCompany(acme._id);

      // Age it by a day so the cutoff has something to bite on.
      const dir = short.directoryFor(acme._id, manifest.timestamp);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      fs.utimesSync(dir, yesterday, yesterday);

      expect(short.cleanup().removed).toBeGreaterThan(0);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  describe('the API', () => {
    let app;
    let superadminToken;
    let adminToken;

    beforeAll(async () => {
      app = express();
      app.use(express.json());
      app.use('/api/auth', require('../routes/auth'));
      app.use('/api/operations', require('../routes/operations'));

      await User.create({
        username: 'backup-super', email: 'super@backup.example',
        password: 'TestPassword123!', role: 'superadmin'
      });
      await User.create({
        username: 'backup-admin', email: 'admin@backup.example',
        password: 'TestPassword123!', role: 'company_admin', company: acme._id
      });

      const login = async (username) => (await request(app)
        .post('/api/auth/login')
        .send({ username, password: 'TestPassword123!' })).body.token;

      superadminToken = await login('backup-super');
      adminToken = await login('backup-admin');
    });

    it('creates a backup for one company', async () => {
      const response = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups`)
        .set('x-auth-token', superadminToken);

      expect(response.status).toBe(200);
      expect(response.body.backup.company.name).toBe('Acme Backup');
    });

    it('is closed to a company admin, who could otherwise restore over their own history', async () => {
      const response = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(403);
    });

    it('will not replace a tenant without the name typed out', async () => {
      const created = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups`)
        .set('x-auth-token', superadminToken);

      const response = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups/${created.body.backup.timestamp}/restore`)
        .set('x-auth-token', superadminToken)
        .send({ mode: 'replace' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Acme Backup/);
    });

    it('restores in merge mode without ceremony, because it cannot delete anything', async () => {
      const created = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups`)
        .set('x-auth-token', superadminToken);

      const response = await request(app)
        .post(`/api/operations/companies/${acme._id}/backups/${created.body.backup.timestamp}/restore`)
        .set('x-auth-token', superadminToken)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.result.mode).toBe('merge');
    });

    it('404s for a company that does not exist', async () => {
      const response = await request(app)
        .post(`/api/operations/companies/${new mongoose.Types.ObjectId()}/backups`)
        .set('x-auth-token', superadminToken);

      expect(response.status).toBe(404);
    });
  });
});
