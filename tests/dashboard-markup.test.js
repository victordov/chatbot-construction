/**
 * The dashboard's markup and its code agree.
 *
 * The dashboard is one page whose sections are wired up by modules in
 * client/admin. Moving a card between sections, or renaming an id, used to
 * fail silently: `getElementById` returned null and the button did nothing.
 * These checks catch that at test time instead of in front of a customer.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin/index.html'), 'utf8');
const clientDir = path.join(root, 'client/admin');
const modules = fs.readdirSync(clientDir)
  .filter(file => file.endsWith('.js'))
  .map(file => ({ file, source: fs.readFileSync(path.join(clientDir, file), 'utf8') }));

const idsInPage = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));

/** Elements the code creates itself before looking them up again. */
const CREATED_AT_RUNTIME = new Set([
  'contact-profile-link',
  'conversation-rating',
  'filter-empty-notice',
  'suggestions-toggle'
]);

describe('dashboard markup', () => {
  test('every id the dashboard code looks up exists in the page', () => {
    const missing = [];

    modules.forEach(({ file, source }) => {
      const lookups = [
        ...source.matchAll(/getElementById\('([^'$`]+)'\)/g),
        ...source.matchAll(/\$\('([a-z0-9-]+)'\)/g)
      ].map(match => match[1]);

      lookups
        .filter(id => !idsInPage.has(id) && !CREATED_AT_RUNTIME.has(id))
        .forEach(id => missing.push(`${file}: #${id}`));
    });

    expect(missing).toEqual([]);
  });

  test('every sidebar link opens a section that exists', () => {
    const linked = [...html.matchAll(/data-section="([a-z-]+)"/g)].map(match => match[1]);

    expect(linked.length).toBeGreaterThan(10);
    linked.forEach(section => {
      expect(idsInPage.has(`${section}-section`)).toBe(true);
    });
  });

  test('every section in the page is registered by a module, or is static', () => {
    const sections = [...html.matchAll(/<section id="([a-z-]+)-section"/g)].map(match => match[1]);
    const registered = new Set(modules.flatMap(({ source }) =>
      [...source.matchAll(/registerSection\('([a-z-]+)'/g)].map(match => match[1])));

    const unregistered = sections.filter(section => !registered.has(section));
    expect(unregistered).toEqual([]);
  });

  test('ids are unique, so a lookup cannot find the wrong element', () => {
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = all.filter((id, index) => all.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  test('no native confirm, alert or prompt is left in the dashboard or editor', () => {
    // They block the socket while open and cannot say which button is the
    // dangerous one; client/shared/dialogs.js replaces them.
    const sources = [
      ...modules,
      { file: 'workflow-editor/editor.js', source: fs.readFileSync(path.join(root, 'client/workflow-editor/editor.js'), 'utf8') }
    ];
    const withoutComments = source => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const offenders = sources
      .filter(({ source }) => /(^|[^.\w])(confirm|alert|prompt)\(/m.test(withoutComments(source)))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  test('tenant-only screens are hidden from a superadmin and operators', () => {
    // A superadmin belongs to no company, so tenant settings could only fail
    // for them; operators cannot change company settings at all.
    ['knowledge', 'assistant', 'actions', 'widget', 'billing', 'webhooks', 'api-keys'].forEach(section => {
      const link = html.match(new RegExp(`<a [^>]*data-section="${section}"[^>]*>`));
      expect(link).not.toBeNull();
      expect(link[0]).toMatch(/data-roles="company_admin"/);
    });
  });
});
