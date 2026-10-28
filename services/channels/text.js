/**
 * Fitting text into the limits a messaging app sets.
 *
 * Each provider refuses a message over its length - 4,096 characters on
 * WhatsApp, 2,000 on Messenger, 1,000 bytes on Instagram - rather than
 * cutting it short. An answer that long is sent as several messages, split
 * where a person would split it.
 */

/** Characters, or the UTF-8 bytes Instagram counts. */
const characters = text => text.length;
const bytes = text => Buffer.byteLength(text, 'utf8');

/**
 * The longest prefix of `text` that measures at most `limit`, by code point so
 * an emoji is never cut in half.
 */
function prefixWithin(text, limit, measure) {
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(points.slice(0, middle).join('')) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return points.slice(0, low).join('');
}

/**
 * Split text into parts that each fit, preferring a paragraph break, then a
 * line, then a sentence, then a word.
 *
 * @param {string} text
 * @param {number} limit
 * @param {Function} [measure] `characters` (default) or `bytes`
 * @returns {string[]} never empty for non-empty text
 */
function chunkText(text, limit, measure = characters) {
  const parts = [];
  let rest = String(text || '').trim();

  while (rest) {
    if (measure(rest) <= limit) {
      parts.push(rest);
      break;
    }

    const window = prefixWithin(rest, limit, measure);
    if (!window) {
      // Nothing fits at all; never loop forever over it.
      parts.push(rest);
      break;
    }
    const sentenceEnds = [...window.matchAll(/[.!?]\s/g)];
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      sentenceEnds.length ? sentenceEnds[sentenceEnds.length - 1].index + 1 : -1,
      window.lastIndexOf(' ')
    ];
    // The first kind of break that falls past the first third: splitting a
    // long paragraph after its first word makes two awkward messages
    // instead of one long one.
    const cut = candidates.find(index => index > window.length / 3) || window.length;

    parts.push(window.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  return parts;
}

/** Shorten to `max` characters, marking the cut. */
function clip(text, max, ellipsis = '…') {
  const value = String(text || '');
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

module.exports = { chunkText, clip, characters, bytes };
