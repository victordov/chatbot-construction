const { OpenAI } = require('openai');
const { getResponseTemplateService } = require('./responseTemplates');
const { PromptEngineeringService, wrapKnowledge } = require('./promptEngineering');
const { getVectorStore } = require('./vector-store');
const { logger } = require('./logging');
const { openaiClientOptions } = require('../config/env');

/** A client for the configured key, or null when there is none. */
function buildClient(apiKey = process.env.OPENAI_API_KEY) {
  return apiKey ? new OpenAI({ apiKey, ...openaiClientOptions() }) : null;
}

const openai = buildClient();

/** The chat model used wherever a caller does not name one. */
function defaultModel() {
  return process.env.OPENAI_MODEL || 'gpt-4o';
}

/**
 * Thrown when a reply needs the model and there is no client to call.
 *
 * This used to return a "mock response" string, which then went to real
 * visitors of any deployment that lost its key. Throwing lets the caller send
 * a proper apology instead of a test stub.
 */
function noClientError() {
  const error = new Error('OPENAI_API_KEY is not configured; no model is available to answer');
  error.code = 'NO_AI_CLIENT';
  return error;
}

/**
 * The assistant's behaviour when a tenant has not configured a persona.
 *
 * Deliberately says nothing about any industry. This used to describe a
 * property management company, so every tenant's bot introduced itself as one
 * until they built a workflow.
 */
const DEFAULT_SYSTEM_MESSAGE = `
You are a customer support assistant. Be accurate, concise and plain spoken.
Answer from the information available to you, and say plainly when you do not
know something rather than guessing.
`;

/**
 * Put the tenant's own material in front of the model, and tell it to prefer
 * that material over what it happens to know.
 *
 * The wording matches `workflow-compiler.js#buildPromptHierarchy`, so a company
 * gets the same answer from the assistant as from a workflow's knowledge node.
 * The instruction to say so when the material does not cover the question is
 * the point of retrieval in support: a confident wrong answer about somebody
 * else's refund policy is worse than "I don't know".
 */
function groundInKnowledge(promptMessages, knowledgeContext) {
  const system = promptMessages.find(entry => entry.role === 'system');

  const grounding = `\n\n${wrapKnowledge(knowledgeContext)}\n\n` +
    'Answer from the material above whenever it covers the question, and say ' +
    'plainly that you do not have that information when it does not. Do not ' +
    'invent details that are not there.';

  if (system) {
    system.content += grounding;
  } else {
    promptMessages.unshift({ role: 'system', content: DEFAULT_SYSTEM_MESSAGE + grounding });
  }

  return promptMessages;
}

/**
 * Get a response from ChatGPT
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Configuration options
 * @returns {Promise<string>} - The assistant's response
 */
async function getChatGPTResponse(messages, options = {}) {
  try {
    // The caller's own client wins over the module-level one, which is built
    // from the environment when this file is first required. An AIService that
    // was handed a client had it ignored here, so the reply path could return
    // the mock string below while `this.openai` was a perfectly good client.
    const client = options.client || openai;

    if (!client) {
      throw noClientError();
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
    const response = await client.chat.completions.create({
      model: options.model || defaultModel(),
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
async function isOnTopic(message, openaiClient = openai, scope = null) {
  // No configured scope means every question is in scope. This is the default
  // and the common case: a general-purpose assistant has no business refusing
  // to answer.
  //
  // The previous implementation hardcoded the scope to "property management,
  // real estate, apartments, housing, mortgages, or payment plans" and spent
  // an extra model call on every single message to enforce it.
  if (!scope || !String(scope).trim()) {
    return true;
  }

  try {
    if (!openaiClient) {
      return true;
    }

    const response = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Decide whether the message falls within this assistant\'s remit.\n\n' +
            `Remit: ${scope}\n\n` +
            'Reply with only "true" or "false".'
        },
        { role: 'user', content: message }
      ],
      temperature: 0,
      max_tokens: 5
    });

    return response.choices[0].message.content.trim().toLowerCase().startsWith('true');
  } catch (error) {
    // Fail open: refusing to answer because a classifier call failed is worse
    // than answering something slightly off-topic.
    logger.error('Error checking if message is on-topic:', { error });
    return true;
  }
}


/**
 * Service for AI integration with OpenAI
 */
class AIService {
  constructor(options = {}) {
    // A caller's own client (tests, or a per-tenant key one day) wins over the
    // one built from the environment.
    this.openai = options.openai || buildClient();

    this.systemMessage = options.systemMessage || DEFAULT_SYSTEM_MESSAGE;
    // Use environment variable for model if set, otherwise use options.model or default to GPT-4o
    this.defaultModel = options.model || defaultModel();
    // Set a higher token limit for GPT-4o
    this.maxTokens = options.maxTokens || 4000;

    // Which tenant this instance is answering for. Templates and persona are
    // per-company, so without it the service can only use neutral defaults.
    this.companyId = options.companyId || null;

    // Optional description of what this assistant is for. Empty means the
    // assistant answers anything, which is the default.
    this.scope = options.scope || null;

    this.templateService = options.templateService || getResponseTemplateService();

    this.promptService = options.promptService ||
      new PromptEngineeringService(options.promptOptions);

    // How many knowledge chunks to put in front of the model. Five is what the
    // workflow knowledge node uses; keeping them the same means a tenant does
    // not get a different answer depending on whether they drew a graph.
    this.knowledgeLimit = options.knowledgeLimit || 5;

    // Retrieval can be turned off per instance, which the tests need and a
    // tenant answering purely from a persona might want.
    this.useKnowledge = options.useKnowledge !== false;

    this.vectorStore = options.vectorStore || null;
  }

  /**
   * Adopt a tenant's persona, so replies sound like their business rather than
   * a generic assistant.
   */
  setPersona(persona) {
    if (persona && String(persona).trim()) {
      this.systemMessage = String(persona).trim();
      this.promptService.setPersona(persona);
    }
  }

  /**
   * Generate a response to a user message
   * @param {string} message - The user's message
   * @param {Array} messageHistory - Array of previous messages for context
   * @param {object} [options] `toolSession` from services/assistant-tools.js,
   *        when the model may call the tenant's actions this turn
   * @returns {Promise<string>} - The AI-generated response
   */
  async generateResponse(message, messageHistory = [], options = {}) {
    try {
      // Only enforced when the tenant configured a scope; otherwise every
      // question is in scope and this costs nothing.
      const onTopic = await isOnTopic(message, this.openai, this.scope);

      if (!onTopic) {
        const offTopic = await this.templateService.getByRole(this.companyId, 'offTopic');
        return offTopic ||
          'That is outside what I can help with here. Would you like me to pass you to a colleague?';
      }

      const templateResponse = await this.checkForTemplateMatch(message);
      if (templateResponse) {
        return templateResponse;
      }

      return await this.generateEngineeredResponse(message, messageHistory, options);
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
  async checkForTemplateMatch(message) {
    if (!this.companyId) {
      // No tenant, no templates. Fall through to the model.
      return null;
    }

    const lowerMessage = String(message).toLowerCase();

    // A greeting is the one universal case worth special-casing, and only
    // because a tenant that defined a greeting template clearly wants it used.
    if (this.isGreeting(lowerMessage)) {
      const greeting = await this.templateService.getByRole(this.companyId, 'greeting');
      if (greeting) {
        return greeting;
      }
    }

    // Everything else is matched against the templates this company defined,
    // by meaning rather than by keyword. There is no built-in list of
    // "property inquiry" or "mortgage inquiry" patterns any more - what counts
    // as a recognisable question is the tenant's to decide.
    const match = await this.templateService.match(this.companyId, message);
    return match ? match.text : null;
  }

  /**
   * Generate a response using prompt engineering techniques
   * @param {string} message - The user's message
   * @param {Array} messageHistory - Array of previous messages for context
   * @returns {Promise<string>} - The AI-generated response
   */
  async generateEngineeredResponse(message, messageHistory = [], options = {}) {
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

    const knowledge = await this.retrieveKnowledge(message);
    if (knowledge) {
      groundInKnowledge(promptMessages, knowledge);
    }

    // No client means no answer: the caller turns the throw into an apology.
    // Returning stub text here put "This is an engineered response for a
    // complex query" in front of real visitors whenever the key was missing.
    if (!this.openai) {
      throw noClientError();
    }

    // The one seam for tool calling. Everything about which tools, their caps
    // and the confirmation rule lives in services/assistant-tools.js; this
    // only hands it the prompt the assistant would otherwise have sent.
    if (options.toolSession && options.toolSession.hasTools()) {
      return await options.toolSession.run(promptMessages, {
        client: this.openai,
        model: this.defaultModel,
        temperature: 0.7,
        maxTokens: 500
      });
    }

    return await getChatGPTResponse(promptMessages, {
      client: this.openai,
      model: this.defaultModel,
      temperature: 0.7, // Slightly higher temperature for more creative responses
      maxTokens: 500
    });
  }

  /**
   * What this tenant has written down that bears on the question.
   *
   * Until this existed, everything a tenant imported - their spreadsheets,
   * their PDFs, their site - was reachable only from a workflow's knowledge
   * node. A company that uploaded a price list and never drew a graph had an
   * assistant that answered as though the price list did not exist, which is
   * the opposite of what uploading it implies.
   *
   * @returns {Promise<string>} the chunks as text, or '' when there are none
   */
  async retrieveKnowledge(message) {
    if (!this.useKnowledge || !this.companyId || !String(message || '').trim()) {
      return '';
    }

    try {
      const store = this.vectorStore || getVectorStore();
      const results = await store.search(message, {
        companyId: this.companyId,
        limit: this.knowledgeLimit
      });

      return (results || [])
        .map(result => String(result.content || '').trim())
        .filter(Boolean)
        .join('\n\n');
    } catch (error) {
      // A knowledge base that is down should cost the answer its context, not
      // cost the visitor their reply - but it is an error, not a warning: the
      // tenant's bot has just answered as though they never imported anything.
      logger.error('Knowledge retrieval failed; answering without it', {
        companyId: String(this.companyId),
        error: error.message
      });
      return '';
    }
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
   * Generate a suggestion for operators based on a user message and conversation history
   * This is specifically for operator suggestions and not direct responses to users
   * @param {string} userMessage - The user's message
   * @param {Array} messageHistory - Array of previous messages for context
   * @returns {Promise<string>} - The AI-generated suggestion for the operator
   */
  async generateOperatorSuggestion(userMessage, messageHistory = []) {
    try {
      const onTopic = await isOnTopic(userMessage, this.openai, this.scope);

      if (!onTopic) {
        const offTopic = await this.templateService.getByRole(this.companyId, 'offTopic');
        return offTopic ||
          'This looks outside our remit - you may want to redirect the customer.';
      }

      const templateResponse = await this.checkForTemplateMatch(userMessage);
      if (templateResponse) {
        return templateResponse;
      }

      // Create a special system message for operator suggestions
      const operatorSuggestionSystemMessage = `
${this.systemMessage}

You are generating a response suggestion for a human operator to review. 
This suggestion will NOT be sent directly to the user - it will only be shown to the operator.
The operator can choose to use your suggestion as-is, edit it, or ignore it completely.

Provide a comprehensive, helpful response that the operator can use or modify.
Include all relevant information that might help the user, as the operator can edit out anything unnecessary.
`;

      // Use prompt engineering for more complex or specific queries
      // Detect the appropriate prompt type for the message
      // eslint-disable-next-line no-unused-vars
      const promptType = this.promptService.detectPromptType(userMessage);

      // Extract variables from the message
      // eslint-disable-next-line no-unused-vars
      const variables = this.promptService.extractVariables(userMessage);

      // Create the engineered prompt messages with the operator suggestion system message
      const promptMessages = [
        { role: 'system', content: operatorSuggestionSystemMessage },
        ...messageHistory,
        { role: 'user', content: userMessage }
      ];

      // An operator drafting a reply needs the tenant's material at least as
      // much as the bot does - more, since they are about to send it as the
      // company rather than as a machine.
      const knowledge = await this.retrieveKnowledge(userMessage);
      if (knowledge) {
        groundInKnowledge(promptMessages, knowledge);
      }

      if (!this.openai) {
        throw noClientError();
      }

      // Get response from ChatGPT using the engineered prompt
      const response = await this.openai.chat.completions.create({
        model: this.defaultModel,
        messages: promptMessages,
        temperature: 0.7,
        max_tokens: this.maxTokens
      });

      return response.choices[0].message.content;
    } catch (error) {
      logger.error('Error generating operator suggestion:', { error });
      return 'I encountered an error generating a suggestion. Please respond to the user directly.';
    }
  }
}

/**
 * An AIService configured for one tenant: their persona, their scope, their
 * templates.
 *
 * Every call site used to do `new AIService()`, which meant the hardcoded
 * property-management persona regardless of whose conversation it was.
 */
AIService.forCompany = async function forCompany(companyId, options = {}) {
  const service = new AIService({ ...options, companyId });

  if (companyId) {
    // Required lazily: assistant-config depends on the workflow model, which
    // depends back on this module through the compiler.
    const { resolve } = require('./assistant-config');
    const { persona, scope } = await resolve(companyId);
    service.setPersona(persona);
    service.scope = scope;
  }

  return service;
};

module.exports = AIService;
module.exports.buildClient = buildClient;
module.exports.getChatGPTResponse = getChatGPTResponse;
