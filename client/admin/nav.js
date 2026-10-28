/**
 * Sections, and moving between them.
 *
 * Each dashboard module registers the section it owns with a `setup` that
 * runs the first time the section is opened and a `show` that runs every
 * time. Nothing loads for a screen nobody opened: the dashboard used to set
 * up all twenty sections at boot, which on a trial plan spent a third of the
 * minute's API allowance before the admin had clicked anything.
 *
 * The URL carries the section (`?section=knowledge`), so a screen can be
 * bookmarked, survives a reload, and the browser's back button works.
 */

import feather from 'feather-icons';
import { getUrlParams, logger, updateUrlWithParams } from './utils.js';

const registry = new Map();
const opened = new Set();

/** Old names still arriving from bookmarks and notification links. */
const ALIASES = {
  dashboard: 'home',
  settings: 'profile'
};

let current = null;
let user = null;
// What the tab says after the section's name. Replaced by core.js with the
// product's own name from the server once it is known.
let productName = 'Dashboard';

/** The product's name, for the browser tab. */
export function setProductName(name) {
  if (name) {
    productName = name;
    if (current) {
      const title = titleFor(current);
      document.title = title ? `${title} · ${productName}` : productName;
    }
  }
}

/**
 * Show the Developers group, or the one line saying which plan has it.
 *
 * Its four screens are for integrating with the API, which the Trial and
 * Basic plans do not include; showing them anyway made each one a dead end.
 */
export function setDevelopersAvailable(available) {
  const group = document.getElementById('nav-developers')?.closest('.nav-group');
  const locked = document.getElementById('nav-developers-locked');
  if (group) {
    group.classList.toggle('d-none', !available);
  }
  if (locked) {
    locked.classList.toggle('d-none', available);
  }
}

/**
 * Register a section. Call at module load.
 *
 * @param {string} id matches `<section id="{id}-section">` and `data-section`
 * @param {object} [hooks]
 * @param {Function} [hooks.setup] once, on first open
 * @param {Function} [hooks.show] every open, after setup, with the URL params
 */
export function registerSection(id, hooks = {}) {
  registry.set(id, hooks);
}

/** The section on screen. */
export function currentSection() {
  return current;
}

function sectionElement(id) {
  return document.getElementById(`${id}-section`);
}

function allowed(element) {
  if (!element || !user) {
    return Boolean(element);
  }
  const roles = element.getAttribute('data-roles');
  return !roles || roles.split(',').map(role => role.trim()).includes(user.role);
}

/**
 * Remove everything this role cannot use. Showing an operator a screen that
 * answers every request with a 403 is worse than not showing it.
 */
function applyRoles() {
  document.querySelectorAll('[data-roles]').forEach(element => {
    if (!allowed(element)) {
      element.remove();
    }
  });

  // A group whose links were all removed would be an orphaned heading.
  document.querySelectorAll('#sidebar .nav-group').forEach(group => {
    if (!group.querySelector('.nav-link')) {
      group.remove();
    }
  });
}

function titleFor(id) {
  const link = document.querySelector(`#sidebar .nav-link[data-section="${id}"]`);
  if (link) {
    // The link's own words, without the count badge some links carry.
    const copy = link.cloneNode(true);
    copy.querySelectorAll('.badge').forEach(badge => badge.remove());
    return copy.textContent.trim();
  }
  return { profile: 'My settings', home: 'Home' }[id] || '';
}

/**
 * Open a section.
 *
 * @param {string} requested
 * @param {object} [options]
 * @param {boolean} [options.push=true] record it in the browser history
 * @param {object} [options.params] extra URL parameters, e.g. `{ chat }`
 */
export function showSection(requested, { push = true, params = {} } = {}) {
  let id = ALIASES[requested] || requested;
  if (!sectionElement(id) || !allowed(sectionElement(id))) {
    id = 'home';
  }

  document.querySelectorAll('.content-section.active').forEach(section => section.classList.remove('active'));
  sectionElement(id).classList.add('active');

  document.querySelectorAll('#sidebar .nav-link[data-section]').forEach(link => {
    const active = link.getAttribute('data-section') === id;
    link.classList.toggle('active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  // A section inside the collapsed Developers group opens the group, so the
  // highlighted link is visible.
  const activeLink = document.querySelector(`#sidebar .nav-link[data-section="${id}"]`);
  const collapsed = activeLink && activeLink.closest('.collapse:not(.show)');
  if (collapsed) {
    collapsed.classList.add('show');
    const toggle = document.querySelector(`[data-bs-target="#${collapsed.id}"]`);
    if (toggle) {
      toggle.classList.remove('collapsed');
      toggle.setAttribute('aria-expanded', 'true');
    }
  }

  const title = titleFor(id);
  document.getElementById('page-title').textContent = title;
  document.title = title ? `${title} · ${productName}` : productName;

  closeSidebar();
  current = id;

  if (push) {
    updateUrlWithParams({ section: id, ...params });
  }

  const hooks = registry.get(id) || {};
  try {
    if (!opened.has(id)) {
      opened.add(id);
      if (hooks.setup) {
        hooks.setup();
      }
    }
    if (hooks.show) {
      hooks.show({ ...getUrlParams(), ...params });
    }
  } catch (error) {
    logger.error(`Could not open the ${id} section`, error);
  }

  feather.replace();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------ small screens

function openSidebar() {
  document.getElementById('sidebar').classList.add('show');
  document.getElementById('sidebar-backdrop').classList.add('show');
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('show');
  document.getElementById('sidebar-backdrop')?.classList.remove('show');
}

// ------------------------------------------------------------------- wiring

/**
 * Apply the role, wire every link, and open whichever section the URL names.
 */
export function initNavigation(signedInUser) {
  user = signedInUser;
  applyRoles();

  // Sidebar links and any `data-section-link` elsewhere (Home's shortcuts,
  // the profile menu).
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-section], [data-section-link]');
    if (!link || link.tagName === 'SECTION' || !link.closest('a, button')) {
      return;
    }
    // Ctrl/Cmd-click opens in a new tab, as a link should.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    showSection(link.getAttribute('data-section') || link.getAttribute('data-section-link'));
  });

  document.getElementById('sidebarToggle')?.addEventListener('click', openSidebar);
  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSidebar();
    }
  });

  window.addEventListener('popstate', () => {
    const params = getUrlParams();
    showSection(params.section || 'home', { push: false });
  });

  const params = getUrlParams();
  // `#billing?checkout=success` is where Stripe sends a customer back to; a
  // bare `?chat=` or `?session=` (a notification, an old link) means the inbox.
  const fromHash = (window.location.hash.match(/^#([a-z-]+)/) || [])[1];
  const initial = params.section || fromHash ||
    (params.chat || params.session ? 'active-chats' : 'home');
  showSection(initial, { push: false });
}
