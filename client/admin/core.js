/**
 * Dashboard boot: verify the session, open the socket, start what has to be
 * live on every screen, then hand over to the section registry (nav.js).
 *
 * Everything else - knowledge, billing, webhooks and the rest - sets itself
 * up the first time its section is opened.
 */

import feather from 'feather-icons';
import { setupConnectionHandlers, startHeartbeat } from './connection.js';
import { setupContactInfoManagement } from './contact-info.js';
import { setupInbox } from './inbox.js';
import { initNavigation, setDevelopersAvailable, setProductName } from './nav.js';
import { setupNotifications } from './notifications.js';
import { setupOperatorTools } from './operator-tools.js';
import { restoreJoinedChats, state } from './state.js';
import { setupTags } from './tags.js';
import { setupTaskManagement } from './tasks.js';
import {
  api, apiFetch, authHeaders, authToken, confirmDialog, errorMessage, escapeHtml, getUrlParams, logger,
  safeHref, setAuthToken, setStoredUser, showToast
} from './utils.js';

/**
 * The agency's own session, kept aside while its admin works in a client's
 * dashboard on a client token, and put back by "Return to your agency".
 */
const AGENCY_TOKEN_KEY = 'chatbot-agency-token';

/** Which company's brand the sign-in page should wear next time. */
const BRAND_COMPANY_KEY = 'chatbot-brand-company';

function storedAgencyToken() {
  try {
    return localStorage.getItem(AGENCY_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

function setStoredAgencyToken(token) {
  try {
    if (token) {
      localStorage.setItem(AGENCY_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AGENCY_TOKEN_KEY);
    }
  } catch (error) {
    // Storage blocked: "Return to your agency" will mean signing in again.
  }
}

/** Sign one token out on the server, without the session-expired redirect. */
function revoke(token) {
  return fetch('/api/auth/logout', {
    method: 'POST',
    headers: { ...authHeaders(), 'x-auth-token': token }
  }).catch(() => {});
}

/**
 * Open a client's dashboard with the token the agency screen was given: the
 * agency's own session is set aside, not ended.
 */
export function enterClientDashboard(token) {
  setStoredAgencyToken(authToken());
  setAuthToken(token);
  setStoredUser(null);
  window.location.href = '/admin/?section=home';
}

/**
 * Back to the agency: the client session ends on the server - so a copy of
 * it left anywhere is worthless - and the agency's own comes back.
 */
export async function returnToAgency() {
  const agencyToken = storedAgencyToken();
  const clientToken = authToken();
  if (clientToken && clientToken !== agencyToken) {
    await revoke(clientToken);
  }
  setStoredAgencyToken(null);
  setStoredUser(null);
  if (!agencyToken) {
    toLogin();
    return;
  }
  setAuthToken(agencyToken);
  window.location.href = '/admin/?section=agency';
}

/** Back to the sign-in page, saying why when there is a reason worth saying. */
function toLogin(reason) {
  setAuthToken(null);
  setStoredUser(null);
  window.location.href = reason
    ? `/admin/login.html?expired=1&reason=${encodeURIComponent(reason)}`
    : '/admin/login.html';
}

/**
 * Sign out, on the server as well as here.
 *
 * Of this browser only, by default; `everywhere` ends every session this
 * person has, on every device. The local clean-up happens whether or not the
 * server call succeeds, so a dead server cannot keep somebody signed in.
 */
async function logout(everywhere = false) {
  try {
    if (authToken()) {
      await api(everywhere ? '/api/auth/logout-everywhere' : '/api/auth/logout', { method: 'POST' });
    }
    // Signing out while working in a client's dashboard signs the agency
    // session out too: "sign out" should leave nothing signed in behind it.
    const agencyToken = storedAgencyToken();
    if (agencyToken) {
      await revoke(agencyToken);
    }
  } catch (error) {
    logger.warn('Logout request failed; clearing the session locally', error);
  } finally {
    setStoredAgencyToken(null);
    toLogin();
  }
}

/** Exported for My settings, which offers the same button. */
export async function logoutEverywhere() {
  const ok = await confirmDialog({
    title: 'Sign out on every device?',
    message: 'Every browser and phone where you are signed in is signed out, this one included.',
    confirmLabel: 'Sign out everywhere',
    danger: true
  });
  if (ok) {
    logout(true);
  }
}

function initials(user) {
  const name = (user.displayName || user.username || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

/** The person's name and company in the sidebar; also after they edit it. */
export function showProfile(user) {
  const company = user.company && user.company.name;
  document.getElementById('company-badge').textContent = company || '';
  document.getElementById('sidebar-company').textContent =
    company || (user.role === 'superadmin' ? 'Platform admin' : 'Support');
  document.getElementById('profile-name').textContent = user.displayName || user.username;
  document.getElementById('profile-email').textContent = user.email || '';
  document.getElementById('profile-initials').textContent = initials(user);
}

function connect(token) {
  return io({
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });
}

// ---------------------------------------------------------------- banners

/**
 * "Check your inbox", for an admin whose company signed itself up and whose
 * address is not confirmed yet. Until it is, websites cannot be added to the
 * widget, so the banner stays until they do it.
 */
function showVerificationBanner(user) {
  const banner = document.getElementById('verify-email-banner');
  if (!banner) {
    return;
  }

  if (!user.verificationRequired) {
    banner.classList.add('d-none');
    return;
  }

  document.getElementById('verify-email-text').textContent =
    `Check your inbox to confirm ${user.email}. Until you do, you cannot add your website to the widget.`;
  banner.classList.remove('d-none');

  const resend = document.getElementById('verify-email-resend');
  resend.onclick = async () => {
    resend.disabled = true;
    try {
      const result = await api('/api/auth/resend-verification', { method: 'POST' });
      showToast(result.sent
        ? `A new link is on its way to ${result.email}.`
        : 'Email is not set up on this service yet, so the link could not be sent. Ask whoever runs it.',
      result.sent ? 'success' : 'warning', 8000);
    } catch (error) {
      if (error.status === 409) {
        banner.classList.add('d-none');
        showToast('Your address is already confirmed.', 'success');
        return;
      }
      showToast(errorMessage(error, 'Could not send the link'), 'danger');
    } finally {
      resend.disabled = false;
    }
  };
}

/** A meter's warning in one line: "Conversations: 412 of 500 this month (82%)". */
function warningLine(warning) {
  const scope = warning.resets === 'monthly' ? ' this month' : '';
  const amount = value => (warning.money ? `$${Number(value).toFixed(2)}` : Number(value).toLocaleString());
  return `${warning.label}: ${amount(warning.used)} of ${amount(warning.limit)}${scope} (${warning.percent}%)`;
}

/**
 * The plan banner: a trial that has ended, or a meter at 80% or more, with
 * the way out. Shown on every screen, because the screen somebody is on when
 * the bot stops answering is never the billing one.
 */
export function renderUsageBanner(status) {
  const banner = document.getElementById('usage-banner');
  if (!banner) {
    return;
  }

  const all = (status && status.warnings) || [];
  // The spending cap is not a limit anything stops at, so it is said apart
  // from the ones that are, and never with "Upgrade".
  const cap = all.find(warning => warning.money);
  const warnings = all.filter(warning => !warning.money);
  const full = warnings.filter(warning => warning.percent >= 100);
  const upgrade = '<a class="alert-link ms-1" href="?section=billing" data-section-link="billing">Upgrade</a>';
  let html = '';
  let tone = 'warning';

  if (cap && !warnings.length && !(status && status.status === 'trial_expired')) {
    tone = 'info';
    html = cap.percent >= 100
      ? '<strong>Spending cap reached.</strong> Resolutions past it are not billed this month; the bot keeps answering.'
      : `<strong>Nearly at your spending cap.</strong> ${escapeHtml(warningLine(cap))}. Past it, resolutions are not billed.`;
    html += '<a class="alert-link ms-1" href="?section=billing" data-section-link="billing">See billing</a>';
  } else if (status && status.status === 'trial_expired') {
    tone = 'danger';
    html = '<strong>Your trial has ended.</strong> The bot has stopped answering. Choose a plan to switch it back on.' +
      '<a class="alert-link ms-1" href="?section=billing" data-section-link="billing">Choose a plan</a>';
  } else if (full.length) {
    tone = 'danger';
    html = `<strong>Limit reached.</strong> ${full.map(warning => escapeHtml(warningLine(warning))).join('; ')}.` +
      (status.overageAllowed ? ' Overage is on, so nothing stops - it is billed.' : '') + upgrade;
  } else if (warnings.length) {
    html = `<strong>Nearly at a limit.</strong> ${warnings.map(warning => escapeHtml(warningLine(warning))).join('; ')}.` + upgrade;
  }

  banner.className = `alert alert-${tone} app-banner${html ? '' : ' d-none'}`;
  banner.innerHTML = html;
}

/**
 * Plan-dependent parts of the shell: the usage banner and whether the
 * Developers group is offered. Company admins only - an operator cannot
 * change the plan, and the billing API is not theirs to read.
 */
let planStatusInFlight = null;

export function refreshPlanStatus() {
  if (!state.currentUser || state.currentUser.role !== 'company_admin') {
    return Promise.resolve(null);
  }
  // Boot and Home both ask at once; one request answers both.
  if (planStatusInFlight) {
    return planStatusInFlight;
  }
  planStatusInFlight = api('/api/billing/me/status')
    .then(status => {
      renderUsageBanner(status);
      setDevelopersAvailable(Boolean(status.features && status.features.apiAccess));
      return status;
    })
    .catch(error => {
      logger.warn('Could not read the plan status', error);
      return null;
    })
    .finally(() => {
      planStatusInFlight = null;
    });
  return planStatusInFlight;
}

/** The confirmation link lands on the dashboard with `?verified=`. */
function announceVerification(user) {
  const { verified } = getUrlParams();
  if (!verified) {
    return;
  }
  if (verified === 'ok') {
    showToast('Thank you - your email address is confirmed.', 'success', 8000);
    user.verificationRequired = false;
    user.emailVerified = true;
  } else {
    showToast('That confirmation link has expired or was already used. Use Resend in the banner for a new one.', 'warning', 10000);
  }
}

/**
 * The brand this dashboard wears: an agency's on its own and its clients'
 * dashboards, the product's otherwise. The sign-in page is told which
 * company to ask about, so the next sign-in looks the same.
 */
function applyBranding(branding, user) {
  if (!branding) {
    return;
  }
  setProductName(branding.productName);

  const brand = document.getElementById('sidebar-brand');
  const logo = document.getElementById('sidebar-brand-logo');
  const href = branding.custom && branding.logoUrl ? safeHref(branding.logoUrl) : '';
  if (href) {
    logo.src = href;
    logo.alt = branding.productName || '';
    logo.classList.remove('d-none');
  } else {
    logo.classList.add('d-none');
    logo.removeAttribute('src');
  }
  brand.classList.toggle('is-branded', Boolean(branding.custom));

  const color = branding.custom && /^#[0-9a-f]{6}$/i.test(branding.primaryColor || '') ? branding.primaryColor : '';
  // The agency's colour marks the brand and the selected screen.
  if (color) {
    document.documentElement.style.setProperty('--app-brand', color);
    document.documentElement.style.setProperty('--app-sidebar-active', color);
  } else {
    document.documentElement.style.removeProperty('--app-brand');
    document.documentElement.style.removeProperty('--app-sidebar-active');
  }

  try {
    if (branding.custom && user.company && !user.actingAs) {
      localStorage.setItem(BRAND_COMPANY_KEY, String(user.company.id));
    } else if (!user.actingAs) {
      localStorage.removeItem(BRAND_COMPANY_KEY);
    }
  } catch (error) {
    // The sign-in page wears the product's brand instead.
  }
}

/**
 * "You are working in Bloom Dental as Brightside Agency", on every screen
 * of a client's dashboard opened by its agency, with the way back.
 */
function showActingBanner(user) {
  const banner = document.getElementById('acting-banner');
  if (!banner) {
    return;
  }
  if (!user.actingAs) {
    banner.classList.add('d-none');
    return;
  }
  const { companyName, agencyName, expiresAt } = user.actingAs;
  const until = expiresAt
    ? ` This session ends at ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : '';
  document.getElementById('acting-banner-text').textContent =
    `You are working in ${companyName} as ${agencyName}.${until}`;
  banner.classList.remove('d-none');
  document.getElementById('acting-return-btn').onclick = returnToAgency;
}

// ------------------------------------------------------------------- boot

async function boot() {
  if (!authToken()) {
    window.location.href = '/admin/login.html';
    return;
  }

  let user;
  let branding = null;
  try {
    // apiFetch rather than api: a refusal here says why in a header, and the
    // sign-in page needs that reason to say something more useful than
    // "your session expired".
    const response = await apiFetch('/api/auth/verify');
    if (!response.ok) {
      // A client session that has ended goes back to the agency, not to the
      // sign-in page; if the agency's own session has ended too, the next
      // load finds nothing set aside and goes to sign in.
      if (storedAgencyToken()) {
        returnToAgency();
        return;
      }
      toLogin(response.headers.get('x-auth-reason') || 'expired');
      return;
    }
    ({ user, branding } = await response.json());
  } catch (error) {
    logger.error('Auth error:', error);
    toLogin();
    return;
  }

  announceVerification(user);
  setStoredUser(user);
  state.currentUser = user;
  restoreJoinedChats();
  showProfile(user);
  showVerificationBanner(user);
  applyBranding(branding, user);
  showActingBanner(user);

  // A session set aside for an agency that has since signed in afresh is
  // nobody's any more.
  if (!user.actingAs && storedAgencyToken()) {
    setStoredAgencyToken(null);
  }
  document.getElementById('nav-agency')?.classList.toggle(
    'd-none', !(user.company && user.company.isAgency && !user.actingAs)
  );

  document.getElementById('logout-btn').addEventListener('click', () => logout(false));
  document.getElementById('logout-everywhere-btn')?.addEventListener('click', logoutEverywhere);

  const socket = connect(authToken());
  state.socket = socket;

  // Sent just before the server closes this person's sockets on purpose:
  // deactivated, company switched off, signed out everywhere, or a password
  // set by an admin. Straight to the sign-in page, which says which.
  socket.on('session-expired', (data = {}) => {
    toLogin(data.reason || 'expired');
  });

  // A server-side disconnect that came without that notice: ask why, rather
  // than reconnecting into a dashboard that will refuse everything.
  socket.on('disconnect', reason => {
    if (reason !== 'io server disconnect') {
      return;
    }
    apiFetch('/api/auth/verify').then(response => {
      if (response.status === 401) {
        toLogin(response.headers.get('x-auth-reason') || 'expired');
      } else {
        socket.connect();
      }
    }).catch(() => {});
  });

  // Live on every screen: the queue and its counts, notifications, the
  // connection indicator, and what the inbox's buttons need.
  setupConnectionHandlers(socket);
  startHeartbeat(socket);
  setupInbox(socket);
  setupOperatorTools(socket);
  setupTags(socket);
  setupTaskManagement();
  setupContactInfoManagement();
  setupNotifications(socket);

  initNavigation(user);
  refreshPlanStatus();
  feather.replace();
}

document.addEventListener('DOMContentLoaded', boot);
