const EncryptionService = require('../services/encryption');

describe('Encryption Service Test', () => {
  let encryptionService;

  beforeEach(() => {
    encryptionService = new EncryptionService();
  });
  it('should initialize with a valid key pair', () => {
    // Check that public and private keys are generated
    expect(encryptionService.serverKeyPair).toBeDefined();
    expect(encryptionService.serverKeyPair.publicKey).toBeDefined();
    expect(encryptionService.serverKeyPair.secretKey).toBeDefined();
    expect(encryptionService.getServerPublicKey()).toBeDefined();
    expect(typeof encryptionService.getServerPublicKey()).toBe('string');
  });

  it('should register a client public key', () => {
    // Create a mock client public key (base64 encoded string)
    const sessionId = 'test-session-123';
    const fakePublicKey = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY='; // Fake base64 string

    // Register the key
    const result = encryptionService.registerClientPublicKey(sessionId, fakePublicKey);

    // Verify registration was successful
    expect(result).toBe(true);
    expect(encryptionService.hasClientPublicKey(sessionId)).toBe(true);
  });

  it('should remove a client public key', () => {
    // Register a key first
    const sessionId = 'test-session-123';
    const fakePublicKey = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=';
    encryptionService.registerClientPublicKey(sessionId, fakePublicKey);

    // Remove the key
    encryptionService.removeClientPublicKey(sessionId);

    // Verify key was removed
    expect(encryptionService.hasClientPublicKey(sessionId)).toBe(false);
  });

  it('should encrypt and decrypt messages', () => {
    // Create a test session and register a key
    const sessionId = 'test-session-123';

    // We need to create a real key pair for testing encryption/decryption
    const nacl = require('tweetnacl');
    const util = require('tweetnacl-util');

    // Generate a client key pair
    const clientKeyPair = nacl.box.keyPair();
    const clientPublicKeyBase64 = util.encodeBase64(clientKeyPair.publicKey);

    // Register the client's public key
    encryptionService.registerClientPublicKey(sessionId, clientPublicKeyBase64);

    // Original message
    const originalMessage = 'This is a secret message for testing encryption';

    // Encrypt the message for the client
    const encrypted = encryptionService.encryptForClient(sessionId, originalMessage);

    // Verify the encryption was successful
    expect(encrypted).toBeDefined();
    expect(encrypted.encryptedMessage).toBeDefined();
    expect(encrypted.nonce).toBeDefined();

    // Now manually decrypt using the client's secret key
    // This simulates what would happen in the client's browser
    const encryptedData = util.decodeBase64(encrypted.encryptedMessage);
    const nonce = util.decodeBase64(encrypted.nonce);
    const serverPublicKey = util.decodeBase64(encryptionService.getServerPublicKey());

    // Decrypt the message
    const decrypted = nacl.box.open(
      encryptedData,
      nonce,
      serverPublicKey,
      clientKeyPair.secretKey
    );

    // Convert the decrypted message back to a string
    const decryptedMessage = util.encodeUTF8(decrypted);

    // Verify the decrypted message matches the original
    expect(decryptedMessage).toBe(originalMessage);
  });

  it('should fail to encrypt for non-existent client', () => {
    const nonExistentSessionId = 'non-existent-session';
    const message = 'This message should not be encrypted';

    // Try to encrypt for a client that doesn't exist
    const result = encryptionService.encryptForClient(nonExistentSessionId, message);

    // Verify encryption failed
    expect(result).toBeNull();
  });

  it('should fail with invalid client public key', () => {
    const sessionId = 'test-session-123';
    const invalidKey = 'not-a-valid-base64-key';

    // Try to register an invalid key
    const result = encryptionService.registerClientPublicKey(sessionId, invalidKey);

    // Verify registration failed
    expect(result).toBe(false);
  });
});
