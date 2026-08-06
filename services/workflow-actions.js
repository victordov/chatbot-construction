/**
 * Workflow action nodes: calling the tenant's own API mid-conversation.
 *
 * This is what turns the bot from something that answers into something that
 * resolves. "Where is my order?" stops being a knowledge-base lookup and
 * becomes a call to the tenant's order service, with the real status read back
 * to the customer.
 *
 * Two things make this dangerous, and most of this file is about them.
 *
 * SSRF. A tenant admin types a URL and our server fetches it. Pointed at
 * `http://169.254.169.254/` that reads the cloud instance's credentials;
 * pointed at `http://localhost:27017` it reaches the database holding every
 * other tenant's conversations. So the destination is checked at connect time,
 * on the resolved address, for every address the name resolves to, and again
 * on each redirect. Checking the hostname alone is not enough: DNS can return
 * a public address once and a private one a moment later.
 *
 * Leakage. The response is a third party's data arriving mid-conversation. Only
 * the fields the author explicitly mapped are exposed - never the whole body -
 * so an endpoint that happens to return an email address or a card's last four
 * digits does not silently end up in the transcript or the model's context.
 */

const secrets = require('./secrets');
const safeHttp = require('./safe-http');
const { logger } = require('./logging');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

// The transport, and the address checks that make it safe to point at a URL a
// tenant typed, live in services/safe-http.js — webhook delivery needs exactly
// the same guarantees, and one copy is the only way they stay identical.
const { request, validateUrl, isBlockedAddress, guardedLookup } = safeHttp;
const MAX_RESPONSE_BYTES = safeHttp.MAX_RESPONSE_BYTES;

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Headers a tenant may not set.
 *
 * `host` would let a request aimed at an allowed address be routed to a
 * different virtual host; the rest are controlled by the transport and setting
 * them by hand produces malformed or smuggled requests.
 */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'upgrade', 'proxy-authorization', 'te', 'trailer'
]);

// ---------------------------------------------------------------- template

/**
 * Fill `{{variable}}` placeholders.
 *
 * `encode` is on for the URL, where an unescaped value would let a visitor's
 * message add query parameters or path segments to the tenant's API call.
 */
function fill(template, variables, encode = false) {
  if (template === undefined || template === null) {
    return '';
  }

  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const value = readPath(variables, path);

    if (value === undefined || value === null) {
      return '';
    }

    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return encode ? encodeURIComponent(text) : text;
  });
}

/** Read `a.b.c` out of a nested object, tolerating gaps along the way. */
function readPath(source, path) {
  return String(path).split('.').reduce((value, key) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    // Array indices are written the same way: items.0.name
    return value[key];
  }, source);
}

// ---------------------------------------------------------------- execution

/**
 * Run an action node.
 *
 * Never throws: a failing API is an outcome the workflow branches on, not an
 * exception that takes down the conversation. The caller follows the `error`
 * output when `ok` is false.
 *
 * @param {object} config the node's `data`
 * @param {object} variables the run's variables, for templating
 * @param {object} [options] `includeBody` returns a truncated raw response.
 *        Only ever set from the editor's "Test" button, where a tenant admin is
 *        deliberately inspecting their own API to find the right field paths -
 *        never during a conversation, where the body would reach the model.
 * @returns {Promise<{ok: boolean, status?: number, variables: object,
 *                    error?: string, durationMs: number}>}
 */
async function execute(config = {}, variables = {}, options = {}) {
  const started = Date.now();
  const fail = (error, extra = {}) => ({
    ok: false, error, variables: {}, durationMs: Date.now() - started, ...extra
  });

  const method = String(config.method || 'GET').toUpperCase();

  if (!ALLOWED_METHODS.has(method)) {
    return fail(`${method} is not an allowed method`);
  }

  const rendered = fill(config.url, variables, true);
  const check = validateUrl(rendered);

  if (!check.valid) {
    return fail(check.error);
  }

  // A User-Agent is not optional in practice: some APIs reject an anonymous
  // client outright, and the ones that do not still log it, so a tenant can
  // see in their own logs where the traffic came from. Overridable below.
  const headers = {
    accept: 'application/json',
    'user-agent': process.env.ACTIONS_USER_AGENT || 'chatbot-platform-workflow-action/1.0'
  };

  Object.entries(config.headers || {}).forEach(([name, value]) => {
    if (!FORBIDDEN_HEADERS.has(String(name).toLowerCase())) {
      headers[name] = fill(value, variables);
    }
  });

  // The credential is stored encrypted, so it is decrypted here and never
  // anywhere the value could be logged or returned to a browser.
  const auth = config.auth || {};
  if (auth.type && auth.type !== 'none') {
    const token = secrets.decrypt(auth.value);

    if (!token) {
      return fail('The credential for this action could not be read. Re-enter it in the workflow editor.');
    }

    if (auth.type === 'bearer') {
      headers.authorization = `Bearer ${token}`;
    } else if (auth.type === 'header') {
      headers[auth.header || 'x-api-key'] = token;
    } else if (auth.type === 'basic') {
      headers.authorization = `Basic ${Buffer.from(token).toString('base64')}`;
    }
  }

  let body = null;

  if (method !== 'GET' && config.body) {
    body = fill(config.body, variables);
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }

  const timeoutMs = Math.min(
    Math.max(parseInt(config.timeoutMs, 10) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS
  );

  let response;

  try {
    response = await request(check.url, { method, headers }, body, timeoutMs);
  } catch (error) {
    // The message is shown to the tenant's admins, so it says what happened;
    // the visitor only ever sees whatever the error branch is wired to.
    logger.warn('Workflow action failed', { url: check.url.host, error: error.message });
    return fail(error.message);
  }

  const durationMs = Date.now() - started;

  let parsed = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      // Not JSON. The raw text is still available to a mapping using the
      // `$body` path, which is the escape hatch for plain-text APIs.
      parsed = null;
    }
  }

  const preview = options.includeBody
    ? { body: response.body.slice(0, 4000), truncated: response.body.length > 4000 }
    : {};

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      status: response.statusCode,
      error: `The API returned ${response.statusCode}`,
      variables: {},
      durationMs,
      ...preview
    };
  }

  // Only what the author asked for. Copying the whole response into the run's
  // variables would put arbitrary third-party data - names, addresses, payment
  // details - into the model's context and the stored transcript.
  const extracted = {};

  (config.outputs || []).forEach(mapping => {
    if (!mapping || !mapping.variable) {
      return;
    }

    const name = String(mapping.variable).replace(/[^\w]/g, '_');
    const value = mapping.path === '$body'
      ? response.body
      : readPath(parsed, mapping.path || '');

    extracted[name] = value === undefined || value === null
      ? (mapping.fallback || '')
      : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  });

  return { ok: true, status: response.statusCode, variables: extracted, durationMs, ...preview };
}

module.exports = {
  execute,
  validateUrl,
  fill,
  readPath,
  // Re-exported so the existing tests, and anything already importing them,
  // keep working after the transport moved out.
  isBlockedAddress,
  guardedLookup,
  __setLookupForTests: safeHttp.__setLookupForTests,
  ALLOWED_METHODS,
  FORBIDDEN_HEADERS,
  MAX_RESPONSE_BYTES
};
