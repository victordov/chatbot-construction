/**
 * Encryption for secrets held at rest.
 *
 * Workflow action nodes carry a credential for the tenant's own API. Those live
 * inside a workflow document, which is read by several routes and returned to
 * the editor, so storing them in plain text would put a customer's API key in
 * every backup, log and browser that touches a workflow.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decrypting
 * to something an attacker chose.
 */

const crypto = require('crypto');
const { logger } = require('./logging');

const PREFIX = 'enc:v1:';

let cachedKey = null;
let warned = false;

/**
 * The key, derived once.
 *
 * `SECRETS_KEY` is the real setting. Falling back to `SESSION_SECRET` keeps
 * development working without a second variable, at the cost of tying stored
 * credentials to it: rotating `SESSION_SECRET` makes existing secrets
 * undecryptable. That fails loudly at decrypt time rather than silently
 * returning the wrong bytes, and the warning below says so.
 */
function key() {
  if (cachedKey) {
    return cachedKey;
  }

  const material = process.env.SECRETS_KEY || process.env.SESSION_SECRET;

  if (!material) {
    return null;
  }

  if (!process.env.SECRETS_KEY && !warned) {
    warned = true;
    logger.warn(
      'SECRETS_KEY is not set, so stored credentials are encrypted with a key ' +
      'derived from SESSION_SECRET. Rotating SESSION_SECRET will make them ' +
      'undecryptable. Set SECRETS_KEY to decouple the two.'
    );
  }

  // HKDF rather than the raw string: the input is a passphrase of unknown
  // length, and the info label keeps this key distinct from anything else the
  // same material is used for.
  cachedKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(material), Buffer.alloc(0), Buffer.from('chatbot-platform:secrets:v1'), 32)
  );

  return cachedKey;
}

/** Whether a value has already been through {@link encrypt}. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * @returns {string} `enc:v1:<iv>:<tag>:<ciphertext>`, all base64url.
 * @throws if no key material is configured — a silent plaintext fallback would
 *         be worse than a failed save.
 */
function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') {
    return '';
  }

  if (isEncrypted(plaintext)) {
    // Already encrypted: re-encrypting would double-wrap it.
    return plaintext;
  }

  const secret = key();
  if (!secret) {
    throw new Error('Cannot store a secret: set SECRETS_KEY (or SESSION_SECRET)');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return PREFIX + [iv, cipher.getAuthTag(), ciphertext]
    .map(part => part.toString('base64url'))
    .join(':');
}

/**
 * @returns {string|null} the plaintext, or null if it cannot be decrypted —
 *          a rotated key, a corrupted value, or tampering.
 */
function decrypt(value) {
  if (!isEncrypted(value)) {
    // Values written before this existed, or never encrypted, are returned as
    // they are so an upgrade does not break a working workflow.
    return value === undefined || value === null ? null : String(value);
  }

  const secret = key();
  if (!secret) {
    return null;
  }

  try {
    const [iv, tag, ciphertext] = value.slice(PREFIX.length).split(':')
      .map(part => Buffer.from(part, 'base64url'));

    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    logger.error('Failed to decrypt a stored secret', { error: error.message });
    return null;
  }
}

/**
 * Reset the derived key. Tests only — the key is cached for the process.
 */
function resetForTests() {
  cachedKey = null;
  warned = false;
}

module.exports = { encrypt, decrypt, isEncrypted, resetForTests };
