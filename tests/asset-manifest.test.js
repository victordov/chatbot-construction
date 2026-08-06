/**
 * Content-hashed widget assets.
 *
 * The widget runs on other people's sites, where a cache cannot be busted
 * after the fact. Hashing the content into the URL is what lets it be cached
 * hard and still update the instant a deploy changes it.
 */

const request = require('supertest');
const express = require('express');
const path = require('path');
const assetManifest = require('../services/asset-manifest');

describe('Asset manifest', () => {
  beforeAll(() => {
    assetManifest.build();
  });

  test('hashes every widget asset', () => {
    const manifest = assetManifest.all();

    assetManifest.HASHED_ASSETS.forEach(asset => {
      expect(manifest[asset]).toMatch(/\.[a-f0-9]{8}\.(js|css)$/);
    });
  });

  test('the loader is not hashed, because its URL is pasted into customer sites', () => {
    // Changing it would silently break every existing embed.
    expect(assetManifest.HASHED_ASSETS).not.toContain('widget/js/widget-loader.js');
    expect(assetManifest.all()['widget/js/widget-loader.js']).toBeUndefined();
  });

  test('the same content always produces the same hash', () => {
    const first = assetManifest.all();
    assetManifest.build();
    expect(assetManifest.all()).toEqual(first);
  });

  test('resolves a hashed path back to the real file', () => {
    expect(assetManifest.resolveHashedPath('/widget/js/widget.a1b2c3d4.js'))
      .toBe('widget/js/widget.js');
  });

  test('accepts a stale hash, so a page loaded before a deploy still works', () => {
    // Returning 404 here would break the widget mid-conversation.
    expect(assetManifest.resolveHashedPath('/widget/js/widget.00000000.js'))
      .toBe('widget/js/widget.js');
  });

  test('refuses a path that is not a known widget asset', () => {
    expect(assetManifest.resolveHashedPath('/widget/js/evil.a1b2c3d4.js')).toBeNull();
    expect(assetManifest.resolveHashedPath('/server.a1b2c3d4.js')).toBeNull();
  });

  test('refuses a malformed hash', () => {
    expect(assetManifest.resolveHashedPath('/widget/js/widget.zz.js')).toBeNull();
    expect(assetManifest.resolveHashedPath('/widget/js/widget.js')).toBeNull();
  });

  describe('serving', () => {
    let app;

    beforeAll(() => {
      const publicDir = path.join(__dirname, '..', 'public');
      app = express();

      app.get(/^\/widget\/.+\.[a-f0-9]{8}\.(js|css)$/, (req, res, next) => {
        const resolved = assetManifest.resolveHashedPath(req.path);
        if (!resolved) {
          return next();
        }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(path.join(publicDir, resolved), err => err && next(err));
      });

      app.use(express.static(publicDir, {
        setHeaders(res) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }));
    });

    test('a hashed asset is cached immutably', async () => {
      const hashed = assetManifest.all()['widget/js/widget.js'];
      const response = await request(app).get(hashed);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('max-age=31536000');
      expect(response.headers['cache-control']).toContain('immutable');
    });

    test('the loader is served no-cache', async () => {
      const response = await request(app).get('/widget/js/widget-loader.js');

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    });

    test('a hashed URL serves the same bytes as the unhashed one', async () => {
      const hashed = assetManifest.all()['widget/js/widget.js'];
      const [viaHash, direct] = await Promise.all([
        request(app).get(hashed),
        request(app).get('/widget/js/widget.js')
      ]);

      expect(viaHash.text).toBe(direct.text);
    });

    test('a traversal attempt through the hashed route is refused', async () => {
      const response = await request(app).get('/widget/js/../../server.a1b2c3d4.js');
      expect(response.status).toBe(404);
    });
  });
});
