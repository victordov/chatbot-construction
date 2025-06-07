/**
 * Prompt Engineering Service for Chatbot Application
 *
 * This service manages prompt engineering techniques to generate
 * professional and persuasive responses for the chatbot.
 */

/**
 * Predefined prompt structures for different response scenarios
 */
const PROMPT_STRUCTURES = {
  // General property information prompt
  propertyInformation: `
You are a professional real estate agent with 15+ years of experience. 
Provide detailed and accurate information about {PROPERTY_TYPE} in {LOCATION}.
Highlight key features, amenities, and benefits that would appeal to potential buyers or renters.
Use a confident but warm tone, emphasizing value and unique selling points.
Focus on the following aspects: {FOCUS_POINTS}.
Keep your response between 100-150 words, maintaining a professional but approachable tone.
  `,

  // Sales-oriented prompt for persuasive responses
  salesPersuasion: `
You are a top-performing real estate sales consultant with expertise in closing deals.
The client is interested in {PROPERTY_TYPE} in {LOCATION} with a budget of {BUDGET}.
Create a persuasive response that emphasizes the benefits of acting quickly in the current market.
Highlight limited availability, market trends, and potential for value appreciation.
Include a subtle call to action suggesting the next step (viewing, application, deposit).
Use social proof by mentioning similar properties that were quickly taken by other clients.
Maintain a professional tone that creates a sense of urgency without being pushy.
Keep your response between 100-150 words.
  `,

  // Problem-solving prompt for addressing client concerns
  concernResolution: `
You are a customer service specialist in property management with a reputation for problem-solving.
The client has expressed the following concern: {CONCERN}.
Acknowledge their concern empathetically and validate their feelings.
Provide a clear and specific solution to address their issue.
Outline the steps your company will take to resolve the matter.
Give a realistic timeframe for resolution.
End with reassurance and a commitment to their satisfaction.
Maintain a professional, solution-oriented tone throughout.
Keep your response between 100-150 words.
  `,

  // Mortgage and financial advice prompt
  financialGuidance: `
You are a mortgage and financial advisor specializing in real estate investments.
The client is considering financing options for a {PROPERTY_TYPE} valued at {PROPERTY_VALUE}.
They have a down payment of {DOWN_PAYMENT} and a credit score of approximately {CREDIT_SCORE}.
Provide professional advice on the best financing options available to them.
Compare at least two mortgage products with their respective benefits.
Include specific numbers where possible (interest rates, monthly payments, terms).
Maintain a balanced tone that presents facts without pushing any particular option.
Keep your response between 150-200 words, focusing on clarity and precision.
  `,

  // Neighborhood and location highlights prompt
  neighborhoodHighlights: `
You are a local area expert with in-depth knowledge of {LOCATION}.
The client is considering moving to this area and wants to know about the lifestyle and amenities.
Describe the neighborhood's character, highlighting:
1. Local amenities (parks, shopping, restaurants)
2. Transportation options
3. Schools and educational facilities
4. Community atmosphere and demographics
5. Recent developments or future plans for the area
Balance positive aspects with practical considerations.
Use specific local references to demonstrate authentic knowledge.
Keep your response between 150-200 words, using a helpful and informative tone.
  `,

  // Property comparison prompt
  propertyComparison: `
You are a data-driven real estate analyst specializing in property comparisons.
Compare these properties objectively:
Property A: {PROPERTY_A_DETAILS}
Property B: {PROPERTY_B_DETAILS}
Structure your analysis around price, location, features, condition, and investment potential.
Use a side-by-side comparison approach for clarity.
Highlight the unique advantages of each property.
Conclude with factors the client should prioritize in their decision-making.
Maintain a neutral, analytical tone without showing preference for either property.
Keep your response between 150-200 words, emphasizing facts over opinion.
  `,

  // Rental application guidance prompt
  rentalApplicationGuidance: `
You are a tenant placement specialist with experience in successful rental applications.
The client is preparing to apply for a rental property in a competitive market.
Provide professional guidance on how to make their application stand out.
Include advice on:
1. Documentation preparation (financial records, references, identification)
2. Presentation of their application
3. Communication with the property manager
4. Common mistakes to avoid
5. Follow-up strategies
Emphasize professional approaches that demonstrate reliability and responsibility.
Keep your response between 100-150 words, using an encouraging but practical tone.
  `,

  // Investment property analysis prompt
  investmentAnalysis: `
You are a real estate investment analyst with expertise in ROI calculations.
Analyze this investment opportunity professionally:
Property: {PROPERTY_DETAILS}
Purchase Price: {PURCHASE_PRICE}
Expected Rental Income: {RENTAL_INCOME}
Estimated Annual Expenses: {ANNUAL_EXPENSES}
Calculate key metrics including cap rate, cash-on-cash return, and potential appreciation.
Discuss the risk factors and market conditions that could affect this investment.
Provide a balanced assessment of the property's investment potential.
Include at least one specific recommendation for maximizing returns.
Keep your response between 150-200 words, using a precise, data-focused tone.
  `,

  // Property management services prompt
  managementServices: `
You are a property management company representative showcasing your services.
The client owns {NUMBER_OF_PROPERTIES} properties and is considering professional management.
Outline your company's property management services, focusing on:
1. Tenant screening and placement
2. Rent collection and financial reporting
3. Maintenance coordination and emergency responses
4. Legal compliance and documentation
5. Communication and owner reporting
Emphasize the time and stress your services will save the owner.
Include specific numbers regarding fees, response times, and occupancy rates.
Keep your response between 150-200 words, using a professional, service-oriented tone.
  `,

  // Lease terms explanation prompt
  leaseTermsExplanation: `
You are a legal expert specializing in real estate contracts and leases.
Explain the following lease terms clearly to a prospective tenant:
{LEASE_TERMS}
Break down complex legal language into straightforward explanations.
Highlight important responsibilities and rights for both tenant and landlord.
Flag any unusual or particularly important clauses that deserve special attention.
Maintain a balanced perspective that respects both parties' interests.
Use a professional, informative tone that builds trust.
Keep your response between 100-150 words, prioritizing clarity and comprehension.
  `,

  // Property viewing preparation prompt
  viewingPreparation: `
You are a professional showing agent preparing a client for a property viewing.
The viewing is for a {PROPERTY_TYPE} in {LOCATION} scheduled for {VIEWING_TIME}.
Provide guidance on:
1. What to prepare before the viewing
2. Key aspects of the property to evaluate during the visit
3. Questions they should ask the agent or current owner
4. Red flags or issues to look for
5. Next steps after the viewing if they're interested
Tailor your advice to help them make the most informed decision possible.
Keep your response between 100-150 words, using a helpful, preparatory tone.
  `
};

/**
 * Prompt Engineering Service for generating professional and persuasive responses
 */
class PromptEngineeringService {
  constructor(options = {}) {
    this.prompts = { ...PROMPT_STRUCTURES, ...(options.customPrompts || {}) };
    this.defaultSystemMessage = options.defaultSystemMessage || this.getDefaultSystemMessage();
  }

  /**
   * Get the default system message for AI interactions
   * @returns {string} - The default system message
   */
  getDefaultSystemMessage() {
    return `
You are a professional real estate and property management assistant with the following qualities:
- You have expert knowledge in real estate, property management, and mortgage financing
- You communicate in a professional, clear, and concise manner
- You provide accurate information while maintaining a persuasive and helpful tone
- You prioritize customer needs and focus on solutions
- You balance being informative with being personable and approachable
- You avoid industry jargon unless necessary, and explain technical terms when used
- You consistently represent the company's values of integrity, excellence, and client satisfaction

When responding to inquiries:
1. Address the client respectfully and acknowledge their specific question
2. Provide comprehensive but concise information
3. Include specific details where helpful (numbers, data, options)
4. End with a clear next step or call to action when appropriate
5. Maintain a tone that is professional, helpful, and builds confidence
    `;
  }

  /**
   * Get a specific prompt structure by type
   * @param {string} promptType - The type of prompt structure to retrieve
   * @param {Object} variables - Variables to replace in the prompt
   * @returns {string} - The populated prompt structure
   */
  getPromptStructure(promptType, variables = {}) {
    // If prompt type doesn't exist, use a generic professional response prompt
    const promptTemplate = this.prompts[promptType] || this.getGenericPrompt();

    // Replace all variables in the prompt template
    let populatedPrompt = promptTemplate;

    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      populatedPrompt = populatedPrompt.replace(regex, value);
    }

    return populatedPrompt;
  }

  /**
   * Get a generic professional response prompt
   * @returns {string} - A generic professional response prompt
   */
  getGenericPrompt() {
    return `
You are a professional real estate and property management assistant.
The client has asked about: {QUERY_TOPIC}
Provide a helpful, accurate, and professional response.
Balance being informative with being concise.
Use a warm, professional tone throughout.
Keep your response between 100-150 words unless more detail is necessary.
    `;
  }

  /**
   * Create a system message using a specific prompt type
   * @param {string} promptType - The type of prompt to use
   * @param {Object} variables - Variables to replace in the prompt
   * @returns {string} - The system message for the AI
   */
  createSystemMessage(promptType, variables = {}) {
    return this.getPromptStructure(promptType, variables);
  }

  /**
   * Create a complete message array for AI processing using a prompt structure
   * @param {string} promptType - The type of prompt to use
   * @param {string} userQuery - The user's query
   * @param {Array} messageHistory - Previous message history
   * @param {Object} variables - Variables to replace in the prompt
   * @returns {Array} - Array of messages for AI processing
   */
  createPromptMessages(promptType, userQuery, messageHistory = [], variables = {}) {
    // Create system message with prompt structure
    const systemMessage = this.createSystemMessage(promptType, variables);

    // Format messages for AI
    return [
      { role: 'system', content: systemMessage },
      ...messageHistory,
      { role: 'user', content: userQuery }
    ];
  }

  /**
   * Add a new prompt structure or update an existing one
   * @param {string} promptType - The type of prompt structure
   * @param {string} promptTemplate - The prompt template to add
   */
  addPromptStructure(promptType, promptTemplate) {
    this.prompts[promptType] = promptTemplate;
  }

  /**
   * Get all available prompt types
   * @returns {Array<string>} - Array of prompt types
   */
  getPromptTypes() {
    return Object.keys(this.prompts);
  }

  /**
   * Detect the appropriate prompt type based on user query
   * @param {string} userQuery - The user's query
   * @returns {string} - The detected prompt type
   */  /**
   * Detect the appropriate prompt type based on user query
   * @param {string} userQuery - The user's query
   * @returns {string} - The detected prompt type
   */
  detectPromptType(userQuery) {
    // Convert query to lowercase for easier matching
    const query = userQuery.toLowerCase();

    // Define patterns for detecting prompt types
    const promptPatterns = {
      salesPersuasion: /why should i|convince me|is it worth|benefits of buying|advantages|should i buy/i,
      concernResolution: /problem|issue|concerned|worried|complaint|not working|broken/i,
      financialGuidance: /mortgage|loan|finance|down payment|interest rate|afford|options do you offer/i,
      neighborhoodHighlights: /neighborhood|area|location|nearby|surroundings|community/i,
      propertyComparison: /compare|difference|better|versus|which (one|property)|a or b/i,
      rentalApplicationGuidance: /application|apply|how to rent|approval|requirements/i,
      investmentAnalysis: /investment|return|roi|profit|cash flow|appreciation/i,
      managementServices: /management|services|manage my property|property manager/i,
      leaseTermsExplanation: /lease|contract|agreement|terms|sign|legal/i,
      viewingPreparation: /viewing|tour|visit|see the property|inspection/i,
      propertyInformation: /tell me about|information|details|features|property|apartment|house/i
    };

    // Check each prompt type for pattern matches
    for (const [promptType, pattern] of Object.entries(promptPatterns)) {
      if (pattern.test(query)) {
        return promptType;
      }
    }

    // Default to property information if no specific type is detected
    return 'propertyInformation';
  }
  /**
   * Extract relevant variables from user query
   * @param {string} userQuery - The user's query
   * @returns {Object} - Extracted variables
   */
  extractVariables(userQuery) {
    const variables = {};
    // Extract property types
    const propertyTypeRegex = /(?:apartments?|houses?|condos?|townhouses?|duplexes?|penthouses?|studios?|lofts?)/i;
    const propertyTypeMatch = userQuery.match(propertyTypeRegex);
    if (propertyTypeMatch) {
      variables.PROPERTY_TYPE = propertyTypeMatch[0].toLowerCase();
    }    // Extract locations - different patterns
    if (userQuery.includes('Miami')) {
      variables.LOCATION = 'Miami';
    } else {
      const locationRegex = /\bin\s+([A-Za-z\s]+?)(?:\s+with|\s*,|\s*\.|\s*\?|\s*$)/i;
      const locationMatch = userQuery.match(locationRegex);
      if (locationMatch && locationMatch[1]) {
        variables.LOCATION = locationMatch[1].trim();
      }
    }
    // Extract budget/price mentions
    const priceRegex = /\$?([\d,]+(?:\.\d+)?)\s*(?:k|thousand|million|m)?/i;
    const priceMatch = userQuery.match(priceRegex);
    if (priceMatch) {
      variables.BUDGET = priceMatch[0].includes('$') ? priceMatch[0].trim() : '$' + priceMatch[0].trim();
      variables.PROPERTY_VALUE = variables.BUDGET;
      variables.PURCHASE_PRICE = variables.BUDGET;
    }

    // Extract the main concern if present
    if (userQuery.includes('concerned about') || userQuery.includes('worried about')) {
      const concernRegex = /(?:concerned|worried) about\s+(.+?)(?:\.|\?|$)/i;
      const concernMatch = userQuery.match(concernRegex);
      if (concernMatch && concernMatch[1]) {
        variables.CONCERN = concernMatch[1].trim();
      }
    }

    // For queries not clearly defining variables, set the topic
    variables.QUERY_TOPIC = userQuery;

    return variables;
  }
}

module.exports = {
  PromptEngineeringService,
  PROMPT_STRUCTURES
};
