/**
 * Response strategies.
 *
 * This module used to hold a dozen real-estate roles — "you are a top
 * performing real estate sales consultant", "you are a mortgage and financial
 * advisor" — so every tenant's bot behaved like an estate agent whatever
 * business they ran.
 *
 * What remains is deliberately about the *shape* of a reply, not the industry
 * it is in. "Someone has raised a complaint" wants the same structure whether
 * the product is software, insurance or garden furniture: acknowledge, resolve,
 * commit to a timeframe. Who the assistant is comes from the tenant's persona,
 * which is set in the workflow editor and layered on top of these.
 */

/**
 * Strategies keyed by the shape of the request, not the subject matter.
 *
 * `{PERSONA}` is substituted with the tenant's own description of their
 * assistant, so these never assert an identity of their own.
 */
const PROMPT_STRUCTURES = {
  // Someone wants to know something.
  informational: `
{PERSONA}

The customer has asked: {QUERY_TOPIC}

Answer using only the information available to you. Where you do not know
something, say so plainly rather than guessing. Lead with the direct answer,
then add the detail that supports it. Keep it under 150 words unless the
question genuinely needs more.
  `,

  // Something has gone wrong and they are unhappy about it.
  concernResolution: `
{PERSONA}

The customer has raised this concern: {CONCERN}

Acknowledge the problem and its impact on them before doing anything else.
Give a specific resolution rather than a general reassurance, say what will
happen next and by when, and avoid defensive or evasive language. If you
cannot resolve it yourself, say who will and when they will be in touch.
Keep it under 150 words.
  `,

  // They are choosing between options.
  comparison: `
{PERSONA}

The customer is comparing options and asked: {QUERY_TOPIC}

Set out the genuine differences that bear on their decision. Be even-handed:
name the drawbacks of each option as well as the strengths. Where one option
suits a particular circumstance better, say which circumstance rather than
simply declaring a winner. Close by naming the factor that should drive their
choice. Keep it under 200 words.
  `,

  // They need to do something and want to know how.
  instructional: `
{PERSONA}

The customer wants to know how to: {QUERY_TOPIC}

Give the steps in order, numbered. Keep each step to a single action. Note
anything they need to have ready before starting, and anything that commonly
goes wrong. Do not pad with encouragement. Keep it under 200 words.
  `,

  // The request is beyond what the assistant can do.
  escalation: `
{PERSONA}

The customer has asked about something you cannot resolve: {QUERY_TOPIC}

Say clearly that you are passing this to a colleague, without pretending to
have an answer. Confirm what you have understood so they do not have to repeat
themselves. Set expectations about what happens next. Keep it under 80 words.
  `
};

/**
 * The persona used when a tenant has not set one.
 *
 * Deliberately says nothing about any industry, and does not invent expertise
 * the assistant does not have.
 */
const DEFAULT_PERSONA = `
You are a customer support assistant. You are accurate, concise and plain
spoken. You do not invent facts, and you say when you do not know something.
`.trim();

/**
 * Patterns that suggest which strategy fits a message.
 *
 * All industry-neutral: the previous set matched on "mortgage", "lease",
 * "neighborhood" and "property".
 */
const STRATEGY_PATTERNS = {
  concernResolution: /\b(problem|issue|concern(ed)?|worried|complaint|complain|broken|not working|doesn'?t work|failed|wrong|unhappy|disappointed)\b/i,
  comparison: /\b(compare|comparison|difference|differences|better|versus|vs\.?|which one|which should|instead of)\b/i,
  instructional: /\b(how do i|how to|how can i|steps|guide|walk me through|set up|configure|install)\b/i,
  escalation: /\b(speak to (a|someone)|human|agent|representative|manager|escalate|complain to)\b/i
};

class PromptEngineeringService {
  constructor(options = {}) {
    this.prompts = { ...PROMPT_STRUCTURES, ...(options.customPrompts || {}) };
    this.persona = options.persona || DEFAULT_PERSONA;
  }

  /**
   * The tenant's persona, or the neutral default.
   */
  getDefaultSystemMessage() {
    return this.persona;
  }

  /**
   * Set the persona for this tenant. Called with whatever the company
   * configured in their workflow's Persona node.
   */
  setPersona(persona) {
    if (persona && String(persona).trim()) {
      this.persona = String(persona).trim();
    }
  }

  /**
   * A populated strategy prompt.
   */
  getPromptStructure(promptType, variables = {}) {
    const template = this.prompts[promptType] || this.prompts.informational;

    // The persona is always available to a strategy, so none of them has to
    // assert an identity of its own.
    const allVariables = { PERSONA: this.persona, ...variables };

    let populated = template;
    Object.entries(allVariables).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      populated = populated.replace(new RegExp(`\\{${safeKey}\\}`, 'g'), String(value));
    });

    return populated.trim();
  }

  createSystemMessage(promptType, variables = {}) {
    return this.getPromptStructure(promptType, variables);
  }

  createPromptMessages(promptType, userQuery, messageHistory = [], variables = {}) {
    return [
      { role: 'system', content: this.createSystemMessage(promptType, variables) },
      ...messageHistory,
      { role: 'user', content: userQuery }
    ];
  }

  addPromptStructure(promptType, promptTemplate) {
    this.prompts[promptType] = promptTemplate;
  }

  getPromptTypes() {
    return Object.keys(this.prompts);
  }

  /**
   * Choose a strategy from the shape of the message.
   *
   * Falls back to `informational`, which is the safe default: answering the
   * question plainly is never actively wrong, whereas treating a simple query
   * as a complaint is.
   */
  detectPromptType(userQuery) {
    const query = String(userQuery || '');

    for (const [strategy, pattern] of Object.entries(STRATEGY_PATTERNS)) {
      if (pattern.test(query)) {
        return strategy;
      }
    }

    return 'informational';
  }

  /**
   * Pull out the few things a strategy prompt needs.
   *
   * The previous implementation extracted property types, locations and
   * budgets with hardcoded patterns — including a literal check for the word
   * "Miami". Nothing here is domain-specific: a generic extractor cannot know
   * what matters to a given business, and guessing wrongly is worse than not
   * guessing. Anything richer belongs in the tenant's own workflow.
   */
  extractVariables(userQuery) {
    const query = String(userQuery || '');
    const variables = { QUERY_TOPIC: query };

    const concernMatch = query.match(
      /(?:concerned|worried|unhappy|frustrated)\s+(?:about|with|that)\s+(.+?)(?:[.?!]|$)/i
    );
    if (concernMatch && concernMatch[1]) {
      variables.CONCERN = concernMatch[1].trim();
    } else if (STRATEGY_PATTERNS.concernResolution.test(query)) {
      // The whole message is the concern when it is not phrased as "worried
      // about X".
      variables.CONCERN = query;
    }

    return variables;
  }
}

module.exports = {
  PromptEngineeringService,
  PROMPT_STRUCTURES,
  DEFAULT_PERSONA
};
