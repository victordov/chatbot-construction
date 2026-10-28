const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * A tenant's WhatsApp number, Facebook Page or Instagram account, connected so
 * that its messages land in the same inbox and are answered by the same bot as
 * the website widget.
 *
 * One per provider per company. The Messenger and Instagram documents are
 * written together by one settings screen - an Instagram professional account
 * is reached through the Facebook Page it is linked to, with that Page's token
 * - but they are separate rows because they are separate inboxes on Meta's
 * side, with separate ids in every webhook.
 *
 * The provider's id for the account (`phoneNumberId`, `pageId`, `igUserId`) is
 * what an incoming webhook names, so each is unique across every tenant: two
 * companies claiming one number would leave nobody able to say whose queue a
 * message belongs to.
 */

const PROVIDERS = ['whatsapp', 'messenger', 'instagram'];

/** How an approved WhatsApp template takes the customer's name. */
const TEMPLATE_PARAMS = ['positional', 'named', 'none'];

const ChannelAccountSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  provider: {
    type: String,
    enum: PROVIDERS,
    required: true
  },
  enabled: {
    type: Boolean,
    default: true
  },

  // WhatsApp Cloud API: the business phone number's id (not the number
  // itself), and the WhatsApp Business Account it belongs to.
  phoneNumberId: { type: String, trim: true },
  wabaId: { type: String, trim: true },
  /** The number as customers see it, for the settings screen. */
  displayPhoneNumber: { type: String, trim: true },

  // Messenger, and Instagram through the Page it is linked to.
  pageId: { type: String, trim: true },
  /** The Instagram professional account id webhooks name as `entry[].id`. */
  igUserId: { type: String, trim: true },

  /** What the dashboard calls this account: "Acme on WhatsApp". */
  displayName: { type: String, trim: true, maxlength: 120 },

  /**
   * The WhatsApp system-user token, or the Page access token. Encrypted at
   * rest by services/secrets.js and never selected unless asked for: it can
   * send messages as the business to anybody who has written to it.
   */
  accessToken: { type: String, select: false },
  /**
   * The Meta app's secret, which signs every webhook (`X-Hub-Signature-256`).
   * Encrypted at rest, like the token.
   */
  appSecret: { type: String, select: false },
  /**
   * What Meta echoes back when the webhook is first subscribed. Generated
   * here, shown to the admin to paste into Meta, and only good for that
   * handshake - which is why it is kept readable rather than hashed.
   */
  verifyToken: { type: String, select: false },

  /**
   * WhatsApp: the approved template an operator may send once the 24-hour
   * customer service window has closed, with the customer's name as its one
   * parameter - `{{1}}`, a named parameter, or none at all.
   */
  template: {
    name: { type: String, trim: true, maxlength: 512 },
    language: { type: String, trim: true, maxlength: 15 },
    param: { type: String, enum: TEMPLATE_PARAMS, default: 'positional' },
    paramName: { type: String, trim: true, maxlength: 60 }
  },
  /**
   * Messenger and Instagram: the Meta app has been approved for the Human
   * Agent permission, so an operator may answer up to seven days after the
   * customer last wrote rather than twenty-four hours. Meta refuses the tag
   * from an app without it, so this is the admin saying it was granted.
   */
  humanAgentTag: { type: Boolean, default: false },

  /**
   * Where the connection stands, as the settings screen shows it: `pending`
   * until Meta has verified the webhook or a message has arrived, `error`
   * after a send was refused (an expired token, most often).
   */
  status: {
    type: String,
    enum: ['pending', 'connected', 'error', 'disabled'],
    default: 'pending'
  },
  webhookVerifiedAt: { type: Date },
  lastInboundAt: { type: Date },
  lastError: {
    message: { type: String, maxlength: 500 },
    at: { type: Date }
  }
}, { timestamps: true });

ChannelAccountSchema.index({ company: 1, provider: 1 }, { unique: true });
// Partial rather than sparse: the field is absent on the other providers'
// rows, and only a present value needs to be unique.
ChannelAccountSchema.index(
  { provider: 1, phoneNumberId: 1 },
  { unique: true, partialFilterExpression: { phoneNumberId: { $type: 'string' } } }
);
ChannelAccountSchema.index(
  { provider: 1, pageId: 1 },
  { unique: true, partialFilterExpression: { pageId: { $type: 'string' } } }
);
ChannelAccountSchema.index(
  { provider: 1, igUserId: 1 },
  { unique: true, partialFilterExpression: { igUserId: { $type: 'string' } } }
);
ChannelAccountSchema.index({ verifyToken: 1 });

/** A fresh verify token: long enough not to be guessed, plain enough to paste. */
ChannelAccountSchema.statics.newVerifyToken = function() {
  return crypto.randomBytes(24).toString('hex');
};

/** The provider's id for this account, whichever field holds it. */
ChannelAccountSchema.methods.externalKey = function() {
  if (this.provider === 'whatsapp') {
    return this.phoneNumberId;
  }
  return this.provider === 'instagram' ? this.igUserId : this.pageId;
};

const ChannelAccount = mongoose.model('ChannelAccount', ChannelAccountSchema);

module.exports = ChannelAccount;
module.exports.PROVIDERS = PROVIDERS;
module.exports.TEMPLATE_PARAMS = TEMPLATE_PARAMS;
