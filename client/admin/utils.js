/**
 * Shared helpers for the admin dashboard.
 *
 * Loaded before every other admin_parts script.
 */

import * as bootstrap from 'bootstrap';
import { marked } from 'marked';


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

/**
 * Bootstrap's colour names, from whatever a caller passed. `error` is what
 * half the call sites say and `text-bg-error` is not a class Bootstrap has,
 * so those toasts rendered as unstyled white boxes.
 */
export const TOAST_VARIANTS = new Set(['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark']);

export function toastVariant(type) {
  const aliases = { error: 'danger', warn: 'warning', notice: 'info' };
  const variant = aliases[type] || type;
  return TOAST_VARIANTS.has(variant) ? variant : 'info';
}

/**
 * A toast in the corner. The one implementation for every module.
 *
 * @param {string} message
 * @param {string} [type] a Bootstrap colour name, or `error`
 */
export function showToast(message, type = 'info') {
  const container = document.querySelector('.toast-container');
  if (!container) {
    logger.info(message);
    return;
  }

  const variant = toastVariant(type);
  const wrapper = document.createElement('div');
  wrapper.className = `toast align-items-center text-bg-${variant} border-0`;
  wrapper.setAttribute('role', variant === 'danger' || variant === 'warning' ? 'alert' : 'status');
  wrapper.setAttribute('aria-live', variant === 'danger' || variant === 'warning' ? 'assertive' : 'polite');
  wrapper.setAttribute('aria-atomic', 'true');
  wrapper.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(wrapper);

  if (typeof bootstrap === 'undefined' || !bootstrap.Toast) {
    return;
  }
  const toast = new bootstrap.Toast(wrapper, { delay: 5000 });
  toast.show();
  wrapper.addEventListener('hidden.bs.toast', () => wrapper.remove());
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

// ---------------------------------------------------------------- auth + API

export const AUTH_TOKEN_KEY = 'chatbot-auth-token';
export const STORED_USER_KEY = 'chatbot-user';

/**
 * The signed-in operator's token. One accessor rather than eighty-four
 * `localStorage.getItem('chatbot-auth-token')` calls, so the key lives in
 * exactly one place and a blocked localStorage cannot throw mid-render.
 */
export function authToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

export function setAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch (error) {
    // Nothing to do: the next page load will ask them to sign in again.
  }
}

/**
 * The cached user record from login, or null.
 *
 * Wrapped because `JSON.parse(localStorage.getItem(...))` throws on a corrupt
 * or missing value, and a throw at the top of a module means the whole
 * module never loads.
 */
export function getStoredUser() {
  try {
    const raw = localStorage.getItem(STORED_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

export function setStoredUser(user) {
  try {
    if (user) {
      localStorage.setItem(STORED_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORED_USER_KEY);
    }
  } catch (error) {
    // Ignore.
  }
}

/** Headers for a JSON request to our own API. */
export function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'x-auth-token': authToken(),
    ...extra
  };
}

/**
 * Parse a JSON response, refusing to pretend a failure was a success.
 *
 * `.then(response => response.json())` handed an error body to code that
 * then read `data.operators.forEach` and crashed with a message that had
 * nothing to do with the real problem. Throwing here sends every failure to
 * the caller's `.catch`, with the server's own message when it gave one.
 */
export async function parseJsonResponse(response) {
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const serverMessage = body && (body.error || body.message);
    const error = new Error(serverMessage || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    // Only set when the server actually said something, so a network failure
    // still gets the caller's own wording.
    error.apiMessage = serverMessage || null;
    throw error;
  }

  return body;
}

/**
 * What to tell the operator: the server's message if there is one, else the
 * caller's fallback.
 */
export function errorMessage(error, fallback) {
  return (error && error.apiMessage) || fallback;
}

/**
 * A JSON call to our own API, authenticated.
 *
 * @param {string} path full path, e.g. `/api/companies/me/widget`
 * @param {RequestInit} [options]
 * @returns {Promise<any>} the parsed body; rejects with the server's error
 */
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers)
  });

  return parseJsonResponse(response);
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
