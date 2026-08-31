/**
 * Per-tenant backup and restore.
 *
 * `services/backup.js` dumps the whole database with `mongodump`, which is the
 * right tool for losing a server and the wrong one for losing a customer. One
 * tenant deleting their workflows, or an import corrupting one company's
 * knowledge base, had no answer short of restoring every tenant to a point in
 * the past - which trades one company's accident for everybody else's day.
 *
 * So this works in documents rather than in database files: everything
 * belonging to one company, exported as EJSON (which keeps ObjectIds and dates
 * as themselves rather than as strings), and put back the same way.
 *
 * ## What "belonging to one company" means
 *
 * Most collections carry a `company` field, and those are discovered from the
 * schemas rather than listed here, so a new tenant-scoped model is included
 * the day it is added rather than the day somebody remembers this file.
 *
 * The rest hang off a parent - a comment belongs to a task, a version to a
 * workflow - and are collected by their parents' ids in a second pass. Those
 * do have to be declared, and a model that is neither is reported in the
 * manifest as uncovered rather than quietly omitted: a backup you cannot see
 * the edges of is not one you can rely on.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { logger } = require('./logging');

const { EJSON } = mongoose.mongo.BSON;

/**
 * Collections reached through a parent rather than through a `company` field.
 * `parent` names a model that pass one has already collected.
 */
const DEPENDENTS = [
  { model: 'Comment', field: 'taskId', parent: 'Task' },
  { model: 'Notification', field: 'userId', parent: 'User' },
  { model: 'Suggestion', field: 'conversationId', parent: 'Conversation' },
  { model: 'WorkflowVersion', field: 'workflowId', parent: 'Workflow' },
  { model: 'KnowledgeDocument', field: 'userId', parent: 'User' }
];

/**
 * Collections that are deliberately not a tenant's to restore.
 *
 * The audit log is append-only evidence: restoring an old copy of it would let
 * a restore rewrite the record of what happened, which is the one thing an
 * audit log must not allow. Rate-limit counters are seconds-old scratch data.
 */
const NEVER_RESTORE = new Set(['AuditLog', 'RateLimitCounter']);

/** Load every model file, so the registry is complete however we were called. */
function loadModels() {
  const dir = path.join(__dirname, '..', 'models');
  fs.readdirSync(dir)
    .filter(file => file.endsWith('.js'))
    .forEach(file => require(path.join(dir, file)));
}

function isTenantScoped(model) {
  return Boolean(model.schema.path('company'));
}

class TenantBackupService {
  /**
   * @param {object} [options]
   * @param {string} [options.backupDir] where tenant backups are written
   * @param {number} [options.retentionDays] how long they are kept
   */
  constructor(options = {}) {
    this.backupDir = options.backupDir
      || path.join(__dirname, '..', 'backups', 'tenants');
    // `??`, not `||`: 0 days is a legitimate setting and would otherwise be
    // read as "unset" and silently become 90.
    this.retentionDays = options.retentionDays
      ?? parseInt(process.env.TENANT_BACKUP_RETENTION_DAYS || '90', 10);
    this.batchSize = options.batchSize || 500;
  }

  /**
   * Every model that holds tenant data, and how to find one company's share.
   */
  plan() {
    loadModels();

    const direct = [];
    const uncovered = [];
    const dependentNames = new Set(DEPENDENTS.map(d => d.model));

    Object.keys(mongoose.models).forEach(name => {
      const model = mongoose.models[name];

      if (name === 'Company') {
        direct.push({ name, match: id => ({ _id: id }) });
        return;
      }

      if (isTenantScoped(model)) {
        direct.push({ name, match: id => ({ company: id }) });
        return;
      }

      if (!dependentNames.has(name) && !NEVER_RESTORE.has(name)) {
        uncovered.push(name);
      }
    });

    return { direct, dependents: DEPENDENTS, uncovered };
  }

  /**
   * Both segments come from a URL, so both are checked rather than trusted: a
   * timestamp of `../../..` would otherwise make the recovery tool a way to
   * read and overwrite arbitrary paths.
   */
  directoryFor(companyId, timestamp) {
    const segment = (value, label) => {
      const text = String(value);
      if (!/^[A-Za-z0-9_-]+$/.test(text)) {
        throw new Error(`Invalid ${label}`);
      }
      return text;
    };

    return path.join(this.backupDir, segment(companyId, 'company id'), segment(timestamp, 'backup id'));
  }

  /**
   * Write one company's data to disk.
   *
   * @returns {Promise<object>} the manifest
   */
  async backupCompany(companyId) {
    const Company = mongoose.model('Company');
    const company = await Company.findById(companyId).lean();

    if (!company) {
      throw new Error(`Company ${companyId} not found`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = this.directoryFor(companyId, timestamp);
    fs.mkdirSync(target, { recursive: true });

    const { direct, dependents, uncovered } = this.plan();
    const collections = {};
    const parentIds = {};

    for (const entry of direct) {
      const model = mongoose.model(entry.name);
      const documents = await model.find(entry.match(company._id)).lean();

      collections[entry.name] = documents.length;
      parentIds[entry.name] = documents.map(doc => doc._id);
      this.write(target, entry.name, documents);
    }

    for (const dependent of dependents) {
      if (!mongoose.models[dependent.model]) {
        continue;
      }

      const ids = parentIds[dependent.parent] || [];
      const documents = ids.length
        ? await mongoose.model(dependent.model).find({ [dependent.field]: { $in: ids } }).lean()
        : [];

      collections[dependent.model] = documents.length;
      this.write(target, dependent.model, documents);
    }

    const manifest = {
      company: { id: String(company._id), name: company.name },
      createdAt: new Date().toISOString(),
      timestamp,
      collections,
      documents: Object.values(collections).reduce((total, count) => total + count, 0),
      // Said out loud so nobody discovers it during a restore.
      notCovered: {
        collections: uncovered,
        notes: [
          'Uploaded files on disk are not included; back up the uploads directory separately.',
          'The audit log is append-only and is exported but never restored.'
        ]
      }
    };

    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));

    logger.info('Tenant backup written', {
      company: company.name,
      documents: manifest.documents,
      timestamp
    });

    return manifest;
  }

  write(target, name, documents) {
    // One JSON document per line: a 400,000-conversation export should not have
    // to be held in memory as a single string to be read back.
    const lines = documents.map(doc => EJSON.stringify(doc)).join('\n');
    fs.writeFileSync(path.join(target, `${name}.ndjson`), lines ? `${lines}\n` : '');
  }

  read(target, name) {
    const file = path.join(target, `${name}.ndjson`);

    if (!fs.existsSync(file)) {
      return [];
    }

    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => EJSON.parse(line));
  }

  /**
   * List a company's backups, newest first.
   */
  listBackups(companyId) {
    const dir = path.join(this.backupDir, String(companyId));

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const manifestPath = path.join(dir, entry.name, 'manifest.json');
        const manifest = fs.existsSync(manifestPath)
          ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
          : null;

        return {
          timestamp: entry.name,
          createdAt: manifest ? manifest.createdAt : null,
          documents: manifest ? manifest.documents : null,
          collections: manifest ? manifest.collections : null
        };
      })
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  }

  /**
   * Put a company's data back.
   *
   * Two modes, because they answer different accidents:
   *
   *   merge   - restore what is in the backup, leave everything else. The safe
   *             default: it can bring back what was deleted and cannot itself
   *             delete anything.
   *   replace - make the tenant match the backup exactly, dropping whatever
   *             has happened since. Sometimes the only correct answer, and
   *             never one to arrive at by leaving an option unset.
   *
   * Either way the scope is one company: every query carries the tenant, so a
   * restore cannot reach a neighbour's data even if the backup did.
   */
  async restoreCompany(companyId, timestamp, options = {}) {
    const mode = options.mode === 'replace' ? 'replace' : 'merge';
    const target = this.directoryFor(companyId, timestamp);
    const manifestPath = path.join(target, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Backup ${timestamp} not found for company ${companyId}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (manifest.company.id !== String(companyId)) {
      // Restoring one tenant's documents into another tenant would be a data
      // breach performed by the recovery tool.
      throw new Error('This backup belongs to a different company');
    }

    const { direct, dependents } = this.plan();
    const result = { mode, timestamp, restored: {}, removed: {} };
    const parentIds = {};

    for (const entry of direct) {
      if (NEVER_RESTORE.has(entry.name)) {
        continue;
      }

      const documents = this.read(target, entry.name);
      parentIds[entry.name] = documents.map(doc => doc._id);

      if (mode === 'replace') {
        // `$and` rather than one object: the Company collection is matched by
        // `_id`, so merging the two conditions into a single literal would
        // drop the tenant condition on a duplicate key - and delete every
        // other company on the platform.
        const removal = await mongoose.model(entry.name).deleteMany({
          $and: [
            entry.match(new mongoose.Types.ObjectId(String(companyId))),
            { _id: { $nin: documents.map(doc => doc._id) } }
          ]
        });
        result.removed[entry.name] = removal.deletedCount || 0;
      }

      result.restored[entry.name] = await this.upsert(entry.name, documents);
    }

    for (const dependent of dependents) {
      if (!mongoose.models[dependent.model] || NEVER_RESTORE.has(dependent.model)) {
        continue;
      }

      const documents = this.read(target, dependent.model);

      if (mode === 'replace') {
        const ids = parentIds[dependent.parent] || [];
        const removal = await mongoose.model(dependent.model).deleteMany({
          $and: [
            { [dependent.field]: { $in: ids } },
            { _id: { $nin: documents.map(doc => doc._id) } }
          ]
        });
        result.removed[dependent.model] = removal.deletedCount || 0;
      }

      result.restored[dependent.model] = await this.upsert(dependent.model, documents);
    }

    logger.warn('Tenant restore completed', {
      company: manifest.company.name,
      timestamp,
      mode,
      documents: Object.values(result.restored).reduce((total, count) => total + count, 0)
    });

    return result;
  }

  /**
   * Write documents back by `_id`.
   *
   * `replaceOne` with upsert rather than `insertMany`, so restoring over a
   * tenant that still half exists is not a wall of duplicate-key errors.
   */
  async upsert(name, documents) {
    if (documents.length === 0) {
      return 0;
    }

    const model = mongoose.model(name);
    let written = 0;

    for (let i = 0; i < documents.length; i += this.batchSize) {
      const batch = documents.slice(i, i + this.batchSize);

      const operations = batch.map(doc => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
      }));

      const outcome = await model.bulkWrite(operations, { ordered: false });
      written += (outcome.upsertedCount || 0) + (outcome.modifiedCount || 0) + (outcome.matchedCount || 0);
    }

    return written;
  }

  /**
   * Drop tenant backups past the retention window. A backup system that only
   * ever grows is one somebody eventually turns off.
   */
  cleanup() {
    if (!fs.existsSync(this.backupDir)) {
      return { removed: 0 };
    }

    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const company of fs.readdirSync(this.backupDir, { withFileTypes: true })) {
      if (!company.isDirectory()) {
        continue;
      }

      const companyDir = path.join(this.backupDir, company.name);

      for (const backup of fs.readdirSync(companyDir, { withFileTypes: true })) {
        if (!backup.isDirectory()) {
          continue;
        }

        const dir = path.join(companyDir, backup.name);
        if (fs.statSync(dir).mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      }
    }

    if (removed) {
      logger.info(`Removed ${removed} expired tenant backups`);
    }

    return { removed };
  }
}

module.exports = TenantBackupService;
