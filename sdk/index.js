/**
 * The connector SDK.
 *
 * A tenant installs this, implements the methods that apply to their business,
 * and exposes the result at one URL. From then on their chatbot can search
 * their catalogue, show a product with its picture, offer real appointment
 * times and book one.
 *
 * Everything that is fiddly and easy to get wrong is handled here rather than
 * left to them:
 *
 *   - verifying that a request really came from the platform, in constant time,
 *     with a timestamp window so an old request cannot be replayed
 *   - answering the discovery request, so the platform knows what they
 *     implemented without anybody maintaining a list by hand
 *   - shaping and checking what their methods return, so a mistake is a clear
 *     message at their end rather than a blank product card at ours
 *
 * The only thing they write is the part only they can know: how to get a
 * product out of their own database.
 *
 * Deliberately dependency-free and framework-agnostic. It returns a plain
 * `(req, res)` handler that works with Express, Fastify's raw handler, or
 * node:http on its own — a tenant should not have to adopt anything to
 * implement four functions.
 */

const crypto = require('crypto');

const SDK_VERSION = '0.1.0';

/** Kept in step with config/capabilities.js on the platform side. */
const CAPABILITY_METHODS = {
  searchCatalog: 'catalog.search',
  getProduct: 'catalog.get',
  listSlots: 'availability.slots',
  bookSlot: 'availability.book'
};

/**
 * How far out of step a request's timestamp may be.
 *
 * Five minutes covers ordinary clock drift between two servers. Wider than that
 * and a captured request stays usable for longer than it should.
 */
const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Verify that a request came from the platform.
 *
 * The signature covers the timestamp as well as the body, so an old request
 * cannot be replayed with its timestamp edited to look current.
 */
function verifySignature(rawBody, header, secret) {
  if (!secret) {
    return { ok: false, reason: 'no secret configured on this connector' };
  }

  if (!header) {
    return { ok: false, reason: 'the request was not signed' };
  }

  const parts = Object.fromEntries(
    String(header).split(',').map(part => part.split('=').map(piece => piece.trim()))
  );

  const timestamp = Number(parts.t);
  const provided = String(parts.v1 || '');

  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'the signature had no usable timestamp' };
  }

  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    // Rejected even if the signature is valid: this is what makes a captured
    // request stop working rather than working forever.
    return { ok: false, reason: 'the request is too old' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // the comparison is constant-time because this is a secret.
  const ok = provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  return ok ? { ok: true } : { ok: false, reason: 'the signature did not match' };
}

/** Read the whole body, with a cap so a request cannot exhaust memory. */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && typeof req.body === 'string') {
      return resolve(req.body);
    }

    // Express with a JSON parser in front has already consumed the stream and
    // left a parsed object. Re-serialising it would not reproduce the exact
    // bytes that were signed, so that case is refused with an explanation
    // rather than failing as a bad signature and wasting somebody's afternoon.
    if (req.body !== undefined && typeof req.body === 'object') {
      return reject(new Error(
        'The request body was already parsed, so the signature cannot be checked ' +
        'against the original bytes. Mount this handler before express.json(), ' +
        'or use express.raw({ type: "*/*" }) on this route.'
      ));
    }

    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        return reject(new Error('The request body was too large'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Shape one value the way the platform expects it.
 *
 * Applied to what a tenant's method returns so small differences — a price as a
 * number, a date as a Date object — are absorbed here instead of becoming a
 * validation failure at the far end.
 */
function coerce(value, spec) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  switch (spec) {
  case 'string':
    return String(value);
  case 'number':
    return Number(value);
  case 'boolean':
    return Boolean(value);
  case 'date':
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  default:
    return value;
  }
}

const SHAPES = {
  Product: {
    id: 'string', title: 'string', price: 'string', currency: 'string',
    image: 'string', url: 'string', description: 'string', inStock: 'boolean'
  },
  Slot: {
    id: 'string', startsAt: 'date', endsAt: 'date', label: 'string', staff: 'string'
  },
  Booking: {
    id: 'string', startsAt: 'date', reference: 'string', status: 'string'
  }
};

const RETURNS = {
  'catalog.search': { list: 'Product' },
  'catalog.get': { one: 'Product' },
  'availability.slots': { list: 'Slot' },
  'availability.book': { one: 'Booking' }
};

function shape(value, typeName) {
  const fields = SHAPES[typeName];
  const out = {};

  Object.entries(fields).forEach(([field, spec]) => {
    const coerced = coerce(value ? value[field] : undefined, spec);
    if (coerced !== undefined) {
      out[field] = coerced;
    }
  });

  return out;
}

/**
 * Build the connector.
 *
 * @param {object} methods the ones this business has. Anything left out is
 *        simply not offered — a shop with no appointments implements the two
 *        catalogue methods and nothing else.
 * @param {object} options `secret` is the signing secret from the dashboard;
 *        without it the connector refuses every request rather than serving
 *        a tenant's product data to anyone who finds the URL.
 * @returns {Function} an (req, res) handler
 */
function createConnector(methods = {}, options = {}) {
  const secret = options.secret || process.env.CHATBOT_CONNECTOR_SECRET;

  const implemented = Object.keys(CAPABILITY_METHODS)
    .filter(method => typeof methods[method] === 'function')
    .map(method => CAPABILITY_METHODS[method]);

  if (implemented.length === 0) {
    throw new Error(
      'A connector with no methods does nothing. Implement at least one of: ' +
      Object.keys(CAPABILITY_METHODS).join(', ')
    );
  }

  const byCapability = Object.fromEntries(
    Object.entries(CAPABILITY_METHODS)
      .filter(([method]) => typeof methods[method] === 'function')
      .map(([method, capability]) => [capability, methods[method]])
  );

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    });
    res.end(body);
  };

  return async function handler(req, res) {
    try {
      // Discovery. Answered without a signature on purpose: it lists which
      // capabilities exist and nothing about the business, and requiring a
      // signature here would make "is my connector reachable?" impossible to
      // answer with a browser.
      if (req.method === 'GET') {
        return send(res, 200, {
          protocol: 'chatbot-platform/connector',
          version: SDK_VERSION,
          capabilities: implemented,
          signed: Boolean(secret)
        });
      }

      if (req.method !== 'POST') {
        return send(res, 405, { error: 'Use POST to call a capability, or GET to discover one.' });
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }

      const verified = verifySignature(
        raw,
        req.headers['x-connector-signature'] || req.headers['X-Connector-Signature'],
        secret
      );

      if (!verified.ok) {
        // Deliberately specific. This is a developer integrating, not an
        // attacker probing — "unauthorised" with no reason is how people give
        // up on an integration.
        return send(res, 401, { error: `Rejected: ${verified.reason}` });
      }

      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'The request body was not valid JSON' });
      }

      const capability = payload.capability;
      const method = byCapability[capability];

      if (!method) {
        return send(res, 404, {
          error: `This connector does not implement ${capability}`,
          capabilities: implemented
        });
      }

      const result = await method(payload.input || {}, { capability, raw: payload });
      const returns = RETURNS[capability];

      const shaped = returns.list
        ? (Array.isArray(result) ? result : []).map(item => shape(item, returns.list))
        : shape(result, returns.one);

      return send(res, 200, { capability, result: shaped });
    } catch (error) {
      // The message is passed through because the only caller is the platform,
      // which shows it to the tenant who wrote this code and needs to know what
      // their method threw.
      return send(res, 500, { error: error.message || 'The connector threw an error' });
    }
  };
}

module.exports = {
  createConnector,
  verifySignature,
  SDK_VERSION,
  CAPABILITY_METHODS,
  MAX_CLOCK_SKEW_SECONDS
};
