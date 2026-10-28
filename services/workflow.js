/**
 * Workflow service for managing visual workflow editor operations
 */

const Workflow = require('../models/workflow');
const WorkflowVersion = require('../models/workflow-version');
const WorkflowCompilerService = require('./workflow-compiler');
const capabilities = require('../config/capabilities');
const secrets = require('./secrets');
const { companyScope } = require('../utils/query');
const { logger } = require('./logging');

/**
 * Encrypt any credential an action node carries, and keep the one already
 * stored when the editor sends the node back without it.
 *
 * The editor never receives a saved secret - it gets `hasSecret: true` and an
 * empty value - so a save that leaves the field blank must not be read as
 * "clear the credential", or editing a node's URL would silently break its
 * authentication.
 */
function protectNodeSecrets(incomingNodes, existingNodes = []) {
  if (!Array.isArray(incomingNodes)) {
    return incomingNodes;
  }

  const previous = new Map(
    existingNodes.map(node => [node.id, (node.data && node.data.auth) || {}])
  );

  return incomingNodes.map(node => {
    const auth = node.data && node.data.auth;

    if (!auth || !auth.type || auth.type === 'none') {
      // Switching authentication off drops the stored credential rather than
      // leaving it decryptable in a node nobody is looking at any more.
      if (auth) {
        return { ...node, data: { ...node.data, auth: { type: 'none' } } };
      }
      return node;
    }

    const provided = auth.value;
    const stored = previous.get(node.id) || {};

    let value;
    if (provided && !secrets.isEncrypted(provided)) {
      value = secrets.encrypt(provided);
    } else if (provided && secrets.isEncrypted(provided)) {
      value = provided;
    } else {
      value = stored.value || '';
    }

    return {
      ...node,
      data: {
        ...node.data,
        auth: { type: auth.type, header: auth.header, value }
      }
    };
  });
}

/**
 * The fields a client may change through the editor.
 *
 * Everything else on the document is the platform's: `company` decides whose
 * visitors a workflow answers, `status` and `publishedAt` decide whether it is
 * live, `version` is the audit trail, `createdBy` is attribution. A PUT used to
 * `Object.assign` the whole request body onto the document, so any of those
 * could be set by whoever could edit a draft - including moving a workflow to
 * another tenant.
 */
const EDITABLE_FIELDS = ['name', 'description', 'nodes', 'edges', 'trigger', 'moderationConfig', 'changeDescription'];

/**
 * The fields that change what the workflow does. Editing one makes a new
 * version; renaming does not, so renaming a live workflow from the list does
 * not leave it with "unpublished changes" that are only a new name.
 */
const VERSIONED_FIELDS = ['nodes', 'edges', 'trigger', 'moderationConfig'];

function pickEditable(updateData = {}) {
  return Object.fromEntries(
    Object.entries(updateData).filter(([key]) => EDITABLE_FIELDS.includes(key))
  );
}

/** Bounds on what a trigger may hold, so it cannot grow without limit. */
const MAX_TRIGGER_DESCRIPTION = 200;
const MAX_TRIGGER_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 60;

/**
 * A trigger as the editor sent it, cleaned: an unknown type is `always`,
 * keywords may arrive as a list or as comma-separated text, and everything is
 * trimmed and capped.
 */
function cleanTrigger(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const type = ['always', 'intent', 'keywords'].includes(input.type) ? input.type : 'always';
  const keywords = (Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(','))
    .map(keyword => String(keyword || '').trim().slice(0, MAX_KEYWORD_LENGTH))
    .filter(Boolean)
    .filter((keyword, index, all) =>
      all.findIndex(other => other.toLowerCase() === keyword.toLowerCase()) === index)
    .slice(0, MAX_TRIGGER_KEYWORDS);

  return {
    type,
    description: String(input.description || '').trim().slice(0, MAX_TRIGGER_DESCRIPTION),
    keywords
  };
}

/** What a trigger still needs before it can go live. */
function triggerProblems(trigger) {
  const clean = cleanTrigger(trigger);
  if (clean.type === 'intent' && !clean.description) {
    return ['Say what the visitor wants for this workflow to run, under "When does this run?"'];
  }
  if (clean.type === 'keywords' && clean.keywords.length === 0) {
    return ['Add at least one keyword under "When does this run?"'];
  }
  return [];
}

/** An error with the HTTP status (and any detail) a route should answer with. */
function statusError(message, status, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

/** The tenant id of a workflow whose `company` may or may not be populated. */
function companyIdOf(workflow) {
  const company = workflow && workflow.company;
  if (!company) {
    return null;
  }
  return String(company._id || company);
}

/**
 * Strip credentials before a workflow crosses back to a browser.
 *
 * Whether one is set is useful in the editor; the value itself is not, and an
 * admin should not be able to read back a key a colleague entered.
 *
 * This walks the whole document rather than the two or three places a
 * credential is expected. The first version redacted `nodes` and
 * `compiledChain.steps`, and the ciphertext still went out - because the stored
 * chain is actually nested under `compiledChain.compilationResult`, twice over,
 * in the execution plan and the chain config. Anything shaped like an auth
 * block gets redacted wherever it turns up, so a future change to the compiled
 * shape cannot quietly reintroduce the leak.
 *
 * The value is a ciphertext, not a plaintext key, so this was not an immediate
 * disclosure - but handing out the encrypted secret means anyone who later gets
 * the key can decrypt what they already collected.
 */
function redactWorkflow(workflow) {
  if (!workflow) {
    return workflow;
  }

  const plain = typeof workflow.toObject === 'function' ? workflow.toObject() : workflow;

  const isAuthBlock = value =>
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value') &&
    Object.prototype.hasOwnProperty.call(value, 'type');

  // Copies on the way down rather than editing in place: the argument is
  // usually a live mongoose document whose Mixed paths are shared with what the
  // caller goes on to save, and stripping those removed the credential from the
  // workflow being persisted.
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      return value.map(item => walk(item));
    }

    if (!value || typeof value !== 'object' || value instanceof Date ||
        typeof value.toHexString === 'function') {
      return value;
    }

    if (key === 'auth' && isAuthBlock(value)) {
      return { type: value.type || 'none', header: value.header, hasSecret: Boolean(value.value) };
    }

    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, walk(child, childKey)])
    );
  };

  return walk(plain);
}

class WorkflowService {
  constructor() {
    this.compiler = new WorkflowCompilerService();
  }

  /**
   * Refuse a graph that is unsafe to store, as opposed to unfinished.
   *
   * A draft may be saved half-built - an Ask with no question yet, a node not
   * wired up - because building a flow takes more than one sitting. What may
   * not be saved is anything the editor would draw into its page unescaped, or
   * that it could not draw at all.
   */
  assertStorable({ nodes = [], edges = [] }) {
    const problems = this.compiler.structuralProblems(nodes, edges);
    if (problems.length > 0) {
      throw statusError(problems[0].message, 400, {
        problems: problems.map(problem => ({ ...problem, level: 'error' }))
      });
    }
  }

  /**
   * Everything that would stop this graph going live, and everything worth a
   * second look, at once.
   *
   * @returns {{valid: boolean, errors: string[], warnings: string[],
   *            problems: Array<{message, nodeId, level}>}}
   */
  report(nodes = [], edges = [], trigger = undefined) {
    const plainNodes = (nodes || []).map(node => (node && typeof node.toObject === 'function' ? node.toObject() : node));
    const plainEdges = (edges || []).map(edge => (edge && typeof edge.toObject === 'function' ? edge.toObject() : edge));

    const problems = [
      ...this.compiler.structuralProblems(plainNodes, plainEdges).map(problem => ({ ...problem, level: 'error' })),
      ...this.compiler.validateWorkflow(plainNodes, plainEdges).problems
    ];

    plainNodes.forEach(node => {
      if (!node || !node.data) {
        return;
      }
      try {
        this.validateNodeData(node);
      } catch (error) {
        problems.push({ message: error.message, nodeId: node.id || null, level: 'error' });
      }
    });

    if (trigger !== undefined) {
      triggerProblems(trigger).forEach(message => problems.push({ message, nodeId: null, level: 'error' }));
    }

    // The same complaint reached by two routes is said once.
    const seen = new Set();
    const unique = problems.filter(problem => {
      const key = `${problem.level}|${problem.nodeId}|${problem.message}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    const errors = unique.filter(problem => problem.level === 'error').map(problem => problem.message);
    const warnings = unique.filter(problem => problem.level === 'warning').map(problem => problem.message);
    return { valid: errors.length === 0, errors, warnings, problems: unique };
  }

  /**
   * The compiled chain for a graph that is complete, or a note saying it is
   * not yet. A draft with problems is stored as it is; it is compiled for
   * real when it is published.
   */
  async compileIfReady(nodes, edges, tenantId) {
    if (!nodes || nodes.length === 0) {
      return { compiled: false, reason: 'No nodes to compile', timestamp: new Date() };
    }

    const report = this.report(nodes, edges);
    if (!report.valid) {
      return {
        compiled: false,
        reason: 'Not ready to publish yet',
        problems: report.errors.length,
        timestamp: new Date()
      };
    }

    return this.compileWorkflow({ nodes, edges }, tenantId);
  }

  /**
   * Create a new workflow
   */
  async createWorkflow(workflowData, user) {
    try {
      this.assertStorable(workflowData);

      // Set company context for multi-tenancy
      const company = user.role === 'superadmin' ? null : user.company?.id;

      const workflow = new Workflow({
        name: workflowData.name,
        description: workflowData.description,
        nodes: protectNodeSecrets(workflowData.nodes || []),
        edges: workflowData.edges || [],
        trigger: cleanTrigger(workflowData.trigger),
        ...(workflowData.moderationConfig ? { moderationConfig: workflowData.moderationConfig } : {}),
        company,
        createdBy: user.id,
        version: 1
      });

      // Compiled from the protected nodes, so the chain that gets persisted
      // carries the encrypted credential rather than the plaintext one the
      // request arrived with.
      workflow.compiledChain = await this.compileIfReady(workflow.nodes, workflow.edges, company);

      await workflow.save();

      // Save initial version
      await this.saveVersion(workflow, user, 'Initial version');

      logger.info(`Workflow created: ${workflow._id} by user ${user.id}`);
      return workflow;
    } catch (error) {
      logger.error('Error creating workflow:', error);
      throw error;
    }
  }

  /**
   * A copy of a workflow, as a new draft. Credentials come with it, still
   * encrypted, so a copy of a flow that calls an API still calls it.
   */
  async duplicateWorkflow(workflowId, user) {
    const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
    const source = await this.getWorkflow(workflowId, userCompanyId, user.role);
    const plain = source.toObject();

    return this.createWorkflow({
      name: `${plain.name} (copy)`.slice(0, 200),
      description: plain.description,
      nodes: plain.nodes,
      edges: plain.edges,
      trigger: plain.trigger
    }, user);
  }

  /**
   * Get workflows for a company or user
   */
  async getWorkflows(userCompanyId = null, userRole = null, status = null) {
    try {
      const filter = {};

      // Superadmins see every tenant's workflows; everybody else sees their
      // own company's, and a user with no company sees none. Assigning
      // `filter.company = undefined` looked like a filter but was not one:
      // mongoose drops undefined values, leaving the query unscoped.
      Object.assign(filter, companyScope(userCompanyId, userRole));

      if (status) {
        filter.status = status;
      }

      const workflows = await Workflow.find(filter)
        .populate('createdBy', 'username displayName')
        .populate('publishedBy', 'username displayName')
        .populate('company', 'name')
        .sort({ updatedAt: -1 });

      return workflows;
    } catch (error) {
      logger.error('Error getting workflows:', error);
      throw error;
    }
  }

  /**
   * Get a specific workflow by ID
   */
  async getWorkflow(workflowId, userCompanyId = null, userRole = null) {
    try {
      const query = { _id: workflowId };

      Object.assign(query, companyScope(userCompanyId, userRole));

      const workflow = await Workflow.findOne(query)
        .populate('createdBy', 'username displayName email')
        .populate('publishedBy', 'username displayName')
        .populate('company', 'name description');

      if (!workflow) {
        throw new Error('Workflow not found');
      }

      return workflow;
    } catch (error) {
      logger.error('Error getting workflow:', error);
      throw error;
    }
  }

  /**
   * Save changes to a workflow.
   *
   * A save is a draft. On a live workflow it makes a new version and leaves
   * the live one serving visitors until Publish; it used to hot-swap straight
   * away, so a half-finished edit reached customers on Save.
   */
  async updateWorkflow(workflowId, rawUpdate, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;

      // Only the editable fields survive; see EDITABLE_FIELDS.
      const updateData = pickEditable(rawUpdate);

      // Get existing workflow
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      if (updateData.nodes || updateData.edges) {
        this.assertStorable({
          nodes: updateData.nodes || workflow.nodes.map(node => node.toObject()),
          edges: updateData.edges || workflow.edges.map(edge => edge.toObject())
        });
      }

      if (updateData.nodes) {
        updateData.nodes = protectNodeSecrets(updateData.nodes, workflow.nodes);
      }

      if (updateData.trigger !== undefined) {
        const before = JSON.stringify(cleanTrigger(workflow.trigger));
        updateData.trigger = cleanTrigger(updateData.trigger);
        workflow.$locals.triggerChanged = before !== JSON.stringify(updateData.trigger);
      }

      const versioned = VERSIONED_FIELDS.some(field => updateData[field] !== undefined);
      const { changeDescription, ...fields } = updateData;

      if (versioned) {
        fields.compiledChain = await this.compileIfReady(
          fields.nodes || workflow.nodes,
          fields.edges || workflow.edges,
          companyIdOf(workflow)
        );

        // Published before drafts existed: pin what visitors have now, so this
        // save does not become live by the back door.
        if (workflow.status === 'published' && !workflow.liveVersion) {
          workflow.liveVersion = workflow.version;
          workflow.liveTrigger = Workflow.liveTriggerOf(workflow);
        }

        fields.version = workflow.version + 1;
      }

      fields.updatedAt = new Date();
      Object.assign(workflow, fields);
      await workflow.save();

      if (versioned) {
        await this.saveVersion(workflow, user, changeDescription);
      }

      logger.info(`Workflow updated: ${workflowId} to version ${workflow.version}`);
      return workflow;
    } catch (error) {
      logger.error('Error updating workflow:', error);
      throw error;
    }
  }

  /**
   * How many workflows a company has live, and how many its plan allows.
   *
   * Counted here rather than through the usage meter, because the meter
   * counted every workflow that was not archived - drafts included - and a
   * draft answers nobody. Fails open, like every other quota check: the plan
   * service being down must not stop somebody publishing a fix.
   *
   * @returns {Promise<{used: number, limit: number|null, entitled: boolean,
   *                    reason?: string}>}
   */
  async liveUsage(companyId, { excluding = null } = {}) {
    const filter = { company: companyId, status: 'published' };
    if (excluding) {
      filter._id = { $ne: excluding };
    }

    const used = await Workflow.countDocuments(filter);

    try {
      const subscription = await require('./usage').getSubscription(companyId);
      const entitled = subscription.isEntitled();
      return {
        used,
        limit: entitled ? subscription.limitFor('workflows') : 0,
        entitled,
        ...(entitled ? {} : {
          reason: subscription.status === 'trialing'
            ? 'Your trial has ended. Choose a plan to continue.'
            : `This account is ${subscription.status}.`
        })
      };
    } catch (error) {
      logger.error('Could not read the live-workflow limit; allowing', { error: error.message });
      return { used, limit: null, entitled: true };
    }
  }

  /** Take a workflow off live without touching its draft. */
  async takeOffline(workflowId) {
    await Workflow.updateOne(
      { _id: workflowId },
      { $set: { status: 'draft', updatedAt: new Date() }, $unset: { liveVersion: 1, liveTrigger: 1 } }
    );
  }

  /**
   * Make the current version live.
   *
   * Several workflows may be live at once, each answering the messages its
   * trigger matches. Only one may answer everything: publishing a second
   * `always` workflow is refused with a 409 naming the first, and done with
   * `replace: true`, which takes the first offline.
   *
   * @param {object} [options]
   * @param {boolean} [options.replace] take the live `always` workflow offline
   * @returns {Promise<Workflow>} with `$locals.replaced` set to the workflow
   *          it replaced, if any
   */
  async publishWorkflow(workflowId, user, options = {}) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      // The full set of checks a draft is spared on save.
      const report = this.report(workflow.nodes, workflow.edges, workflow.trigger);
      if (!report.valid) {
        throw statusError(
          report.errors.length === 1
            ? `Fix this before publishing: ${report.errors[0]}`
            : `Fix ${report.errors.length} problems before publishing. First: ${report.errors[0]}`,
          400,
          { errors: report.errors, problems: report.problems }
        );
      }

      const companyId = companyIdOf(workflow);
      const trigger = cleanTrigger(workflow.trigger);
      let replaced = null;

      if (companyId) {
        const others = await Workflow.find({
          company: companyId, status: 'published', _id: { $ne: workflow._id }
        }).select('name trigger liveTrigger').lean();

        const conflict = trigger.type === 'always'
          ? others.find(other => Workflow.liveTriggerOf(other).type === 'always')
          : null;

        if (conflict && !options.replace) {
          throw statusError(
            `"${conflict.name}" already answers every message. Only one workflow can do that.`,
            409,
            { code: 'ALWAYS_CONFLICT', conflict: { id: String(conflict._id), name: conflict.name } }
          );
        }

        // Republishing a live workflow does not need another slot, and a
        // superadmin is not subject to a tenant's plan.
        if (workflow.status !== 'published' && user.role !== 'superadmin') {
          const usage = await this.liveUsage(companyId, { excluding: workflow._id });
          const used = usage.used - (conflict ? 1 : 0);

          if (!usage.entitled || (usage.limit !== null && usage.limit !== undefined && used + 1 > usage.limit)) {
            throw statusError(
              usage.entitled
                ? `Your plan allows ${usage.limit} live workflow${usage.limit === 1 ? '' : 's'} and you have ${used}. ` +
                  'Unpublish one first, or upgrade.'
                : usage.reason,
              402,
              { code: 'PLAN_LIMIT_REACHED', meter: 'workflows', limit: usage.limit, used }
            );
          }
        }

        if (conflict) {
          await this.takeOffline(conflict._id);
          replaced = { id: String(conflict._id), name: conflict.name };
        }
      }

      workflow.compiledChain = await this.compileWorkflow(
        { nodes: workflow.nodes, edges: workflow.edges },
        companyId
      );
      workflow.status = 'published';
      workflow.publishedAt = new Date();
      workflow.publishedBy = user.id;
      workflow.liveVersion = workflow.version;
      workflow.liveTrigger = trigger;
      await workflow.save();

      workflow.$locals.replaced = replaced;
      logger.info(`Workflow published: ${workflowId}`);
      return workflow;
    } catch (error) {
      logger.error('Error publishing workflow:', error);
      throw error;
    }
  }

  /**
   * Take a workflow off live. It stays as a draft, with its history, and can
   * be published again; the messages it answered go back to the assistant
   * (or another live workflow) from the next one.
   */
  async unpublishWorkflow(workflowId, user) {
    const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
    const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

    if (workflow.status !== 'published') {
      throw statusError('This workflow is not live', 400);
    }

    workflow.status = 'draft';
    workflow.liveVersion = undefined;
    workflow.liveTrigger = undefined;
    await workflow.save();

    logger.info(`Workflow unpublished: ${workflowId}`);
    return workflow;
  }

  /**
   * Get workflow versions
   */
  async getWorkflowVersions(workflowId, userCompanyId = null, userRole = null) {
    try {
      // Verify user has access to this workflow
      await this.getWorkflow(workflowId, userCompanyId, userRole);

      const versions = await WorkflowVersion.getVersionHistory(workflowId, 20);
      return versions;
    } catch (error) {
      logger.error('Error getting workflow versions:', error);
      throw error;
    }
  }

  /**
   * Put an earlier version back on the canvas.
   *
   * Like a save, it is a draft: a live workflow keeps serving the version
   * visitors have until it is published again.
   */
  async rollbackWorkflow(workflowId, targetVersion, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;

      // Get current workflow and target version
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);
      const targetVersionData = await WorkflowVersion.getVersion(workflowId, targetVersion);

      if (!targetVersionData) {
        throw new Error(`Version ${targetVersion} not found`);
      }

      if (workflow.status === 'published' && !workflow.liveVersion) {
        workflow.liveVersion = workflow.version;
        workflow.liveTrigger = Workflow.liveTriggerOf(workflow);
      }

      // Update workflow with target version data
      workflow.nodes = targetVersionData.nodes;
      workflow.edges = targetVersionData.edges;
      workflow.compiledChain = targetVersionData.compiledChain;
      if (targetVersionData.trigger && targetVersionData.trigger.type) {
        workflow.trigger = cleanTrigger(targetVersionData.trigger);
      }
      workflow.version = workflow.version + 1; // Increment version for rollback
      workflow.updatedAt = new Date();

      await workflow.save();

      // Save rollback version
      await this.saveVersion(
        workflow,
        user,
        `Rollback to version ${targetVersion}`,
        true,
        targetVersion
      );

      logger.info(`Workflow ${workflowId} rolled back to version ${targetVersion}`);
      return workflow;
    } catch (error) {
      logger.error('Error rolling back workflow:', error);
      throw error;
    }
  }

  /**
   * Delete a workflow
   */
  async deleteWorkflow(workflowId, user) {
    try {
      const userCompanyId = user.role === 'superadmin' ? null : user.company?.id;
      const workflow = await this.getWorkflow(workflowId, userCompanyId, user.role);

      // Deleting what visitors are talking to would cut conversations off
      // mid-question; taking it offline first is one click and reversible.
      if (workflow.status === 'published') {
        throw statusError('This workflow is live. Unpublish it first, then delete it.', 409, { code: 'WORKFLOW_LIVE' });
      }

      // Delete workflow and its versions
      await WorkflowVersion.deleteMany({ workflowId: workflow._id });
      await Workflow.findByIdAndDelete(workflow._id);

      logger.info(`Workflow deleted: ${workflowId}`);
      return {
        success: true,
        message: 'Workflow deleted successfully',
        name: workflow.name,
        company: workflow.company ? String(workflow.company._id || workflow.company) : null
      };
    } catch (error) {
      logger.error('Error deleting workflow:', error);
      throw error;
    }
  }

  /**
   * The most recently published workflow for a company.
   */
  async getActiveWorkflow(companyId) {
    try {
      return await Workflow.getActiveWorkflow(companyId);
    } catch (error) {
      logger.error('Error getting active workflow:', error);
      throw error;
    }
  }

  /**
   * Validate workflow structure, throwing the first problem.
   *
   * Kept for callers that want a yes or no; the editor's routes use report()
   * for the whole list.
   */
  validateWorkflow(workflowData) {
    const { nodes = [], edges = [] } = workflowData;

    if (nodes.length === 0) {
      return; // Empty workflow is valid for drafts
    }

    const result = this.report(nodes, edges);
    if (!result.valid) {
      throw statusError(result.errors[0], 400, { problems: result.problems });
    }
  }

  /**
   * Validate node-specific data
   */
  validateNodeData(node) {
    const type = (node.data && node.data.type) || node.type;
    const data = node.data || {};
    const config = data.config || {};
    // Named the way the editor shows it, never by its internal id.
    const name = this.compiler.nodeLabel(node);

    switch (type) {
    case 'persona':
      if (!data.prompt || data.prompt.trim().length === 0) {
        throw new Error(`"${name}" must have a prompt`);
      }
      break;

    case 'knowledge':
    case 'knowledge-source': {
      if (!data.sourceType) {
        throw new Error(`"${name}" must have a source type`);
      }

      switch (data.sourceType) {
      case 'google_sheets':
      case 'google-sheets':
        if (!config.sheetId && !config.spreadsheetId) {
          throw new Error(`"${name}" with Google Sheets source must have a sheet ID`);
        }
        break;
      case 'pdf':
      case 'url':
      case 'pdf-url':
        if (!config.url && !config.filePath) {
          throw new Error(`"${name}" must have a URL or file path`);
        }
        break;
      case 'vector_store':
      case 'vector-store':
        // An empty collection means this company's own knowledge base, which
        // is what almost everyone wants and the only one most tenants have.
        // Demanding a name they have never seen was a wall in front of the
        // most common configuration.
        break;
      default:
        throw new Error(`"${name}" has an unsupported source type: ${data.sourceType}`);
      }
      break;
    }

    case 'router':
      if (!Array.isArray(data.conditions)) {
        throw new Error(`"${name}" must have conditions array`);
      }
      break;

    case 'ask':
      if (!data.question || String(data.question).trim().length === 0) {
        throw new Error(`"${name}" must have a question`);
      }
      if (!data.variable || String(data.variable).trim().length === 0) {
        throw new Error(`"${name}" must say where to save the answer`);
      }
      break;

    case 'buttons':
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error(`"${name}" must offer at least one choice`);
      }
      if (data.choices.some(choice => !choice || !String(choice.label || '').trim())) {
        throw new Error(`"${name}" has a choice with no label`);
      }
      break;

    case 'condition': {
      // Either shape: a clause list, or the single left/operator/right a
      // workflow saved before clauses existed.
      const clauses = Array.isArray(data.clauses) && data.clauses.length > 0
        ? data.clauses
        : [data];
      const usable = clauses.some(clause =>
        clause && clause.left && String(clause.left).trim().length > 0);
      if (!usable) {
        throw new Error(`"${name}" must have at least one value to check`);
      }
      break;
    }

    case 'notify':
      if (!data.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.to).trim())) {
        throw new Error(`"${name}" needs the email address to send to`);
      }
      if (!data.subject || String(data.subject).trim().length === 0) {
        throw new Error(`"${name}" needs a subject`);
      }
      break;

    case 'task':
      if (!data.title || String(data.title).trim().length === 0) {
        throw new Error(`"${name}" must have a title`);
      }
      break;

    case 'tag':
      if (!Array.isArray(data.tags) || data.tags.length === 0) {
        throw new Error(`"${name}" must have at least one tag`);
      }
      break;

    case 'action': {
      // The URL (or the saved Action that holds it) is the compiler's to
      // check: see validateActionNode. A node that uses a saved Action has no
      // URL of its own, and requiring one here made such a node unsaveable.

      // A mapping with a name but no path would quietly resolve to nothing, so
      // a downstream reply would say "your order is " and stop.
      (data.outputs || []).forEach(output => {
        if (output.variable && !output.path) {
          throw new Error(
            `"${name}": "${output.variable}" has no path into the response`
          );
        }
      });
      break;
    }

    case 'fallback':
      if (!data.message || data.message.trim().length === 0) {
        throw new Error(`"${name}" must have a message`);
      }
      break;

    case 'llm':
      if (!data.prompt || data.prompt.trim().length === 0) {
        throw new Error(`"${name}" must have an instruction`);
      }
      break;

    case 'response':
      if (!data.template && !data.message) {
        throw new Error(`"${name}" must have a message template`);
      }
      break;

    case 'capability': {
      // Checked against the contract the connector is held to, so a node that
      // names a capability nobody implements, or feeds it a field it does not
      // take, is refused in the editor rather than at the visitor.
      const capability = data.capability ? capabilities.byId(String(data.capability)) : null;
      if (!capability) {
        throw new Error(
          `"${name}" must choose one of: ${capabilities.ids().join(', ')}`
        );
      }

      const input = data.input || {};
      if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`"${name}" has inputs that are not a set of fields`);
      }

      Object.keys(input).forEach(field => {
        if (!Object.prototype.hasOwnProperty.call(capability.input, field)) {
          throw new Error(
            `"${name}": "${capability.id}" has no input called "${field}"`
          );
        }
      });

      Object.entries(capability.input).forEach(([field, spec]) => {
        const required = !String(spec).endsWith('?');
        const value = input[field];
        if (required && (value === undefined || value === null || String(value).trim() === '')) {
          throw new Error(`"${name}": "${capability.id}" needs "${field}"`);
        }
      });

      if (data.limit !== undefined && data.limit !== '' && !/^\d+$/.test(String(data.limit))) {
        throw new Error(`"${name}" has a limit that is not a whole number`);
      }
      break;
    }

    case 'start':
    case 'moderation':
    case 'operator-handoff':
    case 'set':
    case 'business-hours':
      // No extra configuration required.
      break;

    default:
      throw new Error(`"${name}" is a kind of step this version does not know (${type})`);
    }
  }

  /**
   * Validate workflow is ready for publishing
   */
  validateForPublishing(workflow) {
    if (!workflow.nodes || workflow.nodes.length === 0) {
      throw new Error('Cannot publish empty workflow');
    }

    // Must have at least one entry point
    const entryNodes = this.findEntryPoints(workflow.nodes, workflow.edges);
    if (entryNodes.length === 0) {
      throw new Error('Workflow must have at least one entry point');
    }

    // Must have a compiled chain
    if (!workflow.compiledChain) {
      throw new Error('Workflow must be compiled before publishing');
    }
  }

  /**
   * Find entry points in workflow
   */
  findEntryPoints(nodes, edges) {
    const nodeIds = new Set(nodes.map(n => n.id));
    const targetsWithSources = new Set(edges.map(e => e.target));

    return nodes.filter(node => !targetsWithSources.has(node.id));
  }

  /**
   * Simple cycle detection
   */
  detectCycles(nodes, edges) {
    const graph = {};
    const visited = new Set();
    const recStack = new Set();

    // Build adjacency list
    nodes.forEach(node => {
      graph[node.id] = [];
    });

    edges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });

    // DFS to detect cycles
    const hasCycle = (nodeId) => {
      if (recStack.has(nodeId)) {
        return true;
      }
      if (visited.has(nodeId)) {
        return false;
      }

      visited.add(nodeId);
      recStack.add(nodeId);

      const neighbors = graph[nodeId] || [];
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) {
          return true;
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const nodeId of Object.keys(graph)) {
      if (hasCycle(nodeId)) {
        throw new Error('Workflow contains circular dependencies');
      }
    }
  }

  /**
   * Save workflow version
   */
  async saveVersion(workflow, user, changeDescription = null, isRollback = false, rollbackFromVersion = null) {
    try {
      const version = new WorkflowVersion({
        workflowId: workflow._id,
        version: workflow.version,
        nodes: workflow.nodes,
        edges: workflow.edges,
        trigger: cleanTrigger(workflow.trigger),
        compiledChain: workflow.compiledChain,
        changeDescription,
        isRollback,
        rollbackFromVersion,
        createdBy: user.id
      });

      await version.save();
      return version;
    } catch (error) {
      logger.error('Error saving workflow version:', error);
      throw error;
    }
  }

  /**
   * Compile workflow using WorkflowCompilerService
   */
  async compileWorkflow(workflowData, tenantId = null) {
    try {
      const nodes = workflowData.nodes || [];
      const edges = workflowData.edges || [];

      if (nodes.length === 0) {
        return {
          compiled: false,
          reason: 'No nodes to compile',
          timestamp: new Date()
        };
      }

      // Use the workflow compiler service
      const compilationResult = await this.compiler.compileWorkflow(nodes, edges, tenantId);

      return {
        compiled: true,
        timestamp: new Date(),
        compilationResult,
        entryPoints: this.findEntryPoints(nodes, edges),
        nodeCount: nodes.length,
        edgeCount: edges.length
      };
    } catch (error) {
      logger.error('Error compiling workflow:', error);
      throw error;
    }
  }
}

const instance = new WorkflowService();

module.exports = instance;
module.exports.redactWorkflow = redactWorkflow;
module.exports.protectNodeSecrets = protectNodeSecrets;
module.exports.pickEditable = pickEditable;
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
module.exports.cleanTrigger = cleanTrigger;
module.exports.triggerProblems = triggerProblems;
module.exports.statusError = statusError;
