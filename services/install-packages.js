/**
 * The files a tenant downloads to put the chat on a site builder: the
 * WordPress plugin as an installable zip, and the Shopify theme snippet.
 *
 * Both come from sdk/ and are filled in with the tenant's widget key and this
 * server's address when the download names a real key, so what is installed
 * works without anyone copying values across. The key is public anyway - it
 * is in every page the widget runs on - so the downloads need no sign-in.
 *
 * WordPress's "Upload Plugin" takes only a zip, and no zip library is among
 * our dependencies, so a small writer is here: deflate from zlib, a CRC table,
 * and the three record types a zip file is made of.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SDK_DIR = path.join(__dirname, '..', 'sdk');
const WORDPRESS_DIR = path.join(SDK_DIR, 'wordpress-plugin', 'support-desk-chat');
const SHOPIFY_SNIPPET = path.join(SDK_DIR, 'shopify', 'support-desk-chat.liquid');

/** The folder name WordPress installs the plugin under. */
const PLUGIN_SLUG = 'support-desk-chat';

/** What a widget key looks like (models/company.js mints `wk_` + 32 hex). */
const WIDGET_KEY = /^[A-Za-z0-9_-]{8,128}$/;

// ------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A date in the two 16-bit fields a zip header stores it in. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * A zip archive of the given files.
 *
 * @param {Array<{name: string, data: Buffer}>} files names use `/`
 * @param {Date} [modified]
 * @returns {Buffer}
 */
function zip(files, modified = new Date()) {
  const { time, day } = dosDateTime(modified);
  const locals = [];
  const centrals = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, for deflate
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0 - so the mode below means something
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain file, rw-r--r--
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  });

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

// -------------------------------------------------------- packages

/** Every file under a folder, as zip entries under `prefix/`. */
function filesUnder(dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const full = path.join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        return filesUnder(full, name);
      }
      // Leftovers from a developer's machine are not part of the plugin.
      if (entry.name.startsWith('.') || entry.name === 'defaults.json') {
        return [];
      }
      return [{ name, data: fs.readFileSync(full) }];
    });
}

/** A key and server worth writing into a download, or null. */
function installValues(widgetKey, serverUrl) {
  if (typeof widgetKey !== 'string' || !WIDGET_KEY.test(widgetKey)) {
    return null;
  }
  let origin;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    origin = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
  return { widgetKey, serverUrl: origin };
}

/**
 * The WordPress plugin, ready for Plugins → Add New → Upload Plugin.
 *
 * With install values, a `defaults.json` the plugin reads once on activation
 * fills in the server address and widget key.
 *
 * @param {{widgetKey: string, serverUrl: string}|null} values
 * @returns {Buffer}
 */
function wordpressPlugin(values) {
  const files = filesUnder(WORDPRESS_DIR, PLUGIN_SLUG);
  if (values) {
    files.push({
      name: `${PLUGIN_SLUG}/defaults.json`,
      data: Buffer.from(`${JSON.stringify({ serverUrl: values.serverUrl, widgetKey: values.widgetKey }, null, 2)}\n`)
    });
  }
  return zip(files);
}

/**
 * The Shopify theme snippet, with the server and key filled in when given.
 *
 * The snippet keeps both in two `assign`s at the top; only those two quoted
 * placeholders are replaced, and the values are ones that cannot break out
 * of a quoted Liquid string (a validated key, an origin).
 *
 * @param {{widgetKey: string, serverUrl: string}|null} values
 * @returns {string}
 */
function shopifySnippet(values) {
  const source = fs.readFileSync(SHOPIFY_SNIPPET, 'utf8');
  if (!values || /['"{}%<>\s]/.test(values.serverUrl)) {
    return source;
  }
  return source
    .replace("assign sdc_server_url = 'https://chat.example.com'", `assign sdc_server_url = '${values.serverUrl}'`)
    .replace("assign sdc_widget_key = 'YOUR_WIDGET_KEY'", `assign sdc_widget_key = '${values.widgetKey}'`);
}

module.exports = {
  zip,
  crc32,
  installValues,
  wordpressPlugin,
  shopifySnippet,
  PLUGIN_SLUG
};
