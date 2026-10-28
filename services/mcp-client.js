/**
 * A client for a tenant's remote MCP servers.
 *
 * MCP (the Model Context Protocol) is the second way, after a REST call, that
 * the systems our tenants run publish what an AI agent may do in them —
 * Shopify, Stripe, HubSpot, Zapier and Notion all host one. A tenant pastes a
 * server's URL, we list its tools, they switch on the ones the assistant may
 * use, and services/assistant-tools.js offers those to the model with the same
 * guarantees as a saved Action.
 *
 * Only the Streamable HTTP transport, and only what a tool-using client needs:
 * finding out what the server speaks, listing its tools, calling one. No stdio
 * (we will not run a tenant's process), no resources, prompts, sampling or
 * elicitation. The client declares no capabilities, so a conforming server
 * never asks it for any.
 *
 * Two eras of the protocol are in use, and servers in the wild speak both:
 *
 *   modern  2026-07-28 onwards. Stateless: every request carries its protocol
 *           version and the client's details in `_meta`, mirrored into the
 *           `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers.
 *   legacy  2025-03-26 to 2025-11-25. An `initialize` handshake, then the
 *           `notifications/initialized` notification, and an `Mcp-Session-Id`
 *           the server may hand out and expects back on every later request.
 *
 * As the specification recommends for a client that talks to both, a modern
 * request goes first and the legacy handshake follows only when the refusal
 * is not a recognised modern error. Which one worked is stored on the server's
 * record, so a tool call does not probe again; a call that fails the way a
 * server that changed eras would makes it probe once and retry.
 *
 * Either era may answer a POST with one JSON object or with a stream of
 * server-sent events ending in the response. Both are handled, and a stream is
 * closed as soon as the response carrying our request's id has arrived.
 *
 * Every request goes through services/safe-http.js: the address is checked at
 * connect time against private and cloud-metadata ranges, each redirect is
 * re-checked and loses the credential if it leaves the host, and the response
 * is size-capped. On top of that a hard deadline (15 seconds by default)
 * aborts a server that holds a stream open with keep-alives.
 *
 * Servers that need an OAuth sign-in are out of scope for now. A server is
 * reached with no credential, a bearer token or one custom header, and the
 * secret is stored encrypted by services/secrets.js.
 */

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const safeHttp = require('./safe-http');
const secrets = require('./secrets');
const { logger } = require('./logging');

const MODERN_VERSION = '2026-07-28';
// Newest first: the first one a legacy server agrees to is the one used.
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const DEFAULT_TIMEOUT_MS = 15000;
// The modern probe. A server that does not speak the modern era answers it
// at once with an error; one that says nothing for this long is down, not old.
const PROBE_TIMEOUT_MS = 8000;
const CLOSE_TIMEOUT_MS = 3000;
// A tools/list page with forty tools and their schemas is easily 100 KB, so
// this is larger than safe-http's API-shaped default.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 200;
const MAX_STORED_SCHEMA_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 4000;
// A legacy stream that drops before the response may be resumed. A couple of
// attempts inside the same deadline is the most a visitor should wait for.
const MAX_RESUMES = 2;
const DEFAULT_RETRY_MS = 500;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const MAX_CACHED_CONNECTIONS = 200;

const CLIENT_INFO = { name: 'chatbot-platform', version: '1.0.0' };
const USER_AGENT = 'chatbot-platform-mcp-client/1.0';

// The sub-range -32020 to -32099 belongs to the specification. Any of these in
// a refusal proves the server speaks the modern era.
const HEADER_MISMATCH = -32020;
const MISSING_CAPABILITY = -32021;
const UNSUPPORTED_VERSION = -32022;
const MODERN_ERRORS = new Set([HEADER_MISMATCH, MISSING_CAPABILITY, UNSUPPORTED_VERSION]);

// RFC 9110 token characters: what a header name may be made of.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// An Mcp-Session-Id is visible ASCII only. Anything else is refused rather than
// echoed back into a header.
const SESSION_ID = /^[\x21-\x7E]{1,512}$/;

/**
 * A failure talking to an MCP server, worded for the admin who has to fix it.
 *
 * `kind` says whose problem it is: `config` (ours to fix in the form),
 * `network` (the address), `timeout`, `http` (a status code), `rpc` (a
 * JSON-RPC error from the server) or `protocol` (it answered, but not in MCP).
 */
class McpError extends Error {
  constructor(message, { kind = 'protocol', status, code, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function seconds(ms) {
  const count = Math.max(1, Math.ceil(ms / 1000));
  return `${count} second${count === 1 ? '' : 's'}`;
}

function clip(text, max) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ------------------------------------------------------------------ the URL

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Check a server URL an admin typed, before anything is stored or sent.
 *
 * https only. Plain http sends the tenant's token in clear text, so it is
 * accepted only for a local server outside production, and even then only
 * where safe-http has been told plain http is wanted (ACTIONS_ALLOW_HTTP) —
 * its connect-time address guard still refuses loopback, so in practice that
 * means the test suite. A server being built on a laptop is reached through a
 * tunnel, the same advice the connector gives.
 *
 * @returns {{valid: boolean, error?: string, url?: URL}}
 */
function validateServerUrl(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return { valid: false, error: 'Enter the server\'s URL' };
  }
  if (raw.length > 2000) {
    return { valid: false, error: 'That URL is too long' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'Enter a full URL, including https://' };
  }

  if (url.username || url.password) {
    // It would be shown in the dashboard and written to logs. Credentials
    // belong under Authentication, where they are encrypted.
    return { valid: false, error: 'Put the credential under Authentication, not in the URL' };
  }

  if (url.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(url.hostname) || process.env.NODE_ENV === 'production') {
      return { valid: false, error: 'Use https:// — a token sent over http can be read in transit' };
    }
  } else if (url.protocol !== 'https:') {
    return { valid: false, error: 'An MCP server URL starts with https://' };
  }

  // Never sent, and it would make two spellings of one server look different.
  url.hash = '';

  const check = safeHttp.validateUrl(url.toString());
  if (!check.valid) {
    return { valid: false, error: check.error };
  }

  return { valid: true, url: check.url };
}

/**
 * What to tell the admin about a refused address.
 *
 * The block cannot be lifted — a URL a tenant typed is an SSRF hazard whoever
 * typed it — so say what works instead.
 */
function explainAddress(message) {
  if (!/private or reserved/i.test(message || '')) {
    return message;
  }
  return `${message}. We have to be able to reach the server from the internet: if it runs on your own ` +
    'machine, expose it with a tunnel (ngrok, Cloudflare Tunnel) and use that https URL.';
}

// ----------------------------------------------------------- authentication

// Headers a tenant's custom auth header may not replace: they carry the
// protocol itself, or are the transport's business.
const RESERVED_HEADERS = /^(host|content-type|content-length|accept|accept-encoding|connection|transfer-encoding|user-agent|cookie|last-event-id|mcp-[a-z0-9-]*)$/i;

/** Whether a custom auth header name can be used. */
function validHeaderName(name) {
  const value = String(name || '');
  return value.length > 0 && value.length <= 64 && TOKEN.test(value) && !RESERVED_HEADERS.test(value);
}

/** Whether a secret can go in a header as it is: visible ASCII, spaces and tabs. */
function validSecret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x20-\x7E\t]+$/.test(value);
}

/**
 * The headers that authenticate us to a server, with the secret decrypted.
 *
 * @throws {McpError} when a secret is configured but cannot be decrypted —
 *         sending the request without it would only earn a confusing 401
 */
function authHeaders(auth = {}) {
  const type = auth.type || 'none';

  if (type === 'none') {
    return {};
  }

  const secret = secrets.decrypt(auth.secret);
  if (!secret) {
    throw new McpError('The saved credential could not be read. Enter it again under Authentication.', { kind: 'config' });
  }

  if (type === 'bearer') {
    return { authorization: `Bearer ${secret}` };
  }
  if (type === 'header' && validHeaderName(auth.headerName)) {
    return { [auth.headerName]: secret };
  }
  throw new McpError('The authentication settings are incomplete. Check the header name.', { kind: 'config' });
}

// ------------------------------------------------------- server-sent events

/**
 * Reads an SSE stream until the response to one request arrives.
 *
 * Fed chunk by chunk as they arrive, because the stream need not end after
 * the response — the server only SHOULD close it — and waiting for the end of
 * a stream that is kept alive would mean waiting for the deadline every time.
 *
 * Follows the SSE parsing rules: lines end in CR, LF or CRLF; `data:` lines
 * join with a newline; comment lines (a leading colon) are keep-alives; an
 * event with no data — a legacy server's priming event — is skipped.
 */
class SseReader {
  constructor(requestId, { onRequest } = {}) {
    this.requestId = requestId;
    this.onRequest = onRequest;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.data = [];
    this.lastEventId = null;
    this.retryMs = null;
    this.response = null;
  }

  /** @returns {boolean} true once the response has arrived */
  push(chunk) {
    this.buffer += this.decoder.write(chunk);

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) {
        break;
      }
      // A CR as the very last character may be the first half of a CRLF
      // split across two chunks; wait for the next one to know.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) {
        break;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
      if (this.response) {
        return true;
      }
    }

    return Boolean(this.response);
  }

  line(line) {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'data') {
      this.data.push(value);
    } else if (field === 'id' && !value.includes('\0')) {
      this.lastEventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      this.retryMs = Number(value);
    }
    // `event` is ignored: MCP sends every message as the default event type.
  }

  dispatch() {
    const data = this.data.join('\n');
    this.data = [];
    if (!data) {
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    (Array.isArray(message) ? message : [message]).forEach(entry => this.accept(entry));
  }

  accept(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.id === this.requestId && ('result' in message || 'error' in message)) {
      this.response = message;
      return;
    }
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null && this.onRequest) {
      this.onRequest(message);
    }
    // Notifications (progress, log messages) are not something we act on.
  }

  /** The stream ended: an unterminated last event is read rather than lost. */
  finish() {
    this.buffer += this.decoder.end();
    if (this.buffer) {
      this.line(this.buffer);
      this.buffer = '';
    }
    if (this.data.length > 0) {
      this.dispatch();
    }
  }
}

function isEventStream(headers) {
  return /text\/event-stream/i.test(String((headers && headers['content-type']) || ''));
}

function isJson(headers) {
  return /application\/(.+\+)?json/i.test(String((headers && headers['content-type']) || ''));
}

// ----------------------------------------------------------------- headers

/**
 * A value as an HTTP header can carry it.
 *
 * Plain when it is visible ASCII with no leading or trailing whitespace;
 * otherwise base64 inside the `=?base64?…?=` sentinel the specification
 * defines. A plain value that happens to look like the sentinel is encoded
 * too, so it cannot be mistaken for one.
 */
function encodeHeaderValue(value) {
  const text = String(value);
  if (text === '') {
    return '';
  }
  const plain = /^[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?$/.test(text) &&
    !(text.startsWith('=?base64?') && text.endsWith('?='));
  return plain ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

// Keywords whose value is a map of name to schema, rather than a schema.
const MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
// Keywords whose value is data, which may legitimately contain anything.
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);

function countHeaderAnnotations(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 32) {
    return 0;
  }
  if (Array.isArray(node)) {
    return node.reduce((total, item) => total + countHeaderAnnotations(item, depth + 1), 0);
  }

  let total = Object.prototype.hasOwnProperty.call(node, 'x-mcp-header') ? 1 : 0;
  Object.entries(node).forEach(([key, value]) => {
    if (key === 'x-mcp-header' || DATA_KEYWORDS.has(key)) {
      return;
    }
    if (MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      total += Object.values(value).reduce((sum, child) => sum + countHeaderAnnotations(child, depth + 1), 0);
    } else {
      total += countHeaderAnnotations(value, depth + 1);
    }
  });
  return total;
}

/**
 * The tool parameters a modern server wants mirrored into `Mcp-Param-*`
 * headers, or why the tool definition has to be refused.
 *
 * A client MUST mirror them, and MUST drop a tool whose annotations break the
 * rules: a name that is not a header token, a duplicate, a non-primitive (or
 * `number`) type, or an annotation not reachable from the root through
 * `properties` alone.
 *
 * @returns {{params?: Array<{path: string[], header: string}>, error?: string}}
 */
function headerParams(schema) {
  const params = [];
  const names = new Set();
  let problem = null;

  const walk = (node, path) => {
    const properties = node && typeof node === 'object' ? node.properties : null;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties) || path.length > 16) {
      return;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (problem) {
        return;
      }
      if (!child || typeof child !== 'object') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(child, 'x-mcp-header')) {
        const header = child['x-mcp-header'];
        if (typeof header !== 'string' || !TOKEN.test(header)) {
          problem = `the x-mcp-header on "${key}" is not a valid header name`;
          return;
        }
        if (names.has(header.toLowerCase())) {
          problem = `the x-mcp-header "${header}" is used twice`;
          return;
        }
        if (!['string', 'integer', 'boolean'].includes(child.type)) {
          problem = `the x-mcp-header on "${key}" is not on a string, integer or boolean`;
          return;
        }
        names.add(header.toLowerCase());
        params.push({ path: [...path, key], header });
      }
      walk(child, [...path, key]);
    }
  };

  walk(schema, []);

  if (problem) {
    return { error: problem };
  }
  if (countHeaderAnnotations(schema) !== params.length) {
    return { error: 'an x-mcp-header annotation is not reachable from the schema root through properties alone' };
  }
  return { params };
}

/** The `Mcp-Param-*` headers for one call's arguments. */
function paramHeaders(params, args) {
  const headers = {};

  (params || []).forEach(({ path, header }) => {
    let value = args;
    for (const key of path) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
    }
    if (value === undefined || value === null || typeof value === 'object') {
      return;
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      return;
    }
    headers[`Mcp-Param-${header}`] = encodeHeaderValue(typeof value === 'boolean' ? String(value) : value);
  });

  return headers;
}

// ---------------------------------------------------------------- results

/**
 * A JSON-RPC response's result, or the reason it has none.
 *
 * A modern result says what kind it is in `resultType`; an absent one is a
 * legacy server's and means complete. `input_required` is a server asking for
 * something only a person at a client could give (an elicitation, a model
 * call) — we cannot, so it is reported rather than answered.
 */
function unwrap(reply) {
  if (reply.error) {
    const code = typeof reply.error.code === 'number' ? reply.error.code : undefined;
    throw new McpError(clip(reply.error.message || `The server returned error ${code}`, 300), {
      kind: 'rpc', code, data: reply.error.data
    });
  }

  const result = reply.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new McpError('The server answered with something that is not an MCP result');
  }

  const type = result.resultType === undefined ? 'complete' : result.resultType;
  if (type === 'input_required') {
    throw new McpError('The server asked for more input before it would finish (a question for the person or a model call), which the assistant cannot provide.');
  }
  if (type !== 'complete') {
    throw new McpError(`The server answered with a result of type "${clip(type, 40)}", which this client does not understand`);
  }

  return result;
}

/**
 * What a tools/call result says, as text a model can read.
 *
 * Text and embedded text resources are kept; images and audio are noted but
 * not passed on (the assistant answers in words); a resource link is its name
 * and address. When there is no text but there is structured content, that is
 * the answer.
 */
function readResult(result) {
  const parts = [];

  (Array.isArray(result.content) ? result.content : []).forEach(block => {
    if (!block || typeof block !== 'object') {
      return;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      parts.push(typeof block.resource.text === 'string'
        ? block.resource.text
        : `[${clip(block.resource.mimeType || 'binary', 60)} content omitted]`);
    } else if (block.type === 'resource_link') {
      parts.push(`[link: ${clip(block.name || block.title || '', 120)} ${clip(block.uri || '', 500)}]`.replace(/\s+\]$/, ']'));
    } else if (block.type === 'image' || block.type === 'audio') {
      parts.push(`[${block.type} omitted]`);
    }
  });

  let text = parts.join('\n\n').trim();
  if (!text && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
  }

  return {
    isError: result.isError === true,
    text,
    structured: result.structuredContent
  };
}

/**
 * Check one tool definition from tools/list, and keep what we store.
 *
 * Lenient where the server is merely untidy (a missing schema is read as "any
 * object"), strict where using the tool would go wrong: no name, a schema too
 * big to store, or `x-mcp-header` annotations that break the rules.
 *
 * @returns {{tool?: object, warning?: string}}
 */
function checkTool(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name || raw.name.length > 128) {
    return { warning: 'A tool without a usable name was skipped' };
  }

  const name = raw.name;
  let schema = raw.inputSchema;
  if (schema === undefined) {
    schema = { type: 'object' };
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { warning: `"${clip(name, 60)}" was skipped: its input schema is not a JSON Schema object` };
  }

  let serialised;
  try {
    serialised = JSON.stringify(schema);
  } catch {
    return { warning: `"${clip(name, 60)}" was skipped: its input schema could not be read` };
  }
  if (Buffer.byteLength(serialised) > MAX_STORED_SCHEMA_BYTES) {
    return { warning: `"${clip(name, 60)}" was skipped: its input schema is larger than 64 KB` };
  }

  const headers = headerParams(schema);
  if (headers.error) {
    logger.warn('MCP tool refused for an invalid x-mcp-header', { tool: clip(name, 128), reason: headers.error });
    return { warning: `"${clip(name, 60)}" was skipped: ${headers.error}` };
  }

  const annotations = raw.annotations && typeof raw.annotations === 'object' ? raw.annotations : {};
  const title = typeof raw.title === 'string' ? raw.title
    : (typeof annotations.title === 'string' ? annotations.title : '');

  return {
    tool: {
      name,
      title: clip(title, 200),
      description: clip(typeof raw.description === 'string' ? raw.description : '', MAX_DESCRIPTION_CHARS),
      inputSchema: serialised,
      // Hints, and untrusted ones. They only choose defaults the admin sees
      // and can change; nothing is skipped because a server said so.
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: annotations.readOnlyHint === true ? false : annotations.destructiveHint !== false
    }
  };
}

// ------------------------------------------------------------ for the model

const SCHEMA_MAX_DEPTH = 8;
const SCHEMA_MAX_NODES = 400;
const SCHEMA_MAX_PROPERTIES = 60;
const SCHEMA_MAX_ENUM = 100;
const SCHEMA_MAX_BRANCHES = 10;
const SCHEMA_DESCRIPTION_CHARS = 300;
const MODEL_SCHEMA_BYTES = 8000;
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const NUMBER_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const COUNT_KEYWORDS = ['minLength', 'maxLength', 'minItems', 'maxItems'];

function isPrimitive(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

/** A `#/…` JSON pointer into the same schema, or null. Never a network fetch. */
function resolveLocalRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    return null;
  }
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    let part;
    try {
      part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return null;
    }
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) {
      return null;
    }
    node = node[part];
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? node : null;
}

function mergeSchema(target, source) {
  Object.entries(source).forEach(([key, value]) => {
    if (key === 'properties') {
      target.properties = { ...(target.properties || {}), ...value };
    } else if (key === 'required') {
      target.required = [...new Set([...(target.required || []), ...value])];
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  });
}

function sanitiseNode(node, ctx, depth) {
  ctx.nodes += 1;
  if (ctx.nodes > SCHEMA_MAX_NODES) {
    ctx.tooBig = true;
    return {};
  }
  // Past the depth cap, "anything" is the honest description.
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > SCHEMA_MAX_DEPTH) {
    return {};
  }

  const out = {};
  const description = typeof node.description === 'string' ? node.description
    : (typeof node.title === 'string' ? node.title : '');
  if (description && (ctx.descriptions || depth <= 1)) {
    out.description = clip(description, SCHEMA_DESCRIPTION_CHARS);
  }

  if (typeof node.$ref === 'string') {
    const target = resolveLocalRef(ctx.root, node.$ref);
    // Unresolvable, remote, or a cycle: accept anything here.
    if (!target || ctx.resolving.includes(node.$ref)) {
      return out;
    }
    ctx.resolving.push(node.$ref);
    const siblings = { ...node };
    delete siblings.$ref;
    const resolved = sanitiseNode({ ...target, ...siblings }, ctx, depth);
    ctx.resolving.pop();
    return resolved;
  }

  let type = node.type;
  if (Array.isArray(type)) {
    const types = type.filter(entry => SCHEMA_TYPES.has(entry));
    type = types.length === 1 ? types[0] : undefined;
  }
  if (SCHEMA_TYPES.has(type)) {
    out.type = type;
  }

  if (Array.isArray(node.enum)) {
    const values = node.enum.filter(isPrimitive).slice(0, SCHEMA_MAX_ENUM)
      .map(value => (typeof value === 'string' ? clip(value, 100) : value));
    if (values.length > 0) {
      out.enum = values;
    }
  } else if (isPrimitive(node.const)) {
    out.enum = [node.const];
  }
  if (isPrimitive(node.default)) {
    out.default = typeof node.default === 'string' ? clip(node.default, 200) : node.default;
  }
  if (typeof node.format === 'string' && node.format.length <= 40) {
    out.format = node.format;
  }
  if (typeof node.pattern === 'string' && node.pattern.length <= 200) {
    out.pattern = node.pattern;
  }
  NUMBER_KEYWORDS.forEach(key => {
    if (typeof node[key] === 'number' && Number.isFinite(node[key])) {
      out[key] = node[key];
    }
  });
  COUNT_KEYWORDS.forEach(key => {
    if (Number.isInteger(node[key]) && node[key] >= 0) {
      out[key] = node[key];
    }
  });
  if (typeof node.uniqueItems === 'boolean') {
    out.uniqueItems = node.uniqueItems;
  }

  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    out.properties = {};
    Object.entries(node.properties).slice(0, SCHEMA_MAX_PROPERTIES).forEach(([key, child]) => {
      out.properties[key] = sanitiseNode(child, ctx, depth + 1);
    });
    out.type = out.type || 'object';
  }
  if (Array.isArray(node.required) && out.properties) {
    const required = node.required.filter(key => typeof key === 'string' &&
      Object.prototype.hasOwnProperty.call(out.properties, key));
    if (required.length > 0) {
      out.required = [...new Set(required)];
    }
  }
  if (typeof node.additionalProperties === 'boolean') {
    out.additionalProperties = node.additionalProperties;
  } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.additionalProperties = sanitiseNode(node.additionalProperties, ctx, depth + 1);
  }

  // The tuple form keeps its first item's schema: looser, but still a list.
  const items = Array.isArray(node.items) ? node.items[0] : node.items;
  if (items && typeof items === 'object') {
    out.items = sanitiseNode(items, ctx, depth + 1);
    out.type = out.type || 'array';
  }
  if (out.type === 'array' && !out.items) {
    // Function-calling APIs refuse an array without `items`.
    out.items = {};
  }

  // `Optional[X]` arrives as anyOf [X, null]; the null branch says nothing a
  // model needs, so it goes before deciding whether a choice remains.
  const branches = [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : [])
  ].filter(branch => !(branch && branch.type === 'null')).slice(0, SCHEMA_MAX_BRANCHES);
  if (branches.length === 1) {
    mergeSchema(out, sanitiseNode(branches[0], ctx, depth + 1));
  } else if (branches.length > 1) {
    out.anyOf = branches.map(branch => sanitiseNode(branch, ctx, depth + 1));
  }
  if (Array.isArray(node.allOf)) {
    node.allOf.slice(0, SCHEMA_MAX_BRANCHES).forEach(branch => mergeSchema(out, sanitiseNode(branch, ctx, depth + 1)));
  }

  return out;
}

/**
 * A tool's input schema, rebuilt as something a model's function parameters
 * will accept.
 *
 * Function-calling APIs take a subset of JSON Schema, and an unsupported
 * keyword is not ignored: the whole request is refused, which would take the
 * assistant down for every conversation rather than the ones needing the
 * tool. So the schema is rebuilt from an allow-list instead of passed on:
 *
 *   - local `$ref`s (`#/$defs/…`) are inlined, which is how servers generated
 *     from typed models describe nested objects. A network `$ref` is never
 *     fetched — the specification forbids it by default — and a cycle stops
 *     at its second visit.
 *   - `oneOf` becomes `anyOf`, `allOf` is merged, and `not`, conditionals,
 *     pattern properties and the like are dropped. That loosens the schema,
 *     which is safe: the server validates its own input.
 *   - a list of types keeps its one non-null type; the top level is always
 *     an object, because a function's parameters are.
 *   - depth, property count, enum length and descriptions are capped, nested
 *     descriptions go if the result is still too big, and past that the tool
 *     is not offered at all.
 *
 * @param {string|object} input the stored schema
 * @returns {{ok: boolean, schema?: object, error?: string}}
 */
function modelSchema(input) {
  let root = input;
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Its input schema could not be read' };
    }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, error: 'Its input schema is not a JSON Schema object' };
  }

  for (const descriptions of [true, false]) {
    const ctx = { root, resolving: [], nodes: 0, tooBig: false, descriptions };
    const cleaned = sanitiseNode(root, ctx, 0);
    if (ctx.tooBig) {
      return { ok: false, error: 'Its input schema is too complex to offer the assistant' };
    }

    // Alternatives at the top cannot be expressed as one function's
    // parameters; offering the union of their fields, none required, is the
    // closest a model can use.
    const properties = { ...(cleaned.properties || {}) };
    (cleaned.anyOf || []).forEach(branch => {
      Object.entries(branch.properties || {}).forEach(([key, value]) => {
        if (!properties[key]) {
          properties[key] = value;
        }
      });
    });

    const schema = {
      type: 'object',
      properties,
      ...(cleaned.required ? { required: cleaned.required } : {}),
      ...(cleaned.additionalProperties === false ? { additionalProperties: false } : {})
    };

    if (Buffer.byteLength(JSON.stringify(schema)) <= MODEL_SCHEMA_BYTES) {
      return { ok: true, schema };
    }
  }

  return { ok: false, error: 'Its input schema is too large to offer the assistant, even simplified' };
}

/**
 * The name the model calls a tool by: `mcp_<server>_<tool>`.
 *
 * Function names may use letters, digits, `_` and `-`, up to 64 characters —
 * the strictest of the model APIs this may sit on. Anything else becomes `_`,
 * and a name that would be too long keeps its start and gains a short hash
 * of the original, so two long names sharing a prefix stay distinct.
 */
function assistantToolName(slug, toolName) {
  const name = `mcp_${slug}_${String(toolName || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (name.length <= 64) {
    return name;
  }
  const hash = crypto.createHash('sha256').update(String(toolName)).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

/**
 * A tool's top-level inputs, for the dashboard to list.
 *
 * @returns {Array<{name: string, type: string, description: string, required: boolean}>}
 */
function describeInputs(input) {
  const result = modelSchema(input);
  if (!result.ok) {
    return [];
  }
  const required = new Set(result.schema.required || []);
  return Object.entries(result.schema.properties).slice(0, 30).map(([name, schema]) => ({
    name,
    type: schema.enum ? `one of ${schema.enum.slice(0, 5).join(', ')}${schema.enum.length > 5 ? '…' : ''}` : (schema.type || 'any'),
    description: clip(schema.description || '', 200),
    required: required.has(name)
  }));
}

// -------------------------------------------------------------- connection

/**
 * One conversation with one server: its address, credential, era and, for a
 * legacy server, its session.
 *
 * Kept for a few minutes between tool calls (see `connectionFor`), so a
 * legacy server is not put through a fresh handshake for every question.
 */
class Connection {
  constructor({ url, headers = {}, era = null, version = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.url = url;
    this.headers = headers;
    // Dropped on a redirect to another host, like Authorization is.
    this.credentialHeaders = [...Object.keys(headers), 'mcp-session-id'];
    this.timeoutMs = timeoutMs;
    this.era = era;
    this.version = era ? version : null;
    this.sessionId = null;
    this.ready = false;
    this.starting = null;
    this.nextId = 1;
    this.serverInfo = null;
    this.lastUsed = Date.now();
  }

  // ------------------------------------------------------------- transport

  /**
   * POST one JSON-RPC message and read the reply.
   *
   * @returns {Promise<{reply?: object, headers: object, status: number}>}
   */
  async exchange(message, { headers = {}, timeoutMs = this.timeoutMs, expectReply = true } = {}) {
    const deadline = Date.now() + timeoutMs;
    const body = JSON.stringify(message);
    const reader = new SseReader(message.id, { onRequest: request => this.answerServerRequest(request) });

    const response = await this.send({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': USER_AGENT,
        ...this.headers,
        ...headers,
        'content-length': Buffer.byteLength(body)
      },
      body,
      deadline,
      reader: expectReply ? reader : null
    });

    const { statusCode: status } = response;

    if (status < 200 || status >= 300) {
      throw httpError(status, response);
    }
    if (!expectReply) {
      return { status, headers: response.headers };
    }

    if (isEventStream(response.headers)) {
      if (!response.stoppedEarly) {
        reader.finish();
      }
      if (!reader.response && this.era === 'legacy') {
        await this.resume(reader, deadline);
      }
      if (!reader.response) {
        throw new McpError('The server closed its event stream without answering');
      }
      return { reply: reader.response, headers: response.headers, status };
    }

    if (isJson(response.headers) || /^\s*[[{]/.test(response.body || '')) {
      let parsed;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new McpError('The server answered with JSON that could not be read');
      }
      // Legacy servers could batch; we never send a batch, but read one.
      const reply = (Array.isArray(parsed) ? parsed : [parsed])
        .find(entry => entry && entry.id === message.id && ('result' in entry || 'error' in entry));
      if (!reply) {
        throw new McpError('The server\'s answer did not match the request');
      }
      return { reply, headers: response.headers, status };
    }

    throw new McpError(
      `The server answered with ${clip(response.headers['content-type'] || 'no content type', 60)}, not MCP. ` +
      'Is that the MCP endpoint? It often ends in /mcp.'
    );
  }

  /** One HTTP request through safe-http, aborted at the deadline. */
  async send({ method, headers, body = null, deadline, reader = null }) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new McpError(`The server did not answer within ${seconds(this.timeoutMs)}`, { kind: 'timeout' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      return await safeHttp.request(this.url, {
        method,
        headers,
        maxBytes: MAX_RESPONSE_BYTES,
        signal: controller.signal,
        credentialHeaders: this.credentialHeaders,
        onData: reader
          ? (chunk, { statusCode, headers: responseHeaders }) =>
            statusCode >= 200 && statusCode < 300 && isEventStream(responseHeaders) && reader.push(chunk)
          : undefined
      }, body, remaining);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpError(`The server did not answer within ${seconds(this.timeoutMs)}`, { kind: 'timeout' });
      }
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(explainAddress(networkMessage(error)), { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pick a legacy stream up where it dropped.
   *
   * A legacy server may close the connection mid-stream once it has sent an
   * event id, expecting the client to reconnect with `Last-Event-ID` after
   * the `retry` interval it gave. Tried a couple of times within the same
   * deadline; a wait longer than the time left is not attempted at all.
   */
  async resume(reader, deadline) {
    for (let attempt = 0; attempt < MAX_RESUMES && reader.lastEventId && !reader.response; attempt += 1) {
      const wait = reader.retryMs === null ? DEFAULT_RETRY_MS : reader.retryMs;
      if (Date.now() + wait >= deadline) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, wait));

      const response = await this.send({
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
          ...this.headers,
          ...this.legacyHeaders(),
          'last-event-id': reader.lastEventId
        },
        deadline,
        reader
      });

      if (response.statusCode < 200 || response.statusCode >= 300 || !isEventStream(response.headers)) {
        return;
      }
      if (!response.stoppedEarly) {
        reader.finish();
      }
    }
  }

  /**
   * Answer a request a legacy server sent on a stream.
   *
   * We declared no capabilities, so the only one a conforming server sends is
   * a ping. Anything else is told it does not exist, rather than left to hang
   * the tool call it arrived in the middle of. Modern servers never send
   * requests at all.
   */
  answerServerRequest(request) {
    if (this.era !== 'legacy') {
      return;
    }
    const reply = request.method === 'ping'
      ? { jsonrpc: '2.0', id: request.id, result: {} }
      : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    const body = JSON.stringify(reply);

    this.send({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': USER_AGENT,
        ...this.headers,
        ...this.legacyHeaders(),
        'content-length': Buffer.byteLength(body)
      },
      body,
      deadline: Date.now() + CLOSE_TIMEOUT_MS
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ eras

  legacyHeaders() {
    return {
      ...(this.version ? { 'mcp-protocol-version': this.version } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
    };
  }

  /**
   * Work out which era the server speaks, and get ready to use it.
   *
   * Modern first, by asking for `server/discover`. A recognised modern error
   * settles it the other way only when it names versions we can fall back to;
   * a 401 or 403 is about the credential, which a handshake would not fix;
   * an unreachable address is unreachable in either era. Anything else — a
   * 4xx without a modern error, "method not found", an answer that is not a
   * result — is a legacy server, and gets the handshake.
   */
  async negotiate() {
    if (!this.starting) {
      this.starting = this.probe().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async probe() {
    this.era = 'modern';
    this.version = MODERN_VERSION;
    this.sessionId = null;
    this.ready = false;

    let result = null;
    let legacyVersion = LEGACY_VERSIONS[0];

    try {
      result = await this.modernRequest('server/discover', {}, {
        timeoutMs: Math.min(this.timeoutMs, PROBE_TIMEOUT_MS)
      });
    } catch (error) {
      if (error.code === UNSUPPORTED_VERSION) {
        // Modern, but not our modern version: perhaps a legacy one we share.
        legacyVersion = this.sharedLegacyVersion(error.data && error.data.supported);
      } else if (MODERN_ERRORS.has(error.code) || ['config', 'network', 'timeout'].includes(error.kind) ||
        error.status === 401 || error.status === 403) {
        this.era = null;
        throw error;
      }
      // Anything else is a legacy server refusing a request it does not know.
    }

    if (result) {
      const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
      if (supported.length === 0 || supported.includes(MODERN_VERSION)) {
        const meta = result._meta && typeof result._meta === 'object' ? result._meta : {};
        this.serverInfo = meta['io.modelcontextprotocol/serverInfo'] || null;
        this.ready = true;
        return;
      }
      legacyVersion = this.sharedLegacyVersion(supported);
    }

    await this.initialize(legacyVersion);
  }

  /** The newest legacy version a server says it supports, if we speak it too. */
  sharedLegacyVersion(supported) {
    const list = Array.isArray(supported) ? supported : [];
    const shared = LEGACY_VERSIONS.find(version => list.includes(version));
    if (!shared) {
      this.era = null;
      throw noCommonVersion(list);
    }
    return shared;
  }

  /** The legacy handshake: initialize, then notifications/initialized. */
  async initialize(requested) {
    this.era = 'legacy';
    this.version = null;
    this.sessionId = null;
    this.ready = false;

    const id = this.nextId++;
    // No MCP-Protocol-Version header yet: it is for the requests after the
    // version has been agreed.
    const { reply, headers } = await this.exchange({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: requested, capabilities: {}, clientInfo: CLIENT_INFO }
    });
    const result = unwrap(reply);

    if (!LEGACY_VERSIONS.includes(result.protocolVersion)) {
      // The server picked a version we do not speak. The specification's
      // advice is to disconnect.
      this.era = null;
      throw new McpError(`The server speaks MCP ${clip(result.protocolVersion, 20) || '(no version)'}, which this client does not support`);
    }
    this.version = result.protocolVersion;

    const sessionId = headers['mcp-session-id'];
    if (sessionId !== undefined) {
      if (!SESSION_ID.test(String(sessionId))) {
        this.era = null;
        throw new McpError('The server sent a session id that is not valid');
      }
      this.sessionId = String(sessionId);
    }
    this.serverInfo = result.serverInfo || null;

    await this.exchange(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers: this.legacyHeaders(), expectReply: false }
    );
    this.ready = true;
  }

  async ensureReady() {
    this.lastUsed = Date.now();
    if (this.ready) {
      return;
    }
    if (this.era === 'legacy' && this.version) {
      // A known legacy server whose session was dropped: the handshake again,
      // at the version it agreed to last time.
      if (!this.starting) {
        this.starting = this.initialize(this.version).finally(() => {
          this.starting = null;
        });
      }
      await this.starting;
      return;
    }
    if (this.era === 'modern') {
      // Stateless: nothing to set up.
      this.ready = true;
      return;
    }
    await this.negotiate();
  }

  // -------------------------------------------------------------- requests

  /** A request in the modern era: `_meta` in the body, mirrored in headers. */
  async modernRequest(method, params = {}, { timeoutMs, headers = {} } = {}) {
    const id = this.nextId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...(params._meta || {}),
          'io.modelcontextprotocol/protocolVersion': this.version,
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    };
    const name = params.name !== undefined ? params.name : params.uri;

    const { reply } = await this.exchange(message, {
      timeoutMs,
      headers: {
        'mcp-protocol-version': this.version,
        'mcp-method': method,
        ...(name !== undefined ? { 'mcp-name': encodeHeaderValue(name) } : {}),
        ...headers
      }
    });
    return unwrap(reply);
  }

  /** A request in the legacy era, starting a fresh session if it expired. */
  async legacyRequest(method, params = {}, { timeoutMs } = {}) {
    const session = this.sessionId;
    try {
      const { reply } = await this.exchange(
        { jsonrpc: '2.0', id: this.nextId++, method, params },
        { timeoutMs, headers: this.legacyHeaders() }
      );
      return unwrap(reply);
    } catch (error) {
      // A 404 to a request carrying a session id means the session is over,
      // and the client MUST start a new one. Once: a second 404 is a real one.
      if (error.status === 404 && session) {
        if (this.sessionId === session) {
          this.ready = false;
          this.sessionId = null;
        }
        await this.ensureReady();
        const { reply } = await this.exchange(
          { jsonrpc: '2.0', id: this.nextId++, method, params },
          { timeoutMs, headers: this.legacyHeaders() }
        );
        return unwrap(reply);
      }
      throw error;
    }
  }

  async request(method, params = {}, options = {}) {
    await this.ensureReady();
    return this.era === 'modern'
      ? this.modernRequest(method, params, options)
      : this.legacyRequest(method, params, options);
  }

  /** Every tool, across pages. */
  async listTools() {
    const tools = [];
    const warnings = [];
    const names = new Set();
    const cursors = new Set();
    let cursor;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});

      (Array.isArray(result.tools) ? result.tools : []).forEach(raw => {
        const checked = checkTool(raw);
        if (checked.warning) {
          warnings.push(checked.warning);
        } else if (names.has(checked.tool.name)) {
          warnings.push(`"${clip(checked.tool.name, 60)}" is listed twice; the first was kept`);
        } else {
          names.add(checked.tool.name);
          tools.push(checked.tool);
        }
      });

      if (tools.length >= MAX_TOOLS) {
        warnings.push(`Only the first ${MAX_TOOLS} tools are listed`);
        break;
      }

      const next = result.nextCursor;
      // A cursor seen before would loop for ever.
      if (typeof next !== 'string' || !next || cursors.has(next)) {
        break;
      }
      if (page === MAX_TOOL_PAGES - 1) {
        warnings.push(`The server has more than ${MAX_TOOL_PAGES} pages of tools; only the first ${MAX_TOOL_PAGES} were read`);
        break;
      }
      cursors.add(next);
      cursor = next;
    }

    return { tools: tools.slice(0, MAX_TOOLS), warnings: warnings.slice(0, 20) };
  }

  /** Call one tool. */
  async callTool(name, args, { inputSchema } = {}) {
    await this.ensureReady();

    if (this.era === 'modern') {
      let headers = {};
      if (inputSchema) {
        const found = headerParams(inputSchema);
        if (found.error) {
          throw new McpError(`This tool can no longer be called: ${found.error}. Refresh the server's tools.`, { kind: 'config' });
        }
        headers = paramHeaders(found.params, args);
      }
      return readResult(await this.modernRequest('tools/call', { name, arguments: args }, { headers }));
    }

    return readResult(await this.legacyRequest('tools/call', { name, arguments: args }));
  }

  /** End a legacy session. Best effort: a server may refuse with 405. */
  async close() {
    if (this.era !== 'legacy' || !this.sessionId) {
      return;
    }
    const headers = { 'user-agent': USER_AGENT, ...this.headers, ...this.legacyHeaders() };
    this.sessionId = null;
    this.ready = false;
    try {
      await this.send({ method: 'DELETE', headers, deadline: Date.now() + CLOSE_TIMEOUT_MS });
    } catch {
      // Nothing to do: the server will expire it.
    }
  }

  protocol() {
    return this.era ? { era: this.era, version: this.version } : null;
  }
}

function noCommonVersion(supported) {
  const list = supported.filter(entry => typeof entry === 'string').slice(0, 6).map(entry => clip(entry, 20));
  return new McpError(
    `The server speaks MCP ${list.join(', ') || 'versions it did not name'}, and this client speaks ` +
    `${[MODERN_VERSION, ...LEGACY_VERSIONS].join(', ')}. There is no version in common.`
  );
}

function networkMessage(error) {
  const message = String((error && error.message) || 'The request failed');
  if (/ENOTFOUND|EAI_AGAIN/.test(error && error.code ? error.code : message)) {
    return 'That server name could not be found. Check the URL.';
  }
  if (/ECONNREFUSED/.test(error && error.code ? error.code : message)) {
    return 'The server refused the connection. Is it running, and is that the right port?';
  }
  return clip(message, 300);
}

/** An HTTP failure, explained by its status and any JSON-RPC error in the body. */
function httpError(status, response) {
  let rpc = null;
  try {
    const parsed = JSON.parse(response.body);
    if (parsed && parsed.error && typeof parsed.error === 'object') {
      rpc = parsed.error;
    }
  } catch {
    // Not JSON: the status is all we have.
  }

  const detail = rpc && rpc.message ? ` The server said: ${clip(rpc.message, 200)}` : '';
  let message;

  if (status === 401 || status === 403) {
    const oauth = /resource_metadata|oauth/i.test(String(response.headers['www-authenticate'] || ''));
    message = oauth
      ? `The server wants an OAuth sign-in (HTTP ${status}), which cannot be connected here yet. Use a server or plan that accepts an API key or token.`
      : `The server refused the credential (HTTP ${status}). Check the token under Authentication.`;
  } else if (status === 404) {
    message = 'Nothing answered at that URL (HTTP 404). Check it is the MCP endpoint — it often ends in /mcp.';
  } else if (status === 405) {
    message = 'That URL does not accept MCP requests (HTTP 405). Check it is the MCP endpoint, not a web page or an older SSE-only URL.';
  } else if (status >= 500) {
    message = `The server had a problem (HTTP ${status}).`;
  } else {
    message = `The server refused the request (HTTP ${status}).`;
  }

  return new McpError(`${message}${detail}`, {
    kind: 'http',
    status,
    code: rpc && typeof rpc.code === 'number' ? rpc.code : undefined,
    data: rpc ? rpc.data : undefined
  });
}

// ------------------------------------------------------------------- cache

/**
 * Connections kept between tool calls, by server.
 *
 * Swept on use rather than by a timer, so nothing keeps the process alive.
 * A server whose address or credential changed gets a new connection; the
 * old one's session is ended.
 */
const connections = new Map();

function fingerprint(server) {
  const auth = server.auth || {};
  return crypto.createHash('sha256')
    .update(JSON.stringify([server.url, auth.type || 'none', auth.headerName || '', auth.secret || '']))
    .digest('hex');
}

function sweep() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [key, entry] of connections) {
    if (entry.connection.lastUsed < cutoff || connections.size > MAX_CACHED_CONNECTIONS) {
      connections.delete(key);
      entry.connection.close();
    }
  }
}

function buildConnection(server, options = {}) {
  const check = validateServerUrl(server.url);
  if (!check.valid) {
    throw new McpError(check.error, { kind: 'config' });
  }
  const stored = server.protocol || {};
  const era = options.fresh ? null : (['modern', 'legacy'].includes(stored.era) ? stored.era : null);
  return new Connection({
    url: check.url,
    headers: authHeaders(server.auth || {}),
    era,
    version: era === 'modern' ? MODERN_VERSION : (LEGACY_VERSIONS.includes(stored.version) ? stored.version : null),
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
  });
}

function connectionFor(server, options = {}) {
  sweep();
  const key = String(server._id);
  const print = fingerprint(server);
  const cached = connections.get(key);

  if (cached && cached.fingerprint === print && !options.fresh) {
    return cached.connection;
  }
  if (cached) {
    connections.delete(key);
    cached.connection.close();
  }

  const connection = buildConnection(server, options);
  connections.set(key, { connection, fingerprint: print });
  return connection;
}

/** Forget a server's connection, ending its session. */
async function forget(serverId) {
  const key = String(serverId);
  const cached = connections.get(key);
  if (cached) {
    connections.delete(key);
    await cached.connection.close();
  }
}

/** Test seam: drop every cached connection without contacting anybody. */
function resetForTests() {
  connections.clear();
}

/**
 * Whether a failure looks like the server changed eras since we last spoke.
 *
 * A stored era is an assumption the specification says to re-check when it
 * fails: a server that upgraded answers a legacy request with a 400, and one
 * that was replaced answers a modern one the way any legacy server would.
 */
function suggestsNewEra(error) {
  if (!error || error.kind === 'config' || error.kind === 'network' || error.kind === 'timeout') {
    return false;
  }
  if (error.code === UNSUPPORTED_VERSION) {
    return true;
  }
  return [400, 404, 405].includes(error.status) && !MODERN_ERRORS.has(error.code);
}

// ------------------------------------------------------------------ public

/**
 * Connect to a server afresh and list its tools: "Connect & list tools".
 *
 * Never throws. Always probes, whatever era was stored, because this is the
 * admin asking whether the server works now.
 *
 * @returns {Promise<{ok: boolean, tools?: object[], warnings?: string[],
 *   protocol?: {era: string, version: string}, serverInfo?: object, error?: string}>}
 */
async function discover(server, options = {}) {
  let connection;
  try {
    connection = connectionFor(server, { ...options, fresh: true });
    const { tools, warnings } = await connection.listTools();
    const info = connection.serverInfo && typeof connection.serverInfo === 'object' ? connection.serverInfo : {};

    return {
      ok: true,
      tools,
      warnings,
      protocol: connection.protocol(),
      serverInfo: {
        name: clip(typeof info.name === 'string' ? info.name : '', 120),
        version: clip(typeof info.version === 'string' ? info.version : '', 40)
      }
    };
  } catch (error) {
    if (server && server._id) {
      await forget(server._id);
    }
    logger.warn('MCP server could not be listed', { serverId: server && String(server._id), error: error.message });
    return { ok: false, error: error instanceof McpError ? error.message : 'The server could not be reached' };
  }
}

/**
 * Call one of a server's tools.
 *
 * Never throws: a server being down is something the assistant apologises
 * for, not an exception that ends the conversation. `isError` is the tool
 * itself reporting a problem (bad input, a business rule), which the model
 * may be able to correct; `ok: false` is everything else.
 *
 * @param {object} server the McpServer, with `auth.secret` selected
 * @param {object} tool the stored tool (`name`, `inputSchema`)
 * @param {object} args
 * @returns {Promise<{ok: boolean, isError?: boolean, text?: string, structured?: *,
 *   error?: string, durationMs: number, protocol?: object}>}
 */
async function callTool(server, tool, args = {}, options = {}) {
  const started = Date.now();
  let schema = null;
  try {
    schema = JSON.parse(tool.inputSchema || '{}');
  } catch {
    schema = null;
  }

  let connection;
  try {
    connection = connectionFor(server, options);
    const before = connection.protocol();
    let result;

    try {
      result = await connection.callTool(tool.name, args, { inputSchema: schema });
    } catch (error) {
      if (!before || !suggestsNewEra(error)) {
        throw error;
      }
      // The stored era was wrong or out of date: probe once, and retry.
      await connection.close();
      connection.era = null;
      connection.ready = false;
      result = await connection.callTool(tool.name, args, { inputSchema: schema });
    }

    return { ok: true, ...result, durationMs: Date.now() - started, protocol: connection.protocol() };
  } catch (error) {
    logger.warn('MCP tool call failed', {
      serverId: String(server._id), tool: clip(tool.name, 128), error: error.message
    });
    return {
      ok: false,
      error: error instanceof McpError ? error.message : 'The call failed',
      durationMs: Date.now() - started
    };
  }
}

module.exports = {
  discover,
  callTool,
  forget,
  validateServerUrl,
  validHeaderName,
  validSecret,
  explainAddress,
  checkTool,
  modelSchema,
  describeInputs,
  assistantToolName,
  headerParams,
  paramHeaders,
  encodeHeaderValue,
  readResult,
  SseReader,
  Connection,
  McpError,
  resetForTests,
  MODERN_VERSION,
  LEGACY_VERSIONS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES
};
