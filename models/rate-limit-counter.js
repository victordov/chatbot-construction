const mongoose = require('mongoose');

/**
 * One rate-limit bucket.
 *
 * Rate limiting used to live in each process's memory, which meant the limits
 * multiplied by the number of instances: three replicas behind a load balancer
 * enforced "5 login attempts per hour" as fifteen. Counting in MongoDB - which
 * every instance already talks to - makes a limit mean the same thing however
 * many processes are serving.
 *
 * `_id` is `<prefix>:<key>:<windowStart>`, so a new fixed window is a new
 * document rather than a mutation of the old one. Correctness therefore comes
 * from the window in the id, not from the TTL sweep: Mongo removes expired
 * documents on its own schedule (up to a minute late) and a straggler is never
 * read, because the id no longer matches the current window.
 */
const RateLimitCounterSchema = new mongoose.Schema({
  _id: { type: String },
  hits: { type: Number, default: 0 },
  /** Reaped by MongoDB once this passes. Housekeeping only - see above. */
  expiresAt: { type: Date, required: true, expires: 0 }
}, { versionKey: false, _id: false });

module.exports = mongoose.models.RateLimitCounter
  || mongoose.model('RateLimitCounter', RateLimitCounterSchema);
