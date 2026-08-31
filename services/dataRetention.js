/**
 * Data retention.
 *
 * Retention used to be one policy for the whole platform: a fixed number of
 * days after which every tenant's conversations were deleted, wherever they
 * were and whatever they had promised their own customers. A tenant with a
 * stricter obligation could not express it, and a tenant with a longer one
 * lost data they were required to keep.
 *
 * A policy is now per company, with the platform's numbers as the fallback,
 * and it has two stages rather than one:
 *
 *   anonymise - strip what identifies the person, keep the shape of the
 *               conversation, so reports covering last year still have a last
 *               year to cover
 *   delete    - drop the record entirely
 *
 * Both are counted in days since a conversation's last activity. A company may
 * set either to 0, meaning never, which is a different statement from having
 * not chosen: an unset value takes the platform default, and 0 does not.
 */

const Conversation = require('../models/conversation');
const Company = require('../models/company');
const { logger } = require('./logging');

/** Days -> the moment before which a conversation is in scope. */
function cutoff(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function positiveInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

class DataRetentionService {
  /**
   * @param {object} [options]
   * @param {number} [options.anonymizeAfterDays] platform default, 0 = never
   * @param {number} [options.deleteAfterDays] platform default, 0 = never
   * @param {number} [options.batchSize] conversations anonymised per query
   * @param {number} [options.maxPerRun] ceiling on one sweep, so a backlog is
   *   worked through over several runs instead of holding the database for an
   *   unbounded stretch
   */
  constructor(options = {}) {
    this.defaults = {
      anonymizeAfterDays: positiveInt(options.anonymizeAfterDays) ?? 0,
      deleteAfterDays: positiveInt(options.deleteAfterDays) ?? 0
    };

    this.runInterval = options.runInterval || 24 * 60 * 60 * 1000;
    this.batchSize = options.batchSize || 200;
    this.maxPerRun = options.maxPerRun || 5000;
    this.initialized = false;
  }

  /**
   * The policy in force for one company: its own choices where it has made
   * them, the platform's where it has not.
   *
   * @param {object|null} company a company document or lean object
   */
  policyFor(company) {
    const own = (company && company.dataRetention) || {};

    const resolve = (field) => {
      const value = own[field];
      // `0` is a decision ("never"), so only an absent value falls back.
      return value === undefined || value === null ? this.defaults[field] : value;
    };

    return {
      anonymizeAfterDays: resolve('anonymizeAfterDays'),
      deleteAfterDays: resolve('deleteAfterDays'),
      source: {
        anonymizeAfterDays: own.anonymizeAfterDays === undefined || own.anonymizeAfterDays === null
          ? 'platform' : 'company',
        deleteAfterDays: own.deleteAfterDays === undefined || own.deleteAfterDays === null
          ? 'platform' : 'company'
      }
    };
  }

  /**
   * Delete, then anonymise, one company's expired conversations.
   *
   * Deleting is done first in each pass so that a conversation past both
   * windows is not scrubbed a moment before it is dropped, which is pure work.
   *
   * @param {string|ObjectId|null} companyId null sweeps conversations that
   *   belong to no company - legacy rows, and anything a tenancy bug produced.
   */
  async sweepCompany(companyId, policy) {
    const scope = companyId ? { company: companyId } : { company: { $exists: false } };
    const result = { companyId: companyId ? String(companyId) : null, deleted: 0, anonymized: 0 };

    if (policy.deleteAfterDays > 0) {
      const deletion = await Conversation.deleteMany({
        ...scope,
        lastActivity: { $lt: cutoff(policy.deleteAfterDays) }
      });
      result.deleted = deletion.deletedCount || 0;
    }

    if (policy.anonymizeAfterDays > 0) {
      result.anonymized = await this.anonymizeBatch({
        ...scope,
        anonymizedAt: { $exists: false },
        lastActivity: { $lt: cutoff(policy.anonymizeAfterDays) }
      });
    }

    return result;
  }

  /**
   * Scrub matching conversations, a batch at a time.
   *
   * Document by document rather than one `updateMany` because anonymising has
   * to reach inside every message, and because a single statement covering an
   * unbounded number of documents is how a nightly job becomes an outage.
   */
  async anonymizeBatch(query) {
    let processed = 0;

    while (processed < this.maxPerRun) {
      const batch = await Conversation.find(query)
        .sort({ lastActivity: 1 })
        .limit(Math.min(this.batchSize, this.maxPerRun - processed));

      if (batch.length === 0) {
        break;
      }

      for (const conversation of batch) {
        await conversation.anonymize();
        processed += 1;
      }

      if (batch.length < this.batchSize) {
        break;
      }
    }

    if (processed >= this.maxPerRun) {
      logger.warn('Retention sweep hit its per-run ceiling; the remainder waits for the next run', {
        processed
      });
    }

    return processed;
  }

  /**
   * One pass over every tenant.
   */
  async runCleanup() {
    const summary = { companies: 0, deleted: 0, anonymized: 0 };

    try {
      const companies = await Company.find({}).select('_id name dataRetention').lean();

      for (const company of companies) {
        const policy = this.policyFor(company);

        // Nothing to do, and saying so per tenant in the log would drown the
        // tenants where something did happen.
        if (policy.anonymizeAfterDays === 0 && policy.deleteAfterDays === 0) {
          continue;
        }

        try {
          const result = await this.sweepCompany(company._id, policy);
          summary.companies += 1;
          summary.deleted += result.deleted;
          summary.anonymized += result.anonymized;

          if (result.deleted || result.anonymized) {
            logger.info('Retention applied', {
              company: company.name,
              deleted: result.deleted,
              anonymized: result.anonymized,
              policy: `${policy.anonymizeAfterDays}/${policy.deleteAfterDays} days`
            });
          }
        } catch (error) {
          // One tenant's failure must not stop the others being swept: a
          // policy nobody can rely on is not a policy.
          logger.error('Retention sweep failed for a company', {
            company: company.name,
            error: error.message
          });
        }
      }

      // Conversations with no company at all. They belong to nobody, so the
      // platform default is the only policy that can apply.
      const orphanPolicy = this.policyFor(null);
      if (orphanPolicy.anonymizeAfterDays > 0 || orphanPolicy.deleteAfterDays > 0) {
        const result = await this.sweepCompany(null, orphanPolicy);
        summary.deleted += result.deleted;
        summary.anonymized += result.anonymized;
      }

      logger.info('Data retention sweep complete', summary);
    } catch (error) {
      logger.error('Data retention sweep failed', { error: error.message });
    }

    return summary;
  }

  /**
   * What a policy would do right now, without doing it. The retention screen
   * shows this before an admin saves a shorter window, because "this will
   * delete 4,812 conversations" is the part they need to see first.
   */
  async preview(companyId, policy) {
    const scope = companyId ? { company: companyId } : { company: { $exists: false } };
    const resolved = policy || this.policyFor(await Company.findById(companyId).lean());

    const [toDelete, toAnonymize] = await Promise.all([
      resolved.deleteAfterDays > 0
        ? Conversation.countDocuments({ ...scope, lastActivity: { $lt: cutoff(resolved.deleteAfterDays) } })
        : Promise.resolve(0),
      resolved.anonymizeAfterDays > 0
        ? Conversation.countDocuments({
          ...scope,
          anonymizedAt: { $exists: false },
          lastActivity: { $lt: cutoff(resolved.anonymizeAfterDays) }
        })
        : Promise.resolve(0)
    ]);

    return { policy: resolved, toDelete, toAnonymize };
  }

  start() {
    if (this.initialized) {
      return;
    }

    logger.info('Starting data retention service', {
      platformDefaults: this.defaults
    });

    this.runCleanup();
    this.interval = setInterval(() => this.runCleanup(), this.runInterval);
    this.initialized = true;
  }

  stop() {
    if (!this.initialized) {
      return;
    }

    clearInterval(this.interval);
    this.initialized = false;
    logger.info('Stopping data retention service');
  }
}

module.exports = DataRetentionService;
