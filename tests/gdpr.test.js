/**
 * Data-subject requests find the person, or say they could not.
 *
 * These routes looked up conversations by `Conversation.userId` - a field that
 * is declared and indexed and that nothing in the application ever writes. So
 * every request matched nothing: the export produced an empty file and the
 * erasure answered `success: true, "Deleted 0 conversations"` while writing an
 * audit entry recording that an erasure had been performed.
 *
 * A right-to-be-forgotten endpoint that reports success without deleting
 * anything is worse than one that is broken loudly, because nobody goes
 * looking.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const User = require('../models/user');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Task = require('../models/task');
const WebhookDelivery = require('../models/webhook-delivery');
const uploads = require('../services/uploads');

/** Put a file on disk where the upload route would have put it. */
const storeFile = (companyId, fileId, content = 'attachment body') => {
  const target = uploads.filePath(companyId, fileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/gdpr', require('../routes/gdpr'));
  return app;
};

describe('GDPR data-subject requests', () => {
  let app;
  let company;
  let otherCompany;
  let adminToken;
  let contact;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = buildApp();

    company = await Company.create({ name: 'GDPR Test Co' });
    otherCompany = await Company.create({ name: 'GDPR Other Co' });

    await User.create({
      username: 'gdpr-admin',
      displayName: 'GDPR Admin',
      email: 'admin@gdpr.test',
      password: 'TestPassword123!',
      role: 'company_admin',
      company: company._id
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'gdpr-admin', password: 'TestPassword123!' });

    adminToken = login.body.token;
  });

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ company: { $in: [company._id, otherCompany._id] } }),
      Company.deleteMany({ _id: { $in: [company._id, otherCompany._id] } }),
      Contact.deleteMany({ company: { $in: [company._id, otherCompany._id] } }),
      Conversation.deleteMany({ company: { $in: [company._id, otherCompany._id] } }),
      Task.deleteMany({ company: { $in: [company._id, otherCompany._id] } }),
      WebhookDelivery.deleteMany({ company: { $in: [company._id, otherCompany._id] } })
    ]);
    await uploads.deleteCompanyFiles(company._id);
    await uploads.deleteCompanyFiles(otherCompany._id);
  });

  beforeEach(async () => {
    await Contact.deleteMany({ company: { $in: [company._id, otherCompany._id] } });
    await Conversation.deleteMany({ company: { $in: [company._id, otherCompany._id] } });
    await Task.deleteMany({ company: { $in: [company._id, otherCompany._id] } });
    await WebhookDelivery.deleteMany({ company: { $in: [company._id, otherCompany._id] } });

    contact = await Contact.create({
      company: company._id,
      email: 'subject@example.com',
      name: 'A Subject',
      identityLevel: 'claimed'
    });

    await Conversation.create([
      {
        sessionId: 'gdpr-session-1',
        company: company._id,
        contact: contact._id,
        messages: [{ content: 'my first question', sender: 'user' }]
      },
      {
        sessionId: 'gdpr-session-2',
        company: company._id,
        contact: contact._id,
        messages: [{ content: 'my second question', sender: 'user' }]
      }
    ]);
  });

  describe('finding the person', () => {
    it('finds every conversation for a contact, across sessions', async () => {
      const response = await request(app)
        .get(`/api/gdpr/user-data/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.conversations).toHaveLength(2);
    });

    it('finds a single session by its id', async () => {
      const response = await request(app)
        .get('/api/gdpr/user-data/gdpr-session-1')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.conversations).toHaveLength(1);
      expect(response.body.conversations[0].sessionId).toBe('gdpr-session-1');
    });

    it('says so when the identifier matches nobody', async () => {
      const response = await request(app)
        .get('/api/gdpr/user-data/nobody-by-that-name')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/no data found/i);
    });
  });

  describe('erasure', () => {
    it('actually deletes the conversations', async () => {
      const response = await request(app)
        .delete(`/api/gdpr/user-data/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(2);
      expect(await Conversation.countDocuments({ contact: contact._id })).toBe(0);
    });

    it('refuses rather than reporting a successful erasure of nothing', async () => {
      const response = await request(app)
        .delete('/api/gdpr/user-data/not-a-real-subject')
        .set('x-auth-token', adminToken);

      // The old behaviour: 200 with "Deleted 0 conversations" and an audit
      // entry claiming the erasure was carried out.
      expect(response.status).toBe(404);
      expect(response.body.success).toBeUndefined();
    });

    it('finds the person by email or external id, not only by contact id', async () => {
      await Contact.updateOne({ _id: contact._id }, { $set: { externalId: 'crm-9' } });

      const byEmail = await request(app)
        .delete('/api/gdpr/user-data/subject@example.com')
        .set('x-auth-token', adminToken);

      expect(byEmail.status).toBe(200);
      expect(byEmail.body.conversationsDeleted).toBe(2);
      expect(byEmail.body.contactsDeleted).toBe(1);

      // Gone by every name they had.
      const byExternalId = await request(app)
        .get('/api/gdpr/user-data/crm-9')
        .set('x-auth-token', adminToken);
      expect(byExternalId.status).toBe(404);
    });

    it('removes everything the person is, not only their transcripts', async () => {
      // A visitor becomes a Contact, sends a file, has a task raised about
      // them, and their messages were delivered to the tenant's webhook.
      // Deleting the conversations alone left all four behind.
      const conversation = await Conversation.findOne({ sessionId: 'gdpr-session-1' });
      const fileId = 'a'.repeat(32);
      conversation.messages.push({
        content: '[File uploaded: passport.png]', sender: 'user', fileId, fileName: 'passport.png'
      });
      await conversation.save();
      const stored = storeFile(company._id, fileId);
      expect(fs.existsSync(stored)).toBe(true);

      const task = await Task.create({
        title: 'Call them back',
        description: 'about the refund',
        dueDate: new Date(),
        company: company._id,
        conversationId: conversation._id,
        contactInfo: { name: 'A Subject', email: 'subject@example.com', phone: '07700 900123' }
      });

      await WebhookDelivery.create([
        {
          webhook: new mongoose.Types.ObjectId(), company: company._id,
          event: 'message.received',
          payload: { sessionId: 'gdpr-session-1', message: 'my first question' }
        },
        {
          webhook: new mongoose.Types.ObjectId(), company: company._id,
          event: 'contact.created',
          payload: { contactId: String(contact._id), email: 'subject@example.com' }
        },
        {
          webhook: new mongoose.Types.ObjectId(), company: company._id,
          event: 'message.received',
          payload: { sessionId: 'gdpr-somebody-else', message: 'not them' }
        }
      ]);

      const response = await request(app)
        .delete(`/api/gdpr/user-data/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        conversationsDeleted: 2,
        contactsDeleted: 1,
        filesDeleted: 1,
        tasksAnonymized: 1,
        webhookDeliveriesDeleted: 2
      });

      expect(await Contact.findById(contact._id)).toBeNull();
      expect(fs.existsSync(stored)).toBe(false);

      // The task survives - the operator's work is the tenant's record - but
      // no longer says who it was about.
      const scrubbed = await Task.findById(task._id).lean();
      expect(scrubbed).not.toBeNull();
      expect(scrubbed.title).toBe('Call them back');
      expect(scrubbed.contactInfo?.name).toBeUndefined();
      expect(scrubbed.contactInfo?.email).toBeUndefined();
      expect(scrubbed.contactInfo?.phone).toBeUndefined();

      const remaining = await WebhookDelivery.find({ company: company._id }).lean();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].payload.sessionId).toBe('gdpr-somebody-else');
    });

    it('will not erase another tenant\'s subject', async () => {
      const theirContact = await Contact.create({
        company: otherCompany._id,
        email: 'theirs@example.com',
        identityLevel: 'claimed'
      });

      await Conversation.create({
        sessionId: 'gdpr-their-session',
        company: otherCompany._id,
        contact: theirContact._id,
        messages: [{ content: 'not yours to delete', sender: 'user' }]
      });

      const response = await request(app)
        .delete(`/api/gdpr/user-data/${theirContact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(404);
      expect(await Conversation.countDocuments({ contact: theirContact._id })).toBe(1);
    });
  });

  describe('export', () => {
    it('contains the subject\'s messages', async () => {
      const response = await request(app)
        .get(`/api/gdpr/export/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.conversations).toHaveLength(2);

      const everything = JSON.stringify(response.body);
      expect(everything).toContain('my first question');
      expect(everything).toContain('my second question');
    });

    it('includes who they said they were, the rating, the attachments and the contact record', async () => {
      await Conversation.updateOne(
        { sessionId: 'gdpr-session-1' },
        {
          $set: {
            metadata: { name: 'A Subject', email: 'subject@example.com', phone: '07700 900123' },
            rating: { score: 5, comment: 'lovely', ratedAt: new Date(), handledBy: 'bot' }
          },
          $push: {
            messages: {
              content: '[File uploaded: receipt.pdf]', sender: 'user',
              fileId: 'b'.repeat(32), fileName: 'receipt.pdf'
            }
          }
        }
      );

      const response = await request(app)
        .get(`/api/gdpr/export/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);

      const exported = response.body.conversations.find(c => c.sessionId === 'gdpr-session-1');
      expect(exported.metadata).toMatchObject({ name: 'A Subject', phone: '07700 900123' });
      expect(exported.rating).toMatchObject({ score: 5, comment: 'lovely' });
      expect(exported.attachments.map(a => a.fileName)).toEqual(['receipt.pdf']);

      expect(response.body.contacts).toHaveLength(1);
      expect(response.body.contacts[0]).toMatchObject({ name: 'A Subject', email: 'subject@example.com' });
    });

    it('does not hand over an empty file for an unknown subject', async () => {
      const response = await request(app)
        .get('/api/gdpr/export/nobody')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(404);
    });
  });

  describe('anonymisation', () => {
    it('scrubs the details the widget and dashboard write into metadata', async () => {
      const conversation = await Conversation.findOne({ sessionId: 'gdpr-session-1' });
      conversation.metadata = new Map([
        ['name', 'A Subject'], ['email', 'subject@example.com'], ['phone', '07700 900123'],
        ['visitorCity', 'Leeds'], ['consent', '{"marketing":false}']
      ]);
      conversation.notes.push({ body: 'She mentioned her daughter is unwell', authorName: 'Op' });
      conversation.workflowState = { variables: { orderNumber: 'A-1234', email: 'subject@example.com' } };
      await conversation.save();

      await conversation.anonymize();
      const stored = await Conversation.findById(conversation._id);

      expect(stored.metadata.get('name')).toBeUndefined();
      expect(stored.metadata.get('email')).toBeUndefined();
      expect(stored.metadata.get('phone')).toBeUndefined();
      expect(stored.metadata.get('visitorCity')).toBeUndefined();
      // What they agreed to is not who they are, and has to be kept.
      expect(stored.metadata.get('consent')).toBe('{"marketing":false}');
      expect(stored.notes).toHaveLength(0);
      expect(stored.workflowState.variables).toBeUndefined();
      expect(stored.contact).toBeUndefined();
      expect(stored.anonymizedAt).toBeInstanceOf(Date);
    });
  });
});
