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
 * deliberate statement of intent - but only a workflow that answers every
 * message (trigger `always`). One that runs for "where is my order?" speaks
 * in its own steps; the assistant answering everything else keeps the
 * tenant's persona. And only a persona somebody wrote: the blank starter's
 * Persona step defers to the Persona screen until it is edited
 * (`inheritPersona`), so publishing the starter no longer replaces what the
 * tenant typed there with "You are a helpful assistant."
 *
 * Without this, every tenant fell back to a single hardcoded persona describing
 * a property management company.
 */

const Company = require('../models/company');
const Workflow = require('../models/workflow');
const { DEFAULT_PERSONA } = require('./promptEngineering');
const { inheritsPersona } = require('./workflow-compiler');
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
    const [workflows, company] = await Promise.all([
      Workflow.getLiveWorkflows(companyId),
      Company.findById(companyId).select('assistant name').lean()
    ]);

    // What visitors get is the published version, not a draft being edited.
    const answering = (workflows || []).find(candidate => Workflow.liveTriggerOf(candidate).type === 'always');
    const workflowPersona = answering ? personaOf(await liveCopy(answering)) : null;

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

/**
 * The persona a published workflow declares.
 *
 * Read from the Persona node itself, which is what the tenant wrote. The
 * stored `compiledChain` is also tried, at both shapes it has had: the chain
 * config directly, and wrapped in `compilationResult` as the workflow service
 * persists it. The first version read only the former, so no published
 * workflow's persona was ever found and every tenant got the default.
 */
function personaOf(workflow) {
  if (!workflow) {
    return null;
  }

  const node = (workflow.nodes || []).find(candidate =>
    candidate && candidate.data && candidate.data.type === 'persona');
  if (node && inheritsPersona(node.data)) {
    // Defers to the Persona screen; the compiled chain says nothing else.
    return null;
  }
  if (node && node.data.prompt && String(node.data.prompt).trim()) {
    return String(node.data.prompt).trim();
  }

  const chain = workflow.compiledChain || {};
  const prompts = chain.prompts || chain.compilationResult?.compiledChain?.prompts;
  return prompts?.persona?.compiled?.systemPrompt || null;
}

/**
 * The workflow as visitors get it: its live snapshot when it has unpublished
 * edits. The stored compiled chain belongs to the draft, so it is only used
 * when the draft is what is live.
 */
async function liveCopy(workflow) {
  const graph = await Workflow.liveGraph(workflow);
  return graph.version === workflow.version
    ? workflow
    : { nodes: graph.nodes, edges: graph.edges };
}

module.exports = { resolve, invalidate, personaOf, DEFAULT_PERSONA };
