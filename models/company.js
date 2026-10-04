const mongoose = require('mongoose');
const crypto = require('crypto');
const { WIDGET_LANGUAGE_SETTINGS } = require('../config/widget-languages');

const CompanySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  /**
   * Public identifier embedded in the widget snippet. This is what ties an
   * incoming chat to a tenant - without it, conversations have no company and
   * company admins see an empty dashboard.
   */
  widgetKey: {
    type: String,
    unique: true,
    index: true
  },
  /**
   * Origins allowed to embed this company's widget, e.g. `https://acme.com`.
   * Used both for tenant resolution and per-tenant CORS.
   */
  allowedDomains: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  /**
   * Secret used to verify identities the tenant vouches for.
   *
   * The tenant computes HMAC-SHA256(identitySecret, theirUserId) server-side
   * and passes it to the widget. Without this, a visitor could claim to be any
   * user id and read that person's history, so it is what makes showing
   * account data in chat safe. Never sent to the browser.
   */
  identitySecret: {
    type: String,
    select: false
  },

  /**
   * Who this company's assistant is, for tenants who have not built a workflow
   * yet. A workflow's Persona node takes precedence when one exists.
   *
   * `scope` is optional. Leaving it empty means the assistant answers anything;
   * setting it makes the assistant decline questions outside that remit.
   */
  assistant: {
    persona: { type: String, trim: true },
    scope: { type: String, trim: true }
  },

  /**
   * Email channel.
   *
   * `inboundAddress` is where customers write. `inboundSecret` authenticates
   * the provider webhook - without it anyone who found the URL could inject
   * messages into this tenant's queue.
   */
  emailChannel: {
    enabled: { type: Boolean, default: false },
    inboundAddress: { type: String, trim: true, lowercase: true },
    fromName: { type: String, trim: true },
    fromAddress: { type: String, trim: true, lowercase: true },
    inboundSecret: { type: String, select: false },
    /** Appended to every outbound reply. */
    signature: { type: String, trim: true }
  },

  /**
   * When operators are actually available.
   *
   * Without this the widget always implies someone is about to answer, which
   * is the wrong promise at 3am. Outside these hours the widget collects
   * contact details instead of leaving the visitor waiting.
   *
   * `days` is indexed 0-6 with 0 = Sunday, matching JS `Date#getDay`.
   * An empty `days` array means always open, which is the default.
   */
  businessHours: {
    enabled: { type: Boolean, default: false },
    /** IANA zone, e.g. "Europe/London". The company's local time, not the server's. */
    timezone: { type: String, default: 'UTC' },
    days: [{
      day: { type: Number, min: 0, max: 6 },
      // Minutes from midnight, so comparisons need no date parsing.
      opensAt: { type: Number, min: 0, max: 1440 },
      closesAt: { type: Number, min: 0, max: 1440 },
      closed: { type: Boolean, default: false }
    }],
    offlineMessage: {
      type: String,
      trim: true,
      default: 'We are closed right now. Leave your details and we will get back to you.'
    }
  },

  /**
   * The tenant's own systems, reachable through the connector SDK.
   *
   * One URL where they have mounted the SDK handler, and the secret we sign
   * calls with so their connector can prove the request is ours. `capabilities`
   * is what discovery found they implement — cached so a conversation does not
   * pay for a discovery round trip, and refreshed when they ask us to re-check.
   */
  connector: {
    enabled: { type: Boolean, default: false },
    url: { type: String, trim: true },
    // Never needed for a listing, and a field you have to ask for is a field
    // that does not leak by accident. Encrypted at rest.
    secret: { type: String, select: false },
    capabilities: [{ type: String }],
    sdkVersion: { type: String },
    lastCheckedAt: { type: Date },
    lastError: { type: String }
  },

  /**
   * How conversations reach an operator.
   *
   * Without this a queue is a free-for-all: whoever is watching picks up what
   * they fancy, the same person takes everything, and the visitor nobody
   * fancied waits indefinitely.
   */
  routing: {
    /** Off by default. Turning it on changes who answers, which is a decision. */
    autoAssign: { type: Boolean, default: false },
    /**
     * How many conversations one operator can hold at once.
     *
     * The cap is the point: an operator juggling nine chats is answering none
     * of them well, and a queue that keeps assigning is just hiding the fact
     * that the team is under water.
     */
    maxConcurrent: { type: Number, default: 3, min: 1, max: 20 },
    /**
     * Assign a conversation the moment it starts, rather than when the visitor
     * asks for a person. Suits teams with no bot in front.
     */
    assignOnStart: { type: Boolean, default: false }
  },

  /**
   * How long this company keeps its conversations.
   *
   * Retention used to be one number for the whole platform, which is fine
   * until a tenant is subject to a policy of their own - and a tenant who has
   * promised their customers ninety days cannot honour that on someone else's
   * schedule. Both fields are days since a conversation's last activity:
   *
   *   a positive number - act after that many days
   *   0                 - never (an explicit choice, not an oversight)
   *   unset             - fall back to the platform default
   *
   * Anonymising first and deleting later is the usual shape: the transcript
   * stops being personal data long before the row is dropped, so reporting
   * still has a history to draw on.
   */
  dataRetention: {
    anonymizeAfterDays: { type: Number, min: 0 },
    deleteAfterDays: { type: Number, min: 0 },
    /** Who last changed this, for the audit trail's benefit. */
    updatedAt: { type: Date },
    updatedBy: { type: String }
  },

  /**
   * Tenant-specific widget branding, surfaced to the widget at bootstrap.
   */
  widgetSettings: {
    chatbotName: { type: String, trim: true, default: 'Assistant' },
    primaryColor: { type: String, trim: true, default: '#2196f3' },
    position: { type: String, enum: ['left', 'right'], default: 'right' },
    welcomeMessage: { type: String, trim: true, default: 'Hi! How can we help you today?' },
    // Shown in the widget header as the assistant's avatar. https only,
    // checked by routes/company.js; optional.
    logoUrl: { type: String, trim: true },
    // Which language the widget speaks to visitors. `auto` follows the
    // visitor's browser; a `data-language` attribute on the snippet wins
    // over both. See config/widget-languages.js.
    language: { type: String, enum: WIDGET_LANGUAGE_SETTINGS, default: 'auto' },
    // Pre-chat form: which contact details a visitor must give before
    // chatting. Phone is optional by default; asking for it up front costs
    // more conversations than it is worth for most tenants.
    requireName: { type: Boolean, default: true },
    requireEmail: { type: Boolean, default: true },
    requirePhone: { type: Boolean, default: false },
    // Linked from the pre-chat form; defaults to this server's own policy page.
    privacyPolicyUrl: { type: String, trim: true }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

CompanySchema.index({ allowedDomains: 1 });

/**
 * Generate a widget key for companies that do not have one yet, including
 * companies created before this field existed.
 */
CompanySchema.pre('save', function(next) {
  if (!this.widgetKey) {
    this.widgetKey = 'wk_' + crypto.randomBytes(16).toString('hex');
  }
  // Minted on first save so identity verification can be switched on without
  // a migration, and so it never has to be generated on a hot path.
  if (!this.identitySecret) {
    this.identitySecret = crypto.randomBytes(32).toString('hex');
  }
  if (this.emailChannel && this.emailChannel.enabled && !this.emailChannel.inboundSecret) {
    this.emailChannel.inboundSecret = crypto.randomBytes(24).toString('hex');
  }
  next();
});

CompanySchema.methods.rotateWidgetKey = function() {
  this.widgetKey = 'wk_' + crypto.randomBytes(16).toString('hex');
  return this.widgetKey;
};

CompanySchema.methods.rotateIdentitySecret = function() {
  this.identitySecret = crypto.randomBytes(32).toString('hex');
  return this.identitySecret;
};

const Company = mongoose.model('Company', CompanySchema);

module.exports = Company;
