/**
 * The secret that proves a client owns a conversation.
 */

const sessionToken = require('../services/session-token');

describe('Session tokens', () => {
  test('issues 32 random bytes as hex', () => {
    const token = sessionToken.issue();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionToken.issue()).not.toBe(token);
  });

  test('hashes with sha256', () => {
    // A known vector, so the storage format cannot drift without notice.
    expect(sessionToken.hash('abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('verifies the token against its hash and nothing else', () => {
    const token = sessionToken.issue();
    const stored = sessionToken.hash(token);

    expect(sessionToken.verify(stored, token)).toBe(true);
    expect(sessionToken.verify(stored, sessionToken.issue())).toBe(false);
    expect(sessionToken.verify(stored, token.slice(0, -1))).toBe(false);
  });

  test('a missing hash or token is a refusal, never a pass', () => {
    // An absent hash is a legacy conversation the caller has to decide about
    // explicitly; it is not "anything goes".
    const token = sessionToken.issue();

    expect(sessionToken.verify(undefined, token)).toBe(false);
    expect(sessionToken.verify(null, token)).toBe(false);
    expect(sessionToken.verify('', token)).toBe(false);
    expect(sessionToken.verify(sessionToken.hash(token), undefined)).toBe(false);
    expect(sessionToken.verify(sessionToken.hash(token), '')).toBe(false);
    expect(sessionToken.verify(sessionToken.hash(token), { toString: () => token })).toBe(false);
  });
});
