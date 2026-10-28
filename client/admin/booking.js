/**
 * Booking: the diary the bot books real appointments in.
 *
 * Three ways in, each with what it needs said up front: a Cal.com API key, a
 * Google sign-in, or a Calendly token. Once connected, the screen is about the
 * two questions an owner actually has - "what may it book?" and "is it
 * working?" - and the list of what it has booked, with a way to cancel.
 *
 * The rules that matter (confirmation before booking, nothing booked from a
 * test, slots re-checked at booking time) are the server's; this screen says
 * them in the words an owner would use.
 */

import feather from 'feather-icons';
import { registerSection } from './nav.js';
import {
  api, confirmDialog, errorMessage, escapeHtml, safeHref, setLoading, showToast
} from './utils.js';

const $ = id => document.getElementById(id);

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STATUS = {
  booked: { label: 'Booked', className: 'bg-success' },
  pending: { label: 'Link sent', className: 'bg-warning text-dark' },
  cancelled: { label: 'Cancelled', className: 'bg-secondary' },
  rescheduled: { label: 'Moved', className: 'bg-info text-dark' },
  no_show: { label: 'No-show', className: 'bg-dark' }
};

const SERVICES_HELP = {
  google: 'The services customers can book, how long each takes, and the gap to keep clear either side of anything already in the calendar.',
  calcom: 'Your Cal.com event types. Untick any the bot should not offer; hidden ones start unticked. Length, buffers and availability are set in Cal.com.',
  calendly: 'Your Calendly event types. Untick any the bot should not offer; secret ones start unticked. Length and availability are set in Calendly.'
};

let connection = null;
let providers = {};

/** Minutes past midnight -> "09:00", for a time input. */
const toTimeValue = minutes => {
  const value = Number.isFinite(minutes) ? Math.min(minutes, 1439) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/** "17:00" -> minutes past midnight; a closing 00:00 is the end of the day. */
const fromTimeValue = (value, closing = false) => {
  const [hours, minutes] = String(value || '0:00').split(':').map(Number);
  const total = (hours || 0) * 60 + (minutes || 0);
  return closing && total === 0 ? 1440 : total;
};

// --------------------------------------------------------------- rendering

function renderProviders() {
  const google = providers.google || {};
  const button = $('booking-google-connect');
  const note = $('booking-google-unavailable');

  button.disabled = !google.available;
  note.classList.toggle('d-none', Boolean(google.available));
  note.textContent = google.available
    ? ''
    : 'Not available on this server yet: whoever runs it has to add a Google OAuth client (GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET).';
}

function renderServices() {
  const container = $('booking-services');
  const google = connection.provider === 'google';
  const services = connection.services || [];

  $('booking-services-help').textContent = SERVICES_HELP[connection.provider] || '';
  $('booking-service-add').classList.toggle('d-none', !google);
  $('booking-refresh').classList.toggle('d-none', google);

  if (google) {
    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm align-middle booking-services-table">
          <thead>
            <tr>
              <th>Bookable</th>
              <th>Service</th>
              <th>Minutes</th>
              <th>Buffer (min)</th>
              <th><span class="visually-hidden">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            ${services.map(service => serviceRow(service)).join('')}
          </tbody>
        </table>
      </div>`;
    feather.replace();
    return;
  }

  if (services.length === 0) {
    container.innerHTML = `<div class="text-muted small">No event types found. Create one in ${escapeHtml(connection.label)}, then press "Fetch event types again".</div>`;
    return;
  }

  container.innerHTML = `
    <ul class="list-unstyled mb-0 booking-services-list">
      ${services.map(service => `
        <li class="d-flex align-items-center gap-2 py-1" data-service-id="${escapeHtml(service.id)}">
          <input class="form-check-input mt-0" type="checkbox" data-service-enabled
                 id="booking-service-${escapeHtml(service.id)}" ${service.enabled ? 'checked' : ''}>
          <label class="form-check-label" for="booking-service-${escapeHtml(service.id)}">
            ${escapeHtml(service.name)}
            <span class="text-muted small">· ${escapeHtml(String(service.duration))} min</span>
            ${service.hidden ? '<span class="badge bg-secondary-subtle text-secondary-emphasis ms-1">hidden</span>' : ''}
          </label>
        </li>`).join('')}
    </ul>`;
}

function serviceRow(service = {}) {
  return `
    <tr data-service-id="${escapeHtml(service.id || '')}">
      <td><input class="form-check-input" type="checkbox" data-service-enabled aria-label="Bookable"
                 ${service.enabled === false ? '' : 'checked'}></td>
      <td><input type="text" class="form-control form-control-sm" data-service-name maxlength="120"
                 value="${escapeHtml(service.name || '')}" placeholder="e.g. Consultation" aria-label="Service name"></td>
      <td><input type="number" class="form-control form-control-sm" data-service-duration min="5" max="480" step="5"
                 value="${escapeHtml(String(service.duration || 30))}" aria-label="Length in minutes"></td>
      <td><input type="number" class="form-control form-control-sm" data-service-buffer min="0" max="240" step="5"
                 value="${escapeHtml(String(service.buffer || 0))}" aria-label="Buffer in minutes"></td>
      <td><button type="button" class="btn btn-sm btn-link text-danger" data-service-remove aria-label="Remove">
            <span data-feather="x"></span></button></td>
    </tr>`;
}

function collectServices() {
  if (connection.provider === 'google') {
    return [...document.querySelectorAll('#booking-services tbody tr')].map(row => ({
      id: row.dataset.serviceId || undefined,
      name: row.querySelector('[data-service-name]').value.trim(),
      duration: Number(row.querySelector('[data-service-duration]').value),
      buffer: Number(row.querySelector('[data-service-buffer]').value || 0),
      enabled: row.querySelector('[data-service-enabled]').checked
    }));
  }
  return [...document.querySelectorAll('#booking-services [data-service-id]')].map(item => ({
    id: item.dataset.serviceId,
    enabled: item.querySelector('[data-service-enabled]').checked
  }));
}

function renderHours(hours) {
  // Monday first, as in Business hours.
  const order = [1, 2, 3, 4, 5, 6, 0];

  $('booking-hours').innerHTML = order.map(day => {
    const rule = hours.find(entry => entry.day === day) ||
      { day, closed: true, opensAt: 540, closesAt: 1020 };

    return `
      <tr data-day="${day}">
        <td>${escapeHtml(DAY_NAMES[day])}</td>
        <td><input class="form-check-input" type="checkbox" data-day-open
                   aria-label="Taking appointments on ${escapeHtml(DAY_NAMES[day])}" ${rule.closed ? '' : 'checked'}></td>
        <td><input type="time" class="form-control form-control-sm" data-day-from
                   value="${toTimeValue(rule.opensAt)}" ${rule.closed ? 'disabled' : ''}></td>
        <td><input type="time" class="form-control form-control-sm" data-day-to
                   value="${toTimeValue(rule.closesAt === 1440 ? 0 : rule.closesAt)}" ${rule.closed ? 'disabled' : ''}></td>
      </tr>`;
  }).join('');
}

function collectHours() {
  return [...document.querySelectorAll('#booking-hours tr')].map(row => ({
    day: Number(row.dataset.day),
    closed: !row.querySelector('[data-day-open]').checked,
    opensAt: fromTimeValue(row.querySelector('[data-day-from]').value),
    closesAt: fromTimeValue(row.querySelector('[data-day-to]').value, true)
  }));
}

function renderConnection() {
  const google = connection.provider === 'google';

  $('booking-connected-title').textContent = `Connected to ${connection.label}`;
  const account = [connection.account.name, connection.account.email].filter(Boolean);
  $('booking-connected-account').textContent = account.length ? account.join(' · ') : '';
  $('booking-connected-timezone').textContent = `Times are in ${connection.timezone}.`;
  $('booking-connected-error').innerHTML = connection.lastError
    ? `<div class="alert alert-warning py-2 px-3 small mb-0">${escapeHtml(connection.lastError)}</div>`
    : '';

  $('booking-enabled').checked = connection.enabled;
  $('booking-horizon').value = connection.horizonDays;
  $('booking-reminders').checked = connection.reminders;

  $('booking-google-settings').classList.toggle('d-none', !google);
  if (google) {
    renderHours(connection.hours || []);
    $('booking-hours-timezone').textContent = connection.timezone;
    $('booking-notice-hours').value = Math.round((connection.minNoticeMinutes || 0) / 60);
    $('booking-calendar-id').value = connection.calendarId || 'primary';
    $('booking-invite').checked = connection.inviteAttendee;
  }

  renderServices();
}

function render() {
  $('booking-providers').classList.toggle('d-none', Boolean(connection));
  $('booking-connected').classList.toggle('d-none', !connection);
  $('booking-test-result').classList.add('d-none');

  if (connection) {
    renderConnection();
  } else {
    renderProviders();
  }
  feather.replace();
}

// ------------------------------------------------------------------ loading

async function load() {
  $('booking-unavailable').classList.add('d-none');

  try {
    const result = await api('/api/booking/connection');
    connection = result.connection;
    providers = result.providers || {};
    render();
  } catch (error) {
    if (error.status === 402) {
      $('booking-unavailable').textContent = 'Booking is not included in your plan. Upgrade under Plan & billing to let your bot book appointments in your calendar.';
      $('booking-unavailable').classList.remove('d-none');
      $('booking-providers').classList.add('d-none');
      $('booking-connected').classList.add('d-none');
    } else {
      showToast(errorMessage(error, 'Could not load the booking settings'), 'danger');
    }
  }

  loadBookings();
}

function conversationLink(sessionId) {
  return `?section=active-chats&chat=${encodeURIComponent(sessionId)}`;
}

async function loadBookings() {
  const list = $('booking-list');

  try {
    const { bookings } = await api('/api/booking/bookings?upcoming=1&limit=100');

    if (!bookings.length) {
      list.innerHTML = '<div class="text-muted p-3">Nothing booked through the bot yet.</div>';
      return;
    }

    list.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0 booking-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Service</th>
              <th>Customer</th>
              <th>Status</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${bookings.map(bookingRow).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (error) {
    list.innerHTML = `<div class="text-danger small p-3">${escapeHtml(errorMessage(error, 'Could not load the bookings'))}</div>`;
  }
}

function bookingRow(booking) {
  const status = STATUS[booking.status] || { label: booking.status, className: 'bg-secondary' };
  const live = booking.status === 'booked' || booking.status === 'pending';
  const contact = [booking.email, booking.phone].filter(Boolean).map(escapeHtml).join(' · ');
  const link = booking.url ? safeHref(booking.url) : null;

  return `
    <tr class="${live ? '' : 'text-muted'}">
      <td class="text-nowrap">
        ${escapeHtml(booking.label)}
        <div class="small text-muted">${escapeHtml(booking.timezone)} · ${escapeHtml(booking.reference)}</div>
      </td>
      <td>${escapeHtml(booking.service || '')}</td>
      <td>
        ${escapeHtml(booking.name || 'Not given')}
        ${contact ? `<div class="small text-muted">${contact}</div>` : ''}
      </td>
      <td>
        <span class="badge ${status.className}">${escapeHtml(status.label)}</span>
        ${link && booking.status === 'pending' ? `<div class="small"><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Their booking page</a></div>` : ''}
      </td>
      <td class="text-end text-nowrap">
        ${booking.sessionId ? `<a class="btn btn-sm btn-link" href="${conversationLink(booking.sessionId)}">Conversation</a>` : ''}
        ${live ? `<button type="button" class="btn btn-sm btn-outline-danger" data-booking-cancel="${escapeHtml(booking.id)}"
                          data-booking-label="${escapeHtml(booking.label)}">Cancel</button>` : ''}
      </td>
    </tr>`;
}

// ------------------------------------------------------------------ actions

async function connectWithKey(provider, inputId, buttonId) {
  const input = $(inputId);
  const button = $(buttonId);
  const key = input.value.trim();

  if (!key) {
    showToast(provider === 'calcom' ? 'Paste your Cal.com API key first' : 'Paste your Calendly token first', 'warning');
    input.focus();
    return;
  }

  setLoading(button, true);
  try {
    const result = await api('/api/booking/connect', { method: 'POST', body: { provider, key } });
    input.value = '';
    connection = result.connection;
    render();
    showToast(`${connection.label} connected. Check which event types the bot may book, then press Test.`, 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not connect'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function connectGoogle() {
  const button = $('booking-google-connect');
  setLoading(button, true);
  try {
    const { url } = await api('/api/booking/google/start', { method: 'POST' });
    // Same tab: Google sends the browser back to this screen when it is done.
    window.location.href = url;
  } catch (error) {
    showToast(errorMessage(error, 'Could not start connecting Google Calendar'), 'danger');
    setLoading(button, false);
  }
}

function collectSettings() {
  const body = {
    reminders: $('booking-reminders').checked,
    horizonDays: Number($('booking-horizon').value),
    services: collectServices()
  };

  if (connection.provider === 'google') {
    body.hours = collectHours();
    body.minNoticeMinutes = Math.round(Number($('booking-notice-hours').value || 0) * 60);
    body.calendarId = $('booking-calendar-id').value.trim() || 'primary';
    body.inviteAttendee = $('booking-invite').checked;
  }
  return body;
}

async function save() {
  const button = $('booking-save');
  setLoading(button, true);
  try {
    const result = await api('/api/booking/connection', { method: 'PUT', body: collectSettings() });
    connection = result.connection;
    render();
    showToast('Saved', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not save'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function toggleEnabled(event) {
  const enabled = event.target.checked;
  try {
    const result = await api('/api/booking/connection', { method: 'PUT', body: { enabled } });
    connection = result.connection;
    showToast(enabled ? 'The bot books appointments again' : 'Booking paused: the bot takes details instead', 'success');
  } catch (error) {
    event.target.checked = !enabled;
    showToast(errorMessage(error, 'Could not change that'), 'danger');
  }
}

async function test() {
  const button = $('booking-test');
  const panel = $('booking-test-result');
  setLoading(button, true);

  try {
    const { slots, timezone } = await api('/api/booking/test', { method: 'POST' });
    panel.innerHTML = slots.length
      ? `<div class="small mb-1">The next free times the bot would offer (${escapeHtml(timezone)}):</div>
         <div class="d-flex gap-2 flex-wrap">
           ${slots.map(slot => `<span class="badge bg-primary-subtle text-primary-emphasis booking-slot">${escapeHtml(slot.label)}</span>`).join('')}
         </div>`
      : '<div class="small text-warning">No free times found. Check which services the bot may book, and your hours or availability.</div>';
    panel.classList.remove('d-none');
    connection.lastError = null;
    $('booking-connected-error').innerHTML = '';
  } catch (error) {
    panel.innerHTML = `<div class="small text-danger">${escapeHtml(errorMessage(error, 'Could not read the calendar'))}</div>`;
    panel.classList.remove('d-none');
  } finally {
    setLoading(button, false);
  }
}

async function refresh() {
  const button = $('booking-refresh');
  setLoading(button, true);
  try {
    const result = await api('/api/booking/connection/refresh', { method: 'POST' });
    connection = result.connection;
    render();
    showToast('Event types updated', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not fetch the event types'), 'danger');
  } finally {
    setLoading(button, false);
  }
}

async function disconnect() {
  const ok = await confirmDialog({
    title: `Disconnect ${connection.label}?`,
    message: 'The bot stops offering times and goes back to taking a preferred time and raising a task. ' +
      'Appointments already booked stay in your calendar.',
    confirmLabel: 'Disconnect',
    danger: true
  });
  if (!ok) {
    return;
  }

  try {
    await api('/api/booking/connection', { method: 'DELETE' });
    connection = null;
    render();
    showToast('Disconnected', 'success');
  } catch (error) {
    showToast(errorMessage(error, 'Could not disconnect'), 'danger');
  }
}

async function cancelBooking(button) {
  const ok = await confirmDialog({
    title: 'Cancel this appointment?',
    message: `${button.dataset.bookingLabel}. It is taken out of the calendar, and the customer is told only if your calendar emails them.`,
    confirmLabel: 'Cancel the appointment',
    cancelLabel: 'Keep it',
    danger: true
  });
  if (!ok) {
    return;
  }

  setLoading(button, true);
  try {
    await api(`/api/booking/bookings/${encodeURIComponent(button.dataset.bookingCancel)}/cancel`, { method: 'POST' });
    showToast('Appointment cancelled', 'success');
    loadBookings();
  } catch (error) {
    showToast(errorMessage(error, 'Could not cancel it'), 'danger');
    setLoading(button, false);
  }
}

// ------------------------------------------------------------------ wiring

function setupBooking() {
  $('booking-calcom-connect').addEventListener('click', () =>
    connectWithKey('calcom', 'booking-calcom-key', 'booking-calcom-connect'));
  $('booking-calendly-connect').addEventListener('click', () =>
    connectWithKey('calendly', 'booking-calendly-token', 'booking-calendly-connect'));
  $('booking-google-connect').addEventListener('click', connectGoogle);

  $('booking-save').addEventListener('click', save);
  $('booking-enabled').addEventListener('change', toggleEnabled);
  $('booking-test').addEventListener('click', test);
  $('booking-refresh').addEventListener('click', refresh);
  $('booking-disconnect').addEventListener('click', disconnect);
  $('booking-list-refresh').addEventListener('click', loadBookings);

  $('booking-service-add').addEventListener('click', () => {
    const body = document.querySelector('#booking-services tbody');
    if (body) {
      body.insertAdjacentHTML('beforeend', serviceRow({ name: '', duration: 30, buffer: 0, enabled: true }));
      feather.replace();
      body.querySelector('tr:last-child [data-service-name]').focus();
    }
  });

  $('booking-services').addEventListener('click', event => {
    const remove = event.target.closest('[data-service-remove]');
    if (remove) {
      remove.closest('tr').remove();
    }
  });

  $('booking-hours').addEventListener('change', event => {
    if (event.target.matches('[data-day-open]')) {
      const row = event.target.closest('tr');
      row.querySelector('[data-day-from]').disabled = !event.target.checked;
      row.querySelector('[data-day-to]').disabled = !event.target.checked;
    }
  });

  $('booking-list').addEventListener('click', event => {
    const button = event.target.closest('[data-booking-cancel]');
    if (button) {
      cancelBooking(button);
    }
  });
}

function show(params = {}) {
  // Back from Google's consent screen: say how it went, once, and take the
  // outcome out of the address so a reload does not say it again.
  if (params.connected === 'google') {
    showToast('Google Calendar connected. Set your services and hours, then press Test.', 'success');
  } else if (params.booking_error) {
    // Our own callback's words; capped, since anybody can put text in a link.
    showToast(String(params.booking_error).slice(0, 200), 'danger', 10000);
  }
  if (params.connected || params.booking_error) {
    window.history.replaceState({}, '', '?section=booking');
  }

  load();
}

registerSection('booking', { setup: setupBooking, show });
