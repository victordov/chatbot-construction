/**
 * Meta's Graph API, for the WhatsApp Cloud API, Messenger and Instagram.
 *
 * One place that knows the API version, how a token is presented and what a
 * refusal looks like, so the adapters only say what to send. Requests go
 * through services/safe-http.js like every other call to a third party: the
 * host here is fixed, but media URLs arrive in webhook payloads, and one
 * outbound path with one set of size and time limits is easier to trust than
 * two.
 */

const crypto = require('crypto');
const safeHttp = require('../safe-http');

/**
 * The Graph API version every call is pinned to. Meta keeps each version for
 * about two years; moving it is a deliberate change, tested, never a default
 * that drifts. v26.0 was released on 29 July 2026.
 */
const GRAPH_VERSION = 'v26.0';

const GRAPH_ROOT = 'https://graph.facebook.com';

/** How long a send may take before the operator is told it failed. */
const TIMEOUT_MS = 15000;

/**
 * Error codes worth putting into words, because the raw message ("(#131047)
 * Re-engagement message") tells an operator nothing they can act on.
 */
const EXPLANATIONS = {
  190: 'the access token is no longer valid; an admin needs to paste a new one in the channel settings',
  10: 'Meta refused it: the app is missing a permission, or the customer has not written in the allowed time',
  200: 'Meta refused it: the app is missing a permission for this account',
  131047: 'more than 24 hours have passed since the customer last wrote, so only an approved template can be sent',
  131026: 'WhatsApp could not deliver it to this number',
  131030: 'this number is not on the test number\'s list of allowed recipients',
  131031: 'the WhatsApp Business Account is locked or restricted',
  131056: 'too many messages to this customer in a short time; try again in a moment',
  132001: 'the template does not exist, or not in that language',
  132000: 'the template expects a different number of parameters',
  551: 'this person is not available on Messenger right now',
  2018278: 'it is outside the time Messenger allows a reply'
};

class GraphError extends Error {
  constructor({ message, status, code, subcode, details }) {
    super(message || 'The Graph API refused the request');
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.details = details;
  }

  /** Whether the stored credential itself is the problem. */
  get isAuthFailure() {
    return this.code === 190 || this.status === 401;
  }
}

/**
 * The reason a call failed, in words an operator can act on.
 *
 * @param {Error} error
 * @returns {string}
 */
function describe(error) {
  if (!error) {
    return 'unknown error';
  }
  if (error instanceof GraphError) {
    const known = EXPLANATIONS[error.subcode] || EXPLANATIONS[error.code];
    if (known) {
      return known;
    }
    return String(error.details || error.message).slice(0, 300);
  }
  return String(error.message || error).slice(0, 300);
}

/**
 * Proof that the caller holds the app secret as well as the token.
 *
 * An app with "Require app secret" switched on refuses any call without it;
 * one without the setting ignores it. Sending it always means the setting can
 * be switched on without anything here changing.
 */
function appSecretProof(token, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

function parseBody(body) {
  if (!body) {
    return {};
  }
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
  } catch {
    return { raw: String(body).slice(0, 300) };
  }
}

/**
 * One Graph API call.
 *
 * @param {string} path e.g. `123456/messages`, without the version
 * @param {object} options
 * @param {string} options.token the access token
 * @param {string} [options.appSecret] adds `appsecret_proof`
 * @param {string} [options.method='GET']
 * @param {object} [options.body] sent as JSON
 * @returns {Promise<object>} the parsed response
 * @throws {GraphError}
 */
async function call(path, { token, appSecret, method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  if (!token) {
    throw new GraphError({ message: 'No access token is configured', code: 190 });
  }

  const url = new URL(`${GRAPH_ROOT}/${GRAPH_VERSION}/${String(path).replace(/^\//, '')}`);
  if (appSecret) {
    url.searchParams.set('appsecret_proof', appSecretProof(token, appSecret));
  }

  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    // A header rather than `?access_token=`, so the token stays out of every
    // log line that records a URL.
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  let response;
  try {
    response = await safeHttp.request(url, { method, headers }, payload, timeoutMs);
  } catch (error) {
    throw new GraphError({ message: `Could not reach Meta: ${error.message}` });
  }

  const data = parseBody(response.body);

  if (response.statusCode >= 400 || data.error) {
    const failure = data.error || {};
    throw new GraphError({
      message: failure.message || `Meta answered ${response.statusCode}`,
      status: response.statusCode,
      code: failure.code,
      subcode: failure.error_subcode,
      details: failure.error_data && failure.error_data.details
    });
  }

  return data;
}

/**
 * Download a file a webhook pointed at.
 *
 * The URL comes from the payload, so it is fetched through the same guard as
 * any URL somebody else chose, held to the upload size cap. WhatsApp's media
 * URLs want the token; a Messenger attachment URL is already signed and is
 * fetched without one, so the token never goes anywhere it is not needed.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string|null}>}
 */
async function download(url, { token, maxBytes, timeoutMs = TIMEOUT_MS } = {}) {
  const response = await safeHttp.fetchUrl(url, {
    asBuffer: true,
    maxBytes,
    timeoutMs,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  const type = String(response.headers && response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return { buffer: response.body, mimeType: type || null };
}

module.exports = {
  GRAPH_VERSION,
  GRAPH_ROOT,
  GraphError,
  call,
  download,
  describe,
  appSecretProof
};
