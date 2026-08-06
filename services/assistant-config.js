/**
 * Resolves the persona and scope an assistant should use for a given company.
 *
 * There are two places a tenant can say who their assistant is:
 *
 *   1. the Persona node of their published workflow — the richer option, and
 *      the one the workflow editor is built around;
 *   2. `Company.assistant`, a plain text field for tenants who have not built
 *      a workflow yet.
 *
 * The workflow wins when both exist, because it is the more specific and more
 * deliberate statement of intent.
 *
 * Without this, every tenant fell back to a single hardcoded persona describing
 * a property management company.
 */

const Company = require('../models/company');
const Workflow = require('../models/workflow');
const { DEFAULT_PERSONA } = require('./promptEngineering');
const { logger } = require('./logging');

// Resolved on every inbound message, changed on publish. Short TTL keeps a
// persona edit visible quickly without a lookup per message.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function invalidate(companyId) {
  if (companyId) {
    cache.delete(String(companyId));
  } else {
    cache.clear();
  }
}

/**
 * @returns {Promise<{persona: string, scope: string|null, source: string}>}
 */
async function resolve(companyId) {
  if (!companyId) {
    return { persona: DEFAULT_PERSONA, scope: null, source: 'default' };
  }

  const key = String(companyId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }

  let resolved = { persona: DEFAULT_PERSONA, scope: null, source: 'default' };

  try {
    const [workflow, company] = await Promise.all([
      Workflow.getActiveWorkflow(companyId),
      Company.findById(companyId).select('assistant name').lean()
    ]);

    const workflowPersona = workflow?.compiledChain?.prompts?.persona?.compiled?.systemPrompt;

    if (workflowPersona && String(workflowPersona).trim()) {
      resolved = {
        persona: String(workflowPersona).trim(),
        scope: company?.assistant?.scope || null,
        source: 'workflow'
      };
    } else if (company?.assistant?.persona && String(company.assistant.persona).trim()) {
      resolved = {
        persona: String(company.assistant.persona).trim(),
        scope: company.assistant.scope || null,
        source: 'company'
      };
    } else if (company?.assistant?.scope) {
      resolved = { persona: DEFAULT_PERSONA, scope: company.assistant.scope, source: 'default' };
    }
  } catch (error) {
    // A lookup failure should give the visitor a generic assistant, not an
    // error.
    logger.error('Could not resolve assistant configuration', {
      companyId: key,
      error: error.message
    });
  }

  cache.set(key, { value: resolved, expires: Date.now() + CACHE_TTL_MS });
  return resolved;
}

module.exports = { resolve, invalidate, DEFAULT_PERSONA };
