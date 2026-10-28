/**
 * P2D: the WordPress plugin, the Shopify snippet, and their downloads.
 *
 * The PHP is checked with `php -l` (and its token checked against the
 * server's verifier) only where PHP is installed; everything else - the
 * plugin's shape, the zip the dashboard hands out, what is filled in - runs
 * everywhere.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync, execFileSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const Company = require('../models/company');
const packages = require('../services/install-packages');
const { verifyToken } = require('../services/visitor-identity');

const PLUGIN_DIR = path.join(__dirname, '..', 'sdk', 'wordpress-plugin', 'support-desk-chat');
const SHOPIFY_DIR = path.join(__dirname, '..', 'sdk', 'shopify');

const phpFiles = (dir => {
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => (entry.isDirectory()
    ? walk(path.join(folder, entry.name))
    : (entry.name.endsWith('.php') ? [path.join(folder, entry.name)] : [])));
  return walk(dir);
})(PLUGIN_DIR);

const read = file => fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf8');

const hasPhp = (() => {
  try {
    return spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const withPhp = hasPhp ? it : it.skip;

/** Read a zip back: every entry, inflated and checked against its CRC. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = {};

  for (let i = 0; i < count; i += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const data = zlib.inflateRawSync(buffer.subarray(start, start + compressedSize));

    expect(data.length).toBe(size);
    expect(packages.crc32(data)).toBe(crc);
    entries[name] = data;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('P2D: the WordPress plugin', () => {
  it('has a standard plugin header that requires PHP 7.4', () => {
    const main = read('support-desk-chat.php');
    expect(main).toMatch(/^\s*\* Plugin Name:\s+Support Desk Chat$/m);
    expect(main).toMatch(/^\s*\* Version:\s+\d+\.\d+\.\d+$/m);
    expect(main).toMatch(/^\s*\* Requires PHP:\s+7\.4$/m);
    expect(main).toMatch(/^\s*\* Text Domain:\s+support-desk-chat$/m);
    expect(main).toMatch(/^\s*\* License:\s+GPL-2\.0-or-later$/m);
  });

  it('refuses to run outside WordPress, file by file', () => {
    phpFiles.filter(file => !/index\.php$|uninstall\.php$/.test(file)).forEach(file => {
      expect(fs.readFileSync(file, 'utf8')).toMatch(/if \( ! defined\( 'ABSPATH' \) \) \{\s+exit;/);
    });
    expect(read('uninstall.php')).toMatch(/if \( ! defined\( 'WP_UNINSTALL_PLUGIN' \) \) \{\s+exit;/);
  });

  it('cleans up both options on uninstall, across a network', () => {
    const uninstall = read('uninstall.php');
    expect(uninstall).toContain("delete_option( 'support_desk_chat_settings' )");
    expect(uninstall).toContain("delete_option( 'support_desk_chat_identity_secret' )");
    expect(uninstall).toContain('switch_to_blog');
  });

  it('checks capabilities and nonces, and never prints the secret', () => {
    const settings = read('includes/class-support-desk-chat-settings.php');
    const frontend = read('includes/class-support-desk-chat-frontend.php');

    expect(settings).toContain("'manage_options'");
    expect(settings).toContain("current_user_can( 'manage_options' )");
    expect(settings).toContain('settings_fields( self::GROUP )');
    expect(frontend).toContain("check_ajax_referer( self::AJAX_ACTION, 'nonce' )");
    expect(frontend).toContain('wp_create_nonce( self::AJAX_ACTION )');
    expect(frontend).not.toContain('wp_ajax_nopriv_');
    // The secret field is always rendered empty.
    expect(settings).toMatch(/name="<\?php echo esc_attr\( self::SECRET_OPTION \); \?>" value=""/);
    expect(settings).toContain("add_option( self::SECRET_OPTION, '', '', 'no' )");
    expect(frontend).not.toMatch(/secret\(\)/);
  });

  it('escapes what it echoes', () => {
    phpFiles.forEach(file => {
      const source = fs.readFileSync(file, 'utf8');
      // Every echo goes through an escaping function.
      (source.match(/echo [^;]+;/g) || []).forEach(statement => {
        expect(statement).toMatch(/echo (esc_html|esc_attr|esc_textarea|esc_url|wp_kses_post)\(/);
      });
    });
  });

  it('puts the loader in the footer with the snippet\'s attributes', () => {
    const frontend = read('includes/class-support-desk-chat-frontend.php');
    expect(frontend).toContain("'/widget/js/widget-loader.js', array(), null, true");
    ['data-widget-key', 'data-server-url', 'data-user-jwt'].forEach(attribute => {
      expect(frontend).toContain(`'${attribute}'`);
    });
    expect(frontend).toContain('on("identity-expired"');
  });

  it('has a readme in the wordpress.org format', () => {
    const readme = read('readme.txt');
    expect(readme).toMatch(/^=== Support Desk Chat ===$/m);
    ['Requires at least:', 'Tested up to:', 'Requires PHP: 7.4', 'Stable tag:', 'License:'].forEach(field => {
      expect(readme).toContain(field);
    });
    ['== Description ==', '== Installation ==', '== Frequently Asked Questions ==', '== Changelog =='].forEach(section => {
      expect(readme).toContain(section);
    });
  });

  withPhp('passes php -l, every file', () => {
    phpFiles.forEach(file => {
      const result = spawnSync('php', ['-l', file], { encoding: 'utf8' });
      expect({ file, output: result.stdout.trim(), status: result.status })
        .toEqual({ file, output: expect.stringContaining('No syntax errors'), status: 0 });
    });
  });

  withPhp('signs a token the server accepts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-php-'));
    const script = path.join(dir, 'sign.php');
    fs.writeFileSync(script, [
      '<?php',
      "define( 'ABSPATH', '/' );",
      "define( 'DAY_IN_SECONDS', 86400 );",
      'function wp_json_encode( $data ) { return json_encode( $data ); }',
      `require ${JSON.stringify(path.join(PLUGIN_DIR, 'includes', 'class-support-desk-chat-token.php'))};`,
      '$now = time();',
      "echo Support_Desk_Chat_Token::sign( array( 'sub' => '42', 'iat' => $now, 'exp' => $now + 3600, " +
        "'aud' => 'wk_test_key_123', 'name' => 'Zoë', 'attrs' => array( 'plan' => 'gold' ) ), 'php-secret-0123456789' );"
    ].join('\n'));

    try {
      const token = execFileSync('php', [script], { encoding: 'utf8' }).trim();
      expect(verifyToken(token, { secret: 'php-secret-0123456789', widgetKey: 'wk_test_key_123' }))
        .toMatchObject({ ok: true, externalId: '42', name: 'Zoë', attributes: { plan: 'gold' } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P2D: the Shopify snippet', () => {
  const snippet = fs.readFileSync(path.join(SHOPIFY_DIR, 'support-desk-chat.liquid'), 'utf8');

  it('is anonymous by default and loads the widget with the snippet\'s attributes', () => {
    expect(snippet).toContain("assign sdc_identity = 'none'");
    expect(snippet).toContain('/widget/js/widget-loader.js');
    expect(snippet).toContain('data-widget-key="{{ sdc_widget_key | escape }}"');
    expect(snippet).toContain('data-server-url="{{ sdc_server_url | escape }}"');
  });

  it('never holds a secret, only what a server of yours signed', () => {
    expect(snippet).not.toMatch(/hmac_sha256|identitySecret|secret\s*=/i);
    expect(snippet).toContain('customer.metafields.support_desk.user_hash.value');
    expect(snippet).toContain("ChatWidget.on('identity-expired'");
  });

  it('has install instructions', () => {
    const readme = fs.readFileSync(path.join(SHOPIFY_DIR, 'README.md'), 'utf8');
    expect(readme).toContain("{% render 'support-desk-chat' %}");
    expect(readme).toContain('App Proxy');
    expect(readme).toContain('logged_in_customer_id');
  });
});

describe('P2D: install downloads', () => {
  let app;
  let company;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'P2D Downloads Co' });
    app = express();
    app.set('trust proxy', true);
    app.use('/api/downloads', require('../routes/downloads'));
  });

  afterAll(async () => {
    await Company.deleteMany({ name: /^P2D Downloads/ });
  });

  const binary = (req) => req.buffer(true).parse((res, callback) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });

  it('hands out the plugin as a zip WordPress can install, with every file intact', async () => {
    const response = await binary(request(app).get('/api/downloads/wordpress/support-desk-chat.zip'));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('support-desk-chat.zip');

    const entries = unzip(response.body);
    expect(Object.keys(entries)).toEqual(expect.arrayContaining([
      'support-desk-chat/support-desk-chat.php',
      'support-desk-chat/uninstall.php',
      'support-desk-chat/readme.txt',
      'support-desk-chat/includes/class-support-desk-chat-token.php'
    ]));
    expect(entries['support-desk-chat/support-desk-chat.php'].toString('utf8')).toBe(read('support-desk-chat.php'));
    // Nobody's key in the plain copy.
    expect(entries['support-desk-chat/defaults.json']).toBeUndefined();
  });

  it('fills in a real company\'s key and this server\'s address', async () => {
    const response = await binary(request(app)
      .get(`/api/downloads/wordpress/support-desk-chat.zip?key=${company.widgetKey}`)
      .set('X-Forwarded-Proto', 'https')
      .set('Host', 'chat.example.com'));

    const defaults = JSON.parse(unzip(response.body)['support-desk-chat/defaults.json'].toString('utf8'));
    const previous = process.env.PUBLIC_URL;
    expect(defaults).toEqual({
      serverUrl: (previous || 'https://chat.example.com').replace(/\/+$/, ''),
      widgetKey: company.widgetKey
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('ignores a key that belongs to nobody, or is not a key', async () => {
    for (const key of ['wk_nobody_has_this_key_000000000', '"><script>', '']) {
      const response = await binary(request(app).get(`/api/downloads/wordpress/support-desk-chat.zip?key=${encodeURIComponent(key)}`));
      expect(response.status).toBe(200);
      expect(unzip(response.body)['support-desk-chat/defaults.json']).toBeUndefined();
    }
  });

  it('serves the Shopify snippet, filled in for a real key', async () => {
    const plain = await request(app).get('/api/downloads/shopify/support-desk-chat.liquid');
    expect(plain.status).toBe(200);
    expect(plain.text).toContain("assign sdc_widget_key = 'YOUR_WIDGET_KEY'");

    const filled = await request(app)
      .get(`/api/downloads/shopify/support-desk-chat.liquid?key=${company.widgetKey}&download=1`);
    expect(filled.text).toContain(`assign sdc_widget_key = '${company.widgetKey}'`);
    expect(filled.text).not.toContain("'https://chat.example.com'");
    expect(filled.headers['content-disposition']).toContain('support-desk-chat.liquid');
  });
});
