#!/usr/bin/env node
/**
 * Make the key pair push notifications are signed with.
 *
 *   node scripts/generate-vapid-keys.js you@example.com
 *
 * Prints three lines for the environment (.env, or the host's settings):
 *
 *   VAPID_PUBLIC_KEY   handed to browsers when they subscribe
 *   VAPID_PRIVATE_KEY  signs every push; keep it as secret as JWT_SECRET
 *   VAPID_SUBJECT      how a push service can reach whoever runs this
 *                      deployment about a problem: mailto: or https:
 *
 * Generate once per deployment and keep them. Every device subscribed under
 * the old public key stops receiving notifications when it changes, until
 * its owner next opens the dashboard and it subscribes again.
 *
 * The keys are an ordinary P-256 pair in URL-safe base64, made with Node's
 * own crypto - the same thing `web-push generate-vapid-keys` prints.
 */

const crypto = require('crypto');

function generate() {
  const curve = crypto.createECDH('prime256v1');
  curve.generateKeys();

  // The private key is a 32-byte number; a leading zero byte is dropped by
  // getPrivateKey and has to be put back.
  const privateKey = Buffer.alloc(32);
  const raw = curve.getPrivateKey();
  raw.copy(privateKey, 32 - raw.length);

  return {
    publicKey: curve.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url')
  };
}

function subjectFrom(argument) {
  const value = String(argument || '').trim();
  if (!value) {
    return 'mailto:you@example.com';
  }
  return /^(mailto:|https:)/i.test(value) ? value : `mailto:${value}`;
}

if (require.main === module) {
  const { publicKey, privateKey } = generate();
  const subject = subjectFrom(process.argv[2]);

  console.info(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.info(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.info(`VAPID_SUBJECT=${subject}`);

  if (!process.argv[2]) {
    console.warn('\nReplace the VAPID_SUBJECT address with a real one: pass it as the first argument.');
  }
}

module.exports = { generate, subjectFrom };
