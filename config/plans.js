/**
 * Subscription plans.
 *
 * Defined in code rather than the database on purpose: limits and feature
 * flags are read on nearly every request, and a plan definition changing under
 * a running process is a source of confusing behaviour. A company's *choice*
 * of plan lives in the database (models/subscription.js); what that plan means
 * lives here.
 *
 * `null` for a limit means unlimited.
 *
 * Prices are placeholders until the owner decides them, so every price that
 * is new with agencies and per-resolution billing reads from the environment
 * (see `PRICING_ENV` below), with the figure here only as the fallback. They
 * are read once, at start-up, for the same reason the rest of this file is
 * code: a price changing under a running process is a confusing thing to
 * debug.
 */

/** A non-negative number from the environment, or the fallback. */
function envAmount(name, fallback) {
  const value = parseFloat(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A non-negative whole number from the environment, or the fallback. */
function envCount(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The environment keys behind every placeholder price, for the report the
 * integrator writes and for anyone wondering where a figure on the billing
 * screen came from.
 */
const PRICING_ENV = {
  agencyPrice: 'PLAN_AGENCY_PRICE',
  agencyClientsIncluded: 'PLAN_AGENCY_CLIENTS_INCLUDED',
  agencyClientPrice: 'PLAN_AGENCY_CLIENT_PRICE',
  agencyClientLimit: 'PLAN_AGENCY_CLIENT_LIMIT',
  agencyClientPlan: 'PLAN_AGENCY_CLIENT_PLAN',
  perResolution: 'PRICE_PER_RESOLUTION',
  includedResolutions: 'PRICE_INCLUDED_RESOLUTIONS',
  perResolutionBase: 'PRICE_PER_RESOLUTION_BASE'
};

const PLANS = {
  trial: {
    id: 'trial',
    name: 'Trial',
    price: 0,
    interval: 'month',
    description: '14 days to try everything.',
    trialDays: 14,
    limits: {
      conversationsPerMonth: 100,
      aiResponsesPerMonth: 500,
      operators: 2,
      knowledgeChunks: 500,
      workflows: 1,
      actions: 5,
      apiRequestsPerMinute: 60
    },
    features: {
      // WhatsApp, Messenger and Instagram in the inbox.
      channels: true,
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: true,
      analytics: 'basic',
      fileUploads: true,
      actions: true,
      apiAccess: false,
      customBranding: false,
      prioritySupport: false
    }
  },

  basic: {
    id: 'basic',
    name: 'Basic',
    price: 29,
    interval: 'month',
    description: 'A single operator and the essentials.',
    limits: {
      conversationsPerMonth: 500,
      aiResponsesPerMonth: 2000,
      operators: 1,
      knowledgeChunks: 2000,
      workflows: 1,
      // The trial teaches people to rely on a few actions and on suggested
      // replies; taking both away on the first paid plan reads as a downgrade
      // for paying, so Basic keeps a small allowance of each.
      actions: 3,
      apiRequestsPerMinute: 120
    },
    features: {
      channels: false,
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: true,
      analytics: 'basic',
      fileUploads: true,
      actions: true,
      apiAccess: false,
      customBranding: false,
      prioritySupport: false
    }
  },

  professional: {
    id: 'professional',
    name: 'Professional',
    price: 99,
    interval: 'month',
    description: 'A full team, AI assistance and deeper analytics.',
    /**
     * How the plan can be paid for. Flat is the default and what every
     * existing tenant stays on; per resolution is an option a tenant chooses
     * at checkout (or a superadmin sets), and is billed for conversations the
     * bot resolved by the published definition (services/resolutions.js),
     * never beyond the monthly cap the tenant sets.
     *
     * `baseFee` is what the per-resolution option costs before any
     * resolution; `includedResolutions` are free each month on top of it.
     */
    pricing: {
      model: 'flat',
      options: ['flat', 'per_resolution'],
      perResolution: envAmount(PRICING_ENV.perResolution, 0.49),
      includedResolutions: envCount(PRICING_ENV.includedResolutions, 0),
      baseFee: envAmount(PRICING_ENV.perResolutionBase, 49)
    },
    limits: {
      conversationsPerMonth: 5000,
      aiResponsesPerMonth: 25000,
      operators: 10,
      knowledgeChunks: 25000,
      workflows: 10,
      actions: 25,
      apiRequestsPerMinute: 600
    },
    features: {
      channels: true,
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: true,
      analytics: 'advanced',
      fileUploads: true,
      actions: true,
      apiAccess: true,
      // White-label is for agencies (and Enterprise). It was on this card
      // before anything implemented it; now that it means something, it
      // means the agency plan.
      customBranding: false,
      prioritySupport: false
    }
  },

  /**
   * For a business that runs support desks for its own clients: everything
   * Professional has for the agency's own account, its own brand on its
   * clients' dashboards and mail, and a number of client companies in the
   * price. Each client beyond that is an add-on.
   *
   * A company only becomes an agency when a superadmin marks it as one;
   * buying this plan does not, so the plan is only offered to companies that
   * already are.
   */
  agency: {
    id: 'agency',
    name: 'Agency',
    price: envAmount(PRICING_ENV.agencyPrice, 299),
    interval: 'month',
    description: 'Run your clients\' support desks under your own brand.',
    agency: {
      clientsIncluded: envCount(PRICING_ENV.agencyClientsIncluded, 10),
      perClientPrice: envAmount(PRICING_ENV.agencyClientPrice, 19),
      // The plan an agency's clients are put on when the agency pays for
      // them, rather than leaving them on a trial.
      clientPlan: process.env[PRICING_ENV.agencyClientPlan] || 'professional'
    },
    limits: {
      conversationsPerMonth: 5000,
      aiResponsesPerMonth: 25000,
      operators: 10,
      knowledgeChunks: 25000,
      workflows: 10,
      actions: 25,
      apiRequestsPerMinute: 600
    },
    features: {
      channels: true,
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: true,
      analytics: 'advanced',
      fileUploads: true,
      actions: true,
      apiAccess: true,
      customBranding: true,
      prioritySupport: false
    }
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: null, // negotiated
    interval: 'month',
    description: 'Unlimited usage, priority support.',
    limits: {
      conversationsPerMonth: null,
      aiResponsesPerMonth: null,
      operators: null,
      knowledgeChunks: null,
      workflows: null,
      actions: null,
      apiRequestsPerMinute: 3000
    },
    features: {
      channels: true,
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: true,
      analytics: 'advanced',
      fileUploads: true,
      actions: true,
      apiAccess: true,
      customBranding: true,
      prioritySupport: true
    }
  }
};

const DEFAULT_PLAN = 'trial';

/**
 * Human-readable names for the metered quantities, used in limit messages and
 * the usage dashboard.
 *
 * `apiRequestsPerMinute` is deliberately absent: it is a limit but not a
 * meter, enforced per minute by middleware/rateLimiter.js rather than tallied
 * for the month, so it has nothing to show on the usage screen. Like every
 * other limit it can still be overridden per company on the subscription.
 */
const METERS = {
  conversationsPerMonth: { label: 'Conversations', usageKey: 'conversations', resets: 'monthly' },
  aiResponsesPerMonth: { label: 'AI responses', usageKey: 'aiResponses', resets: 'monthly' },
  // Seats are operators: admins run the account and are not counted, which
  // was the September decision. An invited operator holds a seat from the
  // moment the invitation goes out, or a plan could be overfilled by inviting.
  operators: { label: 'Operator seats', usageKey: 'operators', resets: 'never' },
  knowledgeChunks: { label: 'Knowledge chunks', usageKey: 'knowledgeChunks', resets: 'never' },
  // Live workflows only: drafts cost nothing until they answer anybody.
  workflows: { label: 'Live workflows', usageKey: 'workflows', resets: 'never' },
  // Saved actions (models/action.js), counted live like workflows. A plan
  // without the `actions` feature has a limit of 0 as well, so the meter and
  // the feature flag cannot disagree about whether a tenant may create one.
  actions: { label: 'Actions', usageKey: 'actions', resets: 'never' },
  // Money rather than a count: what this month's resolutions cost against
  // the monthly cap the tenant set. Only a per-resolution tenant with a cap
  // has a limit here, so for everyone else it is not a meter at all; its
  // reason to exist is that usage-alerts.js warns at 80% and 100% of any
  // meter, and a cap deserves exactly that warning.
  resolutionSpend: { label: 'Resolution spending cap', usageKey: 'resolutionSpend', resets: 'monthly', money: true }
};

function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN];
}

function listPlans() {
  return Object.values(PLANS);
}

/**
 * The limit for one meter under one plan. `null` means unlimited.
 */
function limitFor(planId, meter) {
  const plan = getPlan(planId);
  const value = plan.limits[meter];
  return value === undefined ? null : value;
}

/**
 * Whether a plan includes a feature. `analytics` returns a tier string rather
 * than a boolean, so callers compare it explicitly.
 */
function hasFeature(planId, feature) {
  return Boolean(getPlan(planId).features[feature]);
}

/**
 * The per-resolution terms a plan offers, or null when it offers none.
 */
function resolutionPricing(planId) {
  const plan = getPlan(planId);
  return plan.pricing && plan.pricing.options.includes('per_resolution') ? plan.pricing : null;
}

/** What the agency plan includes and charges per client. */
function agencyTerms() {
  return PLANS.agency.agency;
}

/**
 * The most clients one agency may hold unless a superadmin set its own
 * limit: a ceiling against a runaway script, not a price.
 */
function defaultClientLimit() {
  return envCount(PRICING_ENV.agencyClientLimit, 50);
}

module.exports = {
  PLANS,
  METERS,
  DEFAULT_PLAN,
  PRICING_ENV,
  getPlan,
  listPlans,
  limitFor,
  hasFeature,
  resolutionPricing,
  agencyTerms,
  defaultClientLimit
};
