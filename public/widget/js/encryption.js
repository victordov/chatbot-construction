/**
 * Encryption utility for the chatbot widget
 * Provides client-side encryption functions using TweetNaCl
 */

// eslint-disable-next-line no-unused-vars
class EncryptionUtil {
  constructor(baseUrl = null) {
    this.isReady = false;
    this.keyPair = null;
    this.serverPublicKey = null;
    this.baseUrl = baseUrl;
  }

  /**
   * Initialize the encryption utility
   * @returns {Promise<boolean>} Whether initialization was successful
   */
  async init() {
    try {
      // Load TweetNaCl and TweetNaCl-util libraries
      await this.loadScripts();

      // Generate key pair
      this.keyPair = nacl.box.keyPair();

      return true;
    } catch (error) {
      console.error('Error initializing encryption:', error);
      return false;
    }
  }

  /**
   * Load TweetNaCl and TweetNaCl-util.
   *
   * These are served from this application's own origin rather than a public
   * CDN. Two reasons:
   *
   *  - The libraries are security-critical. Fetching them from a third party
   *    means that party can silently swap the crypto out from under every
   *    conversation.
   *  - A customer embedding the widget only has to allowlist this server in
   *    their Content-Security-Policy, not two unrelated CDNs. The previous
   *    cdnjs.cloudflare.com URL was blocked outright by this very app's own
   *    CSP, so encryption never initialised at all.
   *
   * @returns {Promise<void>}
   */
  loadScripts() {
    const baseUrl = this.baseUrl || EncryptionUtil.resolveBaseUrl();

    const loadScript = src => new Promise((resolve, reject) => {
      // Do not load the same library twice if two widgets share a page.
      if (document.querySelector(`script[src="${src}"]`)) {
        return resolve();
      }
      const element = document.createElement('script');
      element.src = src;
      element.onload = resolve;
      element.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(element);
    });

    const naclReady = () =>
      typeof nacl !== 'undefined' &&
      nacl.util &&
      typeof nacl.util.encodeBase64 === 'function' &&
      typeof nacl.util.decodeBase64 === 'function';

    return loadScript(`${baseUrl}/widget/js/lib/nacl-fast.min.js`)
      .then(() => loadScript(`${baseUrl}/widget/js/lib/nacl-util.min.js`))
      .then(() => {
        if (naclReady()) {
          return;
        }
        // The globals are assigned during script evaluation, which can lag the
        // load event by a tick in some browsers.
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (naclReady()) {
              resolve();
            } else {
              reject(new Error('TweetNaCl did not initialise'));
            }
          }, 100);
        });
      });
  }

  /**
   * Work out where this script was served from, so the libraries load from the
   * same origin even when the widget is embedded on another domain.
   */
  static resolveBaseUrl() {
    // The src may be content-hashed (encryption.<hash>.js), so match on the
    // directory rather than the exact filename.
    const script = document.querySelector('script[src*="/widget/js/encryption"]');
    if (script && script.src) {
      try {
        return new URL(script.src).origin;
      } catch (error) {
        // fall through
      }
    }
    return window.location.origin;
  }

  /**
   * Set the server's public key
   * @param {string} publicKeyBase64 - The server's public key in Base64 format
   * @returns {Promise<boolean>} Whether the key was set successfully
   */
  async setServerPublicKey(publicKeyBase64) {
    try {
      // Check if nacl and nacl.util are defined, if not wait for them to load
      if (typeof nacl === 'undefined' || !nacl.util || typeof nacl.util.decodeBase64 !== 'function') {
        await this.loadScripts();
      }

      // Double-check that nacl.util is available
      if (!nacl.util || typeof nacl.util.decodeBase64 !== 'function') {
        throw new Error('nacl.util.decodeBase64 is not available after loading scripts');
      }

      this.serverPublicKey = nacl.util.decodeBase64(publicKeyBase64);
      this.isReady = true;
      return true;
    } catch (error) {
      console.error('Error setting server public key:', error);
      this.isReady = false;
      return false;
    }
  }

  /**
   * Get the client's public key in Base64 format
   * @returns {string|null} The client's public key in Base64 format, or null if encryption is not ready
   */
  async getPublicKey() {
    try {
      // Check if nacl.util is available
      if (!nacl || !nacl.util || typeof nacl.util.encodeBase64 !== 'function') {
        console.error('nacl.util.encodeBase64 is not available');
        return null;
      }

      // Check if keyPair is initialized
      if (!this.keyPair) {
        const success = await this.init();
        if (!success) {
          console.error('Failed to initialize key pair');
          return null;
        }
      }

      // Double-check that keyPair is available
      if (!this.keyPair || !this.keyPair.publicKey) {
        console.error('Key pair or public key is not available');
        return null;
      }

      return nacl.util.encodeBase64(this.keyPair.publicKey);
    } catch (error) {
      console.error('Error getting public key:', error);
      return null;
    }
  }

  /**
   * Encrypt a message for the server
   * @param {string} message - The message to encrypt
   * @returns {Object|null} The encrypted message with nonce, or null if encryption fails
   */
  encryptMessage(message) {
    if (!this.isReady) {
      console.error('Encryption not ready');
      return null;
    }

    try {
      // Check if nacl and nacl.util are available
      if (!nacl || !nacl.util ||
          typeof nacl.util.decodeUTF8 !== 'function' ||
          typeof nacl.util.encodeBase64 !== 'function' ||
          typeof nacl.randomBytes !== 'function' ||
          typeof nacl.box !== 'function') {
        console.error('nacl or nacl.util functions are not available');
        return null;
      }

      // Generate a random nonce
      const nonce = nacl.randomBytes(nacl.box.nonceLength);

      // Convert message to Uint8Array
      const messageUint8 = nacl.util.decodeUTF8(message);

      // Encrypt the message
      const encryptedMessage = nacl.box(
        messageUint8,
        nonce,
        this.serverPublicKey,
        this.keyPair.secretKey
      );

      // Return encrypted message and nonce, both in Base64 format
      return {
        encryptedMessage: nacl.util.encodeBase64(encryptedMessage),
        nonce: nacl.util.encodeBase64(nonce)
      };
    } catch (error) {
      console.error('Error encrypting message:', error);
      return null;
    }
  }

  /**
   * Decrypt a message from the server
   * @param {string} encryptedMessageBase64 - The encrypted message in Base64 format
   * @param {string} nonceBase64 - The nonce in Base64 format
   * @returns {string|null} The decrypted message, or null if decryption fails
   */
  decryptMessage(encryptedMessageBase64, nonceBase64) {
    if (!this.isReady) {
      console.error('Encryption not ready');
      return null;
    }

    try {
      // Check if nacl and nacl.util are available
      if (!nacl || !nacl.util ||
          typeof nacl.util.decodeBase64 !== 'function' ||
          typeof nacl.util.encodeUTF8 !== 'function' ||
          typeof nacl.box.open !== 'function') {
        console.error('nacl or nacl.util functions are not available');
        return null;
      }

      // Convert from Base64 to Uint8Array
      const encryptedMessage = nacl.util.decodeBase64(encryptedMessageBase64);
      const nonce = nacl.util.decodeBase64(nonceBase64);

      // Decrypt the message
      const decryptedMessage = nacl.box.open(
        encryptedMessage,
        nonce,
        this.serverPublicKey,
        this.keyPair.secretKey
      );

      if (!decryptedMessage) {
        console.error('Failed to decrypt message');
        return null;
      }

      // Convert Uint8Array to string
      return nacl.util.encodeUTF8(decryptedMessage);
    } catch (error) {
      console.error('Error decrypting message:', error);
      return null;
    }
  }

  /**
   * Check if encryption is ready
   * @returns {boolean} Whether encryption is ready
   */
  isEncryptionReady() {
    return this.isReady;
  }
}
