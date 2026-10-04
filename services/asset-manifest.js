/**
 * Content-hashed URLs for the widget's assets.
 *
 * The widget is embedded on other people's sites, where we have no way to bust
 * a cache after the fact. Serving it from a stable path forced `no-cache`,
 * which means a revalidation request on every page view of every customer
 * site - correct, but wasteful.
 *
 * Hashing the content into the URL lets the widget be cached for a year and
 * still update the instant a deploy changes it: a new build means a new URL,
 * and the old one is simply never requested again.
 *
 * The hash is computed once at startup. Assets do not change under a running
 * process, and re-hashing per request would put file I/O on the hot path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logging');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Assets that get a hashed URL. The loader is deliberately NOT in this list:
 * its URL is what customers paste into their site, so it must stay stable
 * forever. It is small and served with `no-cache`, and it is what tells the
 * browser which hashed URLs to fetch.
 */
const HASHED_ASSETS = [
  'widget/js/widget.js',
  'widget/css/widget.css'
];

const manifest = new Map();

function hashFile(relativePath) {
  const absolute = path.join(PUBLIC_DIR, relativePath);

  try {
    const contents = fs.readFileSync(absolute);
    // Eight hex characters is ~4 billion values: ample for cache busting, and
    // short enough to keep URLs readable.
    return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 8);
  } catch (error) {
    logger.warn(`Could not hash asset "${relativePath}"; it will be served unhashed`, {
      error: error.message
    });
    return null;
  }
}

/**
 * Build the manifest. Call once at startup.
 */
function build() {
  manifest.clear();

  HASHED_ASSETS.forEach(relativePath => {
    const hash = hashFile(relativePath);
    if (!hash) {
      return;
    }

    // `widget/js/widget.js` -> `widget/js/widget.<hash>.js`
    const extension = path.extname(relativePath);
    const withoutExtension = relativePath.slice(0, -extension.length);
    manifest.set(relativePath, `${withoutExtension}.${hash}${extension}`);
  });

  logger.info(`Asset manifest built for ${manifest.size} widget asset(s)`);
  return manifest;
}

/**
 * The hashed path for an asset, or the original if it could not be hashed.
 */
function urlFor(relativePath) {
  return `/${manifest.get(relativePath) || relativePath}`;
}

/**
 * Reverse a hashed request path back to the file on disk.
 *
 * Accepts any hash, not just the current one, so that a page loaded moments
 * before a deploy can still fetch the asset it asked for rather than 404ing
 * mid-session. Serving the current bytes is the right trade: the alternative
 * is a broken widget on a live conversation.
 *
 * @returns {string|null} the real path under public/, or null if not a hashed
 *   widget asset
 */
function resolveHashedPath(requestPath) {
  const clean = requestPath.replace(/^\/+/, '');

  // `widget/js/widget.a1b2c3d4.js` -> `widget/js/widget.js`
  const match = clean.match(/^(.*)\.([a-f0-9]{8})(\.[^.]+)$/);
  if (!match) {
    return null;
  }

  const candidate = `${match[1]}${match[3]}`;
  return HASHED_ASSETS.includes(candidate) ? candidate : null;
}

/**
 * The whole manifest, for the loader to fetch.
 */
function all() {
  return Object.fromEntries(
    [...manifest.entries()].map(([original, hashed]) => [original, `/${hashed}`])
  );
}

module.exports = { build, urlFor, resolveHashedPath, all, HASHED_ASSETS };
