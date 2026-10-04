/**
 * The Content-Security-Policy the running app sends.
 *
 * The dashboard's scripts all live in files now, so 'unsafe-inline' has no
 * business in script-src: with it there, an injected <script> anywhere in an
 * operator's page runs. unpkg.com was allowed for a library nobody loads.
 *
 * Boots the real server.js so the header under test is the one production
 * sends, not a copy of the configuration.
 */

const request = require('supertest');
const mongoose = require('mongoose');

// An ephemeral port, so the suite never collides with a dev server.
process.env.PORT = '0';

describe('Content-Security-Policy', () => {
  let app;
  let server;

  beforeAll(async () => {
    ({ app, server } = require('../server'));

    // The listen call in server.js is asynchronous; wait for it so the
    // teardown has something to close.
    if (!server.listening) {
      await new Promise(resolve => server.once('listening', resolve));
    }
  });

  afterAll(async () => {
    const io = server && server._io;
    if (io) {
      io.close();
    }
    await new Promise(resolve => server.close(resolve));
    await mongoose.connection.close(false);
  });

  const directive = (header, name) => {
    const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `));
    return match ? match.slice(name.length + 1).split(/\s+/) : null;
  };

  let csp;

  beforeAll(async () => {
    const response = await request(app).get('/admin/login.html');
    expect(response.status).toBe(200);
    csp = response.headers['content-security-policy'];
    expect(csp).toBeDefined();
  });

  test('script-src does not allow inline script', () => {
    const sources = directive(csp, 'script-src');
    expect(sources).not.toBeNull();
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).toContain("'self'");
  });

  test('inline event handlers are refused', () => {
    const sources = directive(csp, 'script-src-attr');
    expect(sources).toEqual(["'none'"]);
  });

  test('unpkg.com is not an allowed origin for anything', () => {
    expect(csp).not.toContain('unpkg.com');
  });

  test('the pinned CDN is still allowed for scripts and styles', () => {
    expect(directive(csp, 'script-src')).toContain('https://cdn.jsdelivr.net');
    expect(directive(csp, 'style-src')).toContain('https://cdn.jsdelivr.net');
  });

  test('inline styles remain allowed, because Bootstrap needs them', () => {
    expect(directive(csp, 'style-src')).toContain("'unsafe-inline'");
  });

  test('websocket connections to the server are allowed', () => {
    const sources = directive(csp, 'connect-src');
    expect(sources).toContain('wss:');
  });
});
