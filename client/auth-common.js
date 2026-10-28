/**
 * What the pages before the dashboard share: signing in, starting a trial,
 * accepting an invitation.
 *
 * None of them can use the dashboard's http helpers, which send anyone
 * without a session back to the login page - the one place these pages
 * already are. So the little they need is here.
 */

const AUTH_TOKEN_KEY = 'chatbot-auth-token';
const STORED_USER_KEY = 'chatbot-user';

const FALLBACK_CONFIG = { productName: 'Support Desk', signupEnabled: false, googleSignIn: false };

/** Set by the dashboard: whose brand this browser last signed in under. */
const BRAND_COMPANY_KEY = 'chatbot-brand-company';

/**
 * Which brand to ask the server for. An agency's client should see the
 * agency's name from the invitation onwards: the invitation page asks about
 * its invitation, and the sign-in page about the company in its address
 * (`?company=`) or the one this browser last signed in to.
 */
function brandQuery() {
  const params = new URLSearchParams(window.location.search);
  if (window.location.pathname.endsWith('/invite.html') && params.get('token')) {
    return `?invite=${encodeURIComponent(params.get('token'))}`;
  }
  let company = params.get('company');
  if (!company) {
    try {
      company = localStorage.getItem(BRAND_COMPANY_KEY);
    } catch (error) {
      company = null;
    }
  }
  return company && /^[a-f0-9]{24}$/i.test(company) ? `?company=${encodeURIComponent(company)}` : '';
}

export function readToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(STORED_USER_KEY);
  } catch (error) {
    // Ignore.
  }
}

export function storeSession(token, user) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(STORED_USER_KEY, JSON.stringify(user || null));
  } catch (error) {
    // Storage blocked: the dashboard will send them straight back here.
  }
}

/**
 * Where to go after signing in: the page they were on when their session
 * ended, when it is a dashboard page, and Home otherwise. Anything else is
 * refused, so `?next=` cannot be used to send somebody to another site.
 */
export function nextDestination(params = new URLSearchParams(window.location.search)) {
  const next = params.get('next');
  if (next && next.startsWith('/admin/') && !next.startsWith('//') && !next.includes('\\') &&
      !next.startsWith('/admin/login.html') && !next.startsWith('/admin/signup.html') &&
      !next.startsWith('/admin/invite.html')) {
    return next;
  }
  return '/admin/';
}

/**
 * Parse a JSON body without throwing on an empty one, and say whether the
 * request was rate limited: a 429 is "slow down", not "wrong password", and
 * telling somebody their password is wrong when it is not sends them to
 * reset it.
 */
export async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

export function messageFor(status, body, fallback) {
  if (status === 429) {
    return 'Too many attempts, try again later.';
  }
  return (body && (body.error || body.message)) || fallback;
}

export function postJson(path, body, token) {
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {})
    },
    body: JSON.stringify(body)
  });
}

export function showMessage(element, text, kind) {
  if (!element) {
    return;
  }
  element.textContent = text;
  element.className = `form-message ${kind || ''}`;
  element.style.display = text ? 'block' : 'none';
}

let configPromise = null;

/** The product's name and which ways in are switched on, fetched once. */
export function loadConfig() {
  if (!configPromise) {
    configPromise = fetch(`/api/auth/config${brandQuery()}`)
      .then(response => (response.ok ? response.json() : FALLBACK_CONFIG))
      .catch(() => FALLBACK_CONFIG);
  }
  return configPromise;
}

/**
 * Put the product's name wherever the page marks it (`data-product-name`)
 * and in the tab title, which keeps whatever follows its "|". An agency's
 * brand also brings its logo (`data-brand-logo`) and colour.
 */
export async function applyBrand() {
  const config = await loadConfig();
  const name = config.productName || FALLBACK_CONFIG.productName;
  const branding = config.branding || null;

  document.querySelectorAll('[data-product-name]').forEach(element => {
    element.textContent = name;
  });

  const logo = branding && /^https:\/\//i.test(branding.logoUrl || '') ? branding.logoUrl : '';
  document.querySelectorAll('[data-brand-logo]').forEach(element => {
    if (logo) {
      element.src = logo;
      element.alt = name;
    }
    element.hidden = !logo;
  });

  if (branding && /^#[0-9a-f]{6}$/i.test(branding.primaryColor || '')) {
    document.documentElement.style.setProperty('--auth-brand', branding.primaryColor);
    document.documentElement.setAttribute('data-branded', '');
  }

  const [page] = document.title.split('|').map(part => part.trim());
  document.title = page ? `${page} | ${name}` : name;
  return config;
}

/**
 * The eye button beside a password field. A button, not a checkbox, so it is
 * one tap on a phone and says what it will do next.
 */
export function setupPasswordToggles(root = document) {
  root.querySelectorAll('[data-toggle-password]').forEach(button => {
    const input = document.getElementById(button.getAttribute('data-toggle-password'));
    if (!input) {
      return;
    }
    button.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? 'Show' : 'Hide';
      button.setAttribute('aria-pressed', String(!showing));
      button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      input.focus();
    });
  });
}
