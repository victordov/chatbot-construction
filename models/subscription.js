const mongoose = require('mongoose');
const { DEFAULT_PLAN, getPlan } = require('../config/plans');

/**
 * A company's plan.
 *
 * Separate from the Company document because it changes on a different rhythm
 * (upgrades, downgrades, trial expiry, payment state) and because billing
 * history should not be entangled with widget settings.
 *
 * There is deliberately no payment-processor state here beyond an opaque
 * `externalCustomerId` / `externalSubscriptionId`. Whichever processor is
 * chosen owns the money; this owns what the tenant is allowed to do.
 */
const SubscriptionSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  planId: {
    type: String,
    default: DEFAULT_PLAN
  },
  status: {
    type: String,
    enum: ['trialing', 'active', 'past_due', 'cancelled', 'suspended'],
    default: 'trialing'
  },
  /**
   * When the current billing period ends. Monthly usage counters are keyed by
   * calendar month rather than by this date, so a mid-month plan change does
   * not reset a tenant's usage.
   */
  currentPeriodEnd: {
    type: Date
  },
  trialEndsAt: {
    type: Date
  },
  /**
   * Per-company limit overrides, for negotiated deals. Only keys present here
   * override the plan; everything else falls back to the plan definition.
   */
  limitOverrides: {
    type: Map,
    of: Number
  },
  /**
   * Set by a superadmin to let a tenant exceed their plan temporarily rather
   * than having a support conversation blocked at 2am.
   */
  overageAllowed: {
    type: Boolean,
    default: false
  },
  externalCustomerId: { type: String },
  externalSubscriptionId: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

SubscriptionSchema.pre('save', function(next) {
  this.updatedAt = new Date();

  // Start the trial clock the first time a trialing subscription is saved.
  if (this.isNew && this.status === 'trialing' && !this.trialEndsAt) {
    const days = getPlan(this.planId).trialDays || 14;
    this.trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  next();
});

/**
 * The effective limit for a meter: an override if one exists, otherwise the
 * plan's. `null` means unlimited.
 */
SubscriptionSchema.methods.limitFor = function(meter) {
  if (this.limitOverrides && this.limitOverrides.has(meter)) {
    const override = this.limitOverrides.get(meter);
    // A negative override is the conventional way to say "unlimited" when the
    // storage type cannot hold null.
    return override < 0 ? null : override;
  }

  const value = getPlan(this.planId).limits[meter];
  return value === undefined ? null : value;
};

SubscriptionSchema.methods.hasFeature = function(feature) {
  return Boolean(getPlan(this.planId).features[feature]);
};

/**
 * Whether this subscription currently entitles the tenant to service.
 *
 * `past_due` deliberately still counts: cutting off a support desk the moment
 * a card fails punishes the tenant's customers, not the tenant. Suspension is
 * an explicit action.
 */
SubscriptionSchema.methods.isEntitled = function() {
  if (this.status === 'cancelled' || this.status === 'suspended') {
    return false;
  }
  if (this.status === 'trialing' && this.trialEndsAt && this.trialEndsAt < new Date()) {
    return false;
  }
  return true;
};

/**
 * Fetch a company's subscription, creating a default one on first use so that
 * an existing tenant does not need a migration to acquire a plan.
 */
SubscriptionSchema.statics.forCompany = async function(companyId) {
  let subscription = await this.findOne({ company: companyId });

  if (!subscription) {
    subscription = await this.create({ company: companyId });
  }

  return subscription;
};

const Subscription = mongoose.model('Subscription', SubscriptionSchema);

module.exports = Subscription;
