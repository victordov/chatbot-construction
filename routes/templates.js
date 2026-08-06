/**
 * Response templates and assistant persona, per company.
 *
 * This is where a tenant says what business they are in. Nothing about any
 * industry is compiled into the product any more, so without these a bot is a
 * generic assistant answering from its knowledge base alone.
 */

const express = require('express');
const router = express.Router();

const ResponseTemplate = require('../models/response-template');
const Company = require('../models/company');
const { getResponseTemplateService } = require('../services/responseTemplates');
const assistantConfig = require('../services/assistant-config');
const { auth, admin, operator } = require('../middleware/auth');
const { logger } = require('../services/logging');

const VALID_ROLES = ['greeting', 'fallback', 'offTopic', 'handoff'];

/**
 * Operators need to read templates so they can insert one into a reply. Only
 * managing them requires admin, so this route is registered before that gate.
 */
router.get('/mine', auth, operator, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.json({ templates: [] });
    }

    const templates = await ResponseTemplate.find({
      company: req.user.company.id,
      enabled: true
    }).select('name responses variables role').sort({ name: 1 }).lean();

    // Pre-rendered: an operator inserting a reply wants the finished text, not
    // a template with [PLACEHOLDER] markers they have to fill in by hand.
    const service = getResponseTemplateService();

    res.json({
      templates: templates.map(template => ({
        _id: template._id,
        name: template.name,
        role: template.role,
        text: service.render(template)
      }))
    });
  } catch (error) {
    logger.error('Failed to list templates for operator', { error: error.message });
    res.status(500).json({ error: 'Failed to load replies' });
  }
});

router.use(auth, admin);

/** The caller's company, or a 400 when their account has none. */
function companyOf(req, res) {
  if (!req.user.company) {
    res.status(400).json({ error: 'Your account is not linked to a company' });
    return null;
  }
  return req.user.company.id;
}

/**
 * Validate a template payload.
 * @returns {string|null} an error message, or null when valid
 */
function validate(body) {
  if (!body.name || !String(body.name).trim()) {
    return 'A name is required';
  }

  const responses = (body.responses || []).map(r => String(r || '').trim()).filter(Boolean);
  if (responses.length === 0) {
    return 'At least one response is required';
  }

  if (body.role && !VALID_ROLES.includes(body.role)) {
    return `Role must be one of: ${VALID_ROLES.join(', ')}`;
  }

  const triggers = (body.triggers || []).map(t => String(t || '').trim()).filter(Boolean);

  // A template with neither a role nor triggers can never be selected, which
  // is a silent dead end rather than an obvious mistake - so reject it.
  if (!body.role && triggers.length === 0) {
    return 'Add at least one example phrase, or assign this template to a role';
  }

  if (body.threshold !== undefined) {
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return 'Threshold must be between 0 and 1';
    }
  }

  return null;
}

function normalise(body) {
  return {
    name: String(body.name).trim(),
    role: body.role || null,
    triggers: (body.triggers || []).map(t => String(t || '').trim()).filter(Boolean),
    responses: (body.responses || []).map(r => String(r || '').trim()).filter(Boolean),
    variables: body.variables && typeof body.variables === 'object'
      ? new Map(Object.entries(body.variables).map(([k, v]) => [String(k), String(v)]))
      : undefined,
    threshold: body.threshold !== undefined ? Number(body.threshold) : undefined,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : true
  };
}

// List
router.get('/', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const templates = await ResponseTemplate.find({ company: companyId })
      .sort({ role: 1, name: 1 })
      .lean();

    res.json({
      templates: templates.map(template => ({
        ...template,
        variables: template.variables || {}
      })),
      roles: VALID_ROLES
    });
  } catch (error) {
    logger.error('Failed to list response templates', { error: error.message });
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// Create
router.post('/', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const problem = validate(req.body);
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    const data = normalise(req.body);

    // A role is a single slot. Two enabled greetings would make the bot's
    // opening line random in a way nobody asked for.
    if (data.role) {
      const existing = await ResponseTemplate.findOne({
        company: companyId, role: data.role, enabled: true
      });
      if (existing) {
        return res.status(409).json({
          error: `A template is already assigned to the "${data.role}" role. Edit or disable it first.`,
          conflictingId: existing._id
        });
      }
    }

    const template = await ResponseTemplate.create({
      ...data,
      company: companyId,
      createdBy: req.user.id
    });

    getResponseTemplateService().invalidate(companyId);

    res.status(201).json({ template });
  } catch (error) {
    logger.error('Failed to create response template', { error: error.message });
    res.status(500).json({ error: 'Failed to create the template' });
  }
});

// Update
router.put('/:id', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const problem = validate(req.body);
    if (problem) {
      return res.status(400).json({ error: problem });
    }

    const data = normalise(req.body);

    if (data.role) {
      const existing = await ResponseTemplate.findOne({
        company: companyId, role: data.role, enabled: true, _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(409).json({
          error: `Another template already fills the "${data.role}" role.`,
          conflictingId: existing._id
        });
      }
    }

    // Scoped by company in the query itself, so one tenant cannot edit
    // another's template by guessing an id.
    const template = await ResponseTemplate.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      data,
      { new: true, runValidators: true }
    );

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    getResponseTemplateService().invalidate(companyId);

    res.json({ template });
  } catch (error) {
    logger.error('Failed to update response template', { error: error.message });
    res.status(500).json({ error: 'Failed to update the template' });
  }
});

// Delete
router.delete('/:id', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const result = await ResponseTemplate.deleteOne({
      _id: req.params.id, company: companyId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    getResponseTemplateService().invalidate(companyId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete response template', { error: error.message });
    res.status(500).json({ error: 'Failed to delete the template' });
  }
});

/**
 * Try a message against the tenant's templates without sending anything.
 *
 * Semantic matching is not something an author can reason about by reading
 * their trigger phrases, so being able to ask "what would this reply to?" is
 * the difference between a usable feature and a guessing game.
 */
router.post('/preview', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'A message is required' });
    }

    const match = await getResponseTemplateService().match(companyId, message);

    res.json({
      matched: Boolean(match),
      templateId: match ? match.template._id : null,
      templateName: match ? match.template.name : null,
      score: match ? Number(match.score.toFixed(3)) : null,
      response: match ? match.text : null
    });
  } catch (error) {
    logger.error('Failed to preview template match', { error: error.message });
    res.status(500).json({ error: 'Failed to test the message' });
  }
});

/**
 * The assistant's persona and scope, for tenants who have not built a workflow.
 */
router.get('/assistant/config', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const company = await Company.findById(companyId).select('assistant').lean();
    const resolved = await assistantConfig.resolve(companyId);

    res.json({
      persona: company?.assistant?.persona || '',
      scope: company?.assistant?.scope || '',
      // Which source is actually in effect, so an admin editing this field is
      // not confused when a published workflow is overriding it.
      effective: { persona: resolved.persona, scope: resolved.scope, source: resolved.source }
    });
  } catch (error) {
    logger.error('Failed to load assistant config', { error: error.message });
    res.status(500).json({ error: 'Failed to load the assistant configuration' });
  }
});

router.put('/assistant/config', async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) {
      return;
    }

    const { persona, scope } = req.body;

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    company.assistant = {
      persona: persona ? String(persona).trim() : undefined,
      scope: scope ? String(scope).trim() : undefined
    };
    await company.save();

    assistantConfig.invalidate(companyId);

    const resolved = await assistantConfig.resolve(companyId);
    res.json({ success: true, effective: resolved });
  } catch (error) {
    logger.error('Failed to update assistant config', { error: error.message });
    res.status(500).json({ error: 'Failed to save the assistant configuration' });
  }
});

module.exports = router;
