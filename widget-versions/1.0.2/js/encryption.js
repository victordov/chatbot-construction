/**
 * Encryption utility for the chatbot widget
 * Provides client-side encryption functions using TweetNaCl
 */

class EncryptionUtil {
  constructor() {
    this.isReady = false;
    this.keyPair = null;
    this.serverPublicKey = null;
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
   * Load required scripts dynamically
   * @returns {Promise<void>}
   */
  loadScripts() {
    return new Promise((resolve, reject) => {
      // Load TweetNaCl
      const naclScript = document.createElement('script');
      naclScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/tweetnacl/1.0.3/nacl-fast.min.js';
      naclScript.onload = () => {
        // Load TweetNaCl-util after TweetNaCl is loaded
        const naclUtilScript = document.createElement('script');
        naclUtilScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/tweetnacl-util/0.15.1/nacl-util.min.js';
        naclUtilScript.onload = resolve;
        naclUtilScript.onerror = reject;
        document.body.appendChild(naclUtilScript);
      };
      naclScript.onerror = reject;
      document.body.appendChild(naclScript);
    });
  }

  /**
   * Set the server's public key
   * @param {string} publicKeyBase64 - The server's public key in Base64 format
   * @returns {Promise<boolean>} Whether the key was set successfully
   */
  async setServerPublicKey(publicKeyBase64) {
    try {
      // Check if nacl is defined, if not wait for it to load
      if (typeof nacl === 'undefined') {
        console.log('nacl not loaded yet, waiting for it to load...');
        await this.loadScripts();
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
   * @returns {string} The client's public key in Base64 format
   */
  getPublicKey() {
    return nacl.util.encodeBase64(this.keyPair.publicKey);
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
