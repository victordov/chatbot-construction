/**
 * Response Templates Service for Chatbot Application
 *
 * This service manages predefined response templates for common queries,
 * allowing for consistent and customizable responses across the application.
 */

// Common templates for property management queries
const RESPONSE_TEMPLATES = {
  // Greeting templates
  greeting: [
    'Hello! I\'m your property assistant. How can I help you today with your property search or management needs?',
    'Welcome! I\'m here to assist with any property-related questions. What can I help you with?',
    'Hi there! Looking for your dream property or have questions about property management? I\'m here to help!'
  ],

  // Property information templates
  propertyInquiry: [
    'We have several properties that might meet your requirements. Could you please specify what area you\'re interested in, your budget range, and how many bedrooms you need?',
    'I\'d be happy to help you find the perfect property. To narrow down the options, could you share your preferred location, price range, and the number of bedrooms you\'re looking for?'
  ],

  // Mortgage and financing templates
  mortgageInformation: [
    'Our mortgage options start at [RATE]% interest with terms ranging from 15 to 30 years. The down payment requirement is typically [PERCENTAGE]% of the property value. Would you like me to calculate a sample payment plan for you?',
    'We offer competitive mortgage rates starting at [RATE]% APR with flexible terms. Down payments typically start at [PERCENTAGE]% but can vary based on your credit score and the property value. How much financing were you considering?'
  ],

  // Appointment scheduling templates
  scheduleViewing: [
    'I\'d be happy to arrange a viewing for you. Our available time slots are [SLOTS]. Which date and time works best for you?',
    'We can schedule a viewing at your convenience. We have openings on [SLOTS]. When would you prefer to visit the property?'
  ],

  // Application process templates
  applicationProcess: [
    'The rental application process involves: 1) Completing our online application form, 2) Credit and background check ($[AMOUNT] fee), 3) Income verification, and 4) Previous landlord references. The process typically takes [TIMEFRAME] business days. Would you like me to send you the application link?',
    'To apply for one of our properties, you\'ll need to: 1) Fill out our application form, 2) Pay the $[AMOUNT] application fee for credit/background checks, 3) Provide proof of income, and 4) Supply references. We usually process applications within [TIMEFRAME] business days.'
  ],

  // Payment plan templates
  paymentPlans: [
    'We offer flexible payment plans including monthly, quarterly, and annual options. Paying annually gives you a [DISCOUNT]% discount. Would you like details about a specific payment schedule?',
    'Our payment plans include monthly installments of $[AMOUNT], or you can save [DISCOUNT]% by paying annually. We accept all major credit cards, bank transfers, and automated payments. Which option would work best for you?'
  ],

  // Maintenance request templates
  maintenanceRequest: [
    'I\'ll submit a maintenance request right away. Our team typically responds within [TIMEFRAME] hours for non-emergency issues. Is there anything specific the maintenance team should know about the issue?',
    'I\'ve logged your maintenance request. For this type of issue, our response time is usually [TIMEFRAME]. Someone from our maintenance team will contact you to schedule a visit. Is there a preferred time for them to come?'
  ],

  // Lease renewal templates
  leaseRenewal: [
    'Your lease is coming up for renewal on [DATE]. We\'re offering a [PERCENTAGE]% increase for a 12-month renewal or [PERCENTAGE_ALT]% for a 6-month term. Would you like to proceed with renewing your lease?',
    'Regarding your lease renewal, we can offer you a new 12-month term at $[AMOUNT] per month (a [PERCENTAGE]% increase) or a 6-month term at $[AMOUNT_ALT]. The renewal deadline is [DATE]. What would you prefer?'
  ],

  // Amenities templates
  amenitiesInformation: [
    'This property features [AMENITIES_LIST]. Which of these amenities are most important to you?',
    'The building includes amenities such as [AMENITIES_LIST]. Is there a specific amenity you\'d like more information about?'
  ],

  // Move-in/Move-out templates
  moveInstructions: [
    'For your move-in on [DATE], please arrive at [TIME] to complete the paperwork and receive your keys. You\'ll need to bring [DOCUMENTS] and payment for [AMOUNT]. Our staff will conduct a walk-through with you.',
    'We\'re looking forward to your move-in on [DATE]! Please come to the property management office at [TIME]. Remember to bring [DOCUMENTS] and your first month\'s rent plus security deposit totaling $[AMOUNT].'
  ],

  // Contact information templates
  contactInformation: [
    'You can reach our property management office at [PHONE] or email us at [EMAIL]. Our office hours are [HOURS]. Is there a specific department you need to contact?',
    'For any further questions, please contact us at [PHONE] or [EMAIL]. Our office is open [HOURS], and we have a 24/7 emergency line at [EMERGENCY_PHONE].'
  ],

  // Fallback templates for when no specific template matches
  fallback: [
    'I understand you\'re asking about [TOPIC]. Let me find the most relevant information for you.',
    'Thank you for your question about [TOPIC]. Here\'s what I can tell you based on the information available.'
  ],

  // Off-topic redirect templates
  offTopic: [
    'I\'m specialized in property management and real estate questions. Could you please ask something related to properties, apartments, mortgages, or payment plans?',
    'I\'m here to help with property-related inquiries. If you have questions about real estate, rentals, or property management, I\'d be happy to assist.'
  ]
};

/**
 * Response Template Service for managing predefined responses
 */
class ResponseTemplateService {
  constructor(options = {}) {
    this.templates = { ...RESPONSE_TEMPLATES, ...(options.customTemplates || {}) };
    this.variables = {
      ...{
        RATE: '3.5',
        PERCENTAGE: '20',
        AMOUNT: '50',
        TIMEFRAME: '3-5',
        DISCOUNT: '10',
        SLOTS: 'Monday-Friday, 9 AM to 5 PM',
        AMENITIES_LIST: 'a pool, gym, and covered parking',
        HOURS: 'Monday-Friday, 9 AM to 5 PM',
        PHONE: '(555) 123-4567',
        EMAIL: 'info@propertymanagement.com',
        EMERGENCY_PHONE: '(555) 987-6543'
      },
      ...(options.defaultVariables || {})
    };
  }

  /**
   * Get a template by category
   * @param {string} category - The template category
   * @param {Object} variables - Variables to replace in the template
   * @returns {string} - The populated template
   */
  getTemplate(category, variables = {}) {
    // Check if the category exists
    if (!this.templates[category]) {
      return this.getTemplate('fallback', { TOPIC: category, ...variables });
    }

    // Get all templates for the category
    const templates = this.templates[category];

    // Randomly select a template from the category
    const randomIndex = Math.floor(Math.random() * templates.length);
    const template = templates[randomIndex];

    // Replace all variables in the template
    return this.populateTemplate(template, variables);
  }

  /**
   * Populate a template with variables
   * @param {string} template - The template string
   * @param {Object} variables - Variables to replace in the template
   * @returns {string} - The populated template
   */
  populateTemplate(template, variables = {}) {
    // Combine default variables with provided variables
    const allVariables = { ...this.variables, ...variables };

    // Replace all variables in the template
    let populatedTemplate = template;

    for (const [key, value] of Object.entries(allVariables)) {
      const regex = new RegExp(`\\[${key}\\]`, 'g');
      populatedTemplate = populatedTemplate.replace(regex, value);
    }

    return populatedTemplate;
  }

  /**
   * Add a new template or update an existing one
   * @param {string} category - The template category
   * @param {string|Array<string>} templates - The template(s) to add
   */
  addTemplate(category, templates) {
    if (!this.templates[category]) {
      this.templates[category] = [];
    }

    if (Array.isArray(templates)) {
      this.templates[category] = [...this.templates[category], ...templates];
    } else {
      this.templates[category].push(templates);
    }
  }

  /**
   * Set default variables for templates
   * @param {Object} variables - Default variables for templates
   */
  setDefaultVariables(variables) {
    this.variables = { ...this.variables, ...variables };
  }

  /**
   * Get all available template categories
   * @returns {Array<string>} - Array of template categories
   */
  getCategories() {
    return Object.keys(this.templates);
  }

  /**
   * Get all templates for a category
   * @param {string} category - The template category
   * @returns {Array<string>} - Array of templates
   */
  getTemplatesForCategory(category) {
    return this.templates[category] || [];
  }
}

module.exports = {
  ResponseTemplateService,
  DEFAULT_TEMPLATES: RESPONSE_TEMPLATES
};
