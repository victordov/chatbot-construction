/**
 * Saved Actions: one definition of a call into the tenant's systems, used by
 * the assistant as a tool and by a workflow's action node by reference.
 *
 * The transport is not here. Every request still goes through
 * services/workflow-actions.js#execute, and from there services/safe-http.js,
 * so an Action gets exactly the SSRF guard, header filtering, JSON-safe body
 * templating, encrypted credential and timeout the Call an API node already
 * has. A second copy of any of that would be a second thing to forget to fix.
 *
 * What this file adds is the part a form-defined action needs and a node did
 * not: typed inputs with a source (visitor, verified contact, constant),
 * validation of what an admin typed, the shape returned to the dashboard
 * (never the credential), and the presets.
 */

const mongoose = require('mongoose');

const Action = require('../models/action');
const secrets = require('./secrets');
const workflowActions = require('./workflow-actions');

/**
 * The tool name the model sees, so it has to satisfy OpenAI's function-name
 * rule as well as ours. Lowercase so two actions cannot differ only by case.
 * `connector_` is reserved for the connector's own capabilities, which are
 * offered alongside actions under that prefix.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
const RESERVED_PREFIX = 'connector_';
const INPUT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;
const MAX_INPUTS = 12;
const MAX_OUTPUTS = 20;

const DEFAULT_MAX_BYTES = 4000;
// Generous enough for an order with its line items; small enough that one tool
// result cannot crowd the conversation out of the model's context.
const MAX_MAX_BYTES = 20000;

/**
 * Contact fields a `verified` input may read.
 *
 * Only `externalId` is signed by the tenant (services/contacts.js verifies an
 * HMAC of it). The others ride along with that signed call, so they are as
 * trustworthy as the tenant's own identify code — which is why they are read
 * only from a contact whose identity *is* verified, never from an anonymous or
 * merely claimed one.
 */
const VERIFIED_ATTRIBUTES = ['externalId', 'email', 'name', 'phone'];

// ---------------------------------------------------------------- validation

function text(value, max) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

/**
 * Check and clean what an admin submitted.
 *
 * `existing` is the stored action on an update: the submission is laid over
 * it, so a PUT that only flips `enabled` does not have to resend everything,
 * and — the important part — a blank credential means "keep the one I have",
 * because the dashboard never receives it and so can never send it back.
 *
 * @returns {{errors: string[], value: object}}
 */
function normalise(body = {}, existing = null) {
  const base = existing ? present(existing) : {};
  const input = { ...base, ...body };
  const request = { ...(base.request || {}), ...(body.request || {}) };
  const auth = { ...((base.request || {}).auth || {}), ...((body.request || {}).auth || {}) };
  const response = { ...(base.response || {}), ...(body.response || {}) };
  const errors = [];

  const name = text(input.name, 48).toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    errors.push('Name must be 2–48 characters: lowercase letters, digits and underscores, starting with a letter');
  } else if (name.startsWith(RESERVED_PREFIX)) {
    errors.push(`Names starting with "${RESERVED_PREFIX}" are reserved for your connector`);
  }

  const title = text(input.title, 120);
  if (!title) {
    errors.push('Give the action a title');
  }

  const method = text(request.method || 'GET', 10).toUpperCase();
  if (!workflowActions.ALLOWED_METHODS.has(method)) {
    errors.push(`${method} is not an allowed method`);
  }

  const url = text(request.url, 2000);
  if (!url) {
    errors.push('Enter the URL to call');
  } else {
    // Placeholders are filled at call time, so the template is checked with
    // them replaced — enough to catch a missing scheme or a private address.
    const check = workflowActions.validateUrl(url.replace(/\{\{\s*[\w.]+\s*\}\}/g, 'x'));
    if (!check.valid) {
      errors.push(check.error);
    }
  }

  const headers = {};
  const rawHeaders = Array.isArray(request.headers)
    ? Object.fromEntries(request.headers.filter(h => h && h.name).map(h => [h.name, h.value]))
    : (request.headers && typeof request.headers === 'object' ? request.headers : {});
  Object.entries(rawHeaders).slice(0, 20).forEach(([header, value]) => {
    const clean = text(header, 100);
    if (!clean || !/^[\w-]+$/.test(clean)) {
      errors.push(`"${clean}" is not a valid header name`);
    } else if (workflowActions.FORBIDDEN_HEADERS.has(clean.toLowerCase())) {
      errors.push(`The ${clean} header is set by the platform and cannot be changed`);
    } else if (clean.toLowerCase() === 'authorization') {
      // A credential typed into a plain header would be stored and returned
      // in clear. The auth block is where it is encrypted.
      errors.push('Put credentials in the authentication settings, not in a header, so they are stored encrypted');
    } else {
      headers[clean] = text(value, 1000);
    }
  });

  const requestBody = method === 'GET' ? '' : text(request.body, 10000);
  if (requestBody && /^\s*[[{]/.test(requestBody) && !workflowActions.isJsonTemplate(requestBody)) {
    errors.push('The request body looks like JSON but does not parse');
  }

  const authType = ['none', 'bearer', 'header', 'basic'].includes(auth.type) ? auth.type : 'none';
  const authHeader = authType === 'header' ? (text(auth.header, 100) || 'x-api-key') : undefined;
  if (authHeader && !/^[\w-]+$/.test(authHeader)) {
    errors.push(`"${authHeader}" is not a valid header name`);
  }

  // Undefined means "unchanged" to the caller; '' means "remove it".
  let credential;
  const submitted = ((body.request || {}).auth || {}).value;
  if (authType === 'none') {
    credential = '';
  } else if (typeof submitted === 'string' && submitted.trim()) {
    credential = submitted.trim();
  }

  const inputs = [];
  const seen = new Set();
  (Array.isArray(input.inputs) ? input.inputs : []).slice(0, MAX_INPUTS).forEach((raw, index) => {
    if (!raw) {
      return;
    }
    const inputName = text(raw.name, 40);
    const label = inputName || `input ${index + 1}`;

    if (!INPUT_NAME_PATTERN.test(inputName)) {
      errors.push(`Input "${label}": names are letters, digits and underscores`);
      return;
    }
    if (seen.has(inputName)) {
      errors.push(`Input "${inputName}" is defined twice`);
      return;
    }
    seen.add(inputName);

    const source = ['visitor', 'verified', 'constant'].includes(raw.source) ? raw.source : 'visitor';
    const clean = {
      name: inputName,
      description: text(raw.description, 300),
      type: ['string', 'number', 'boolean'].includes(raw.type) ? raw.type : 'string',
      required: raw.required !== false,
      source
    };

    if (source === 'constant') {
      clean.value = text(raw.value, 500);
    }
    if (source === 'verified') {
      clean.attribute = text(raw.attribute, 40) || 'externalId';
      if (!VERIFIED_ATTRIBUTES.includes(clean.attribute)) {
        errors.push(`Input "${inputName}": a verified input can read ${VERIFIED_ATTRIBUTES.join(', ')}`);
      }
    }
    inputs.push(clean);
  });

  const mode = response.mode === 'raw' ? 'raw' : 'paths';
  const maxBytes = Math.min(Math.max(parseInt(response.maxBytes, 10) || DEFAULT_MAX_BYTES, 200), MAX_MAX_BYTES);
  const outputs = [];
  (Array.isArray(response.outputs) ? response.outputs : []).slice(0, MAX_OUTPUTS).forEach(raw => {
    const outputName = text(raw && (raw.name || raw.variable), 40).replace(/[^\w]/g, '_');
    const path = text(raw && raw.path, 200);
    if (outputName && path) {
      outputs.push({ name: outputName, path });
    }
  });
  const timeoutMs = request.timeoutMs ? parseInt(request.timeoutMs, 10) || undefined : undefined;

  const value = {
    name,
    title,
    description: text(input.description, 1000),
    inputs,
    request: {
      method,
      url,
      headers,
      body: requestBody,
      timeoutMs,
      auth: { type: authType, header: authHeader }
    },
    response: { mode, maxBytes, outputs },
    mode: input.mode === 'workflow_only' ? 'workflow_only' : 'auto',
    requiresVerified: Boolean(input.requiresVerified),
    enabled: input.enabled !== false
  };

  return { errors, value, credential };
}

/**
 * Apply a normalised submission to a document, encrypting a new credential.
 */
function apply(doc, normalised) {
  const { value, credential } = normalised;
  const previous = doc.request && doc.request.auth ? doc.request.auth.value : undefined;

  doc.set(value);

  if (credential === '') {
    doc.set('request.auth.value', undefined);
  } else if (credential !== undefined) {
    doc.set('request.auth.value', secrets.encrypt(credential));
  } else if (previous) {
    // `set` on the whole request replaced the nested auth object; put the
    // stored ciphertext back so "unchanged" really is unchanged.
    doc.set('request.auth.value', previous);
  }

  return doc;
}

// ---------------------------------------------------------------- shapes

/**
 * An action as the dashboard sees it.
 *
 * The credential never appears — whether one is set does, because that is what
 * an admin needs to know. Same rule as webhook secrets and connector secrets.
 */
function present(action) {
  const doc = action && typeof action.toObject === 'function' ? action.toObject() : (action || {});
  const request = doc.request || {};
  const auth = request.auth || {};

  return {
    _id: doc._id,
    name: doc.name,
    title: doc.title,
    description: doc.description || '',
    inputs: (doc.inputs || []).map(input => ({
      name: input.name,
      description: input.description || '',
      type: input.type || 'string',
      required: input.required !== false,
      source: input.source || 'visitor',
      ...(input.source === 'constant' ? { value: input.value || '' } : {}),
      ...(input.source === 'verified' ? { attribute: input.attribute || 'externalId' } : {})
    })),
    request: {
      method: request.method || 'GET',
      url: request.url || '',
      headers: request.headers || {},
      body: request.body || '',
      timeoutMs: request.timeoutMs,
      auth: {
        type: auth.type || 'none',
        ...(auth.header ? { header: auth.header } : {}),
        hasCredential: doc.hasCredential !== undefined ? Boolean(doc.hasCredential) : Boolean(auth.value)
      }
    },
    response: {
      mode: (doc.response && doc.response.mode) || 'paths',
      maxBytes: (doc.response && doc.response.maxBytes) || DEFAULT_MAX_BYTES,
      outputs: ((doc.response && doc.response.outputs) || []).map(o => ({ name: o.name, path: o.path }))
    },
    mode: doc.mode || 'auto',
    requiresVerified: Boolean(doc.requiresVerified),
    enabled: doc.enabled !== false,
    isWrite: isWrite(doc),
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

function isWrite(action) {
  return String((action && action.request && action.request.method) || 'GET').toUpperCase() !== 'GET';
}

/**
 * Whether calling this action needs a verified contact.
 *
 * An input that reads the verified contact cannot be filled without one, so it
 * implies the gate even when the admin forgot to tick the box.
 */
function needsVerified(action) {
  return Boolean(action.requiresVerified) ||
    (action.inputs || []).some(input => input.source === 'verified');
}

// ---------------------------------------------------------------- inputs

/** A contact field, only from a verified contact. */
function contactAttribute(contact, attribute) {
  if (!contact || contact.identityLevel !== 'verified') {
    return undefined;
  }
  return VERIFIED_ATTRIBUTES.includes(attribute) ? contact[attribute] : undefined;
}

function coerce(value, type) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : NaN;
  }
  if (type === 'boolean') {
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
  }
  // Capped: a visitor's input becomes part of a URL or a body, and nothing a
  // real API takes as one field needs to be longer than this.
  return String(value).slice(0, 500);
}

/**
 * Work out the values an action is called with.
 *
 * `args` supplies visitor inputs only. Verified inputs come from the contact
 * and constants from the definition, whatever `args` says — that is what makes
 * "the model cannot choose whose account it reads" true rather than hoped for.
 * The test panel passes `trustArgs`, because there an admin is supplying
 * sample values for every input on purpose.
 *
 * @returns {{ok: boolean, values?: object, error?: string}}
 */
function resolveInputs(action, args = {}, { contact = null, trustArgs = false } = {}) {
  const values = {};

  for (const input of action.inputs || []) {
    let raw;

    if (input.source === 'constant') {
      raw = input.value;
    } else if (input.source === 'verified') {
      raw = trustArgs ? args[input.name] : contactAttribute(contact, input.attribute || 'externalId');
      if ((raw === undefined || raw === '') && !trustArgs) {
        return { ok: false, error: 'This needs a verified customer, and the visitor is not verified.' };
      }
    } else {
      raw = args[input.name];
    }

    const value = coerce(raw, input.type);

    if (Number.isNaN(value)) {
      return { ok: false, error: `${input.name} must be a number` };
    }
    if (value === undefined) {
      if (input.required !== false) {
        return { ok: false, error: `Missing required input: ${input.name}` };
      }
      continue;
    }
    values[input.name] = value;
  }

  return { ok: true, values };
}

// ---------------------------------------------------------------- running

/** The Call an API node configuration an action amounts to. */
function toRequestConfig(action) {
  const request = action.request || {};
  return {
    label: action.title,
    method: request.method || 'GET',
    url: request.url,
    headers: request.headers || {},
    body: request.body || '',
    timeoutMs: request.timeoutMs,
    auth: request.auth || { type: 'none' },
    outputs: ((action.response && action.response.outputs) || [])
      .map(output => ({ variable: output.name, path: output.path }))
  };
}

/**
 * Run an action once with already-resolved input values.
 *
 * Never throws, like the node it is built on. `includeBody` returns the raw
 * response truncated to the action's cap — used by the test panel, and by the
 * assistant only when the admin chose the "raw" response mode, which is them
 * deciding that this endpoint's whole response is fit for the model to read.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string,
 *                    extracted: object, body?: string, truncated?: boolean,
 *                    durationMs: number}>}
 */
async function run(action, values, options = {}) {
  const maxBytes = options.maxBytes ||
    (action.response && action.response.maxBytes) || DEFAULT_MAX_BYTES;
  const includeBody = options.includeBody !== undefined
    ? options.includeBody
    : (action.response && action.response.mode) === 'raw';

  const result = await workflowActions.execute(toRequestConfig(action), values, {
    includeBody,
    bodyLimit: maxBytes,
    simulate: options.simulate
  });

  return {
    ok: result.ok,
    status: result.status,
    error: result.error,
    extracted: result.variables || {},
    ...(result.body !== undefined ? { body: result.body, truncated: result.truncated } : {}),
    simulated: result.simulated,
    durationMs: result.durationMs
  };
}

/**
 * Load an action with its credential, scoped to one company.
 *
 * The company is in the query, so an id from another tenant finds nothing.
 */
async function loadForRun(companyId, actionId) {
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(actionId || ''))) {
    return null;
  }
  return Action.findOne({ _id: actionId, company: companyId })
    .select('+request.auth.value')
    .lean();
}

// ---------------------------------------------------------------- workflows

/**
 * Run a saved action from a workflow's action node.
 *
 * Workflow variables stand in for visitor inputs, by input name. Verified
 * inputs read the contact facts reply.js put into the run's variables, and
 * only when it marked the contact verified. The result has the same shape as
 * workflowActions.execute, so the compiler's branch logic does not change.
 */
async function runForWorkflow(companyId, actionId, variables = {}, options = {}) {
  const started = Date.now();
  const action = await loadForRun(companyId, actionId);

  if (!action) {
    return { ok: false, error: 'The saved action this node uses no longer exists', variables: {}, durationMs: 0 };
  }
  if (!action.enabled) {
    return { ok: false, error: `The action "${action.title}" is switched off`, variables: {}, durationMs: 0 };
  }

  const verified = String(variables.contact_verified) === 'true';
  const contact = verified
    ? {
      identityLevel: 'verified',
      externalId: variables.contact_external_id,
      email: variables.contact_email,
      name: variables.contact_name
    }
    : null;

  if (needsVerified(action) && !verified) {
    return { ok: false, error: 'This action needs a verified customer', variables: {}, durationMs: 0 };
  }

  const resolved = resolveInputs(action, variables, { contact });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, variables: {}, durationMs: Date.now() - started };
  }

  const result = await workflowActions.execute(toRequestConfig(action), resolved.values, {
    simulate: options.simulate
  });

  return { ...result, label: action.title };
}

// ---------------------------------------------------------------- presets

/**
 * The five Call an API presets from the workflow editor, as action templates.
 *
 * Each is a ready-to-POST action body with no credential. `note` says where the
 * credential comes from, which is the step tenants always get stuck on. Account
 * lookups default to requiring a verified customer and read the identifier
 * from the verified contact, so a visitor cannot ask about somebody else's
 * subscription by typing their id.
 */
const PRESETS = [
  {
    id: 'shopify-order',
    label: 'Shopify — look up an order',
    note: 'Create an Admin API access token (Settings → Apps and sales channels → Develop apps) and paste it as the credential. Set shop_domain to your store\'s myshopify subdomain.',
    action: {
      name: 'shopify_order_lookup',
      title: 'Shopify order lookup',
      description: 'Look up the payment and fulfilment status of one of the customer\'s orders by its order id. Use when the customer asks where their order is or whether it has shipped.',
      inputs: [
        { name: 'shop_domain', type: 'string', required: true, source: 'constant', value: '' },
        { name: 'order_id', type: 'string', required: true, source: 'visitor', description: 'The numeric Shopify order id the customer gives' }
      ],
      request: {
        method: 'GET',
        url: 'https://{{shop_domain}}.myshopify.com/admin/api/2024-07/orders/{{order_id}}.json',
        auth: { type: 'header', header: 'X-Shopify-Access-Token' }
      },
      response: {
        mode: 'paths',
        outputs: [
          { name: 'payment_status', path: 'order.financial_status' },
          { name: 'fulfillment_status', path: 'order.fulfillment_status' }
        ]
      },
      mode: 'auto',
      requiresVerified: true
    }
  },
  {
    id: 'stripe-subscription',
    label: 'Stripe — check a subscription',
    note: 'Use a restricted key with read access to subscriptions, not your live secret key. The customer id is read from the verified visitor\'s external id, so identify visitors with their Stripe customer id.',
    action: {
      name: 'stripe_subscription_status',
      title: 'Stripe subscription status',
      description: 'Check the status and renewal date of the customer\'s own subscription. Use when they ask whether their plan is active, when it renews, or why they lost access.',
      inputs: [
        { name: 'customer_id', type: 'string', required: true, source: 'verified', attribute: 'externalId' }
      ],
      request: {
        method: 'GET',
        url: 'https://api.stripe.com/v1/customers/{{customer_id}}/subscriptions',
        auth: { type: 'bearer' }
      },
      response: {
        mode: 'paths',
        outputs: [
          { name: 'subscription_status', path: 'data.0.status' },
          { name: 'current_period_end', path: 'data.0.current_period_end' }
        ]
      },
      mode: 'auto',
      requiresVerified: true
    }
  },
  {
    id: 'zendesk-ticket',
    label: 'Zendesk — raise a ticket',
    note: 'The credential is your agent email and API token joined as email/token:api_token — exactly in that form. Set subdomain to your Zendesk subdomain.',
    action: {
      name: 'zendesk_create_ticket',
      title: 'Raise a Zendesk ticket',
      description: 'Open a support ticket for a problem that cannot be solved in the chat, so the team can follow up by email. Use only after the customer agrees to a ticket being raised.',
      inputs: [
        { name: 'subdomain', type: 'string', required: true, source: 'constant', value: '' },
        { name: 'summary', type: 'string', required: true, source: 'visitor', description: 'A short description of the customer\'s problem, in their words' }
      ],
      request: {
        method: 'POST',
        url: 'https://{{subdomain}}.zendesk.com/api/v2/tickets.json',
        body: '{"ticket": {"subject": "Chat escalation", "comment": {"body": "{{summary}}"}}}',
        auth: { type: 'basic' }
      },
      response: { mode: 'paths', outputs: [{ name: 'ticket_id', path: 'ticket.id' }] },
      mode: 'auto',
      requiresVerified: false
    }
  },
  {
    id: 'slack-notify',
    label: 'Slack — post to a channel',
    note: 'Paste the path after https://hooks.slack.com/services/ as the webhook_path constant. That path is itself the secret and is stored as written, so anyone who can edit actions can post to the channel. Workflow only: the assistant has no reason to message your team by itself.',
    action: {
      name: 'slack_notify',
      title: 'Post to Slack',
      description: 'Tell the team in Slack that a conversation needs attention.',
      inputs: [
        { name: 'webhook_path', type: 'string', required: true, source: 'constant', value: '' },
        { name: 'message', type: 'string', required: true, source: 'visitor', description: 'What the team should know' }
      ],
      request: {
        method: 'POST',
        url: 'https://hooks.slack.com/services/{{webhook_path}}',
        body: '{"text": "New conversation needs attention: {{message}}"}',
        auth: { type: 'none' }
      },
      response: { mode: 'paths', outputs: [] },
      mode: 'workflow_only',
      requiresVerified: false
    }
  },
  {
    id: 'hubspot-contact',
    label: 'HubSpot — look up a contact',
    note: 'Use a private app token with crm.objects.contacts.read scope. The email is read from the verified visitor, never from what they type.',
    action: {
      name: 'hubspot_contact_lookup',
      title: 'HubSpot contact lookup',
      description: 'Look up the customer\'s own CRM record (first name and lifecycle stage). Use when personalising an answer depends on whether they are a lead or an existing customer.',
      inputs: [
        { name: 'contact_email', type: 'string', required: true, source: 'verified', attribute: 'email' }
      ],
      request: {
        method: 'GET',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/{{contact_email}}?idProperty=email',
        auth: { type: 'bearer' }
      },
      response: {
        mode: 'paths',
        outputs: [
          { name: 'crm_first_name', path: 'properties.firstname' },
          { name: 'crm_lifecycle_stage', path: 'properties.lifecyclestage' }
        ]
      },
      mode: 'auto',
      requiresVerified: true
    }
  }
];

module.exports = {
  normalise,
  apply,
  present,
  isWrite,
  needsVerified,
  resolveInputs,
  contactAttribute,
  toRequestConfig,
  run,
  loadForRun,
  runForWorkflow,
  PRESETS,
  NAME_PATTERN,
  VERIFIED_ATTRIBUTES,
  DEFAULT_MAX_BYTES,
  MAX_MAX_BYTES
};
