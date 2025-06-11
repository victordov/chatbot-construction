const { OpenAI } = require('openai');
const { ResponseTemplateService } = require('./responseTemplates');
const { PromptEngineeringService } = require('./promptEngineering');
const { logger } = require('./logging');

// Initialize OpenAI with API key from environment variables - only create instance if we have a key
const openai = process.env.OPENAI_API_KEY ?
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  }) :
  null;

// Default system message to set the assistant's behavior
const DEFAULT_SYSTEM_MESSAGE = `
You are a helpful assistant for a property management company. 
Your goal is to provide information about properties, answer questions about apartments, 
mortgage options, and payment plans. Be professional, concise, and helpful.
If asked about topics unrelated to property management, politely redirect the conversation.
`;

/**
 * Get a response from ChatGPT
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Configuration options
 * @returns {Promise<string>} - The assistant's response
 */
async function getChatGPTResponse(messages, options = {}) {
  try {
    // If no OpenAI client available, return mock response
    if (!openai) {
      return 'This is a mock response since no OpenAI client is available';
    }

    // Include system message if not already present
    if (!messages.some(msg => msg.role === 'system')) {
      messages.unshift({
        role: 'system',
        content: options.systemMessage || DEFAULT_SYSTEM_MESSAGE
      });
    }

    // Convert message format for API
    const formattedMessages = messages.map(msg => ({
      role: msg.role || (msg.sender === 'user' ? 'user' : 'assistant'),
      content: msg.content
    }));

    // Call OpenAI API
    const response = await openai.chat.completions.create({
      model: options.model || 'gpt-3.5-turbo',
      messages: formattedMessages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 500,
      top_p: options.topP || 1,
      frequency_penalty: options.frequencyPenalty || 0,
      presence_penalty: options.presencePenalty || 0
    });

    return response.choices[0].message.content;
  } catch (error) {
    logger.error('Error getting ChatGPT response:', { error });
    throw error;
  }
}

/**
 * Filter off-topic questions
 * @param {string} message - The user's message
 * @returns {Promise<boolean>} - Whether the message is on-topic
 */
async function isOnTopic(message, openaiClient = openai) {
  try {
    // If we don't have an OpenAI instance (e.g., in testing), default to true
    if (!openaiClient) {
      return true;
    }

    const response = await openaiClient.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
            Determine if the following message is related to property management, real estate, 
            apartments, housing, mortgages, or payment plans. Respond with only "true" if it is 
            related, or "false" if it is not related.
          `
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.1,
      max_tokens: 5
    });

    const result = response.choices[0].message.content.trim().toLowerCase();
    return result === 'true';
  } catch (error) {
    logger.error('Error checking if message is on-topic:', { error });
    return true; // Default to allowing the message
  }
}

/**
 * Summarize a conversation
 * @param {Array} messages - Array of message objects
 * @returns {Promise<string>} - Conversation summary
 */
async function summarizeConversation(messages) {
  try {
    const conversationText = messages
      .map(msg => `${msg.sender}: ${msg.content}`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Summarize the following conversation in 3-5 bullet points.'
        },
        {
          role: 'user',
          content: conversationText
        }
      ],
      temperature: 0.5,
      max_tokens: 250
    });

    return response.choices[0].message.content;
  } catch (error) {
    logger.error('Error summarizing conversation:', { error });
    throw error;
  }
}

/**
 * Service for AI integration with OpenAI
 */
class AIService {
  constructor(options = {}) {
    // Only create OpenAI instance if API key is available or use provided mock
    this.openai = options.openai || (process.env.OPENAI_API_KEY ?
      new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      }) : null);

    this.systemMessage = options.systemMessage || DEFAULT_SYSTEM_MESSAGE;
    this.defaultModel = options.model || 'gpt-3.5-turbo';

    // Initialize response template service
    this.templateService = options.templateService ||
      new ResponseTemplateService(options.templateOptions);

    // Initialize prompt engineering service
    this.promptService = options.promptService ||
      new PromptEngineeringService(options.promptOptions);
  }  /**
   * Generate a response to a user message
   * @param {string} message - The user's message
   * @param {Array} messageHistory - Array of previous messages for context
   * @returns {Promise<string>} - The AI-generated response
   */
  async generateResponse(message, messageHistory = []) {
    try {
      // Check if message is on-topic
      const onTopic = await isOnTopic(message, this.openai);

      if (!onTopic) {
        // Use a template for off-topic responses
        return this.templateService.getTemplate('offTopic');
      }

      // Check if we have a predefined template that matches the query
      const templateResponse = this.checkForTemplateMatch(message);
      if (templateResponse) {
        return templateResponse;
      }

      // Use prompt engineering for more complex or specific queries
      return await this.generateEngineeredResponse(message, messageHistory);
    } catch (error) {
      logger.error('Error generating AI response:', { error });
      return 'I\'m sorry, I encountered an error processing your request. Please try again later.';
    }
  }

  /**
   * Check if the message matches any predefined templates
   * @param {string} message - The user's message
   * @returns {string|null} - The template response or null if no match
   */
  checkForTemplateMatch(message) {
    // Convert message to lowercase for easier matching
    const lowerMessage = message.toLowerCase();

    // Check for greeting patterns
    if (this.isGreeting(lowerMessage)) {
      return this.templateService.getTemplate('greeting');
    }

    // Check for property inquiry patterns
    if (this.isPropertyInquiry(lowerMessage)) {
      return this.templateService.getTemplate('propertyInquiry');
    }

    // Check for mortgage information patterns
    if (this.isMortgageInquiry(lowerMessage)) {
      // Extract interest rate if available in configuration
      const interestRate = process.env.CURRENT_INTEREST_RATE || '3.5';
      const downPayment = process.env.MIN_DOWN_PAYMENT || '20';

      return this.templateService.getTemplate('mortgageInformation', {
        RATE: interestRate,
        PERCENTAGE: downPayment
      });
    }

    // Check for viewing scheduling patterns
    if (this.isViewingRequest(lowerMessage)) {
      // Get available time slots from configuration or database
      const availableSlots = process.env.AVAILABLE_VIEWING_SLOTS ||
        'Monday-Friday, 9 AM to 5 PM';

      return this.templateService.getTemplate('scheduleViewing', {
        SLOTS: availableSlots
      });
    }

    // Check for application process inquiries
    if (this.isApplicationInquiry(lowerMessage)) {
      const applicationFee = process.env.APPLICATION_FEE || '50';
      const processingTime = process.env.APPLICATION_PROCESSING_TIME || '3-5';

      return this.templateService.getTemplate('applicationProcess', {
        AMOUNT: applicationFee,
        TIMEFRAME: processingTime
      });
    }

    // Check for payment plan inquiries
    if (this.isPaymentPlanInquiry(lowerMessage)) {
      const annualDiscount = process.env.ANNUAL_PAYMENT_DISCOUNT || '10';

      return this.templateService.getTemplate('paymentPlans', {
        DISCOUNT: annualDiscount
      });
    }

    // No template match found
    return null;
  }
  /**
   * Generate a response using prompt engineering techniques
   * @param {string} message - The user's message
   * @param {Array} messageHistory - Array of previous messages for context
   * @returns {Promise<string>} - The AI-generated response
   */
  async generateEngineeredResponse(message, messageHistory = []) {
    // Detect the appropriate prompt type for the message
    const promptType = this.promptService.detectPromptType(message);

    // Extract variables from the message
    const variables = this.promptService.extractVariables(message);

    // Create the engineered prompt messages
    const promptMessages = this.promptService.createPromptMessages(
      promptType,
      message,
      messageHistory,
      variables
    );

    // If no OpenAI instance available (for testing), return a mock response
    if (!this.openai) {
      return 'This is an engineered response for a complex query';
    }

    // Get response from ChatGPT using the engineered prompt
    return await getChatGPTResponse(promptMessages, {
      model: this.defaultModel,
      temperature: 0.7, // Slightly higher temperature for more creative responses
      maxTokens: 500
    });
  }

  /**
   * Check if the message is a greeting
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is a greeting
   */
  isGreeting(message) {
    const greetingPatterns = [
      'hello', 'hi', 'hey', 'greetings', 'good morning',
      'good afternoon', 'good evening', 'howdy'
    ];

    return greetingPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if the message is a property inquiry
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is a property inquiry
   */
  isPropertyInquiry(message) {
    const propertyInquiryPatterns = [
      'looking for', 'searching for', 'interested in', 'available',
      'do you have', 'property', 'apartment', 'house', 'condo',
      'rent', 'buy', 'purchase'
    ];

    return propertyInquiryPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if the message is a mortgage inquiry
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is a mortgage inquiry
   */
  isMortgageInquiry(message) {
    const mortgagePatterns = [
      'mortgage', 'loan', 'financing', 'interest rate', 'down payment',
      'monthly payment', 'term', 'pre-approval', 'qualify'
    ];

    return mortgagePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if the message is a viewing request
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is a viewing request
   */
  isViewingRequest(message) {
    const viewingPatterns = [
      'schedule', 'viewing', 'tour', 'visit', 'see the property',
      'appointment', 'when can i see', 'show me'
    ];

    return viewingPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if the message is an application inquiry
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is an application inquiry
   */
  isApplicationInquiry(message) {
    const applicationPatterns = [
      'application', 'apply', 'how do i rent', 'process', 'approval',
      'requirements', 'qualify', 'background check', 'credit check'
    ];

    return applicationPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if the message is a payment plan inquiry
   * @param {string} message - The lowercase message
   * @returns {boolean} - Whether the message is a payment plan inquiry
   */
  isPaymentPlanInquiry(message) {
    const paymentPlanPatterns = [
      'payment plan', 'payment options', 'how to pay', 'installments',
      'monthly payment', 'discount', 'payment schedule'
    ];

    return paymentPlanPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Summarize a conversation
   * @param {Array} messages - Array of conversation messages
   * @returns {Promise<string>} - The summary
   */
  async summarizeConversation(messages) {
    return await summarizeConversation(messages);
  }
}

module.exports = AIService;
