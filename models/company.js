const mongoose = require('mongoose');
const crypto = require('crypto');

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
   * Tenant-specific widget branding, surfaced to the widget at bootstrap.
   */
  widgetSettings: {
    chatbotName: { type: String, trim: true, default: 'Assistant' },
    primaryColor: { type: String, trim: true, default: '#2196f3' },
    position: { type: String, enum: ['left', 'right'], default: 'right' },
    welcomeMessage: { type: String, trim: true, default: 'Hi! How can we help you today?' },
    logoUrl: { type: String, trim: true }
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
  next();
});

CompanySchema.methods.rotateWidgetKey = function() {
  this.widgetKey = 'wk_' + crypto.randomBytes(16).toString('hex');
  return this.widgetKey;
};

const Company = mongoose.model('Company', CompanySchema);

module.exports = Company;
