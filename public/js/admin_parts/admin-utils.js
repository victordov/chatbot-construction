/**
 * Shared helpers for the admin dashboard.
 *
 * Loaded before every other admin_parts script.
 */


/**
 * Escape a value for interpolation into an HTML template string.
 *
 * The dashboard builds rows with `innerHTML` from data that visitors control -
 * chat domains, contact names, message content, task titles. Without escaping,
 * a visitor who types `<img src=x onerror=...>` into the chat widget executes
 * script in the operator's authenticated session.
 */
function escapeHtml(value) {
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

/**
 * Render Markdown to a safe HTML fragment.
 *
 * marked's `sanitize` option was removed in v5, so `marked.setOptions({
 * sanitize: true })` has been a silent no-op ever since the CDN moved on -
 * task descriptions were rendering raw HTML. Rather than trust the renderer,
 * parse into a detached document and strip anything dangerous.
 */
function renderMarkdown(text) {
  if (!text) {
    return '';
  }

  if (typeof marked === 'undefined') {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  const html = marked.parse(String(text));
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
    'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD'
  ]);

  doc.body.querySelectorAll('*').forEach(node => {
    if (!ALLOWED_TAGS.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }

    [...node.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      // Only links keep an attribute, and only a safe scheme.
      const isSafeHref = node.tagName === 'A' && name === 'href' &&
        /^(https?:|mailto:|\/)/i.test(value);

      if (!isSafeHref) {
        node.removeAttribute(attr.name);
      }
    });

    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });

  return doc.body.innerHTML;
}

/**
 * "3 minutes ago" style timestamps - operators scan these constantly, and a
 * relative time answers "is this stale?" faster than a clock time does.
 */
function formatRelativeTime(value) {
  if (!value) {
    return '';
  }

  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return '';
  }

  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 90) {
    return '1 min ago';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (seconds < 604800) {
    const days = Math.round(seconds / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  return new Date(value).toLocaleDateString();
}

/**
 * Delay a call until the user stops firing it. Used for search-as-you-type so
 * each keystroke does not become a database query.
 */
function debounce(fn, wait = 300) {
  let timer;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Title + body notification.
 *
 * `showNotification` was called from a dozen places in task management but was
 * never defined anywhere, so each call threw a ReferenceError and the user saw
 * nothing at all - not the success confirmation, not the error.
 *
 * @param {string} title
 * @param {string} [message]
 * @param {'success'|'error'|'warning'|'info'} [type]
 */
function showNotification(title, message = '', type = 'info') {
  const variant = { error: 'danger', success: 'success', warning: 'warning', info: 'info' }[type] || 'info';
  const text = message ? `${title}: ${message}` : title;

  if (typeof showToast === 'function') {
    showToast(text, variant);
    return;
  }

  // showToast lives in admin-operators.js; if load order ever changes, fall
  // back to the console rather than throwing.
  logger.info(text);
}
