#!/usr/bin/env node
/**
 * Draw the operator app's icons into public/admin/icons/.
 *
 *   node scripts/generate-app-icons.js
 *
 * A white speech bubble on the dashboard's blue, in the sizes and shapes the
 * platforms ask for:
 *
 *   icon-192.png, icon-512.png          rounded square, for the install prompt
 *                                       and desktop launchers
 *   maskable-192.png, maskable-512.png  full bleed; Android crops these to its
 *                                       own shape, so the bubble stays inside
 *                                       the centre circle it promises to keep
 *   apple-touch-icon.png                180px, opaque: iOS fills transparency
 *                                       with black and rounds the corners itself
 *   badge-96.png                        the bubble alone; Android shows only
 *                                       its outline in the status bar
 *
 * Drawn here with nothing but Node's own zlib so the icons can be regenerated
 * (in another colour, say) without an image editor or a dependency. The
 * output is committed; this does not run at build time.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'admin', 'icons');

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// ------------------------------------------------------------------- shapes
// Every shape works on coordinates from 0 to 1 across the icon.

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const side = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = side(x, y, ax, ay, bx, by);
  const d2 = side(x, y, bx, by, cx, cy);
  const d3 = side(x, y, cx, cy, ax, ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function insideCircle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** The speech bubble, scaled about the centre (1 fills the safe zone). */
function bubble(x, y, scale) {
  const u = 0.5 + (x - 0.5) / scale;
  const v = 0.5 + (y - 0.5) / scale;
  const body = insideRoundedRect(u, v, 0.22, 0.24, 0.78, 0.66, 0.11);
  const tail = insideTriangle(u, v, [0.3, 0.6], [0.3, 0.8], [0.48, 0.64]);
  return body || tail;
}

/** The three dots inside the bubble, "somebody is typing". */
function dots(x, y, scale) {
  const u = 0.5 + (x - 0.5) / scale;
  const v = 0.5 + (y - 0.5) / scale;
  return [0.36, 0.5, 0.64].some(cx => insideCircle(u, v, cx, 0.45, 0.042));
}

// --------------------------------------------------------------- rendering

/**
 * Colour one pixel by sampling it on a grid, so edges are smooth rather
 * than stair-stepped.
 *
 * @param {Function} paint (x, y) -> [r, g, b, a] or null for transparent
 */
function render(size, paint, samples = 4) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const colour = paint((column + (sx + 0.5) / samples) / size, (row + (sy + 0.5) / samples) / size);
          if (colour) {
            const alpha = colour[3] === undefined ? 255 : colour[3];
            r += colour[0] * alpha;
            g += colour[1] * alpha;
            b += colour[2] * alpha;
            a += alpha;
          }
        }
      }

      const offset = (row * size + column) * 4;
      const count = samples * samples;
      // Colour is averaged weighted by coverage, so a half-covered edge
      // pixel is the shape's colour at half opacity, not a muddier colour.
      pixels[offset] = a ? Math.round(r / a) : 0;
      pixels[offset + 1] = a ? Math.round(g / a) : 0;
      pixels[offset + 2] = a ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a / count);
    }
  }

  return pixels;
}

// --------------------------------------------------------------------- PNG

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGBA PNG. */
function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each row starts with its filter type; 0 is "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0;
    pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------- icons

/** Rounded square background, bubble at full size. */
function standard(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, 1, 1, 0.22)) {
    return null;
  }
  if (bubble(x, y, 1)) {
    return dots(x, y, 1) ? BLUE : WHITE;
  }
  return BLUE;
}

/**
 * Full-bleed background, bubble shrunk into the centre 80% circle that a
 * maskable icon must keep its content inside.
 */
function maskable(x, y) {
  if (bubble(x, y, 0.8)) {
    return dots(x, y, 0.8) ? BLUE : WHITE;
  }
  return BLUE;
}

/** The bubble with its dots cut out, on nothing. */
function badge(x, y) {
  return bubble(x, y, 1.15) && !dots(x, y, 1.15) ? WHITE : null;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, paint: standard },
  { file: 'icon-512.png', size: 512, paint: standard },
  { file: 'maskable-192.png', size: 192, paint: maskable },
  { file: 'maskable-512.png', size: 512, paint: maskable },
  { file: 'apple-touch-icon.png', size: 180, paint: maskable },
  { file: 'badge-96.png', size: 96, paint: badge }
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  ICONS.forEach(({ file, size, paint }) => {
    const target = path.join(OUT_DIR, file);
    fs.writeFileSync(target, png(size, render(size, paint)));
    console.info(`wrote ${path.relative(process.cwd(), target)}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { png, render, crc32 };
