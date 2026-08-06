/**
 * The AI service is tenant-scoped.
 *
 * It used to carry a single hardcoded persona describing a property management
 * company, plus keyword detectors for property/mortgage/viewing enquiries. Both
 * are gone: who the assistant is comes from the company.
 */

const mongoose = require('mongoose');
const AIService = require('../services/ai');
const Company = require('../models/company');
const ResponseTemplate = require('../models/response-template');
const assistantConfig = require('../services/assistant-config');
const { getResponseTemplateService } = require('../services/responseTemplates');
const { DEFAULT_PERSONA } = require('../services/promptEngineering');

describe('AIService tenant scoping', () => {
  let acme;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    acme = await Company.create({ name: 'AI Tenant Co' });
  });

  // Scoped to this suite's own company for the same reason as above.
  afterAll(async () => {
    await ResponseTemplate.deleteMany({ company: acme._id });
    await Company.deleteMany({ name: /^AI Tenant/ });
  });

  beforeEach(async () => {
    await ResponseTemplate.deleteMany({ company: acme._id });
    assistantConfig.invalidate();
    // The template service caches per company for 60s. Writing directly to the
    // model bypasses the route that would normally invalidate it.
    getResponseTemplateService().invalidate();
  });

  describe('the removed industry logic', () => {
    test('no property, mortgage or viewing detectors remain', () => {
      const service = new AIService();

      ['isPropertyInquiry', 'isMortgageInquiry', 'isViewingRequest',
        'isApplicationInquiry', 'isPaymentPlanInquiry'].forEach(method => {
        expect(service[method]).toBeUndefined();
      });
    });

    test('the default persona names no industry', () => {
      expect(new AIService().systemMessage)
        .not.toMatch(/property|real estate|mortgage|apartment/i);
    });

    test('greeting detection survives, because it is universal', () => {
      const service = new AIService();
      expect(service.isGreeting('hello there')).toBe(true);
      expect(service.isGreeting('what are your opening hours')).toBe(false);
    });
  });

  describe('persona resolution', () => {
    test('a company with no configuration gets the neutral default', async () => {
      const service = await AIService.forCompany(acme._id);
      expect(service.systemMessage).toBe(DEFAULT_PERSONA);
    });

    test('a company persona is adopted', async () => {
      await Company.findByIdAndUpdate(acme._id, {
        assistant: { persona: 'You are the assistant for a bakery.' }
      });
      assistantConfig.invalidate(acme._id);

      const service = await AIService.forCompany(acme._id);
      expect(service.systemMessage).toContain('bakery');
    });

    test('two companies get different assistants from one codebase', async () => {
      const bakery = await Company.create({
        name: 'AI Tenant Bakery',
        assistant: { persona: 'You are the assistant for a bakery.' }
      });
      const garage = await Company.create({
        name: 'AI Tenant Garage',
        assistant: { persona: 'You are the assistant for a car garage.' }
      });
      assistantConfig.invalidate();

      const [bakeryService, garageService] = await Promise.all([
        AIService.forCompany(bakery._id),
        AIService.forCompany(garage._id)
      ]);

      expect(bakeryService.systemMessage).toContain('bakery');
      expect(garageService.systemMessage).toContain('car garage');

      await Company.deleteMany({ _id: { $in: [bakery._id, garage._id] } });
    });
  });

  describe('template matching', () => {
    test('a service with no company matches nothing', async () => {
      const service = new AIService();
      expect(await service.checkForTemplateMatch('anything')).toBeNull();
    });

    test('matches the company\'s own template', async () => {
      await ResponseTemplate.create({
        company: acme._id, name: 'Hours',
        triggers: ['opening hours', 'when are you open'],
        responses: ['We are open 9 to 5, Monday to Friday.']
      });

      const service = await AIService.forCompany(acme._id);
      expect(await service.checkForTemplateMatch('what are your opening hours'))
        .toBe('We are open 9 to 5, Monday to Friday.');
    });

    test('uses the company greeting when one is defined', async () => {
      await ResponseTemplate.create({
        company: acme._id, name: 'Welcome', role: 'greeting',
        responses: ['Hi, welcome to Acme!']
      });

      const service = await AIService.forCompany(acme._id);
      expect(await service.checkForTemplateMatch('hello')).toBe('Hi, welcome to Acme!');
    });

    test('a greeting with no template falls through to the model', async () => {
      const service = await AIService.forCompany(acme._id);
      expect(await service.checkForTemplateMatch('hello')).toBeNull();
    });
  });

  describe('scope', () => {
    test('everything is in scope when the tenant sets none', async () => {
      const service = await AIService.forCompany(acme._id);
      expect(service.scope).toBeNull();

      // With no scope the check short-circuits, so no model call is made even
      // though no client is configured.
      const response = await service.generateResponse('tell me about anything', []);
      expect(typeof response).toBe('string');
    });

    test('a configured scope is carried onto the service', async () => {
      await Company.findByIdAndUpdate(acme._id, {
        assistant: { persona: 'x', scope: 'orders and delivery only' }
      });
      assistantConfig.invalidate(acme._id);

      const service = await AIService.forCompany(acme._id);
      expect(service.scope).toBe('orders and delivery only');
    });
  });
});
