const mongoose = require('mongoose');
const { DEFAULT_PLAN, getPlan } = require('../config/plans');

/**
 * How long a new tenant's trial lasts. Read from the environment so a
 * deployment can be more or less generous without a code change; the plan
 * table's `trialDays` is the fallback, and 14 the fallback for that.
 */
function trialDays() {
  const fromEnv = parseInt(process.env.TRIAL_DAYS, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return getPlan(DEFAULT_PLAN).trialDays || 14;
}

function trialEnd() {
  return new Date(Date.now() + trialDays() * 24 * 60 * 60 * 1000);
}

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
  /**
   * When the trial runs out. Set the moment the subscription is created
   * rather than the first time something saves it: a tenant who signed up
   * and was never touched again used to have no trial end at all, which
   * meant a trial that never expired.
   */
  trialEndsAt: {
    type: Date,
    default: trialEnd
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
  /**
   * How the plan is paid for: a flat monthly price (everyone's default), or
   * a base fee plus each conversation the bot resolved. Only a plan whose
   * `pricing.options` include it can be per resolution (config/plans.js).
   */
  pricingModel: {
    type: String,
    enum: ['flat', 'per_resolution'],
    default: 'flat'
  },
  /**
   * The most a per-resolution tenant will pay for resolutions in one month,
   * in the plan's currency. Set by the tenant on Plan & billing. Past it,
   * resolutions stop being billed; the bot does not stop answering. Unset
   * means no cap.
   */
  spendCap: { type: Number, min: 0 },
  spendCapUpdatedAt: { type: Date },
  /**
   * The agency paying for this company's plan, when one is. A client an
   * agency put on its own client plan is not the client's to pay for, and
   * going back to a trial is what detaching from the agency means.
   */
  managedByAgency: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  externalCustomerId: { type: String, index: true },
  externalSubscriptionId: { type: String, index: true },
  /**
   * When the last processor event we acted on was raised.
   *
   * Processors retry, and retries arrive out of order. Without this, a
   * redelivered "payment failed" from Tuesday can land after Wednesday's
   * "payment succeeded" and suspend a tenant who is paid up.
   */
  externalEventAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

SubscriptionSchema.pre('save', function(next) {
  this.updatedAt = new Date();

  if (this.isNew && this.status !== 'trialing') {
    // Created straight onto a paid plan, so the default trial clock is
    // meaningless and would only confuse the dashboard.
    this.trialEndsAt = undefined;
  }

  next();
});

/**
 * Whether the trial, if there is one, has run out.
 */
SubscriptionSchema.methods.trialExpired = function() {
  return this.status === 'trialing' && Boolean(this.trialEndsAt) && this.trialEndsAt < new Date();
};

/**
 * The status as a person would describe it.
 *
 * The stored `status` stays `trialing` after the trial ends - nothing runs to
 * flip it, and a flag that has to be kept in step with a clock is a flag that
 * is eventually wrong. So anything that reports the status asks here instead.
 */
SubscriptionSchema.methods.effectiveStatus = function() {
  return this.trialExpired() ? 'trial_expired' : this.status;
};

/**
 * The effective limit for a meter: an override if one exists, otherwise the
 * plan's. `null` means unlimited.
 */
SubscriptionSchema.methods.limitFor = function(meter) {
  // The spending cap is the tenant's own limit, in money, and only means
  // anything while they pay per resolution.
  if (meter === 'resolutionSpend') {
    return this.pricingModel === 'per_resolution' && Number.isFinite(this.spendCap) ? this.spendCap : null;
  }

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
  if (this.trialExpired()) {
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
    try {
      subscription = await this.create({ company: companyId });
    } catch (error) {
      // Two first requests for a new tenant both found nothing and both
      // created; the unique index lets one win, and the other reads it.
      if (error && error.code === 11000) {
        return this.findOne({ company: companyId });
      }
      throw error;
    }
  }

  return subscription;
};

const Subscription = mongoose.model('Subscription', SubscriptionSchema);

module.exports = Subscription;
module.exports.trialDays = trialDays;
