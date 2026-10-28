/**
 * The operator app on this device: the service worker, "Install the app",
 * and push notifications (My settings → Notifications on this device).
 *
 * The dashboard's own alerts only work while it is open, and somebody
 * answering customers from a reception desk or a shop floor is mostly not
 * looking at it. Installed on a phone with notifications on, a customer
 * asking for a person reaches their pocket.
 *
 * What a device is told about follows the person's Notifications setting on
 * that browser (everything / only when I'm needed / none), sent to the
 * server whenever it is saved and on every load. Previews are this device's
 * own choice, off until turned on.
 *
 * A device belongs to whoever is signed in on it: signing out here stops its
 * notifications, and the next person to sign in has to turn them on for
 * themselves (services/push.js `register`).
 */

import { showSection } from './nav.js';
import { actionToast, openLink, setPushActive } from './notifications.js';
import {
  api, apiFetch, authToken, errorMessage, escapeHtml, formatRelativeTime, logger, setLoading, showToast
} from './utils.js';

const WORKER_URL = '/admin/sw.js';
/** Set once the install offer (or the iPhone instructions) has been shown. */
const INSTALL_OFFERED_KEY = 'app-install-offered';

/** This page's service worker registration, once registered. */
let registration = null;
/** The browser's install prompt, held until the person asks for it. */
let installPrompt = null;
/** `{enabled, publicKey}` from the server, once asked. */
let serverKey = null;
/** This browser's device as the server knows it, or null when push is off here. */
let thisDevice = null;

/**
 * This browser's push device, or null. The dashboard's own desktop alerts
 * stand down while push is on here: Chrome does not merge a page's
 * notification with the service worker's, so both would show.
 */
function useDevice(device) {
  thisDevice = device;
  setPushActive(Boolean(device));
}
/** This browser's push endpoint while it is registered, for signing out. */
let endpoint = null;

const LEVEL_WORDS = {
  all: 'everything: new chats, people asking for a person, chats handed to you',
  important: 'only when you are needed: someone asks for a person, or a chat is assigned or transferred to you',
  none: 'nothing, because your Notifications setting above is None'
};

// ------------------------------------------------------------- the browser

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iPhone and iPad, including an iPad that says it is a Mac. */
function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Running as the installed app rather than in a browser tab. */
function runningInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function stored(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // A browser that keeps nothing offers again next time; no harm.
  }
}

/** The Notifications setting saved on this browser (profile.js). */
function savedLevel() {
  return stored('notification-setting', 'all');
}

function fromBase64Url(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function toBase64Url(buffer) {
  let binary = '';
  new Uint8Array(buffer).forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The server key a subscription was made with, where the browser says. */
function keyOf(subscription) {
  const key = subscription && subscription.options && subscription.options.applicationServerKey;
  return key ? toBase64Url(key) : null;
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  try {
    registration = await navigator.serviceWorker.register(WORKER_URL, { scope: '/admin/' });
  } catch (error) {
    logger.warn('Could not register the service worker', error);
    registration = null;
  }
  return registration;
}

async function currentSubscription() {
  if (!registration || !registration.pushManager) {
    return null;
  }
  try {
    return await registration.pushManager.getSubscription();
  } catch (error) {
    return null;
  }
}

async function loadServerKey() {
  if (!serverKey) {
    try {
      serverKey = await api('/api/push/key');
    } catch (error) {
      logger.warn('Could not ask whether push is set up', error);
      return { enabled: false, publicKey: null };
    }
  }
  return serverKey;
}

/** Tell the server about this browser's subscription. */
function report(subscription, extra = {}) {
  return api('/api/push/subscribe', {
    method: 'POST',
    body: {
      subscription: subscription.toJSON(),
      applicationServerKey: keyOf(subscription) || undefined,
      level: savedLevel(),
      installed: runningInstalled(),
      ...extra
    }
  });
}

function subscribe(publicKey) {
  return registration.pushManager.subscribe({
    // Every push shows a notification; browsers refuse anything else.
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(publicKey)
  });
}

/**
 * On every load: if this browser holds a subscription, check it in, so the
 * server has the current session and setting for it.
 *
 * Only where notifications were allowed and a subscription exists, so a
 * dashboard without push makes no request for it.
 */
async function checkIn() {
  if (!pushSupported() || Notification.permission !== 'granted' || !registration) {
    return;
  }

  const subscription = await currentSubscription();
  if (!subscription) {
    return;
  }

  try {
    const result = await report(subscription, { refresh: true });

    if (!result.device) {
      // Somebody else's, or nobody's: this browser stops listening until
      // the person signed in now turns notifications on themselves.
      await subscription.unsubscribe().catch(() => {});
      useDevice(null);
      endpoint = null;
      return;
    }

    if (result.resubscribe) {
      // The server's key changed since this browser subscribed. Subscribe
      // again under the new one, keeping the device's settings.
      await subscription.unsubscribe().catch(() => {});
      const fresh = await subscribe(result.publicKey);
      await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: subscription.endpoint } }).catch(() => {});
      useDevice((await report(fresh, { previews: result.device.previews })).device);
      endpoint = fresh.endpoint;
      return;
    }

    useDevice(result.device);
    endpoint = subscription.endpoint;
  } catch (error) {
    if (error.status !== 503) {
      logger.warn('Could not check this device in for notifications', error);
    }
  }
}

// --------------------------------------------------------------- settings

function $(id) {
  return document.getElementById(id);
}

function show(id, visible) {
  $(id)?.classList.toggle('d-none', !visible);
}

/** The status line and which buttons make sense right now. */
function renderStatus() {
  const status = $('push-status');
  if (!status) {
    return;
  }

  const previews = $('push-previews');
  let text;
  let canEnable = false;
  let isOn = false;

  show('push-ios-hint', false);

  if (!pushSupported()) {
    if (isIos() && !runningInstalled()) {
      text = 'Notifications need the app on your home screen.';
      show('push-ios-hint', true);
    } else {
      text = 'This browser cannot show notifications from the dashboard.';
    }
  } else if (serverKey && !serverKey.enabled) {
    text = 'Push notifications are not set up on this server yet. Whoever runs it needs to add VAPID keys.';
  } else if (Notification.permission === 'denied') {
    text = 'Notifications are blocked for this site. Allow them in your browser\'s site settings, then come back here.';
  } else if (thisDevice) {
    isOn = true;
    text = `On. This device is told about ${LEVEL_WORDS[thisDevice.level] || LEVEL_WORDS.all}.`;
  } else {
    canEnable = Boolean(serverKey && serverKey.enabled);
    text = 'Off on this device.';
  }

  status.textContent = text;
  show('push-enable-btn', canEnable);
  show('push-disable-btn', isOn);
  show('push-test-btn', isOn);
  if (previews) {
    previews.disabled = !isOn;
    previews.checked = Boolean(thisDevice && thisDevice.previews);
  }
  show('push-install-btn', Boolean(installPrompt));
}

function renderDevices(devices) {
  const list = $('push-devices');
  if (!list) {
    return;
  }

  if (!devices.length) {
    list.innerHTML = '<li class="list-group-item text-muted small">None yet</li>';
    return;
  }

  list.innerHTML = devices.map(device => {
    const current = thisDevice && thisDevice.id === device.id;
    const used = device.lastSentAt ? `last notified ${formatRelativeTime(device.lastSentAt)}` : 'not notified yet';
    return `
      <li class="list-group-item d-flex align-items-center gap-2" data-device-id="${escapeHtml(device.id)}">
        <div class="me-auto">
          <div>${escapeHtml(device.label)}${current ? ' <span class="badge text-bg-primary ms-1">This device</span>' : ''}</div>
          <div class="small text-muted">Added ${escapeHtml(formatRelativeTime(device.createdAt))}, ${escapeHtml(used)}</div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-danger" data-remove-device>Remove</button>
      </li>`;
  }).join('');
}

async function loadDevices() {
  try {
    const { devices } = await api('/api/push/devices');
    renderDevices(devices || []);
  } catch (error) {
    logger.warn('Could not list push devices', error);
  }
}

/** Everything the card shows, fresh: when My settings opens. */
async function refreshCard() {
  await loadServerKey();
  renderStatus();
  if (serverKey && serverKey.enabled) {
    loadDevices();
  }
}

async function enable() {
  const button = $('push-enable-btn');

  // Asked for straight away, while the click still counts as the person's:
  // Safari refuses a permission request that comes after other work.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    showToast(permission === 'denied'
      ? 'Notifications are blocked for this site. Allow them in your browser\'s site settings.'
      : 'Notifications were not allowed', 'warning', 8000);
    renderStatus();
    return;
  }

  setLoading(button, true);
  try {
    const { publicKey } = await loadServerKey();
    if (!registration) {
      await registerWorker();
    }
    if (!registration || !publicKey) {
      throw new Error('This browser could not set up notifications');
    }

    let subscription = await currentSubscription();
    if (subscription && keyOf(subscription) && keyOf(subscription) !== publicKey) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription) {
      subscription = await subscribe(publicKey);
    }

    useDevice((await report(subscription)).device);
    endpoint = subscription.endpoint;
    showToast('Notifications are on for this device. Send a test to see one.', 'success');
    loadDevices();
  } catch (error) {
    logger.error('Could not turn notifications on', error);
    showToast(errorMessage(error, 'Could not turn notifications on for this device'), 'danger');
  } finally {
    setLoading(button, false);
    renderStatus();
  }
}

/** Stop this browser listening, here and on the server. */
async function disable() {
  const button = $('push-disable-btn');
  setLoading(button, true);
  try {
    const subscription = await currentSubscription();
    const address = (subscription && subscription.endpoint) || endpoint;
    if (address) {
      await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: address } });
    }
    if (subscription) {
      await subscription.unsubscribe().catch(() => {});
    }
    useDevice(null);
    endpoint = null;
    showToast('Notifications are off for this device', 'success');
    loadDevices();
  } catch (error) {
    showToast(errorMessage(error, 'Could not turn notifications off'), 'danger');
  } finally {
    setLoading(button, false);
    renderStatus();
  }
}

async function sendTest() {
  const button = $('push-test-btn');
  setLoading(button, true);
  try {
    await api('/api/push/test', { method: 'POST', body: { id: thisDevice ? thisDevice.id : undefined } });
    showToast('Sent. It should arrive in a few seconds.', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not send a test notification'), 'danger');
    if (error.status === 404) {
      // The push service said this device is gone; the server forgot it.
      useDevice(null);
      renderStatus();
      loadDevices();
    }
  } finally {
    setLoading(button, false);
  }
}

/** Save a change to this device: its previews, or the Notifications setting. */
async function updateDevice(changes) {
  const subscription = await currentSubscription();
  if (!subscription || !thisDevice) {
    return;
  }
  try {
    useDevice((await report(subscription, changes)).device || thisDevice);
  } catch (error) {
    showToast(errorMessage(error, 'Could not save that for this device'), 'danger');
  }
  renderStatus();
}

async function removeDevice(id) {
  try {
    await api('/api/push/subscribe', { method: 'DELETE', body: { id } });
    if (thisDevice && thisDevice.id === id) {
      const subscription = await currentSubscription();
      if (subscription) {
        await subscription.unsubscribe().catch(() => {});
      }
      useDevice(null);
      endpoint = null;
      renderStatus();
    }
    loadDevices();
  } catch (error) {
    showToast(errorMessage(error, 'Could not remove that device'), 'danger');
  }
}

// ---------------------------------------------------------------- install

async function install() {
  if (!installPrompt) {
    showSection('profile');
    return;
  }
  const prompt = installPrompt;
  installPrompt = null;
  show('install-app-item', false);
  renderStatus();
  try {
    await prompt.prompt();
  } catch (error) {
    logger.warn('The install prompt could not be shown', error);
  }
}

/** Whether the dashboard has had a few seconds to settle after loading. */
let settled = false;

/**
 * Offer the app once, the first time the browser says it can be installed,
 * and once on an iPhone or iPad (where only the Share menu can do it). After
 * that it waits in My settings and the profile menu.
 *
 * Not in the first seconds after loading, so the offer is not the first
 * thing somebody sees on signing in.
 */
function offerInstallOnce() {
  if (!settled || !authToken() || stored(INSTALL_OFFERED_KEY) || runningInstalled()) {
    return;
  }

  if (installPrompt) {
    remember(INSTALL_OFFERED_KEY, '1');
    actionToast('Install the dashboard as an app, to be notified on this device even when it is closed', {
      actionLabel: 'Install',
      onAction: install,
      delay: 15000
    });
  } else if (isIos()) {
    remember(INSTALL_OFFERED_KEY, '1');
    actionToast('Want notifications on this iPhone or iPad? Add the dashboard to your home screen: tap Share, then Add to Home Screen', {
      actionLabel: 'How',
      onAction: () => showSection('profile'),
      delay: 15000
    });
  }
}

window.addEventListener('beforeinstallprompt', event => {
  // Kept for a button the person presses, rather than the browser's own
  // banner at a moment of its choosing.
  event.preventDefault();
  installPrompt = event;
  show('install-app-item', true);
  renderStatus();
  offerInstallOnce();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  show('install-app-item', false);
  renderStatus();
});

// ------------------------------------------------------------------- wiring

function wire() {
  $('push-enable-btn')?.addEventListener('click', enable);
  $('push-disable-btn')?.addEventListener('click', disable);
  $('push-test-btn')?.addEventListener('click', sendTest);
  $('push-install-btn')?.addEventListener('click', install);
  $('install-app-btn')?.addEventListener('click', install);
  $('push-previews')?.addEventListener('change', event => updateDevice({ previews: event.target.checked }));

  $('push-devices')?.addEventListener('click', event => {
    const row = event.target.closest('[data-device-id]');
    if (row && event.target.closest('[data-remove-device]')) {
      removeDevice(row.dataset.deviceId);
    }
  });

  // The Notifications setting decides what this device is told about too.
  // Read from the form, since this runs before profile.js stores it.
  $('settings-form')?.addEventListener('submit', () => {
    const level = $('notification-setting')?.value;
    if (thisDevice && level && level !== thisDevice.level) {
      updateDevice({ level });
    }
  });

  // Signing out of this browser stops its notifications. Sent with
  // keepalive, because the page is about to go to the sign-in screen.
  $('logout-btn')?.addEventListener('click', () => {
    if (endpoint) {
      apiFetch('/api/push/subscribe', { method: 'DELETE', body: { endpoint }, keepalive: true }).catch(() => {});
      currentSubscription().then(subscription => subscription && subscription.unsubscribe()).catch(() => {});
      endpoint = null;
    }
  });

  // The card is filled when My settings is opened, not at every load: the
  // section is shown by nav.js, which marks it active.
  const section = $('profile-section');
  if (section) {
    let wasActive = false;
    new MutationObserver(() => {
      const active = section.classList.contains('active');
      if (active && !wasActive) {
        refreshCard();
      }
      wasActive = active;
    }).observe(section, { attributes: true, attributeFilter: ['class'] });
  }
}

/** A tap on a notification, in a dashboard that is already open. */
function listenToWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'open-link' && typeof data.url === 'string') {
      openLink(data.url);
    }
  });
  if (typeof navigator.serviceWorker.startMessages === 'function') {
    navigator.serviceWorker.startMessages();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Signed out: core.js is on its way to the sign-in page.
  if (!authToken()) {
    return;
  }

  wire();
  listenToWorker();
  registerWorker()
    .then(checkIn)
    .catch(error => logger.warn('Could not start the operator app', error));

  setTimeout(() => {
    settled = true;
    offerInstallOnce();
  }, 5000);
});
