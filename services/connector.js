/**
 * Calling a tenant's connector.
 *
 * The other half of sdk/. A tenant implements a few methods and exposes them at
 * one URL; this is what reaches them, proves who we are, and checks that what
 * came back is the shape we said it would be.
 *
 * Why this is not just another Call an API node: because the shapes are known.
 * A product that comes back through here has a title and an image and a price,
 * which means the widget can render a card, a workflow node can offer the
 * results as buttons, and — eventually — the assistant can decide by itself to
 * search the catalogue. None of that is possible with arbitrary JSON pulled
 * apart by hand-written paths.
 */

const crypto = require('crypto');

const Company = require('../models/company');
const capabilities = require('../config/capabilities');
const safeHttp = require('./safe-http');
const secrets = require('./secrets');
const booking = require('./booking');
const { logger } = require('./logging');

const CALL_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Reads are cached for a few seconds.
 *
 * A conversation asks the same question more than once — a preview run, a
 * retry, the assistant checking something it already knows — and a catalogue
 * search is not going to have changed in the meantime. Short enough that a
 * tenant editing a product sees it almost immediately, long enough to spare
 * their server the duplicate work.
 */
const CACHE_TTL_MS = 10000;
const cache = new Map();

function cacheKey(companyId, capability, input) {
  return `${companyId}:${capability}:${JSON.stringify(input)}`;
}

function readCache(key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function writeCache(key, value) {
  // Bounded so a busy tenant cannot grow this without limit; the oldest entry
  // goes, which for a TTL cache is also the least useful.
  if (cache.size > 500) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Test seam, and used when a tenant changes their connector settings. */
function clearCache(companyId) {
  if (!companyId) {
    cache.clear();
    return;
  }
  [...cache.keys()]
    .filter(key => key.startsWith(`${String(companyId)}:`))
    .forEach(key => cache.delete(key));
}

/**
 * Sign a call so the connector can prove it came from us.
 *
 * The same scheme as outbound webhooks, for the same reason: the timestamp is
 * inside the signed material, so a captured request cannot be replayed with its
 * timestamp edited to look current. The SDK verifies this without the tenant
 * writing any of it.
 */
function sign(body, secret, timestamp) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

function generateSecret() {
  return `csec_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * The tenant's hosted connector, with the secret decrypted.
 *
 * @returns {Promise<{url: string, secret: string, capabilities: string[]}|null>}
 */
async function hostedSettingsFor(companyId) {
  if (!companyId) {
    return null;
  }

  const company = await Company.findById(companyId)
    .select('+connector.secret')
    .lean();

  const connector = company && company.connector;

  if (!connector || !connector.enabled || !connector.url) {
    return null;
  }

  return {
    url: connector.url,
    secret: secrets.decrypt(connector.secret) || '',
    capabilities: connector.capabilities || []
  };
}

/**
 * What this company's systems can answer: its hosted connector, and a
 * connected booking calendar (services/booking), which answers the
 * availability capabilities without the tenant hosting anything.
 *
 * A calendar alone gives settings with no `url`; `capabilities` then lists
 * only what the calendar answers. An empty list still means "everything the
 * hosted connector was not asked about", as it always has.
 *
 * @returns {Promise<{url: string|null, secret: string, capabilities: string[], calendar?: boolean}|null>}
 */
async function settingsFor(companyId) {
  const hosted = await hostedSettingsFor(companyId);
  const calendar = await booking.capabilitiesFor(companyId);

  if (calendar.length === 0) {
    return hosted;
  }
  if (!hosted) {
    return { url: null, secret: '', capabilities: calendar, calendar: true };
  }

  return {
    ...hosted,
    capabilities: hosted.capabilities.length > 0
      ? [...new Set([...hosted.capabilities, ...calendar])]
      : hosted.capabilities,
    calendar: true
  };
}

/**
 * Ask a connector what it implements.
 *
 * Unsigned, because it reveals nothing about the business and requiring a
 * signature would make "is this thing reachable?" impossible to answer from a
 * browser while somebody is setting it up.
 */
async function discover(url) {
  const check = safeHttp.validateUrl(url);

  if (!check.valid) {
    return { ok: false, error: explainAddress(check.error, url) };
  }

  try {
    const response = await safeHttp.request(
      check.url,
      { method: 'GET', headers: { accept: 'application/json' } },
      null,
      DISCOVERY_TIMEOUT_MS
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { ok: false, error: `The connector returned ${response.statusCode}` };
    }

    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      return {
        ok: false,
        error: 'The connector did not return JSON. Is that URL the connector, or your website?'
      };
    }

    if (body.protocol !== 'chatbot-platform/connector') {
      return {
        ok: false,
        error: 'That URL answered, but it is not a connector. Check you have mounted the SDK handler there.'
      };
    }

    const known = new Set(capabilities.ids());
    const offered = (body.capabilities || []).filter(id => known.has(id));
    const unknown = (body.capabilities || []).filter(id => !known.has(id));

    return {
      ok: true,
      version: body.version,
      signed: Boolean(body.signed),
      capabilities: offered,
      // Reported rather than ignored: it usually means the connector is built
      // against a newer SDK than this platform knows about, and silently
      // dropping them would look like the capability was not implemented.
      unknown
    };
  } catch (error) {
    // A hostname is not an IP literal, so `localhost` passes validateUrl and
    // is refused later by the connect-time address check — which lands here
    // rather than in the branch above. Both paths need the explanation.
    return { ok: false, error: explainAddress(error.message, url) };
  }
}

/**
 * Say what to do about a refused address.
 *
 * "Refusing to connect to localhost" is accurate and useless. Building a
 * connector on your own machine first is the overwhelmingly common first
 * experience, and the block cannot be lifted — a tenant-supplied URL we fetch
 * is an SSRF hazard whoever typed it — so the least we can do is say what
 * actually works instead.
 */
function explainAddress(error, url) {
  // Matches both wordings: the up-front check on an IP literal, and the
  // connect-time refusal when a hostname resolves somewhere private.
  const isLocal = /private or reserved/i.test(error || '');

  if (!isLocal) {
    return error;
  }

  return `${error}. If you are building your connector locally, expose it with ` +
    'a tunnel (ngrok, Cloudflare Tunnel) and use that https URL here — we have ' +
    `to be able to reach it from the internet, and ${url} only exists on your machine.`;
}

/**
 * Call one capability.
 *
 * Never throws: a connector being down is a branch a workflow takes, not an
 * exception that ends a conversation.
 *
 * @param {object} [options]
 * @param {boolean} [options.simulate] a preview: writes are not sent
 * @param {number} [options.maxItems]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.sessionId] the conversation asking, so a booking
 *        made through a connected calendar is recorded against it
 * @returns {Promise<{ok: boolean, value?: *, error?: string, warnings?: string[]}>}
 */
async function call(companyId, capabilityId, input = {}, options = {}) {
  const capability = capabilities.byId(capabilityId);

  if (!capability) {
    return { ok: false, error: `Unknown capability: ${capabilityId}` };
  }

  // A write is never run to try a flow out. Booking an appointment six times
  // while testing a branch would put six appointments in somebody's diary.
  if (options.simulate && capability.kind === 'write') {
    return {
      ok: true,
      simulated: [{
        description: `${capability.label} (${capabilityId})`,
        detail: 'Not sent — previews do not change your systems.'
      }],
      value: null
    };
  }

  const checked = capabilities.validateInput(capabilityId, input);

  if (!checked.ok) {
    // Ours to report: the workflow node supplied these, so this is a wiring
    // mistake in the editor rather than anything the tenant's code did.
    return { ok: false, error: `Cannot call ${capabilityId}: ${checked.errors.join(', ')}` };
  }

  // A connected booking calendar answers the availability capabilities in
  // place of the hosted connector. It returns null when there is none, and the
  // call carries on to the connector exactly as before.
  if (booking.handles(capabilityId)) {
    const answered = await booking.dispatch(companyId, capabilityId, checked.value, options);
    if (answered) {
      return answered;
    }
  }

  const settings = await hostedSettingsFor(companyId);

  if (!settings) {
    return { ok: false, error: 'No connector is set up for this company' };
  }

  if (settings.capabilities.length > 0 && !settings.capabilities.includes(capabilityId)) {
    return {
      ok: false,
      error: `Your connector does not implement ${capabilityId}`,
      notImplemented: true
    };
  }

  const key = cacheKey(companyId, capabilityId, checked.value);

  if (capability.kind === 'read') {
    const cached = readCache(key);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const check = safeHttp.validateUrl(settings.url);

  if (!check.valid) {
    return { ok: false, error: explainAddress(check.error, settings.url) };
  }

  const body = JSON.stringify({ capability: capabilityId, input: checked.value });
  const timestamp = Math.floor(Date.now() / 1000);

  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    accept: 'application/json',
    'x-connector-capability': capabilityId
  };

  // Added only when there is one, rather than set to undefined — an undefined
  // header value is sent as the literal string "undefined", which the SDK would
  // then reject as a malformed signature and blame the tenant for.
  if (settings.secret) {
    headers['x-connector-signature'] = sign(body, settings.secret, timestamp);
  }

  try {
    const response = await safeHttp.request(
      check.url,
      { method: 'POST', headers },
      body,
      options.timeoutMs || CALL_TIMEOUT_MS
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let message = `The connector returned ${response.statusCode}`;

      try {
        const parsed = JSON.parse(response.body);
        if (parsed.error) {
          // Passed through: this is the tenant's own message about their own
          // code, and it is far more useful than a status code.
          message = parsed.error;
        }
      } catch {
        // Not JSON; the status code is all we have.
      }

      return { ok: false, error: message, status: response.statusCode };
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { ok: false, error: 'The connector did not return JSON' };
    }

    const validated = capabilities.validateResult(capabilityId, parsed.result, {
      maxItems: options.maxItems
    });

    if (!validated.ok) {
      // Checked rather than trusted, so a mis-shaped response is a clear
      // message now instead of a blank product card three steps later.
      logger.warn('Connector returned an unusable shape', {
        companyId: String(companyId),
        capability: capabilityId,
        errors: validated.errors
      });

      return {
        ok: false,
        error: `Your connector's response did not match the contract: ${validated.errors.slice(0, 3).join('; ')}`
      };
    }

    const result = {
      ok: true,
      value: validated.value,
      warnings: validated.warnings,
      truncated: validated.truncated
    };

    if (capability.kind === 'read') {
      writeCache(key, result);
    }

    return result;
  } catch (error) {
    logger.warn('Connector call failed', {
      companyId: String(companyId),
      capability: capabilityId,
      error: error.message
    });
    return { ok: false, error: explainAddress(error.message, settings.url) };
  }
}

module.exports = {
  call,
  discover,
  explainAddress,
  sign,
  generateSecret,
  settingsFor,
  hostedSettingsFor,
  clearCache,
  CACHE_TTL_MS
};
