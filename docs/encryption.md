# End-to-End Encryption Implementation for Chatbot

This document provides technical details about the implementation of end-to-end encryption in the chatbot application.

## Overview

The chatbot now features end-to-end encryption using the TweetNaCl.js library, which provides:

- Secure key generation
- Public-key encryption (box)
- Message authentication
- Secure random number generation

The encryption ensures that messages between the client and server cannot be read by third parties, even if network traffic is intercepted.

## Technology Stack

- **Encryption Library**: TweetNaCl.js (tweetnacl)
- **Utilities**: TweetNaCl-util (tweetnacl-util)
- **Key Exchange Protocol**: X25519 (Curve25519)
- **Encryption Algorithm**: XSalsa20-Poly1305

## Implementation Details

### Server-Side Components

1. **Encryption Service** (`services/encryption.js`):
   - Generates and manages server key pairs
   - Stores client public keys in memory
   - Handles encryption/decryption of messages
   - Provides session-based key management

2. **WebSockets Integration** (`websockets.js`):
   - Initializes encryption on new connections
   - Handles key exchange protocol
   - Processes encrypted messages
   - Tracks which conversations are encrypted

3. **Data Model** (`models/conversation.js`):
   - Added `encrypted` field to message schema
   - Stores information about whether messages were encrypted

### Client-Side Components

1. **Encryption Utility** (`public/widget/js/encryption.js`):
   - Dynamically loads required libraries
   - Generates client key pairs
   - Handles key exchange with server
   - Provides encryption/decryption of messages

2. **Widget Integration** (`public/widget/js/widget.js`):
   - Initializes encryption utility
   - Manages encryption key exchange
   - Encrypts outgoing messages
   - Decrypts incoming messages

## Security Features

### Key Management

- Keys are generated using secure random number generation
- Public keys are exchanged over WebSocket connections
- Private keys never leave their respective environments (client or server)
- Keys are ephemeral and regenerated on each session

### Message Encryption

- Each message uses a unique random nonce
- Messages are encrypted with XSalsa20 stream cipher
- Message integrity is protected with Poly1305 MAC
- Both the message content and nonce are Base64 encoded for transmission

### Session Management

- Each client session has its own unique encryption keys
- Keys are removed when clients disconnect
- Server maintains a mapping of session IDs to public keys

## Usage Flow

1. **Initialization**:
   - Client loads the encryption utility
   - Client generates a key pair
   - Server sends its public key to client
   - Client sends its public key to server
   - Both sides store the other's public key

2. **Sending Messages**:
   - Client encrypts message with server's public key
   - Client sends encrypted message and nonce to server
   - Server verifies and decrypts the message

3. **Receiving Messages**:
   - Server encrypts response with client's public key
   - Server sends encrypted response and nonce to client
   - Client verifies and decrypts the message

## Fallback Mechanism

If encryption fails at any point:
- A fallback to unencrypted messages is available
- Error messages are logged to the console
- The UI continues to function without interruption

## Testing

A test page (`public/test-encryption.html`) is available to verify encryption functionality:
- Widget initialization
- Key exchange
- Message encryption
- Message decryption

## Security Considerations

While this implementation provides strong encryption, additional security measures should be considered:

- HTTPS should be used for all connections
- Regular security audits should be performed
- Server-side private keys should be properly secured
- Consider implementing perfect forward secrecy for long-term security

## Future Improvements

Potential improvements to the encryption system:
- Add support for encrypted file transfers
- Implement key rotation for long-lived sessions
- Add fingerprint verification for public keys
- Provide visual indicators for encrypted conversations
