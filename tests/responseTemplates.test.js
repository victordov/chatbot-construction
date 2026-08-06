/**
 * Tenant-owned canned replies.
 *
 * Templates used to be a hardcoded module of property-management copy shared by
 * every tenant. They now belong to a company, and the platform ships none.
 */

const mongoose = require('mongoose');
const Company = require('../models/company');
const ResponseTemplate = require('../models/response-template');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { IntentClassifier } = require('../services/intent-classifier');
const { EmbeddingService } = require('../services/embeddings');

describe('ResponseTemplateService', () => {
  let service;
  let acme;
  let other;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    acme = await Company.create({ name: 'Template Acme' });
    other = await Company.create({ name: 'Template Other' });

    service = new ResponseTemplateService({
      classifier: new IntentClassifier({ embeddings: new EmbeddingService({ apiKey: null }) }),
      // Caching would hide writes between assertions.
      cacheTtl: 0
    });
  });

  // Scoped to this suite's own companies: a bare deleteMany({}) would wipe
  // fixtures belonging to any suite Jest happens to run in parallel.
  const ownTemplates = () => ({ company: { $in: [acme._id, other._id] } });

  afterAll(async () => {
    await ResponseTemplate.deleteMany(ownTemplates());
    await Company.deleteMany({ name: /^Template / });
  });

  beforeEach(async () => {
    await ResponseTemplate.deleteMany(ownTemplates());
    service.invalidate();
  });

  test('the platform ships no templates of its own', async () => {
    // The whole point of the change: a fresh company starts empty.
    expect(await service.load(acme._id)).toEqual([]);
    expect(await service.match(acme._id, 'anything at all')).toBeNull();
  });

  describe('roles', () => {
    test('returns the template filling a role', async () => {
      await ResponseTemplate.create({
        company: acme._id, name: 'Welcome', role: 'greeting',
        responses: ['Hello from Acme Tools!']
      });

      expect(await service.getByRole(acme._id, 'greeting')).toBe('Hello from Acme Tools!');
    });

    test('returns null when the tenant defined no template for the role', async () => {
      expect(await service.getByRole(acme._id, 'greeting')).toBeNull();
    });
  });

  describe('matching', () => {
    beforeEach(async () => {
      await ResponseTemplate.create({
        company: acme._id,
        name: 'Returns',
        triggers: ['return an item', 'send it back', 'refund'],
        responses: ['You can return anything within [WINDOW] days.'],
        variables: new Map([['WINDOW', '30']])
      });
    });

    test('matches a message against the tenant\'s trigger phrases', async () => {
      const match = await service.match(acme._id, 'I want to return an item');

      expect(match).not.toBeNull();
      expect(match.template.name).toBe('Returns');
    });

    test('fills the template\'s own variables', async () => {
      const match = await service.match(acme._id, 'return an item');
      expect(match.text).toBe('You can return anything within 30 days.');
    });

    test('returns null for an unrelated message, so the model answers instead', async () => {
      // Forcing an ill-fitting canned reply is worse than not having one.
      expect(await service.match(acme._id, 'zebra xylophone quantum')).toBeNull();
    });

    test('one company never matches another company\'s templates', async () => {
      expect(await service.match(other._id, 'I want to return an item')).toBeNull();
    });

    test('a disabled template never matches', async () => {
      await ResponseTemplate.updateMany({}, { $set: { enabled: false } });
      service.invalidate();

      expect(await service.match(acme._id, 'return an item')).toBeNull();
    });

    test('records that a template was used', async () => {
      await service.match(acme._id, 'return an item');

      // Recorded fire-and-forget, so give it a moment to land.
      await new Promise(resolve => setTimeout(resolve, 50));
      const template = await ResponseTemplate.findOne({ name: 'Returns' });
      expect(template.useCount).toBe(1);
    });
  });

  describe('rendering', () => {
    test('call-site variables beat the template\'s own', () => {
      const rendered = service.render(
        { responses: ['Open [HOURS]'], variables: { HOURS: '9-5' } },
        { HOURS: '24/7' }
      );
      expect(rendered).toBe('Open 24/7');
    });

    test('leaves an unresolved placeholder visible', () => {
      // Silently blanking it would hide a misconfiguration from the tenant.
      expect(service.render({ responses: ['Call [PHONE]'] })).toBe('Call [PHONE]');
    });

    test('a variable name cannot inject regex syntax', () => {
      expect(service.populate('a [A(B] c', { 'A(B': 'X' })).toBe('a X c');
    });

    test('picks from the available variations', () => {
      const template = { responses: ['one', 'two', 'three'] };
      const seen = new Set();
      for (let i = 0; i < 60; i += 1) {
        seen.add(service.render(template));
      }
      expect(seen.size).toBeGreaterThan(1);
    });

    test('an empty template renders as empty rather than throwing', () => {
      expect(service.render({ responses: [] })).toBe('');
    });
  });

  test('a missing company yields no templates rather than an error', async () => {
    expect(await service.load(null)).toEqual([]);
    expect(await service.match(null, 'hello')).toBeNull();
  });
});
