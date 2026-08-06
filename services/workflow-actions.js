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

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const secrets = require('./secrets');
const { logger } = require('./logging');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

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

// ---------------------------------------------------------------- addresses

/**
 * Whether an IP belongs to a range that must never be reachable from here.
 *
 * Loopback and private ranges are the obvious ones. 169.254.0.0/16 is the
 * important one: that is where every major cloud puts its instance metadata
 * service, and reaching it is a credential disclosure rather than a nuisance.
 */
function isBlockedAddress(address) {
  const version = net.isIP(address);

  if (version === 4) {
    const [a, b] = address.split('.').map(Number);

    return (
      a === 0 ||                              // "this network"
      a === 10 ||                             // private
      a === 127 ||                            // loopback
      (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
      (a === 169 && b === 254) ||             // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||    // private
      (a === 192 && b === 168) ||             // private
      (a === 192 && b === 0) ||               // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224                                // multicast and reserved
    );
  }

  if (version === 6) {
    const normalised = address.toLowerCase().replace(/^\[|\]$/g, '');

    // IPv4 written as IPv6 reaches the same hosts, so unwrap and re-check
    // rather than treating ::ffff:127.0.0.1 as a distinct, allowed address.
    const mapped = normalised.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isBlockedAddress(mapped[1]);
    }

    return (
      normalised === '::' ||
      normalised === '::1' ||
      /^f[cd]/.test(normalised) ||   // unique local fc00::/7
      /^fe[89ab]/.test(normalised) || // link-local fe80::/10
      /^ff/.test(normalised)          // multicast
    );
  }

  // Not an IP literal at all: refuse rather than guess.
  return true;
}

/**
 * A DNS lookup that refuses to hand back a blocked address.
 *
 * Passed to the request so the check happens on the address actually connected
 * to. Validating the hostname up front and then connecting by name would leave
 * a rebinding window in which the second lookup returns 127.0.0.1.
 */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      return callback(error);
    }

    const list = Array.isArray(addresses) ? addresses : [addresses];
    const allowed = list.filter(entry => !isBlockedAddress(entry.address));

    if (allowed.length === 0) {
      const blocked = new Error(`Refusing to connect to ${hostname}: it resolves to a private or reserved address`);
      blocked.code = 'EBLOCKEDADDRESS';
      return callback(blocked);
    }

    if (options && options.all) {
      return callback(null, allowed);
    }
    return callback(null, allowed[0].address, allowed[0].family);
  });
}

/**
 * The lookup the request layer actually uses.
 *
 * Swappable only from code, never from configuration. The test suite needs to
 * reach a server on 127.0.0.1 - precisely what the guard exists to prevent -
 * and an environment variable for that would eventually get set in production
 * by someone who wanted an internal endpoint to work.
 */
let activeLookup = guardedLookup;

/** Test seam. Pass nothing to restore the real guard. */
function __setLookupForTests(replacement) {
  activeLookup = replacement || guardedLookup;
}

/**
 * Check a URL an admin has typed, before anything is stored.
 *
 * @returns {{valid: boolean, error?: string, url?: URL}}
 */
function validateUrl(value) {
  let url;

  try {
    url = new URL(String(value));
  } catch {
    return { valid: false, error: 'Enter a full URL, including https://' };
  }

  if (url.protocol === 'http:') {
    // Plain HTTP sends the tenant's own API credential in clear text. Allowed
    // only where someone has deliberately opted in, which is local development.
    if (process.env.ACTIONS_ALLOW_HTTP !== 'true') {
      return { valid: false, error: 'Use https:// — an API key sent over http can be read in transit' };
    }
  } else if (url.protocol !== 'https:') {
    return { valid: false, error: 'Only http and https URLs can be called' };
  }

  // A literal private address never needs DNS, so catch it here too and give a
  // useful message instead of a connect-time failure.
  if (net.isIP(url.hostname) && isBlockedAddress(url.hostname)) {
    return { valid: false, error: 'That address is private or reserved and cannot be called' };
  }

  return { valid: true, url };
}

// ----------------------------------------------------------------- request

/**
 * One HTTP request, with the destination checked at connect time.
 *
 * Redirects are followed by hand rather than by the transport, because each hop
 * is a fresh destination that has to pass the same checks - a redirect to
 * 169.254.169.254 would otherwise walk straight past them.
 */
function request(url, options, body, timeoutMs, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(url, {
      method: options.method,
      headers: options.headers,
      lookup: activeLookup,
      timeout: timeoutMs
    }, response => {
      const { statusCode, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();

        if (redirectsLeft <= 0) {
          return reject(new Error('Too many redirects'));
        }

        let next;
        try {
          next = new URL(headers.location, url);
        } catch {
          return reject(new Error('The API redirected to an invalid URL'));
        }

        const check = validateUrl(next.toString());
        if (!check.valid) {
          return reject(new Error(`Refusing to follow a redirect: ${check.error}`));
        }

        // Credentials are dropped when the redirect leaves the original host,
        // otherwise the tenant's API key is handed to whoever the redirect
        // names.
        const headersForNext = { ...options.headers };
        if (next.host !== url.host) {
          Object.keys(headersForNext).forEach(name => {
            if (/^(authorization|x-api-key|api-key|cookie)$/i.test(name)) {
              delete headersForNext[name];
            }
          });
        }

        return resolve(request(next, { ...options, headers: headersForNext }, body, timeoutMs, redirectsLeft - 1));
      }

      const chunks = [];
      let size = 0;

      response.on('data', chunk => {
        size += chunk.length;

        if (size > MAX_RESPONSE_BYTES) {
          // Destroy rather than buffer: an endpoint streaming gigabytes would
          // otherwise take the process's memory with it.
          response.destroy();
          reject(new Error('The API returned more data than we will read (256 KB limit)'));
          return;
        }

        chunks.push(chunk);
      });

      response.on('end', () => {
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
      });

      response.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`The API did not respond within ${timeoutMs}ms`));
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

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
  // Exported for tests: these carry the security weight.
  isBlockedAddress,
  guardedLookup,
  __setLookupForTests,
  ALLOWED_METHODS,
  FORBIDDEN_HEADERS,
  MAX_RESPONSE_BYTES
};
