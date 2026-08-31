/**
 * An express-rate-limit store backed by MongoDB.
 *
 * The point is that every instance counts into the same place. A limit written
 * as "20 messages a minute" is otherwise "20 per minute per process", which is
 * a different and much weaker promise, and one that changes silently whenever
 * somebody scales the deployment.
 *
 * MongoDB rather than Redis because MongoDB is already a hard dependency:
 * adding an second piece of infrastructure to enforce a limit that is checked
 * a few times a second is not a trade worth making. If throughput ever
 * outgrows this, the store interface is the seam to swap.
 */

const mongoose = require('mongoose');
const RateLimitCounter = require('../models/rate-limit-counter');
const { logger } = require('./logging');

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class MongoRateLimitStore {
  /**
   * @param {object} [options]
   * @param {string} [options.prefix] namespaces one limiter's buckets from
   *   another's, so the login limiter and the chat limiter do not share counts.
   * @param {function} [options.isConnected] whether the database can be
   *   reached. Injectable so the degraded path can be exercised without
   *   tearing down a real connection.
   */
  constructor(options = {}) {
    this.prefix = options.prefix || 'rl';
    this.windowMs = options.windowMs || 60 * 1000;
    this.isConnected = options.isConnected || (() => mongoose.connection.readyState === 1);

    // Keys are shared, so express-rate-limit must not assume it can reset them
    // locally.
    this.localKeys = false;

    // Used only while MongoDB is unreachable; see `unavailable()`.
    this.memory = new Map();
    this.degraded = false;
  }

  /** Called by express-rate-limit with the limiter's resolved options. */
  init(options) {
    if (options && options.windowMs) {
      this.windowMs = options.windowMs;
    }
  }

  /**
   * Falling back to memory during an outage is deliberate. The alternative -
   * failing the request - turns a database blip into an outage of the login
   * page, and refusing to count at all turns it into an open door.
   */
  unavailable() {
    const connected = this.isConnected();

    if (!connected && !this.degraded) {
      this.degraded = true;
      logger.warn('Rate limit store degraded to per-process counting: MongoDB is unreachable');
    } else if (connected && this.degraded) {
      this.degraded = false;
      this.memory.clear();
      logger.info('Rate limit store back on MongoDB');
    }

    return !connected;
  }

  windowStart(now = Date.now()) {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  documentId(key, windowStart) {
    return `${this.prefix}:${key}:${windowStart}`;
  }

  memoryIncrement(id, resetTime, delta) {
    const existing = this.memory.get(id);
    const hits = Math.max(0, (existing ? existing.hits : 0) + delta);
    this.memory.set(id, { hits, resetTime });

    // The map would otherwise grow for the life of the process.
    if (this.memory.size > 10000) {
      const now = Date.now();
      for (const [otherId, entry] of this.memory) {
        if (entry.resetTime.getTime() <= now) {
          this.memory.delete(otherId);
        }
      }
    }

    return { totalHits: hits, resetTime };
  }

  async increment(key) {
    const start = this.windowStart();
    const resetTime = new Date(start + this.windowMs);
    const id = this.documentId(key, start);

    if (this.unavailable()) {
      return this.memoryIncrement(id, resetTime, 1);
    }

    try {
      const doc = await this.bump(id, resetTime, 1);
      return { totalHits: doc.hits, resetTime };
    } catch (error) {
      logger.error('Rate limit increment failed; counting in memory', { error: error.message });
      return this.memoryIncrement(id, resetTime, 1);
    }
  }

  /**
   * Two requests arriving together can both find no document and both try to
   * insert one; the loser gets a duplicate-key error. Retrying once is enough,
   * because by then the document exists and the update is an ordinary $inc.
   */
  async bump(id, resetTime, delta) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await RateLimitCounter.findOneAndUpdate(
          { _id: id },
          { $inc: { hits: delta }, $setOnInsert: { expiresAt: resetTime } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
      } catch (error) {
        if (error.code !== 11000 || attempt === 1) {
          throw error;
        }
      }
    }

    throw new Error('unreachable');
  }

  async decrement(key) {
    const start = this.windowStart();
    const resetTime = new Date(start + this.windowMs);
    const id = this.documentId(key, start);

    if (this.unavailable()) {
      this.memoryIncrement(id, resetTime, -1);
      return;
    }

    try {
      await RateLimitCounter.updateOne({ _id: id, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
    } catch (error) {
      logger.error('Rate limit decrement failed', { error: error.message });
    }
  }

  async get(key) {
    const start = this.windowStart();
    const id = this.documentId(key, start);

    if (this.unavailable()) {
      const entry = this.memory.get(id);
      return entry ? { totalHits: entry.hits, resetTime: entry.resetTime } : undefined;
    }

    const doc = await RateLimitCounter.findById(id).lean();
    return doc ? { totalHits: doc.hits, resetTime: new Date(start + this.windowMs) } : undefined;
  }

  /**
   * Clear one key's current window. Used by the "unblock this tenant" path and
   * by tests; there is no scheduled caller.
   */
  async resetKey(key) {
    const id = this.documentId(key, this.windowStart());
    this.memory.delete(id);

    if (this.unavailable()) {
      return;
    }

    await RateLimitCounter.deleteOne({ _id: id });
  }

  async resetAll() {
    this.memory.clear();

    if (this.unavailable()) {
      return;
    }

    await RateLimitCounter.deleteMany({ _id: new RegExp(`^${escapeRegExp(this.prefix)}:`) });
  }
}

module.exports = MongoRateLimitStore;
