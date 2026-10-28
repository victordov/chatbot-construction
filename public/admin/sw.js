/**
 * The operator app's service worker: what makes the dashboard installable,
 * survives a dropped connection, and shows push notifications.
 *
 * A plain script rather than part of the bundle, because a service worker is
 * fetched and updated by the browser on its own schedule and has to live at a
 * fixed URL whose folder is its scope (/admin/). server.js serves it with
 * `no-cache`, so a deploy reaches it on the browser's next check.
 *
 * Caching is deliberately narrow. Every screen in the dashboard is live data
 * read from /api, which is never cached and never intercepted: a stale
 * conversation list is worse than none, because somebody would answer from it.
 */

/* eslint-env serviceworker */

const CACHE_PREFIX = 'operator-app-';
// Bump to drop what older versions cached.
const CACHE = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/admin/offline.html';

/**
 * The dashboard's script and stylesheet, kept so a flaky connection that
 * loads the page but drops the script still gets a working dashboard, and
 * the offline page. The page itself is not served from here; see `page`.
 */
const SHELL = ['/dist/admin.js', '/dist/admin.css', OFFLINE_URL, '/admin/icons/icon-192.png'];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', event => {
  // One file failing (a development server without a build, say) must not
  // stop the worker installing; push matters more than the cache.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names
        .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE)
        .map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

/** The network's answer, kept for later; the kept copy when there is no network. */
async function networkFirst(request, cacheKey) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(cacheKey || request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(cacheKey || request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

/**
 * A page of the dashboard. Always from the network; with no network, the
 * offline page rather than a kept copy of the dashboard.
 *
 * The dashboard reads an unreachable server as a session that could not be
 * checked and sends the person to sign in again - so a copy served from the
 * cache while offline would sign them out. The offline page reloads itself
 * and, once the connection is back, that reload is the dashboard again.
 */
async function page(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL);
    if (offline) {
      return offline;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Live data and the socket go straight to the network, always.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }

  if (request.mode === 'navigate') {
    if (url.pathname.startsWith('/admin/')) {
      event.respondWith(page(request));
    }
    return;
  }

  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  }
});

// -------------------------------------------------------------------- push

/** A dashboard window, as opposed to the sign-in page or the workflow editor. */
function isDashboard(client) {
  try {
    const path = new URL(client.url).pathname;
    return path === '/admin/' || path === '/admin/index.html';
  } catch (error) {
    return false;
  }
}

/**
 * Safari and the iPhone app count a push that showed nothing against the
 * site, and after a few take the subscription away. There the notification
 * is shown even while the dashboard is in front, just without a sound.
 */
function mustAlwaysShow() {
  const agent = self.navigator.userAgent || '';
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg|OPR|Android/.test(agent);
}

async function showPush(data) {
  const title = data.title || 'New activity';
  let quiet = false;

  // Somebody already looking at the dashboard has it on screen, and its own
  // alerts; a phone notification on top would only repeat it. A test is
  // always shown: it is sent from the dashboard being looked at.
  if (!data.always) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const watching = windows.some(client => isDashboard(client) && client.focused && client.visibilityState === 'visible');
    if (watching) {
      if (!mustAlwaysShow()) {
        return undefined;
      }
      quiet = true;
    }
  }

  return self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/admin/icons/icon-192.png',
    badge: '/admin/icons/badge-96.png',
    timestamp: data.timestamp || Date.now(),
    silent: quiet,
    data: { url: data.url || '/admin/' }
  });
}

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: event.data ? event.data.text() : '' };
  }
  event.waitUntil(showPush(data));
});

/**
 * Open what the notification is about: in a dashboard window that is already
 * open if there is one, without reloading it (it is told where to go and
 * goes there itself), otherwise in a new one - the installed app, where it is
 * installed.
 */
async function openFromNotification(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const dashboard = windows.find(client => isDashboard(client) && client.focused) || windows.find(isDashboard);

  if (dashboard) {
    try {
      await dashboard.focus();
    } catch (error) {
      // Some platforms only allow focusing from a click they can see; the
      // message below still moves it to the right conversation.
    }
    dashboard.postMessage({ type: 'open-link', url: target });
    return undefined;
  }

  return self.clients.openWindow(target);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();

  // Only ever somewhere in the dashboard, whatever the payload said.
  let target = '/admin/';
  try {
    const url = new URL((event.notification.data && event.notification.data.url) || '/admin/', self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith('/admin/')) {
      target = url.pathname + url.search;
    }
  } catch (error) {
    // Keep the dashboard's front page.
  }

  event.waitUntil(openFromNotification(target));
});
