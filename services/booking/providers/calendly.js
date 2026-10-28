/**
 * Calendly, with the account owner's personal access token.
 *
 * Calendly owns the event types and the availability. For a long time its API
 * could not make a booking at all - integrations sent people to the booking
 * page. It now can (`POST /invitees`, the "Scheduling API"), but only for
 * accounts on a paid plan (Standard and up); a Free account gets a 403. So:
 *
 *   - paid plan: the invitee is created directly and Calendly sends its usual
 *     confirmation, exactly as if they had booked on the page
 *   - free plan, or an event type whose location the visitor has to choose
 *     (Calendly needs it in the request and we have no way to ask), or no
 *     email to book under: the result is a single-use scheduling link,
 *     pre-filled with their name, email and the day they picked, returned as
 *     `status: 'link'` for the widget to show as a button
 *
 * Calendly has no API to move a booking; moving one here books the new time
 * and then cancels the old, so the visitor never ends up with neither.
 */

const http = require('../http');
const time = require('../time');

const API = 'https://api.calendly.com';

/** Calendly's limit is 31 days per availability request; a week keeps each answer small. */
const WINDOW_DAYS = 7;
const E164 = /^\+[1-9]\d{6,14}$/;

/** Location kinds Calendly fills in itself: we only have to name them. */
const HOST_LOCATIONS = new Set([
  'google_conference', 'zoom_conference', 'microsoft_teams_conference',
  'webex_conference', 'gotomeeting_conference', 'inbound_call'
]);

function headers(conn) {
  return { authorization: `Bearer ${conn.credentials.apiKey}` };
}

/** The last path segment of a Calendly URI: what their other endpoints take. */
function uuidOf(uri) {
  return String(uri || '').split('/').filter(Boolean).pop() || '';
}

async function verify(credentials) {
  const { body } = await http.request(`${API}/users/me`, { headers: headers({ credentials }) });
  const me = (body && body.resource) || {};
  if (!me.uri) {
    throw new http.ProviderError('Calendly did not say whose token this is', 502, body);
  }
  return {
    name: me.name || me.email || 'Calendly',
    email: me.email || '',
    timezone: me.timezone || '',
    handle: me.uri
  };
}

async function listServices(conn) {
  const services = [];
  let pageToken = null;

  // Three pages of a hundred is more event types than any one person keeps.
  for (let page = 0; page < 3; page += 1) {
    const { body } = await http.request(`${API}/event_types`, {
      headers: headers(conn),
      query: { user: conn.account && conn.account.handle, active: 'true', count: 100, page_token: pageToken }
    });

    ((body && body.collection) || []).forEach(type => {
      if (!type || !type.uri) {
        return;
      }
      services.push({
        id: uuidOf(type.uri),
        name: String(type.name || type.slug || 'Event').slice(0, 120),
        duration: Number(type.duration) || 30,
        hidden: Boolean(type.secret),
        providerData: {
          uri: type.uri,
          schedulingUrl: type.scheduling_url || null,
          poolingType: type.pooling_type || null,
          locations: Array.isArray(type.locations)
            ? type.locations.map(location => ({ kind: location.kind, location: location.location || null }))
            : []
        }
      });
    });

    pageToken = body && body.pagination && body.pagination.next_page_token;
    if (!pageToken) {
      break;
    }
  }

  return services;
}

function serviceFor(conn, serviceId, given) {
  return given || (conn.services || []).find(service => service.id === serviceId) || null;
}

async function slots(conn, { serviceId, service: given, from, to }) {
  const service = serviceFor(conn, serviceId, given);
  const uri = service && service.providerData && service.providerData.uri;
  if (!uri) {
    return [];
  }
  const duration = Number(service.duration) || 30;

  // Calendly refuses a start in the past, and "now" has moved on by the time
  // the request arrives.
  let windowStart = new Date(Math.max(from.getTime(), Date.now() + 60000));
  const result = [];

  while (windowStart < to && result.length < 200) {
    const windowEnd = new Date(Math.min(to.getTime(), windowStart.getTime() + WINDOW_DAYS * 86400000));
    const { body } = await http.request(`${API}/event_type_available_times`, {
      headers: headers(conn),
      query: {
        event_type: uri,
        start_time: windowStart.toISOString(),
        end_time: windowEnd.toISOString()
      }
    });

    ((body && body.collection) || [])
      .filter(entry => entry && entry.start_time && (!entry.status || entry.status === 'available'))
      .forEach(entry => {
        const start = new Date(entry.start_time);
        if (!Number.isNaN(start.getTime())) {
          result.push({ start, end: new Date(start.getTime() + duration * 60000) });
        }
      });

    windowStart = windowEnd;
  }

  return result;
}

/**
 * What to tell Calendly about where the meeting is, or null when the visitor
 * would have to choose (which only the booking page can ask them).
 *
 * @returns {{location?: object}|null} an empty object means "send none"
 */
function locationFor(service, phone) {
  const data = service.providerData || {};
  const locations = data.locations || [];

  // Round robin event types must not be sent a location at all.
  if (data.poolingType === 'round_robin' || locations.length === 0) {
    return {};
  }
  if (locations.length > 1) {
    return null;
  }

  const [only] = locations;
  if (HOST_LOCATIONS.has(only.kind)) {
    return { location: { kind: only.kind } };
  }
  if ((only.kind === 'physical' || only.kind === 'custom') && only.location) {
    return { location: { kind: only.kind, location: only.location } };
  }
  if (only.kind === 'outbound_call' && phone) {
    return { location: { kind: 'outbound_call', location: phone } };
  }
  return null;
}

/**
 * A booking page the visitor finishes themselves, with what we know filled in.
 *
 * Single-use where Calendly will make one, so the link cannot be passed round
 * to book a second appointment; the event type's own page otherwise.
 */
async function link(conn, service, { start, name, email, timezone }) {
  let base = service.providerData && service.providerData.schedulingUrl;

  try {
    const { body } = await http.request(`${API}/scheduling_links`, {
      method: 'POST',
      headers: headers(conn),
      json: { max_event_count: 1, owner: service.providerData.uri, owner_type: 'EventType' }
    });
    if (body && body.resource && body.resource.booking_url) {
      base = body.resource.booking_url;
    }
  } catch {
    // The page itself still works; it is only not single-use.
  }

  if (!base) {
    throw new http.ProviderError('Calendly gave no booking page for this event type', 502);
  }

  const url = new URL(base);
  if (name) {
    url.searchParams.set('name', name);
  }
  if (email) {
    url.searchParams.set('email', email);
  }
  if (start) {
    const local = time.localParts(start, timezone || 'UTC');
    url.searchParams.set('month', local.date.slice(0, 7));
    url.searchParams.set('date', local.date);
  }

  return {
    providerRef: null,
    start,
    end: start ? new Date(start.getTime() + (Number(service.duration) || 30) * 60000) : null,
    status: 'link',
    url: url.toString()
  };
}

async function book(conn, { serviceId, service: given, start, name, email, phone, timezone }) {
  const service = serviceFor(conn, serviceId, given);
  if (!service || !service.providerData || !service.providerData.uri) {
    throw new http.ProviderError('That event type is not offered', 404);
  }

  const compactPhone = String(phone || '').replace(/[\s().-]/g, '');
  const where = locationFor(service, E164.test(compactPhone) ? compactPhone : null);

  // Calendly needs an email to book under, and we cannot ask the visitor for
  // a meeting location from here; the booking page can do both.
  if (!email || !name || where === null) {
    return link(conn, service, { start, name, email, timezone });
  }

  let body;
  try {
    ({ body } = await http.request(`${API}/invitees`, {
      method: 'POST',
      headers: headers(conn),
      json: {
        event_type: service.providerData.uri,
        start_time: start.toISOString(),
        invitee: {
          name,
          email,
          timezone: timezone || 'UTC',
          ...(E164.test(compactPhone) ? { text_reminder_number: compactPhone } : {})
        },
        ...where
      }
    }));
  } catch (error) {
    // The Free plan cannot use the Scheduling API.
    if (error.status === 403) {
      return link(conn, service, { start, name, email, timezone });
    }
    throw error;
  }

  const invitee = (body && body.resource) || {};
  if (!invitee.event) {
    throw new http.ProviderError('Calendly did not return the booking', 502, body);
  }

  return {
    providerRef: uuidOf(invitee.event),
    start,
    end: new Date(start.getTime() + (Number(service.duration) || 30) * 60000),
    status: 'booked',
    providerData: {
      invitee: invitee.uri || null,
      cancelUrl: invitee.cancel_url || null,
      rescheduleUrl: invitee.reschedule_url || null
    }
  };
}

async function cancel(conn, bookingRef) {
  try {
    await http.request(`${API}/scheduled_events/${encodeURIComponent(bookingRef)}/cancellation`, {
      method: 'POST',
      headers: headers(conn),
      json: { reason: 'Cancelled through the website assistant' }
    });
  } catch (error) {
    // Already gone - cancelled in Calendly or by the invitee, which Calendly
    // answers with a 404 or a 403 saying so - is the outcome we wanted.
    const alreadyCancelled = error.status === 404 ||
      (error.status === 403 && /cancel/i.test(error.message));
    if (!alreadyCancelled) {
      throw error;
    }
  }
  return { cancelled: true };
}

/**
 * Book the new time first, then cancel the old one: if the new time has gone
 * the visitor still has their original appointment.
 */
async function reschedule(conn, bookingRef, start, details = {}) {
  const moved = await book(conn, { ...details, start });
  if (moved.status !== 'booked') {
    throw new http.ProviderError(
      'Calendly cannot move this booking from here. Send the visitor their reschedule link from the Calendly email.',
      409
    );
  }
  await cancel(conn, bookingRef);
  return moved;
}

module.exports = {
  id: 'calendly',
  label: 'Calendly',
  verify,
  listServices,
  slots,
  book,
  cancel,
  reschedule,
  uuidOf,
  locationFor,
  API
};
