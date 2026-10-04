/**
 * Escaping for the HTML the dashboard and the editor build as strings.
 */

/**
 * Escape a value for interpolation into an HTML template string.
 *
 * The dashboard builds rows with `innerHTML` from data that visitors control -
 * chat domains, contact names, message content, task titles. Without escaping,
 * a visitor who types `<img src=x onerror=...>` into the chat widget executes
 * script in the operator's authenticated session.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An http(s) URL safe to put in an href, or null. */
export function safeHref(value) {
  try {
    const url = new URL(String(value), window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (error) {
    return null;
  }
}
