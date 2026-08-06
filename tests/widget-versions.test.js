/**
 * Widget version archiving.
 *
 * The point of an archive is that it does not change. A customer pinned to a
 * version has to keep receiving the code that version was.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WidgetUpdateService = require('../services/widgetUpdate');

describe('Widget version archives', () => {
  let root;
  let widgetDir;
  let versionsDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-versions-'));
    widgetDir = path.join(root, 'widget');
    versionsDir = path.join(root, 'versions');

    fs.mkdirSync(widgetDir, { recursive: true });
    fs.writeFileSync(path.join(widgetDir, 'widget.js'), 'console.log("v1");');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const service = (currentVersion = '1.0.0') => new WidgetUpdateService({
    widgetDir, versionsDir, currentVersion
  });

  test('the current widget is archived on first start', () => {
    const updater = service();
    updater.archiveCurrentVersion();

    expect(fs.readFileSync(path.join(versionsDir, '1.0.0', 'widget.js'), 'utf8'))
      .toContain('v1');
  });

  test('an existing archive is never overwritten', () => {
    const updater = service();
    updater.archiveCurrentVersion();

    // The widget source moves on.
    fs.writeFileSync(path.join(widgetDir, 'widget.js'), 'console.log("v2");');
    const result = updater.archiveCurrentVersion();

    expect(result).toBe(false);
    expect(fs.readFileSync(path.join(versionsDir, '1.0.0', 'widget.js'), 'utf8'))
      .toContain('v1');
  });

  test('a change is archived under a version nothing has claimed', async () => {
    // `incrementVersion` alone returned 1.0.1 while 1.0.1 already existed, so
    // every source change clobbered the same archive.
    const updater = service();
    updater.archiveCurrentVersion();

    ['1.0.1', '1.0.2'].forEach(version => {
      fs.mkdirSync(path.join(versionsDir, version), { recursive: true });
      updater.versionInfo.versions.push(version);
    });

    fs.writeFileSync(path.join(widgetDir, 'widget.js'), 'console.log("v2");');
    await updater.checkForUpdates();

    expect(updater.currentVersion).toBe('1.0.3');
    expect(fs.readFileSync(path.join(versionsDir, '1.0.3', 'widget.js'), 'utf8'))
      .toContain('v2');
    // And the ones that already existed are untouched.
    expect(fs.existsSync(path.join(versionsDir, '1.0.1', 'widget.js'))).toBe(false);
  });

  test('no change means no new version', async () => {
    const updater = service();
    updater.archiveCurrentVersion();

    await updater.checkForUpdates();

    expect(updater.currentVersion).toBe('1.0.0');
    expect(fs.existsSync(path.join(versionsDir, '1.0.1'))).toBe(false);
  });
});
