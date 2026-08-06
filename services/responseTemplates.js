/**
 * Canned replies, owned by the tenant.
 *
 * This module used to ship a fixed set of property-management copy — mortgage
 * rates, lease renewals, viewing appointments — which every tenant's bot used
 * regardless of what business they were in. There is now no industry content
 * in the codebase at all: a company defines its own templates, and a company
 * with none simply falls through to its configured persona.
 *
 * Matching a visitor's message to a template reuses the embedding-based
 * classifier that workflow router intents use, so a template triggered by
 * "refund" also catches "can I get my money back".
 */

const ResponseTemplate = require('../models/response-template');
const { getIntentClassifier } = require('./intent-classifier');
const { logger } = require('./logging');

// Templates change rarely but are consulted on every inbound message.
const CACHE_TTL_MS = 60 * 1000;

class ResponseTemplateService {
  constructor(options = {}) {
    this.classifier = options.classifier || getIntentClassifier();
    this.cache = new Map();
    this.cacheTtl = options.cacheTtl ?? CACHE_TTL_MS;
  }

  cacheKey(companyId) {
    return String(companyId);
  }

  invalidate(companyId) {
    if (companyId) {
      this.cache.delete(this.cacheKey(companyId));
    } else {
      this.cache.clear();
    }
  }

  /**
   * A company's enabled templates, cached.
   */
  async load(companyId) {
    if (!companyId) {
      return [];
    }

    const key = this.cacheKey(companyId);
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value;
    }

    try {
      const templates = await ResponseTemplate.forCompany(companyId);
      this.cache.set(key, { value: templates, expires: Date.now() + this.cacheTtl });
      return templates;
    } catch (error) {
      // A template lookup failing should cost the visitor a canned reply, not
      // the whole conversation.
      logger.error('Could not load response templates', {
        companyId: String(companyId),
        error: error.message
      });
      return [];
    }
  }

  /**
   * The template filling a fixed conversational slot, if the tenant defined one.
   *
   * @param {string} companyId
   * @param {'greeting'|'fallback'|'offTopic'|'handoff'} role
   * @param {object} [variables] values for `[PLACEHOLDER]` markers
   * @returns {Promise<string|null>}
   */
  async getByRole(companyId, role, variables = {}) {
    const templates = await this.load(companyId);
    const match = templates.find(template => template.role === role);

    if (!match) {
      return null;
    }

    return this.render(match, variables);
  }

  /**
   * The best template for what a visitor actually said, or null if none is a
   * good enough match.
   *
   * Returning null is the important case: it means "let the model answer",
   * which is almost always better than forcing an ill-fitting canned reply.
   *
   * @returns {Promise<{text: string, template: object, score: number}|null>}
   */
  async match(companyId, message, variables = {}) {
    if (!message || !String(message).trim()) {
      return null;
    }

    const templates = (await this.load(companyId))
      .filter(template => Array.isArray(template.triggers) && template.triggers.length > 0);

    if (templates.length === 0) {
      return null;
    }

    // Reuse the router's intent scoring: one embedding of the message, then a
    // comparison against each template's example phrases.
    const result = await this.classifier.classify(
      message,
      templates.map(template => ({
        id: String(template._id),
        label: template.name,
        value: template.triggers.join('\n'),
        threshold: template.threshold
      }))
    );

    if (!result.matched) {
      return null;
    }

    const template = templates.find(candidate => String(candidate._id) === result.intent.id);
    if (!template) {
      return null;
    }

    // Fire-and-forget: usage stats must not delay the reply.
    ResponseTemplate.updateOne(
      { _id: template._id },
      { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }
    ).catch(error => logger.warn('Could not record template use', { error: error.message }));

    return {
      text: this.render(template, variables),
      template,
      score: result.score
    };
  }

  /**
   * Pick one of a template's variations and fill in its placeholders.
   */
  render(template, variables = {}) {
    const responses = template.responses || [];
    if (responses.length === 0) {
      return '';
    }

    // Random variation so a bot answering the same question twice does not
    // read like a recording.
    const chosen = responses[Math.floor(Math.random() * responses.length)];

    const templateVariables = template.variables instanceof Map
      ? Object.fromEntries(template.variables)
      : (template.variables || {});

    return this.populate(chosen, { ...templateVariables, ...variables });
  }

  /**
   * Replace `[NAME]` markers.
   *
   * Unresolved markers are left in place rather than blanked: a visitor seeing
   * "[PHONE]" tells the tenant something is unconfigured, whereas silently
   * sending an empty gap hides it.
   */
  populate(text, variables = {}) {
    let output = String(text);

    Object.entries(variables).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      // Escaped so a variable name cannot inject regex syntax.
      const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`\\[${safeKey}\\]`, 'g'), String(value));
    });

    return output;
  }
}

module.exports = {
  ResponseTemplateService,
  // A shared instance so the cache is actually shared.
  getResponseTemplateService: (() => {
    let instance = null;
    return () => {
      if (!instance) {
        instance = new ResponseTemplateService();
      }
      return instance;
    };
  })()
};
