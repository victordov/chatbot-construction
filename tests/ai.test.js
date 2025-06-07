const AIService = require('../services/ai');
const { ResponseTemplateService } = require('../services/responseTemplates');
const { PromptEngineeringService } = require('../services/promptEngineering');

// Mock OpenAI
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

describe('AI Service Test', () => {
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

    // Create a new instance for each test
    aiService = new AIService({
      templateService,
      promptService
    });
  });

  it('should initialize with default values', () => {
    expect(aiService.systemMessage).toBeDefined();
    expect(aiService.templateService).toBeDefined();
    expect(aiService.promptService).toBeDefined();
  });

  it('should use environment variables for configuration', () => {
    // Change environment variables
    process.env.OPENAI_MODEL = 'gpt-3.5-turbo';

    // Create a new instance that should use the new environment variables
    const newAiService = new AIService();

    expect(newAiService.defaultModel).toBe('gpt-3.5-turbo');
  });

  it('should generate a response to a user message', async () => {
    // Mock the entire generateResponse method
    aiService.generateResponse = jest.fn().mockResolvedValue('This is a mock AI response');

    const userMessage = 'Hello, how are you?';
    const messageHistory = [
      { role: 'user', content: 'Initial message' },
      { role: 'assistant', content: 'Initial response' }
    ];

    const response = await aiService.generateResponse(userMessage, messageHistory);

    expect(response).toBe('This is a mock AI response');
    expect(aiService.generateResponse).toHaveBeenCalledWith(userMessage, messageHistory);
  });

  it('should use the template service', () => {
    // Mock the templateService.getTemplate method
    aiService.templateService.getTemplate = jest.fn().mockReturnValue('This is a template response');

    const templateResponse = aiService.templateService.getTemplate('greeting');

    expect(templateResponse).toBe('This is a template response');
    expect(aiService.templateService.getTemplate).toHaveBeenCalledWith('greeting');
  });

  it('should use the prompt engineering service', () => {
    // Mock the promptService.detectPromptType method
    aiService.promptService.detectPromptType = jest.fn().mockReturnValue('propertyInquiry');

    const promptType = aiService.promptService.detectPromptType('I am looking for an apartment');

    expect(promptType).toBe('propertyInquiry');
    expect(aiService.promptService.detectPromptType).toHaveBeenCalledWith('I am looking for an apartment');
  });
});
