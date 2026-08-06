/**
 * Contacts and identity verification.
 *
 * The widget runs on the customer's own page, so everything it sends is
 * attacker-controlled. These tests exist mainly to pin down that an unsigned
 * or wrongly-signed identity claim is never trusted.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

const User = require('../models/user');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const contactService = require('../services/contacts');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/contacts', require('../routes/contacts'));
  return app;
};

describe('Contacts', () => {
  let app;
  let acme;
  let rival;
  let secret;
  let adminToken;
  let rivalToken;

  const sign = (externalId, withSecret = secret) =>
    crypto.createHmac('sha256', withSecret).update(String(externalId)).digest('hex');

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();

    acme = await Company.create({ name: 'Contacts Acme' });
    rival = await Company.create({ name: 'Contacts Rival' });

    const withSecret = await Company.findById(acme._id).select('+identitySecret');
    secret = withSecret.identitySecret;

    await User.create({
      username: 'contacts-admin', email: 'admin@contacts.example',
      password: 'TestPassword123!', role: 'company_admin', company: acme._id
    });
    await User.create({
      username: 'contacts-rival', email: 'rival@contacts.example',
      password: 'TestPassword123!', role: 'company_admin', company: rival._id
    });

    adminToken = await login('contacts-admin');
    rivalToken = await login('contacts-rival');
  });

  afterAll(async () => {
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await User.deleteMany({ email: /@contacts\.example$/ });
    await Company.deleteMany({ name: /^Contacts / });
  });

  beforeEach(async () => {
    await Contact.deleteMany({ company: { $in: [acme._id, rival._id] } });
    await Conversation.deleteMany({ company: { $in: [acme._id, rival._id] } });
  });

  describe('identity verification', () => {
    test('a company gets an identity secret automatically', () => {
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    test('accepts a correctly signed identity', () => {
      expect(contactService.verifyIdentity('user-1', sign('user-1'), secret)).toBe(true);
    });

    test('rejects an unsigned identity', () => {
      // The core threat: a visitor editing the page to claim someone else's id.
      expect(contactService.verifyIdentity('user-1', '', secret)).toBe(false);
      expect(contactService.verifyIdentity('user-1', null, secret)).toBe(false);
    });

    test('rejects a hash for a different user', () => {
      expect(contactService.verifyIdentity('victim', sign('attacker'), secret)).toBe(false);
    });

    test('rejects a hash signed with the wrong secret', () => {
      expect(contactService.verifyIdentity('user-1', sign('user-1', 'not-the-secret'), secret)).toBe(false);
    });

    test('rejects a truncated hash without throwing', () => {
      // timingSafeEqual throws on a length mismatch, so this must be handled.
      expect(() => contactService.verifyIdentity('user-1', 'abc', secret)).not.toThrow();
      expect(contactService.verifyIdentity('user-1', 'abc', secret)).toBe(false);
    });
  });

  describe('resolution', () => {
    test('creates an anonymous contact from a session alone', async () => {
      const contact = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });

      expect(contact.identityLevel).toBe('anonymous');
      expect(contact.sessionIds).toContain('s-1');
    });

    test('recognises a returning session', async () => {
      const first = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });
      const second = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });

      expect(second._id.toString()).toBe(first._id.toString());
    });

    test('a typed email is claimed, not verified', async () => {
      const contact = await contactService.resolve({
        companyId: acme._id, sessionId: 's-1', email: 'someone@example.com'
      });

      // Anyone can type any address; it is useful for threading and no more.
      expect(contact.identityLevel).toBe('claimed');
    });

    test('a signed identity is verified', async () => {
      const contact = await contactService.resolve({
        companyId: acme._id, sessionId: 's-1',
        externalId: 'user-7', userHash: sign('user-7')
      });

      expect(contact.identityLevel).toBe('verified');
      expect(contact.externalId).toBe('user-7');
    });

    test('an unsigned identity claim is ignored entirely', async () => {
      const contact = await contactService.resolve({
        companyId: acme._id, sessionId: 's-1',
        externalId: 'user-7', userHash: 'forged'
      });

      expect(contact.identityLevel).toBe('anonymous');
      expect(contact.externalId).toBeUndefined();
    });

    test('logging in links the browsing session to the known person', async () => {
      // Browse anonymously, then log in: the same person, not two.
      await contactService.resolve({ companyId: acme._id, sessionId: 's-anon' });
      const identified = await contactService.resolve({
        companyId: acme._id, sessionId: 's-anon',
        externalId: 'user-9', userHash: sign('user-9')
      });

      expect(identified.identityLevel).toBe('verified');
      expect(await Contact.countDocuments({ company: acme._id })).toBe(1);
    });

    test('a second device joins the same person', async () => {
      await contactService.resolve({
        companyId: acme._id, sessionId: 'laptop',
        externalId: 'user-9', userHash: sign('user-9')
      });
      const onPhone = await contactService.resolve({
        companyId: acme._id, sessionId: 'phone',
        externalId: 'user-9', userHash: sign('user-9')
      });

      expect(onPhone.sessionIds).toEqual(expect.arrayContaining(['laptop', 'phone']));
      expect(await Contact.countDocuments({ company: acme._id })).toBe(1);
    });

    test('a verified contact is never downgraded by a form submission', async () => {
      await contactService.resolve({
        companyId: acme._id, sessionId: 's-1',
        externalId: 'user-9', userHash: sign('user-9')
      });

      const after = await contactService.resolve({
        companyId: acme._id, sessionId: 's-1', email: 'typed@example.com'
      });

      expect(after.identityLevel).toBe('verified');
    });

    test('several anonymous visitors coexist in one company', async () => {
      // A compound sparse unique index still indexes anonymous contacts,
      // because `company` is always present - so the second visitor who never
      // logs in collided on externalId: null and could not be created.
      const first = await contactService.resolve({ companyId: acme._id, sessionId: 'anon-1' });
      const second = await contactService.resolve({ companyId: acme._id, sessionId: 'anon-2' });
      const third = await contactService.resolve({ companyId: acme._id, sessionId: 'anon-3' });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).not.toBeNull();
      expect(await Contact.countDocuments({ company: acme._id })).toBe(3);
    });

    test('two verified people cannot share one external id', async () => {
      // Uniqueness must still hold where it matters.
      await contactService.resolve({
        companyId: acme._id, sessionId: 'x',
        externalId: 'dup-user', userHash: sign('dup-user')
      });
      const again = await contactService.resolve({
        companyId: acme._id, sessionId: 'y',
        externalId: 'dup-user', userHash: sign('dup-user')
      });

      expect(again.externalId).toBe('dup-user');
      expect(await Contact.countDocuments({ company: acme._id, externalId: 'dup-user' })).toBe(1);
    });

    test('resolving without a company yields nothing rather than throwing', async () => {
      await expect(contactService.resolve({ sessionId: 's-1' })).resolves.toBeNull();
    });
  });

  describe('merging', () => {
    test('moves conversations and removes the duplicate', async () => {
      const keep = await contactService.resolve({ companyId: acme._id, sessionId: 'a' });
      const dupe = await contactService.resolve({ companyId: acme._id, sessionId: 'b' });

      await Conversation.create({
        sessionId: 'b', company: acme._id, contact: dupe._id, messages: []
      });

      await contactService.mergeInto(keep, dupe);

      expect(await Contact.findById(dupe._id)).toBeNull();
      expect(keep.sessionIds).toEqual(expect.arrayContaining(['a', 'b']));

      const moved = await Conversation.findOne({ sessionId: 'b' });
      expect(moved.contact.toString()).toBe(keep._id.toString());
    });
  });

  describe('API', () => {
    test('lists a company\'s own contacts', async () => {
      await contactService.resolve({
        companyId: acme._id, sessionId: 's-1', email: 'lister@example.com'
      });

      const response = await request(app)
        .get('/api/contacts')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.contacts).toHaveLength(1);
    });

    test('another company cannot see them', async () => {
      await contactService.resolve({
        companyId: acme._id, sessionId: 's-1', email: 'private@example.com'
      });

      const response = await request(app)
        .get('/api/contacts')
        .set('x-auth-token', rivalToken);

      expect(response.body.contacts).toHaveLength(0);
    });

    test('another company cannot open one by id', async () => {
      const contact = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });

      const response = await request(app)
        .get(`/api/contacts/${contact._id}`)
        .set('x-auth-token', rivalToken);

      // 404, not 403: a 403 would confirm it exists.
      expect(response.status).toBe(404);
    });

    test('returns the person\'s conversation history', async () => {
      const contact = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });
      await Conversation.create({
        sessionId: 's-1', company: acme._id, contact: contact._id,
        messages: [{ content: 'older question', sender: 'user' }]
      });

      const response = await request(app)
        .get(`/api/contacts/${contact._id}`)
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.conversations).toHaveLength(1);
      expect(response.body.conversations[0].messageCount).toBe(1);
    });

    test('editing by hand never grants verification', async () => {
      const contact = await contactService.resolve({ companyId: acme._id, sessionId: 's-1' });

      const response = await request(app)
        .put(`/api/contacts/${contact._id}`)
        .set('x-auth-token', adminToken)
        .send({ name: 'Typed By Operator', email: 'typed@example.com' });

      expect(response.status).toBe(200);
      expect(response.body.contact.verified).toBe(false);
    });

    test('an admin can read the identity secret', async () => {
      const response = await request(app)
        .get('/api/contacts/identity/secret')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.secret).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.examples.node).toContain('createHmac');
    });

    test('rotating the secret invalidates old signatures', async () => {
      const before = secret;

      const response = await request(app)
        .post('/api/contacts/identity/secret/rotate')
        .set('x-auth-token', adminToken);

      expect(response.status).toBe(200);
      expect(response.body.secret).not.toBe(before);

      // Anything signed with the old secret must stop verifying.
      expect(contactService.verifyIdentity('user-1', sign('user-1', before), response.body.secret))
        .toBe(false);

      secret = response.body.secret;
    });
  });
});
