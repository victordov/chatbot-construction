/**
 * Helpers the dashboard modules share. HTTP, escaping, toasts and dialogs live
 * in client/shared/ because the workflow editor uses them too; they are
 * re-exported here so a dashboard module has one place to import from.
 */

import { marked } from 'marked';
import { escapeHtml } from '../shared/html.js';
import { showToast } from '../shared/toast.js';

export { escapeHtml, safeHref } from '../shared/html.js';
export { showToast } from '../shared/toast.js';
export { confirmDialog, promptDialog } from '../shared/dialogs.js';
export {
  api, apiFetch, authHeaders, authToken, downloadFile, errorMessage, getStoredUser,
  parseJsonResponse, sessionExpired, setAuthToken, setStoredUser
} from '../shared/http.js';


/**
 * Console logging behind one name, so a module can say `logger.info` without
 * caring whether the console is there.
 */
export const logger = {
  info: (message, data) => (data === undefined ? console.info(message) : console.info(message, data)),
  warn: (message, data) => (data === undefined ? console.warn(message) : console.warn(message, data)),
  error: (message, error) => (error === undefined ? console.error(message) : console.error(message, error)),
  debug: (message, data) => (data === undefined ? console.info('[DEBUG]', message) : console.info('[DEBUG]', message, data))
};

/**
 * Render Markdown to a safe HTML fragment.
 *
 * marked's `sanitize` option was removed in v5, so `marked.setOptions({
 * sanitize: true })` has been a silent no-op ever since the CDN moved on -
 * task descriptions were rendering raw HTML. Rather than trust the renderer,
 * parse into a detached document and strip anything dangerous.
 */
export function renderMarkdown(text) {
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
export function formatRelativeTime(value) {
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
export function debounce(fn, wait = 300) {
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
export function showNotification(title, message = '', type = 'info') {
  const text = message ? `${title}: ${message}` : title;
  showToast(text, type);
}

// Toggle loading state for buttons
export function setLoading(button, isLoading) {
  if (!button) {
    return;
  }
  if (isLoading) {
    button.dataset.originalContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
  } else {
    if (button.dataset.originalContent) {
      button.innerHTML = button.dataset.originalContent;
      delete button.dataset.originalContent;
    }
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ the URL

/**
 * Replace the query string without reloading, so a section or a conversation
 * can be bookmarked and survives a refresh.
 */
export function updateUrlWithParams(params) {
  const url = new URL(window.location.href);
  url.search = '';

  Object.keys(params).forEach(key => {
    if (params[key]) {
      url.searchParams.set(key, params[key]);
    }
  });

  window.history.pushState({}, '', url);
}

/**
 * Parameters from the query string and from a `#...?key=value` fragment.
 * Notification links use the fragment form, so both are read.
 */
export function getUrlParams() {
  const params = {};

  for (const [key, value] of new URLSearchParams(window.location.search).entries()) {
    params[key] = value;
  }

  const hashParts = window.location.hash.split('?');
  if (hashParts.length > 1) {
    for (const [key, value] of new URLSearchParams(hashParts[1]).entries()) {
      params[key] = value;
    }
  }

  return params;
}
