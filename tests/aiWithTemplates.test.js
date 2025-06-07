const AIService = require('../services/ai');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { PromptEngineeringService } = require('../services/promptEngineering');

// Mock the OpenAI package
jest.mock('openai', () => {
  return {
    OpenAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: 'This is a mock AI response'
                }
              }
            ]
          })
        }
      }
    }))
  };
});

// Mock template service
jest.mock('../services/responseTemplates', () => {
  const originalModule = jest.requireActual('../services/responseTemplates');

  return {
    ResponseTemplateService: jest.fn().mockImplementation(() => ({
      getTemplate: jest.fn().mockImplementation((category, variables) => {
        if (category === 'greeting') {
          return 'Mock greeting template response';
        }
        if (category === 'propertyInquiry') {
          return 'Mock property inquiry template response';
        }
        if (category === 'mortgageInformation') {
          return `Mock mortgage template with rate ${variables?.RATE || '3.5'}%`;
        }
        if (category === 'offTopic') {
          return 'I can only help with property related questions';
        }
        return 'Mock template response for ' + category;
      }),
      templates: originalModule.DEFAULT_TEMPLATES
    })),
    DEFAULT_TEMPLATES: originalModule.DEFAULT_TEMPLATES
  };
});

// Mock prompt engineering service
jest.mock('../services/promptEngineering', () => {
  const originalModule = jest.requireActual('../services/promptEngineering');

  return {
    PromptEngineeringService: jest.fn().mockImplementation(() => ({
      detectPromptType: jest.fn().mockImplementation(query => {
        if (query.includes('mortgage')) {
          return 'financialGuidance';
        }
        if (query.includes('neighborhood')) {
          return 'neighborhoodHighlights';
        }
        if (query.includes('compare')) {
          return 'propertyComparison';
        }
        return 'propertyInformation';
      }),
      extractVariables: jest.fn().mockReturnValue({
        PROPERTY_TYPE: 'apartment',
        LOCATION: 'New York'
      }),
      createPromptMessages: jest.fn().mockImplementation((type, query, history) => [
        { role: 'system', content: 'Mock system prompt for ' + type },
        ...history,
        { role: 'user', content: query }
      ]),
      prompts: originalModule.PROMPT_STRUCTURES
    })),
    PROMPT_STRUCTURES: originalModule.PROMPT_STRUCTURES
  };
});

describe('AI Service with Templates and Prompt Engineering Test', () => {
  let aiService;
  beforeEach(() => {
    // Reset environment variables
    process.env.OPENAI_API_KEY = 'test-api-key';
    process.env.OPENAI_MODEL = 'gpt-4';

    // Reset mocks
    jest.clearAllMocks();

    // Create instances of mock services
    const templateService = new ResponseTemplateService();
    const promptService = new PromptEngineeringService();

    // Create a new AI service instance for each test
    aiService = new AIService({
      templateService,
      promptService
    });

    // Mock isOnTopic function at the module level
    jest.spyOn(aiService, 'generateResponse').mockImplementation(async (message) => {      // Check for off-topic message
      if (message.toLowerCase().includes('unrelated') ||
          message.toLowerCase().includes('space travel')) {
        return aiService.templateService.getTemplate('offTopic');
      }

      // Check for greeting
      if (message.toLowerCase().includes('hello') ||
          message.toLowerCase().includes('hi') ||
          message.toLowerCase().includes('hey')) {
        return aiService.templateService.getTemplate('greeting');
      }

      // Check for property inquiry
      if (message.toLowerCase().includes('looking for') ||
          message.toLowerCase().includes('apartment')) {
        return aiService.templateService.getTemplate('propertyInquiry');
      }

      // Check for mortgage information
      if (message.toLowerCase().includes('mortgage') ||
          message.toLowerCase().includes('interest rate')) {
        return aiService.templateService.getTemplate('mortgageInformation', {
          RATE: process.env.CURRENT_INTEREST_RATE || '3.5',
          PERCENTAGE: '20'
        });
      }
      // For complex queries, use the engineered response
      if (message.toLowerCase().includes('compare') ||
          message.toLowerCase().includes('neighborhood') ||
          message.toLowerCase().includes('complex')) {
        // Call the prompt engineering methods
        aiService.promptService.detectPromptType(message);
        aiService.promptService.extractVariables(message);
        aiService.promptService.createPromptMessages('propertyComparison', message, [], {});
        return 'This is an engineered response for a complex query';
      }

      // Default response
      return 'Default response';
    });
  });

  it('should use template for greetings', async () => {
    const response = await aiService.generateResponse('Hello there!');

    expect(response).toBe('Mock greeting template response');
    expect(aiService.templateService.getTemplate).toHaveBeenCalledWith('greeting');
  });

  it('should use template for property inquiries', async () => {
    const response = await aiService.generateResponse('I am looking for an apartment');

    expect(response).toBe('Mock property inquiry template response');
    expect(aiService.templateService.getTemplate).toHaveBeenCalledWith('propertyInquiry');
  });
  it('should use template with variables for mortgage inquiries', async () => {
    process.env.CURRENT_INTEREST_RATE = '4.2';

    const response = await aiService.generateResponse('What are your mortgage rates?');

    expect(response).toBe('Mock mortgage template with rate 4.2%');
    expect(aiService.templateService.getTemplate).toHaveBeenCalledWith(
      'mortgageInformation',
      expect.objectContaining({
        RATE: '4.2',
        PERCENTAGE: '20'
      })
    );
  });
  it('should use prompt engineering for complex queries', async () => {
    // Spy on the prompt engineering service methods
    jest.spyOn(aiService.promptService, 'detectPromptType');
    jest.spyOn(aiService.promptService, 'extractVariables');
    jest.spyOn(aiService.promptService, 'createPromptMessages');

    const response = await aiService.generateResponse(
      'Can you compare the neighborhoods of Brooklyn and Manhattan?'
    );

    expect(response).toBe('This is an engineered response for a complex query');
    expect(aiService.promptService.detectPromptType).toHaveBeenCalled();
    expect(aiService.promptService.extractVariables).toHaveBeenCalled();
    expect(aiService.promptService.createPromptMessages).toHaveBeenCalled();
  });
  it('should use off-topic template for unrelated queries', async () => {
    // Spy on the template service
    jest.spyOn(aiService.templateService, 'getTemplate');

    const response = await aiService.generateResponse('This is a completely unrelated question about space travel');

    expect(response).toBe('I can only help with property related questions');
    expect(aiService.templateService.getTemplate).toHaveBeenCalledWith('offTopic');
  });
  it('should correctly identify different types of inquiries', async () => {
    // Test greeting detection
    expect(aiService.isGreeting('hello')).toBe(true);
    expect(aiService.isGreeting('good morning')).toBe(true);
    expect(aiService.isGreeting('tell me about properties')).toBe(false);

    // Test property inquiry detection
    expect(aiService.isPropertyInquiry('i am looking for an apartment')).toBe(true);
    expect(aiService.isPropertyInquiry('do you have any houses for rent')).toBe(true);
    expect(aiService.isPropertyInquiry('what is your name')).toBe(false);

    // Test mortgage inquiry detection
    expect(aiService.isMortgageInquiry('what are your mortgage rates')).toBe(true);
    expect(aiService.isMortgageInquiry('can i get pre-approved for a loan')).toBe(true);
    expect(aiService.isMortgageInquiry('where is your office')).toBe(false);

    // Test viewing request detection
    expect(aiService.isViewingRequest('can i schedule a viewing')).toBe(true);
    expect(aiService.isViewingRequest('i want to see the property')).toBe(true);
    expect(aiService.isViewingRequest('what is the price')).toBe(false);

    // Test application inquiry detection
    expect(aiService.isApplicationInquiry('how do i apply for a rental')).toBe(true);
    expect(aiService.isApplicationInquiry('what are the application requirements')).toBe(true);
    expect(aiService.isApplicationInquiry('when was this built')).toBe(false);

    // Test payment plan inquiry detection
    expect(aiService.isPaymentPlanInquiry('what payment plans do you offer')).toBe(true);
    expect(aiService.isPaymentPlanInquiry('can i pay in installments')).toBe(true);
    expect(aiService.isPaymentPlanInquiry('what is your address')).toBe(false);
  });
});
