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
        naclUtilScript.src = 'https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/nacl-util.min.js';
        naclUtilScript.onload = () => {
          // Ensure nacl.util is fully defined before resolving
          if (typeof nacl !== 'undefined' && nacl.util && typeof nacl.util.encodeBase64 === 'function' && typeof nacl.util.decodeBase64 === 'function') {
            resolve();
          } else {
            // If nacl.util is not fully defined, wait a bit and check again
            setTimeout(() => {
              if (typeof nacl !== 'undefined' && nacl.util && typeof nacl.util.encodeBase64 === 'function' && typeof nacl.util.decodeBase64 === 'function') {
                resolve();
              } else {
                reject(new Error('nacl.util is not fully defined after loading scripts'));
              }
            }, 100);
          }
        };
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
