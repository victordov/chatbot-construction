/**
 * The one way the dashboard and the editor talk to our API.
 *
 * Every call carries the signed-in user's token, every failure becomes a
 * thrown Error with the server's own message, and an expired session sends
 * the person back to the login page saying why - from whichever call noticed
 * first. That used to need `window.fetch` wrapped globally, because forty-odd
 * call sites built their own requests by hand.
 */

const AUTH_TOKEN_KEY = 'chatbot-auth-token';
const STORED_USER_KEY = 'chatbot-user';

/**
 * The signed-in user's token. One accessor rather than a `localStorage`
 * call at every site, so the key lives in exactly one place and a blocked
 * localStorage cannot throw mid-render.
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
 * The cached user record from login, or null. Wrapped because
 * `JSON.parse(localStorage.getItem(...))` throws on a corrupt or missing value.
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

let redirecting = false;

/**
 * Send the person to the login page because their session ended.
 *
 * A token lasts one shift. Past expiry an operator used to get no error and
 * no prompt: Send did nothing, notes silently failed to save, and the first
 * sign of trouble was a customer asking why nobody had replied.
 */
export function sessionExpired(reason) {
  if (redirecting) {
    return;
  }
  redirecting = true;
  setAuthToken(null);
  // `?expired=1` so the login page can say why they are back there, the
  // server's reason when it gave one (a company switched off is not an
  // expired session), and `next` so signing in again lands where they were.
  const params = new URLSearchParams({ expired: '1' });
  if (reason) {
    params.set('reason', reason);
  }
  const here = `${window.location.pathname}${window.location.search}`;
  if (here.startsWith('/admin/') && !here.startsWith('/admin/login.html')) {
    params.set('next', here);
  }
  window.location.href = `/admin/login.html?${params.toString()}`;
}

/**
 * Parse a JSON response, refusing to pretend a failure was a success.
 *
 * Throws with the server's own message when it gave one, and with `status`
 * and `body` attached so a caller can branch on a 402 or a 409.
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

/** What to tell the user: the server's message if there is one, else ours. */
export function errorMessage(error, fallback) {
  return (error && error.apiMessage) || fallback;
}

/**
 * The raw response for a call to our API, authenticated. For downloads; most
 * callers want `api()`.
 *
 * A `FormData` body is sent as multipart, with the browser choosing the
 * boundary - setting Content-Type by hand breaks it. Anything else that is not
 * a string is sent as JSON.
 */
export async function apiFetch(path, options = {}) {
  const init = { ...options };
  const headers = { 'x-auth-token': authToken(), ...(options.headers || {}) };

  if (init.body !== undefined && init.body !== null &&
      !(init.body instanceof FormData) && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
  }
  if (!(init.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  init.headers = headers;

  const response = await fetch(path, init);

  // Never for the login or verify calls: a failed login is a wrong password,
  // not an expired session.
  const isAuthCall = path.includes('/api/auth/login') || path.includes('/api/auth/verify');
  if (response.status === 401 && !isAuthCall) {
    sessionExpired(response.headers.get('x-auth-reason'));
  }

  return response;
}

/**
 * A JSON call to our own API, authenticated.
 *
 * @param {string} path full path, e.g. `/api/companies/me/widget`
 * @param {RequestInit & {body?: any}} [options] an object body is sent as JSON
 * @returns {Promise<any>} the parsed body; rejects with the server's error
 */
export async function api(path, options = {}) {
  return parseJsonResponse(await apiFetch(path, options));
}

/** Download a response as a file the browser saves. */
export async function downloadFile(path, filename) {
  const response = await apiFetch(path);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
