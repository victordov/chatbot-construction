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
 */

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
      actions: 0,
      apiRequestsPerMinute: 120
    },
    features: {
      workflows: true,
      knowledgeBase: true,
      aiSuggestions: false,
      analytics: 'basic',
      fileUploads: true,
      actions: false,
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
  operators: { label: 'Operator seats', usageKey: 'operators', resets: 'never' },
  knowledgeChunks: { label: 'Knowledge chunks', usageKey: 'knowledgeChunks', resets: 'never' },
  workflows: { label: 'Workflows', usageKey: 'workflows', resets: 'never' },
  // Saved actions (models/action.js), counted live like workflows. A plan
  // without the `actions` feature has a limit of 0 as well, so the meter and
  // the feature flag cannot disagree about whether a tenant may create one.
  actions: { label: 'Actions', usageKey: 'actions', resets: 'never' }
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

module.exports = {
  PLANS,
  METERS,
  DEFAULT_PLAN,
  getPlan,
  listPlans,
  limitFor,
  hasFeature
};
