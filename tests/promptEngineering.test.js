const { PromptEngineeringService, PROMPT_STRUCTURES } = require('../services/promptEngineering');

describe('Prompt Engineering Service Test', () => {
  let promptService;

  beforeEach(() => {
    // Create a new instance for each test
    promptService = new PromptEngineeringService();
  });

  it('should initialize with default prompt structures', () => {
    expect(promptService.prompts).toBeDefined();
    expect(Object.keys(promptService.prompts).length).toBeGreaterThan(0);
    expect(promptService.prompts.propertyInformation).toEqual(PROMPT_STRUCTURES.propertyInformation);
  });

  it('should get a prompt structure by type', () => {
    const propertyPrompt = promptService.getPromptStructure('propertyInformation');
    expect(propertyPrompt).toBeDefined();
    expect(typeof propertyPrompt).toBe('string');
    expect(propertyPrompt).toEqual(PROMPT_STRUCTURES.propertyInformation);
  });

  it('should populate prompt variables', () => {
    const populatedPrompt = promptService.getPromptStructure('propertyInformation', {
      PROPERTY_TYPE: 'apartment',
      LOCATION: 'New York',
      FOCUS_POINTS: 'price, amenities, transportation'
    });

    expect(populatedPrompt).toContain('apartment');
    expect(populatedPrompt).toContain('New York');
    expect(populatedPrompt).toContain('price, amenities, transportation');
  });

  it('should return generic prompt for unknown types', () => {
    const unknownPrompt = promptService.getPromptStructure('nonExistentType');
    expect(unknownPrompt).toBeDefined();
    expect(unknownPrompt).toContain('professional real estate');
  });

  it('should create a system message from prompt structure', () => {
    const systemMessage = promptService.createSystemMessage('salesPersuasion', {
      PROPERTY_TYPE: 'condo',
      LOCATION: 'Miami',
      BUDGET: '$500,000'
    });

    expect(systemMessage).toContain('top-performing real estate sales consultant');
    expect(systemMessage).toContain('condo');
    expect(systemMessage).toContain('Miami');
    expect(systemMessage).toContain('$500,000');
  });

  it('should create prompt messages for AI processing', () => {
    const userQuery = 'Tell me about condos in Miami';
    const history = [
      { role: 'user', content: 'I am looking for a property to buy' },
      { role: 'assistant', content: 'I can help you find the perfect property' }
    ];

    const promptMessages = promptService.createPromptMessages(
      'propertyInformation',
      userQuery,
      history,
      {
        PROPERTY_TYPE: 'condo',
        LOCATION: 'Miami',
        FOCUS_POINTS: 'price range, amenities'
      }
    );

    // Should have system message + history + user query
    expect(promptMessages).toHaveLength(4);
    expect(promptMessages[0].role).toBe('system');
    expect(promptMessages[0].content).toContain('condo');
    expect(promptMessages[0].content).toContain('Miami');
    expect(promptMessages[1]).toEqual(history[0]);
    expect(promptMessages[2]).toEqual(history[1]);
    expect(promptMessages[3].role).toBe('user');
    expect(promptMessages[3].content).toBe(userQuery);
  });

  it('should add a new prompt structure', () => {
    const newPrompt = 'You are a custom prompt for {TOPIC}.';
    promptService.addPromptStructure('customPrompt', newPrompt);

    const retrievedPrompt = promptService.getPromptStructure('customPrompt', {
      TOPIC: 'testing'
    });

    expect(retrievedPrompt).toBe('You are a custom prompt for testing.');
  });

  it('should get all prompt types', () => {
    const promptTypes = promptService.getPromptTypes();

    expect(promptTypes).toContain('propertyInformation');
    expect(promptTypes).toContain('salesPersuasion');
    expect(promptTypes).toContain('financialGuidance');
  });

  it('should detect prompt type based on user query', () => {
    expect(promptService.detectPromptType('Tell me about apartments in New York')).toBe('propertyInformation');
    expect(promptService.detectPromptType('Why should I buy this property?')).toBe('salesPersuasion');
    expect(promptService.detectPromptType('I have a problem with my water heater')).toBe('concernResolution');
    expect(promptService.detectPromptType('What mortgage options do you offer?')).toBe('financialGuidance');
    expect(promptService.detectPromptType('Tell me about the neighborhood')).toBe('neighborhoodHighlights');
    expect(promptService.detectPromptType('Which property is better, A or B?')).toBe('propertyComparison');
    expect(promptService.detectPromptType('How do I apply for a rental?')).toBe('rentalApplicationGuidance');
    expect(promptService.detectPromptType('Is this property a good investment?')).toBe('investmentAnalysis');
    expect(promptService.detectPromptType('What property management services do you offer?')).toBe('managementServices');
    expect(promptService.detectPromptType('Explain the lease terms')).toBe('leaseTermsExplanation');
    expect(promptService.detectPromptType('How should I prepare for the viewing?')).toBe('viewingPreparation');
  });

  it('should extract variables from user query', () => {
    const query1 = 'I am looking for an apartment in New York with a budget of $2,000 per month';
    const variables1 = promptService.extractVariables(query1);

    expect(variables1.PROPERTY_TYPE).toBe('apartment');
    expect(variables1.LOCATION).toBe('New York');
    expect(variables1.BUDGET).toBe('$2,000');

    const query2 = 'I am concerned about the noise level in the apartment';
    const variables2 = promptService.extractVariables(query2);

    expect(variables2.CONCERN).toBe('the noise level in the apartment');

    const query3 = 'How much are houses selling for in Miami?';
    const variables3 = promptService.extractVariables(query3);

    expect(variables3.PROPERTY_TYPE).toBe('houses');
    expect(variables3.LOCATION).toBe('Miami');
  });
});
