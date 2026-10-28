/**
 * HTTP to the calendar providers, and nowhere else.
 *
 * Every call goes through services/safe-http.js like any other outbound
 * request, but the destination is never a URL a tenant typed: the providers
 * live at a handful of fixed hosts, so those are the only hosts this module
 * will talk to. A provider response that names some other URL (a "next page"
 * link, an event's self link) cannot turn this into a way of fetching it.
 */

const safeHttp = require('../safe-http');

const ALLOWED_HOSTS = new Set([
  'api.cal.com',
  'api.calendly.com',
  'www.googleapis.com',
  'oauth2.googleapis.com'
]);

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * A provider said no, or could not be reached.
 *
 * `status` is the provider's HTTP status when there was one, so a caller can
 * tell "your key was rejected" (401) from "that time has gone" (409) from
 * "Calendly's free plan cannot do this" (403).
 */
class ProviderError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

/** The message a provider put in its error body, whichever shape it uses. */
function messageFrom(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  // Cal.com: { status: 'error', error: { message } }. Calendly: { title,
  // message }. Google: { error: { message } } or, from the token endpoint,
  // { error: 'invalid_grant', error_description }.
  const error = body.error;
  if (error && typeof error === 'object' && error.message) {
    return String(error.message);
  }
  if (body.error_description) {
    return String(body.error_description);
  }
  if (body.message) {
    return String(body.message);
  }
  if (typeof error === 'string') {
    return error;
  }
  return null;
}

/**
 * One JSON request to a provider.
 *
 * @param {string} rawUrl must be https on an allowed host
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {object} [options.query] appended to the URL, empty values dropped
 * @param {object} [options.json] sent as a JSON body
 * @param {object} [options.form] sent as application/x-www-form-urlencoded
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status: number, body: *}>}
 * @throws {ProviderError} on a refused host, a network failure or a non-2xx
 */
async function request(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError('Bad provider URL', 0);
  }

  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new ProviderError(`Refusing to call ${url.hostname}: not a calendar provider`, 0);
  }

  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = { accept: 'application/json', ...(options.headers || {}) };
  let body = null;

  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (body !== null) {
    headers['content-length'] = Buffer.byteLength(body);
  }

  let response;
  try {
    response = await safeHttp.request(
      url,
      { method: options.method || 'GET', headers },
      body,
      options.timeoutMs || DEFAULT_TIMEOUT_MS
    );
  } catch (error) {
    throw new ProviderError(`Could not reach the calendar: ${error.message}`, 0);
  }

  let parsed = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ProviderError(
      messageFrom(parsed) || `The calendar answered ${response.statusCode}`,
      response.statusCode,
      parsed
    );
  }

  return { status: response.statusCode, body: parsed };
}

module.exports = { request, ProviderError, ALLOWED_HOSTS };
