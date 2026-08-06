/**
 * Outbound HTTP that refuses to be pointed somewhere it should not go.
 *
 * Two features need to fetch a URL a tenant typed: workflow action nodes, and
 * webhook deliveries. Both are the same hazard — our server making a request on
 * behalf of somebody whose interests are not ours. Aimed at
 * `http://169.254.169.254/` a request reads the cloud instance's credentials;
 * aimed at `http://localhost:27017` it reaches the database holding every other
 * tenant's conversations.
 *
 * This lives in one module because a second copy is a second thing to forget to
 * fix. The protection is:
 *
 *   - the destination is checked on the address actually resolved, at connect
 *     time, for every address the name resolves to. Checking the hostname first
 *     and connecting by name afterwards leaves a rebinding window in which the
 *     second lookup returns 127.0.0.1
 *   - redirects are followed by hand so each hop is re-checked, and credentials
 *     are dropped when a redirect leaves the original host
 *   - responses are size-capped and time-bounded, so a hostile endpoint cannot
 *     exhaust memory or hold a request open
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const { logger } = require('./logging');

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

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

module.exports = {
  request,
  validateUrl,
  isBlockedAddress,
  guardedLookup,
  __setLookupForTests,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS
};
