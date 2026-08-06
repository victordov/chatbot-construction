/**
 * Response strategies.
 *
 * These used to assert on real-estate prompt structures ("propertyInformation",
 * "financialGuidance", "neighborhoodHighlights"). The service now describes the
 * *shape* of a reply rather than an industry, so the tests check that nothing
 * industry-specific leaks back in.
 */

const {
  PromptEngineeringService,
  PROMPT_STRUCTURES,
  DEFAULT_PERSONA
} = require('../services/promptEngineering');

describe('PromptEngineeringService', () => {
  let service;

  beforeEach(() => {
    service = new PromptEngineeringService();
  });

  describe('neutrality', () => {
    const INDUSTRY_TERMS = /\b(real estate|property|properties|apartment|mortgage|lease|tenant|landlord|rental|realtor|construction|contractor)\b/i;

    test('no strategy names an industry', () => {
      Object.entries(PROMPT_STRUCTURES).forEach(([name, template]) => {
        expect(`${name}: ${template}`).not.toMatch(INDUSTRY_TERMS);
      });
    });

    test('the default persona names no industry and claims no expertise', () => {
      expect(DEFAULT_PERSONA).not.toMatch(INDUSTRY_TERMS);
      expect(DEFAULT_PERSONA).not.toMatch(/\d+\+?\s*years/i);
    });

    test('strategies are named by request shape, not subject matter', () => {
      expect(service.getPromptTypes().sort()).toEqual(
        ['comparison', 'concernResolution', 'escalation', 'informational', 'instructional']
      );
    });
  });

  describe('persona', () => {
    test('a tenant persona replaces the default', () => {
      service.setPersona('You are the assistant for a bicycle repair shop.');
      expect(service.getDefaultSystemMessage()).toContain('bicycle repair shop');
    });

    test('an empty persona leaves the default in place', () => {
      service.setPersona('   ');
      expect(service.getDefaultSystemMessage()).toBe(DEFAULT_PERSONA);
    });

    test('every strategy carries the tenant persona', () => {
      service.setPersona('You are the assistant for Acme Tools.');

      service.getPromptTypes().forEach(type => {
        expect(service.getPromptStructure(type)).toContain('Acme Tools');
      });
    });
  });

  describe('strategy detection', () => {
    test.each([
      ['my order is broken and I am unhappy', 'concernResolution'],
      ['what is the difference between these two plans', 'comparison'],
      ['how do I set up my account', 'instructional'],
      ['I want to speak to a human', 'escalation'],
      ['what are your opening hours', 'informational']
    ])('%s -> %s', (message, expected) => {
      expect(service.detectPromptType(message)).toBe(expected);
    });

    test('falls back to informational, which is never actively wrong', () => {
      expect(service.detectPromptType('')).toBe('informational');
      expect(service.detectPromptType('zxcvbnm')).toBe('informational');
    });
  });

  describe('variable extraction', () => {
    test('captures a stated concern', () => {
      const variables = service.extractVariables('I am worried about the delivery date.');
      expect(variables.CONCERN).toBe('the delivery date');
    });

    test('treats a complaint without "worried about" as the concern itself', () => {
      const variables = service.extractVariables('this is broken');
      expect(variables.CONCERN).toBe('this is broken');
    });

    test('always carries the query topic', () => {
      expect(service.extractVariables('anything').QUERY_TOPIC).toBe('anything');
    });

    test('does not invent domain variables', () => {
      // The old extractor guessed PROPERTY_TYPE, LOCATION and BUDGET, including
      // a literal check for the word "Miami".
      const variables = service.extractVariables('I want a 2 bedroom apartment in Miami for $2000');
      expect(variables.PROPERTY_TYPE).toBeUndefined();
      expect(variables.LOCATION).toBeUndefined();
      expect(variables.BUDGET).toBeUndefined();
    });
  });

  test('a placeholder cannot inject regex syntax', () => {
    const output = service.getPromptStructure('informational', { 'QUERY_TOPIC': 'a(b' });
    expect(output).toContain('a(b');
  });
});
