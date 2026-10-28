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
    signature: { type: String, trim: true },
    /**
     * When the inbound webhook last accepted a message. The settings screen
     * shows it, because "is my forwarding set up?" is otherwise a question
     * nobody can answer without sending themselves an email and waiting.
     */
    lastInboundAt: { type: Date }
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
    },
    /**
     * Whole days off - bank holidays, a training day - as `YYYY-MM-DD` in the
     * company's own timezone. Closed all day whatever the weekly schedule says.
     */
    closedDates: [{
      _id: false,
      date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      label: { type: String, trim: true, maxlength: 80 }
    }]
  },

  /**
   * How Reports values the bot's work. A person answering one of these
   * conversations would have spent this many minutes on it; the value report
   * turns resolved conversations into hours with it.
   */
  reports: {
    minutesPerConversation: { type: Number, min: 1, max: 240 }
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
    assignOnStart: { type: Boolean, default: false },
    /**
     * Minutes somebody may wait for a person before the team is alerted
     * again, louder: a notification to every admin and to whoever is taking
     * chats. 0 turns it off. Five minutes is long in a chat window.
     */
    escalateAfterMinutes: { type: Number, default: 5, min: 0, max: 240 }
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
    // chatting. Off by default: a form in front of the first answer loses
    // more conversations than it gains. The widget asks for an email when it
    // hands over instead, which is when an address is actually needed.
    requireName: { type: Boolean, default: false },
    requireEmail: { type: Boolean, default: false },
    requirePhone: { type: Boolean, default: false },
    // Linked from the pre-chat form and the consent line. The tenant is the
    // data controller, so this should be their policy, not ours.
    privacyPolicyUrl: { type: String, trim: true },
    // Up to four questions shown as buttons when the chat opens.
    suggestedQuestions: [{ type: String, trim: true, maxlength: 120 }],
    // Ask the visitor to agree before the first message is stored.
    consentRequired: { type: Boolean, default: false },
    consentText: { type: String, trim: true, maxlength: 300 },
    // A short note above the launcher after a delay, on the pages whose
    // path contains `pathContains` (all pages when empty). Shown once per
    // visit and dismissible; validated by routes/company.js.
    proactive: {
      enabled: { type: Boolean, default: false },
      text: { type: String, trim: true, maxlength: 200 },
      delaySeconds: { type: Number, min: 5, max: 120, default: 20 },
      pathContains: { type: String, trim: true, maxlength: 200 }
    }
  },
  /**
   * Where and when the widget was last loaded from a real page. Lets the
   * dashboard say "seen on bloomdental.com 4 minutes ago" instead of assuming
   * it is installed because a conversation exists.
   */
  widgetSeen: {
    at: { type: Date },
    origin: { type: String },
    origins: [{ type: String }]
  },
  /**
   * Which usage warnings have gone out this billing period, so an owner gets
   * one email at 80% and one at 100% per meter rather than one per request.
   */
  usageAlerts: {
    period: { type: String },
    warned80: [{ type: String }],
    warned100: [{ type: String }]
  },
  /** Setup progress that is not visible from the data alone. */
  onboarding: {
    botTestedAt: { type: Date }
  },
  // ---- P2F: agencies and white-label ----
  /**
   * Agencies set up and run support desks for their own clients.
   *
   * `isAgency` is switched on by a superadmin, never by the company itself.
   * `parent` is set on a client: the agency that manages it, whose admins may
   * open its dashboard and whose brand it wears. `clientLimit` caps how many
   * clients one agency may hold (unset: the platform default).
   */
  agency: {
    isAgency: { type: Boolean, default: false },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    clientLimit: { type: Number, min: 0 },
    /** When this company became the parent's client, for the agency's list. */
    attachedAt: { type: Date },
    /** The last agency it left, so a superadmin can see where it came from. */
    detachedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    detachedAt: { type: Date }
  },
  /**
   * An agency's own brand, shown instead of the product's on its clients'
   * dashboards, sign-in pages reached from their invitations, and the mail
   * the platform sends them. Needs the `customBranding` plan feature. The
   * widget carries no product brand at all, so it has nothing to replace.
   */
  branding: {
    productName: { type: String, trim: true, maxlength: 60 },
    // https only, checked by routes/agency.js.
    logoUrl: { type: String, trim: true },
    primaryColor: { type: String, trim: true },
    supportEmail: { type: String, trim: true, lowercase: true }
  },
  /** How the company came to exist: created by us, or signed up itself. */
  createdVia: {
    type: String,
    enum: ['superadmin', 'signup'],
    default: 'superadmin'
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
