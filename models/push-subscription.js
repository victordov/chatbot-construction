const mongoose = require('mongoose');

/**
 * One browser or installed app that receives a person's push notifications.
 *
 * A receptionist is not at a desk, and a customer waiting for a person has to
 * reach their phone; this is the address of that phone. The browser hands us
 * an endpoint on its maker's push service (Google, Apple, Mozilla, Microsoft)
 * and two keys the payload is encrypted with, so the push service carries a
 * notification it cannot read.
 *
 * A device belongs to whoever last signed in on it. Each record remembers the
 * session that registered it - the token's id and the user's token version -
 * so signing out of that browser, or out of every device at once, also stops
 * its notifications: a lost phone must not go on showing who is waiting.
 */
const PushSubscriptionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  /** Kept so a tenant's devices can be found when the tenant is removed. */
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    index: true
  },
  /** Where the push service accepts messages for this device. Unique per browser. */
  endpoint: {
    type: String,
    required: true,
    unique: true
  },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  /**
   * The server key the browser subscribed with. A subscription only accepts
   * messages signed by the key it was made for, so after the deployment's
   * VAPID keys change, the old ones are dead and are removed rather than
   * failing on every send.
   */
  vapidKey: {
    type: String
  },
  /** "Chrome on Android", so the person can tell their devices apart. */
  label: {
    type: String,
    trim: true,
    maxlength: 80
  },
  /**
   * What this device is told about, matching the dashboard's own setting:
   * everything, only when the person is needed (a handoff, a chat assigned or
   * transferred to them), or nothing.
   */
  level: {
    type: String,
    enum: ['all', 'important', 'none'],
    default: 'all'
  },
  /**
   * Whether notifications include a preview of what the visitor wrote. Off
   * unless the person turns it on: the text passes through the push service
   * and shows on a lock screen, and a visitor's name is enough to act on.
   */
  previews: {
    type: Boolean,
    default: false
  },
  /** The session that registered or last refreshed this device. */
  jti: { type: String },
  tokenVersion: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  /** When the dashboard was last opened on this device. */
  lastSeenAt: { type: Date, default: Date.now },
  lastSentAt: { type: Date }
});

/** What the person's device list shows: never the endpoint or the keys. */
PushSubscriptionSchema.methods.toPublic = function() {
  return {
    id: String(this._id),
    label: this.label || 'A browser',
    level: this.level,
    previews: Boolean(this.previews),
    createdAt: this.createdAt,
    lastSeenAt: this.lastSeenAt,
    lastSentAt: this.lastSentAt || null
  };
};

const PushSubscription = mongoose.models.PushSubscription ||
  mongoose.model('PushSubscription', PushSubscriptionSchema);

module.exports = PushSubscription;
