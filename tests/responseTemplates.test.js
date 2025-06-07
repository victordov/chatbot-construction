const { ResponseTemplateService, DEFAULT_TEMPLATES } = require('../services/responseTemplates');

describe('Response Template Service Test', () => {
  let templateService;

  beforeEach(() => {
    // Create a new instance for each test
    templateService = new ResponseTemplateService();
  });

  it('should initialize with default templates', () => {
    expect(templateService.templates).toBeDefined();
    expect(Object.keys(templateService.templates).length).toBeGreaterThan(0);
    expect(templateService.templates.greeting).toEqual(DEFAULT_TEMPLATES.greeting);
  });

  it('should get a template by category', () => {
    const greetingTemplate = templateService.getTemplate('greeting');
    expect(greetingTemplate).toBeDefined();
    expect(typeof greetingTemplate).toBe('string');
    expect(DEFAULT_TEMPLATES.greeting).toContain(greetingTemplate);
  });

  it('should populate template variables', () => {
    const mortgageTemplate = templateService.getTemplate('mortgageInformation', {
      RATE: '4.5',
      PERCENTAGE: '15'
    });

    expect(mortgageTemplate).toContain('4.5%');
    expect(mortgageTemplate).toContain('15%');
  });

  it('should return fallback template for unknown categories', () => {
    const unknownTemplate = templateService.getTemplate('nonExistentCategory');
    expect(unknownTemplate).toBeDefined();

    // Should include the category name as a topic
    expect(unknownTemplate).toContain('nonExistentCategory');
  });

  it('should add a new template', () => {
    const newTemplate = 'This is a new test template for [CATEGORY].';
    templateService.addTemplate('testCategory', newTemplate);

    const retrievedTemplate = templateService.getTemplate('testCategory', {
      CATEGORY: 'testing'
    });

    expect(retrievedTemplate).toBe('This is a new test template for testing.');
  });

  it('should add multiple templates to a category', () => {
    const newTemplates = [
      'First test template',
      'Second test template'
    ];

    templateService.addTemplate('multiCategory', newTemplates);

    // Get all templates for the category
    const categoryTemplates = templateService.getTemplatesForCategory('multiCategory');

    expect(categoryTemplates).toHaveLength(2);
    expect(categoryTemplates).toEqual(newTemplates);
  });

  it('should set default variables for templates', () => {
    const defaultVars = {
      RATE: '5.0',
      AMOUNT: '100'
    };

    templateService.setDefaultVariables(defaultVars);

    // Create a template that uses these variables
    templateService.addTemplate('testDefaults', 'Rate: [RATE]%, Amount: $[AMOUNT]');

    const result = templateService.getTemplate('testDefaults');
    expect(result).toBe('Rate: 5.0%, Amount: $100');
  });

  it('should override default variables with provided variables', () => {
    templateService.setDefaultVariables({
      RATE: '5.0',
      AMOUNT: '100'
    });

    templateService.addTemplate('testOverride', 'Rate: [RATE]%, Amount: $[AMOUNT]');

    const result = templateService.getTemplate('testOverride', {
      RATE: '6.0'
    });

    // RATE should be overridden, AMOUNT should use default
    expect(result).toBe('Rate: 6.0%, Amount: $100');
  });

  it('should get all template categories', () => {
    const categories = templateService.getCategories();

    expect(categories).toContain('greeting');
    expect(categories).toContain('propertyInquiry');
    expect(categories).toContain('mortgageInformation');
  });
});
