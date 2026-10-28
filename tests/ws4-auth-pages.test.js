/**
 * The pages before the dashboard - sign in, start a trial, accept an
 * invitation - and their scripts agree, as the dashboard's do
 * (tests/dashboard-markup.test.js): an id renamed on one side and not the
 * other is a button that silently does nothing.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const PAGES = [
  { page: 'public/admin/login.html', script: 'client/login.js', bundle: '/dist/login.js' },
  { page: 'public/admin/signup.html', script: 'client/signup.js', bundle: '/dist/signup.js' },
  { page: 'public/admin/invite.html', script: 'client/invite.js', bundle: '/dist/invite.js' }
];

describe('sign-in pages', () => {
  test.each(PAGES)('every id $script looks up exists in $page', ({ page, script }) => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    const lookups = [...source.matchAll(/getElementById\('([^'$`]+)'\)/g)].map(match => match[1]);

    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.filter(id => !ids.has(id))).toEqual([]);

    // Every show-password button names a field that exists.
    [...html.matchAll(/data-toggle-password="([^"]+)"/g)].forEach(match => {
      expect(ids.has(match[1])).toBe(true);
    });
  });

  test.each(PAGES)('$page loads its own bundle and the shared stylesheet, and is built', ({ page, script, bundle }) => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    expect(html).toContain(`<script src="${bundle}"></script>`);
    expect(html).toContain('<link rel="stylesheet" href="/dist/auth.css">');
    // The product's name is filled in from the server, not written into the page.
    expect(html).toMatch(/data-product-name/);
    expect(html).not.toMatch(/Chatbot Admin/);

    const build = fs.readFileSync(path.join(root, 'scripts/build-client.js'), 'utf8');
    expect(build).toContain(`in: '${script}'`);
  });
});
