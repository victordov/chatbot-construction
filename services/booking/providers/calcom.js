/**
 * Cal.com, through its v2 API with the tenant's API key.
 *
 * Cal.com owns everything here: the event types, the availability (working
 * hours, buffers, minimum notice, other calendars it checks) and the booking
 * with its confirmation emails. We list, ask, book, cancel and move.
 *
 * Every v2 endpoint is versioned by a `cal-api-version` header, and each
 * endpoint has its own current version; without the header Cal.com quietly
 * answers with an older shape. The values below are the ones the API
 * reference gives for each endpoint (October 2026). They are pinned rather
 * than "latest" so a new Cal.com release cannot change what we parse.
 */

const http = require('../http');

const BASE = 'https://api.cal.com/v2';

const API_VERSIONS = {
  eventTypes: '2026-06-12',
  slots: '2024-09-04',
  bookings: '2026-02-25'
};

/** Cal.com's E.164 rule for attendee phone numbers; anything else is left off. */
const E164 = /^\+[1-9]\d{6,14}$/;

function headers(conn, version) {
  return {
    authorization: `Bearer ${conn.credentials.apiKey}`,
    ...(version ? { 'cal-api-version': version } : {})
  };
}

/**
 * Check a key and say whose it is.
 *
 * @returns {Promise<{name: string, email: string, timezone: string, handle: string}>}
 */
async function verify(credentials) {
  const { body } = await http.request(`${BASE}/me`, { headers: headers({ credentials }) });
  const me = (body && body.data) || {};
  return {
    name: me.name || me.username || me.email || 'Cal.com',
    email: me.email || '',
    timezone: me.timeZone || '',
    handle: me.username || ''
  };
}

/** The key owner's event types. */
async function listServices(conn) {
  const { body } = await http.request(`${BASE}/event-types`, {
    headers: headers(conn, API_VERSIONS.eventTypes),
    query: { username: conn.account && conn.account.handle }
  });

  // An array under `data` today; older versions nested it. Read either, so a
  // shape change shows up as "no event types" rather than a crash.
  const data = body && body.data;
  const list = Array.isArray(data) ? data
    : (data && Array.isArray(data.eventTypes) ? data.eventTypes : []);

  return list
    .filter(type => type && type.id !== undefined)
    .map(type => ({
      id: String(type.id),
      name: String(type.title || type.slug || `Event type ${type.id}`).slice(0, 120),
      duration: Number(type.lengthInMinutes || type.length) || 30,
      hidden: Boolean(type.hidden),
      providerData: { slug: type.slug || null }
    }));
}

/**
 * Free times for one event type.
 *
 * `format=range` so each slot carries its end; the response is grouped by
 * date, which we flatten.
 */
async function slots(conn, { serviceId, from, to, timezone }) {
  const { body } = await http.request(`${BASE}/slots`, {
    headers: headers(conn, API_VERSIONS.slots),
    query: {
      eventTypeId: serviceId,
      start: from.toISOString(),
      end: to.toISOString(),
      timeZone: timezone,
      format: 'range'
    }
  });

  const byDate = (body && body.data) || {};
  const result = [];

  Object.values(byDate).forEach(day => {
    (Array.isArray(day) ? day : []).forEach(entry => {
      const start = new Date(typeof entry === 'string' ? entry : entry.start);
      if (Number.isNaN(start.getTime())) {
        return;
      }
      const end = entry && entry.end ? new Date(entry.end) : null;
      result.push({ start, end: end && !Number.isNaN(end.getTime()) ? end : null });
    });
  });

  return result;
}

/** A booking from whichever shape came back (recurring bookings are arrays). */
function bookingFrom(body) {
  const data = body && body.data;
  return Array.isArray(data) ? data[0] : data;
}

async function book(conn, { serviceId, start, name, email, phone, notes, timezone, reference }) {
  const attendee = {
    name: name || 'Website visitor',
    timeZone: timezone,
    language: 'en'
  };
  if (email) {
    attendee.email = email;
  }
  const compactPhone = String(phone || '').replace(/[\s().-]/g, '');
  if (E164.test(compactPhone)) {
    attendee.phoneNumber = compactPhone;
  }

  // Notes go in metadata rather than a booking field: a field Cal.com does not
  // know for this event type is a 400, metadata never is. Values are capped at
  // 500 characters by Cal.com.
  const metadata = { source: 'chatbot', reference };
  if (notes) {
    metadata.notes = String(notes).slice(0, 500);
  }

  const { body } = await http.request(`${BASE}/bookings`, {
    method: 'POST',
    headers: headers(conn, API_VERSIONS.bookings),
    json: {
      start: start.toISOString(),
      eventTypeId: Number(serviceId),
      attendee,
      metadata
    }
  });

  const booking = bookingFrom(body) || {};
  if (!booking.uid) {
    throw new http.ProviderError('Cal.com did not return a booking', 502, body);
  }
  if (['cancelled', 'rejected'].includes(booking.status)) {
    throw new http.ProviderError(`Cal.com ${booking.status} the booking`, 409, body);
  }

  return {
    providerRef: booking.uid,
    start: booking.start ? new Date(booking.start) : start,
    end: booking.end ? new Date(booking.end) : null,
    status: 'booked',
    // "pending" means the host confirms bookings by hand; worth knowing in
    // the dashboard, not a reason to tell the visitor it failed.
    providerData: { status: booking.status || null, id: booking.id || null }
  };
}

async function cancel(conn, bookingRef) {
  await http.request(`${BASE}/bookings/${encodeURIComponent(bookingRef)}/cancel`, {
    method: 'POST',
    headers: headers(conn, API_VERSIONS.bookings),
    json: { cancellationReason: 'Cancelled through the website assistant' }
  });
  return { cancelled: true };
}

/**
 * Move a booking. Cal.com makes a new booking for the new time, with a new
 * uid, and links the two; the new uid is what a later cancel needs.
 */
async function reschedule(conn, bookingRef, start) {
  const { body } = await http.request(`${BASE}/bookings/${encodeURIComponent(bookingRef)}/reschedule`, {
    method: 'POST',
    headers: headers(conn, API_VERSIONS.bookings),
    json: { start: start.toISOString(), reschedulingReason: 'Moved by the team' }
  });

  const booking = bookingFrom(body) || {};
  return {
    providerRef: booking.uid || bookingRef,
    start: booking.start ? new Date(booking.start) : start,
    end: booking.end ? new Date(booking.end) : null,
    status: 'booked'
  };
}

module.exports = {
  id: 'calcom',
  label: 'Cal.com',
  verify,
  listServices,
  slots,
  book,
  cancel,
  reschedule,
  API_VERSIONS,
  BASE
};
