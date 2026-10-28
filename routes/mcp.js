/**
 * Managing a tenant's MCP servers ("Connected tools (MCP)" on the Actions
 * screen).
 *
 * Admin-only and tenant-scoped by the query itself, like routes/actions.js. A
 * superadmin names the company (`companyId` in the query or body), because a
 * server is reached with one tenant's credential.
 *
 * The plan rules are the Actions ones: the screen needs the `actions` feature,
 * and every tool switched on counts against the `actions` limit together with
 * the saved Actions. The meter (services/usage.js) counts both, so switching a
 * tool on is checked like adding an Action.
 *
 * The credential goes in and never comes out: responses carry
 * `auth.hasSecret` instead. A saved credential is only ever sent to the
 * server it was saved for — changing the address means typing it again.
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const McpServer = require('../models/mcp-server');
const mcpClient = require('../services/mcp-client');
const secrets = require('../services/secrets');
const audit = require('../services/audit');
const usageService = require('../services/usage');
const { auth, admin } = require('../middleware/auth');
const { requireFeature, checkLimit } = require('../middleware/quota');
const { logger } = require('../services/logging');

const MAX_SERVERS = 10;

router.use(auth, admin, requireFeature('actions'));

function companyFor(req) {
  if (req.user.role === 'superadmin') {
    return req.query.companyId || (req.body && req.body.companyId) || null;
  }
  return req.user.company ? req.user.company.id : null;
}

function requireCompany(req, res) {
  const companyId = companyFor(req);

  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    res.status(400).json({
      error: req.user.role === 'superadmin'
        ? 'Name a company: an MCP server belongs to a tenant, not to the platform'
        : 'Your account is not attached to a company'
    });
    return null;
  }

  return companyId;
}

function validId(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Server not found' });
    return false;
  }
  return true;
}

// --------------------------------------------------------------- shaping

function presentTool(tool, slug) {
  const offered = mcpClient.modelSchema(tool.inputSchema);
  return {
    name: tool.name,
    // What the assistant calls it, shown so a run log or a transcript can be
    // matched back to the switch that controls it.
    toolName: mcpClient.assistantToolName(slug, tool.name),
    title: tool.title || '',
    description: tool.description || '',
    inputs: mcpClient.describeInputs(tool.inputSchema),
    readOnly: Boolean(tool.readOnlyHint),
    enabled: Boolean(tool.enabled),
    mode: tool.mode || 'automatic',
    verifiedOnly: Boolean(tool.verifiedOnly),
    needsConfirmation: tool.needsConfirmation !== false,
    available: tool.available !== false,
    changedAt: tool.changedAt || null,
    lastCalledAt: tool.lastCalledAt || null,
    // Why the assistant cannot be offered it, when it cannot.
    problem: offered.ok ? null : offered.error
  };
}

function present(server) {
  const doc = server && typeof server.toObject === 'function' ? server.toObject() : (server || {});
  const authSettings = doc.auth || {};

  return {
    _id: doc._id,
    name: doc.name,
    slug: doc.slug,
    url: doc.url,
    auth: {
      type: authSettings.type || 'none',
      ...(authSettings.headerName ? { headerName: authSettings.headerName } : {}),
      hasSecret: doc.hasSecret !== undefined ? Boolean(doc.hasSecret) : Boolean(authSettings.secret)
    },
    status: doc.status || 'new',
    lastCheckedAt: doc.lastCheckedAt || null,
    lastError: doc.lastError || '',
    protocol: doc.protocol && doc.protocol.era ? { era: doc.protocol.era, version: doc.protocol.version } : null,
    serverInfo: doc.serverInfo && doc.serverInfo.name ? { name: doc.serverInfo.name, version: doc.serverInfo.version || '' } : null,
    warnings: doc.warnings || [],
    tools: (doc.tools || []).map(tool => presentTool(tool, doc.slug)),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

/** The servers of one company, without their credentials ever being read. */
async function listFor(companyId, match = {}) {
  return McpServer.aggregate([
    { $match: { company: new mongoose.Types.ObjectId(String(companyId)), ...match } },
    { $sort: { createdAt: 1 } },
    { $addFields: { hasSecret: { $gt: [{ $strLenCP: { $ifNull: ['$auth.secret', ''] } }, 0] } } },
    { $project: { 'auth.secret': 0 } }
  ]);
}

// --------------------------------------------------------------- settings

function slugFrom(name) {
  const base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 20)
    .replace(/_+$/, '');
  return base || 'server';
}

async function uniqueSlug(companyId, name) {
  const base = slugFrom(name);
  const taken = new Set((await McpServer.find({ company: companyId }).select('slug').lean()).map(entry => entry.slug));

  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; n < 100; n += 1) {
    if (!taken.has(`${base}${n}`)) {
      return `${base}${n}`;
    }
  }
  return `${base.slice(0, 12)}${crypto.randomBytes(4).toString('hex')}`;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Check a server form and work out what to store.
 *
 * `secret` is undefined when the credential is unchanged, null when it is to
 * be removed, and the new plaintext otherwise.
 */
function normalise(body = {}, existing = null) {
  const errors = [];
  const value = {};

  const name = typeof body.name === 'string' ? body.name.trim() : (existing ? existing.name : '');
  if (!name) {
    errors.push('Give the server a name, e.g. "Shopify"');
  } else if (name.length > 80) {
    errors.push('The name is too long (80 characters at most)');
  }
  value.name = name;

  const check = mcpClient.validateServerUrl(body.url !== undefined ? body.url : (existing ? existing.url : ''));
  if (check.valid) {
    value.url = check.url.toString();
  } else {
    errors.push(check.error);
  }

  const given = body.auth && typeof body.auth === 'object' ? body.auth : {};
  const current = (existing && existing.auth) || {};
  const type = given.type !== undefined ? given.type : (current.type || 'none');
  if (!['none', 'bearer', 'header'].includes(type)) {
    errors.push('Choose no authentication, a bearer token or a custom header');
  }
  value.authType = type;

  if (type === 'header') {
    const headerName = given.headerName !== undefined ? String(given.headerName).trim() : (current.headerName || '');
    if (!mcpClient.validHeaderName(headerName)) {
      errors.push('Enter the header the server expects the key in, e.g. X-Api-Key');
    }
    value.headerName = headerName;
  }

  let secret;
  if (typeof given.secret === 'string' && given.secret !== '') {
    if (mcpClient.validSecret(given.secret)) {
      secret = given.secret;
    } else {
      errors.push('The secret contains characters that cannot be sent in a header');
    }
  }

  if (type === 'none') {
    secret = null;
  } else if (secret === undefined) {
    if (!existing || !current.secret) {
      errors.push('Enter the token or key the server needs');
    } else if (value.url && originOf(value.url) !== originOf(existing.url)) {
      // Otherwise anyone who can open the form could send a colleague's
      // token to an address of their choosing.
      errors.push('Enter the credential again: a saved one is only sent to the server it was saved for');
    }
  }

  return { errors, value, secret };
}

function apply(doc, normalised) {
  const { value, secret } = normalised;
  doc.name = value.name;
  doc.url = value.url;
  doc.auth = doc.auth || {};
  doc.auth.type = value.authType;
  doc.auth.headerName = value.authType === 'header' ? value.headerName : undefined;
  if (secret === null) {
    doc.auth.secret = undefined;
  } else if (secret !== undefined) {
    doc.auth.secret = secrets.encrypt(secret);
  }
}

/**
 * Fold a fresh tools/list into what is stored, keeping the admin's choices.
 *
 * New tools arrive switched off. A tool the server no longer lists is kept
 * but marked unavailable, so a server that briefly lists fewer does not wipe
 * every switch. A tool that stops claiming to be read-only gets its
 * confirmation back, whatever it was set to: the setting was chosen for a
 * tool that said it changed nothing.
 */
function mergeTools(existing, discovered, now) {
  const byName = new Map(existing.map(tool => [tool.name, tool]));
  const merged = [];
  let added = 0;
  let changed = 0;

  discovered.forEach(fresh => {
    const old = byName.get(fresh.name);
    if (!old) {
      added += 1;
      merged.push({
        ...fresh,
        enabled: false,
        mode: 'automatic',
        verifiedOnly: false,
        needsConfirmation: !fresh.readOnlyHint,
        available: true
      });
      return;
    }

    byName.delete(fresh.name);
    const different = old.description !== fresh.description || old.inputSchema !== fresh.inputSchema;
    if (different) {
      changed += 1;
    }
    const lostReadOnly = old.readOnlyHint && !fresh.readOnlyHint;

    merged.push({
      ...old,
      title: fresh.title,
      description: fresh.description,
      inputSchema: fresh.inputSchema,
      readOnlyHint: fresh.readOnlyHint,
      destructiveHint: fresh.destructiveHint,
      needsConfirmation: lostReadOnly ? true : old.needsConfirmation,
      available: true,
      changedAt: different || lostReadOnly ? now : old.changedAt
    });
  });

  const missing = [...byName.values()];
  missing.forEach(tool => merged.push({ ...tool, available: false }));

  return { tools: merged, added, changed, missing: missing.length };
}

/** Tools switched on across all of a company's servers. */
async function enabledToolCount(companyId) {
  const [row] = await McpServer.aggregate([
    { $match: { company: new mongoose.Types.ObjectId(String(companyId)) } },
    { $unwind: '$tools' },
    { $match: { 'tools.enabled': true } },
    { $count: 'n' }
  ]);
  return row ? row.n : 0;
}

// ----------------------------------------------------------------- routes

router.get('/', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const servers = await listFor(companyId);
    res.json({ servers: servers.map(present) });
  } catch (error) {
    logger.error('Failed to list MCP servers', { error: error.message });
    res.status(500).json({ error: 'Failed to load the connected servers' });
  }
});

router.post('/', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    if (await McpServer.countDocuments({ company: companyId }) >= MAX_SERVERS) {
      return res.status(400).json({ error: `A company can connect up to ${MAX_SERVERS} MCP servers` });
    }

    const normalised = normalise(req.body);
    if (normalised.errors.length > 0) {
      return res.status(400).json({ error: normalised.errors[0], errors: normalised.errors });
    }

    const doc = new McpServer({
      company: companyId,
      slug: await uniqueSlug(companyId, normalised.value.name),
      createdBy: req.user.id
    });
    apply(doc, normalised);
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'mcp.server_created',
      target: { type: 'mcp_server', id: String(doc._id), label: doc.name },
      details: { authType: doc.auth.type }
    });

    res.status(201).json({ server: present(doc) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Another server was added at the same moment; try again' });
    }
    logger.error('Failed to create MCP server', { error: error.message });
    res.status(500).json({ error: error.message.startsWith('Cannot store a secret') ? error.message : 'Failed to add the server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await McpServer.findOne({ _id: req.params.id, company: companyId }).select('+auth.secret');
    if (!doc) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const normalised = normalise(req.body, doc);
    if (normalised.errors.length > 0) {
      return res.status(400).json({ error: normalised.errors[0], errors: normalised.errors });
    }

    const before = { url: doc.url, type: doc.auth.type, headerName: doc.auth.headerName };
    apply(doc, normalised);
    const reconnect = before.url !== doc.url || before.type !== doc.auth.type ||
      before.headerName !== doc.auth.headerName || normalised.secret !== undefined;

    if (reconnect) {
      // What worked before was worked out for the old address or key.
      doc.status = 'new';
      doc.protocol = undefined;
      await mcpClient.forget(doc._id);
    }
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'mcp.server_updated',
      target: { type: 'mcp_server', id: String(doc._id), label: doc.name },
      details: { authType: doc.auth.type, credentialChanged: normalised.secret !== undefined, addressChanged: before.url !== doc.url }
    });

    res.json({ server: present(doc), reconnect });
  } catch (error) {
    logger.error('Failed to update MCP server', { error: error.message });
    res.status(500).json({ error: 'Failed to update the server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await McpServer.findOneAndDelete({ _id: req.params.id, company: companyId });
    if (!doc) {
      return res.status(404).json({ error: 'Server not found' });
    }
    await mcpClient.forget(doc._id);

    audit.record({
      req,
      company: companyId,
      action: 'mcp.server_deleted',
      target: { type: 'mcp_server', id: String(doc._id), label: doc.name }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete MCP server', { error: error.message });
    res.status(500).json({ error: 'Failed to remove the server' });
  }
});

/** "Connect & list tools", and "Refresh tools" afterwards. */
router.post('/:id/connect', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await McpServer.findOne({ _id: req.params.id, company: companyId }).select('+auth.secret');
    if (!doc) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await mcpClient.discover(doc.toObject());
    const now = new Date();
    doc.lastCheckedAt = now;
    let summary = null;

    if (result.ok) {
      const merged = mergeTools((doc.tools || []).map(tool => tool.toObject()), result.tools, now);
      doc.tools = merged.tools;
      doc.status = 'connected';
      doc.lastError = '';
      doc.protocol = result.protocol;
      doc.serverInfo = result.serverInfo;
      doc.warnings = result.warnings;
      summary = { listed: result.tools.length, added: merged.added, changed: merged.changed, missing: merged.missing };
    } else {
      doc.status = 'error';
      doc.lastError = String(result.error || 'The server could not be reached').slice(0, 600);
    }
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'mcp.server_connected',
      target: { type: 'mcp_server', id: String(doc._id), label: doc.name },
      details: result.ok
        ? { ok: true, era: result.protocol && result.protocol.era, version: result.protocol && result.protocol.version, ...summary }
        : { ok: false, error: doc.lastError },
      outcome: result.ok ? 'success' : 'failure'
    });

    res.json({ ok: result.ok, server: present(doc), ...(summary ? { summary } : {}), ...(result.ok ? {} : { error: doc.lastError }) });
  } catch (error) {
    logger.error('Failed to connect MCP server', { error: error.message });
    res.status(500).json({ error: 'Failed to connect to the server' });
  }
});

/** One tool's switches. */
router.put('/:id/tools/:tool', async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId || !validId(req, res)) {
      return;
    }

    const doc = await McpServer.findOne({ _id: req.params.id, company: companyId });
    if (!doc) {
      return res.status(404).json({ error: 'Server not found' });
    }
    const tool = (doc.tools || []).find(entry => entry.name === req.params.tool);
    if (!tool) {
      return res.status(404).json({ error: 'That server has no tool by that name. Refresh its tools.' });
    }

    const body = req.body || {};
    const changes = {};
    for (const key of ['enabled', 'verifiedOnly', 'needsConfirmation']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') {
          return res.status(400).json({ error: `${key} must be true or false` });
        }
        changes[key] = body[key];
      }
    }
    if (body.mode !== undefined) {
      if (!['automatic', 'workflow_only'].includes(body.mode)) {
        return res.status(400).json({ error: 'mode must be automatic or workflow_only' });
      }
      changes.mode = body.mode;
    }

    if (changes.enabled === true && !tool.enabled) {
      if (tool.available === false) {
        return res.status(400).json({ error: 'The server no longer offers this tool. Refresh its tools first.' });
      }
      const offered = mcpClient.modelSchema(tool.inputSchema);
      if (!offered.ok) {
        return res.status(400).json({ error: `This tool cannot be offered to the assistant: ${offered.error}` });
      }

      // One limit for saved Actions and switched-on tools together. The
      // meter counts the Actions; the tools already on are added as part of
      // the request, so the comparison is the same one enforceLimit makes.
      if (req.user.role !== 'superadmin') {
        // The actions meter already counts switched-on tools with the
        // saved Actions, so this is one more of either.
        const quota = await checkLimit(companyId, 'actions', 1);
        if (!quota.allowed) {
          await usageService.recordLimitHit(companyId);
          return res.status(402).json({
            error: quota.limit
              ? `Your plan allows ${quota.limit} actions and connected tools together, and ${quota.used} are in use. ` +
                'Switch something off or upgrade under Plan & billing.'
              : (quota.reason || 'Your plan does not allow more actions.'),
            code: 'PLAN_LIMIT_REACHED',
            meter: 'actions',
            limit: quota.limit,
            used: quota.used,
            planId: quota.planId
          });
        }
      }
    }

    Object.assign(tool, changes);
    await doc.save();

    audit.record({
      req,
      company: companyId,
      action: 'mcp.tool_updated',
      target: { type: 'mcp_server', id: String(doc._id), label: `${doc.name}: ${tool.name}` },
      details: { tool: tool.name, ...changes }
    });

    res.json({ tool: presentTool(tool, doc.slug) });
  } catch (error) {
    logger.error('Failed to update MCP tool', { error: error.message });
    res.status(500).json({ error: 'Failed to update the tool' });
  }
});

module.exports = router;
module.exports.mergeTools = mergeTools;
module.exports.enabledToolCount = enabledToolCount;
