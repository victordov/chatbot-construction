/**
 * End-to-End Encryption Service
 * Provides encryption/decryption functionality for secure communication
 */

const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

class EncryptionService {
  constructor() {
    // Generate server keypair on initialization
    this.serverKeyPair = nacl.box.keyPair();

    // Store client public keys mapped to their session IDs
    this.clientPublicKeys = new Map();
  }

  /**
   * Register a client's public key
   * @param {string} sessionId - The client's session ID
   * @param {string} publicKeyBase64 - The client's public key in Base64 format
   */
  registerClientPublicKey(sessionId, publicKeyBase64) {
    try {
      // Convert Base64 to Uint8Array
      const publicKey = naclUtil.decodeBase64(publicKeyBase64);
      this.clientPublicKeys.set(sessionId, publicKey);
      return true;
    } catch (error) {
      console.error('Error registering client public key:', error);
      return false;
    }
  }

  /**
   * Get the server's public key in Base64 format
   * @returns {string} The server's public key in Base64 format
   */
  getServerPublicKey() {
    return naclUtil.encodeBase64(this.serverKeyPair.publicKey);
  }

  /**
   * Encrypt a message for a specific client
   * @param {string} sessionId - The client's session ID
   * @param {string} message - The message to encrypt
   * @returns {Object|null} The encrypted message with nonce, or null if encryption fails
   */
  encryptForClient(sessionId, message) {
    try {
      const clientPublicKey = this.clientPublicKeys.get(sessionId);

      if (!clientPublicKey) {
        console.error('No public key found for session:', sessionId);
        return null;
      }

      // Generate a random nonce
      const nonce = nacl.randomBytes(nacl.box.nonceLength);

      // Convert message to Uint8Array
      const messageUint8 = naclUtil.decodeUTF8(message);

      // Encrypt the message
      const encryptedMessage = nacl.box(
        messageUint8,
        nonce,
        clientPublicKey,
        this.serverKeyPair.secretKey
      );

      // Return encrypted message and nonce, both in Base64 format
      return {
        encryptedMessage: naclUtil.encodeBase64(encryptedMessage),
        nonce: naclUtil.encodeBase64(nonce)
      };
    } catch (error) {
      console.error('Error encrypting message for client:', error);
      return null;
    }
  }

  /**
   * Decrypt a message from a client
   * @param {string} sessionId - The client's session ID
   * @param {string} encryptedMessageBase64 - The encrypted message in Base64 format
   * @param {string} nonceBase64 - The nonce in Base64 format
   * @returns {string|null} The decrypted message, or null if decryption fails
   */
  decryptFromClient(sessionId, encryptedMessageBase64, nonceBase64) {
    try {
      const clientPublicKey = this.clientPublicKeys.get(sessionId);

      if (!clientPublicKey) {
        console.error('No public key found for session:', sessionId);
        return null;
      }

      // Convert from Base64 to Uint8Array
      const encryptedMessage = naclUtil.decodeBase64(encryptedMessageBase64);
      const nonce = naclUtil.decodeBase64(nonceBase64);

      // Decrypt the message
      const decryptedMessage = nacl.box.open(
        encryptedMessage,
        nonce,
        clientPublicKey,
        this.serverKeyPair.secretKey
      );

      if (!decryptedMessage) {
        console.error('Failed to decrypt message');
        return null;
      }

      // Convert Uint8Array to string
      return naclUtil.encodeUTF8(decryptedMessage);
    } catch (error) {
      console.error('Error decrypting message from client:', error);
      return null;
    }
  }

  /**
   * Check if a client has registered a public key
   * @param {string} sessionId - The client's session ID
   * @returns {boolean} True if the client has a registered public key
   */
  hasClientPublicKey(sessionId) {
    return this.clientPublicKeys.has(sessionId);
  }

  /**
   * Remove a client's public key when they disconnect
   * @param {string} sessionId - The client's session ID
   */
  removeClientPublicKey(sessionId) {
    this.clientPublicKeys.delete(sessionId);
  }
}

module.exports = EncryptionService;
