/**
 * Static pages that must not exist.
 *
 * `public/index.html` was a demo page that embedded the widget against
 * localhost, and `integration-example.html` shipped the old encrypted
 * snippet. Both were served to anyone who asked, from every production
 * deployment, and both told a customer to do the wrong thing.
 */

const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');

describe('Removed static pages', () => {
  let app;

  beforeAll(() => {
    // The same static handler server.js mounts, without the rest of the app.
    app = express();
    app.get('/', (req, res) => res.redirect('/admin/'));
    app.use(express.static(publicDir));
  });

  test.each([
    '/index.html',
    '/widget/integration-example.html'
  ])('%s is gone', async page => {
    expect(fs.existsSync(path.join(publicDir, page))).toBe(false);

    const response = await request(app).get(page);
    expect(response.status).toBe(404);
  });

  test('the root redirects to the dashboard rather than serving a demo page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin/');
  });

  test('the widget encryption scripts are gone', () => {
    expect(fs.existsSync(path.join(publicDir, 'widget/js/encryption.js'))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, 'widget/js/lib'))).toBe(false);
  });

  test('the admin pages carry no inline script', () => {
    // The CSP refuses inline script, so an inline block would silently
    // not run - the page would load and do nothing.
    ['admin/index.html', 'admin/login.html', 'admin/signup.html', 'admin/invite.html', 'admin/workflow-editor.html'].forEach(page => {
      const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
      const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
      expect(inline).toEqual([]);
      expect(html).not.toMatch(/\son[a-z]+="/i);
      expect(html).not.toMatch(/javascript:/i);
    });
  });

  test('the admin pages load nothing from a third-party origin', () => {
    // Bootstrap, Chart.js, Feather and marked are bundled into /dist by
    // scripts/build-client.js, so a compromised or changed CDN file has no way
    // into an operator's authenticated session.
    ['admin/index.html', 'admin/login.html', 'admin/signup.html', 'admin/invite.html', 'admin/workflow-editor.html', 'privacy-policy.html'].forEach(page => {
      const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
      const external = html.match(/<(?:script|link)\b[^>]*(?:src|href)="https?:\/\/[^>]*>/gi) || [];

      expect(external).toEqual([]);
      expect(html).toMatch(/<link rel="stylesheet" href="\/dist\/[a-z-]+\.css">/);
    });
  });
});
