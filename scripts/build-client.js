#!/usr/bin/env node
/**
 * Bundle the dashboard, the login page and the workflow editor.
 *
 * The sources in client/ are ES modules that import each other and their
 * libraries (Bootstrap, Chart.js, Feather, marked) from node_modules. This
 * turns each page's entry point into one script and one stylesheet under
 * public/dist/, which the server serves like any other static file.
 *
 * Bundling replaces nineteen classic scripts that had to be loaded in exactly
 * the right order and shared one global scope, and five CDN requests, with
 * one file per page that is ours from end to end.
 *
 *   node scripts/build-client.js            production build (minified)
 *   node scripts/build-client.js --watch    rebuild on change, for `npm run dev`
 *
 * The widget is not built here: it is embedded on customers' sites, ships as
 * plain scripts and is content-hashed at start-up by services/asset-manifest.js.
 */

const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  absWorkingDir: root,
  entryPoints: [
    { in: 'client/admin/main.js', out: 'admin' },
    { in: 'client/styles/admin.css', out: 'admin' },
    { in: 'client/workflow-editor/main.js', out: 'workflow-editor' },
    { in: 'client/styles/workflow-editor.css', out: 'workflow-editor' },
    { in: 'client/login.js', out: 'login' },
    { in: 'client/styles/base.css', out: 'base' }
  ],
  outdir: 'public/dist',
  bundle: true,
  // An IIFE rather than an ES module, so the pages need no type="module" and
  // nothing the bundle defines leaks into the global scope.
  format: 'iife',
  target: ['es2020'],
  minify: !watch,
  sourcemap: 'linked',
  // Bootstrap's CSS references its icon font and images by relative URL;
  // copy them alongside rather than inlining megabytes of base64.
  loader: { '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file' },
  logLevel: 'info'
};

async function main() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }

  await esbuild.build(options);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
