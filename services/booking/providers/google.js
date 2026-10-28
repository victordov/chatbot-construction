/**
 * Google Calendar, through OAuth with the diary owner's Google account.
 *
 * Unlike Cal.com and Calendly, Google knows nothing about appointments: it
 * holds events. So the tenant defines their services (name, duration, buffer)
 * and opening hours in our dashboard, and the free times are worked out here:
 * opening hours, minus whatever free/busy says is already in the diary, minus
 * the buffer around each of those, in the business's timezone. A booking is an
 * event with the visitor's details in it.
 *
 * Its own OAuth client (GOOGLE_CALENDAR_CLIENT_ID/SECRET/REDIRECT_URI, falling
 * back to the Sheets client's id and secret) because the consent screen, the
 * scopes and the redirect are different, and because a deployment may want to
 * verify one with Google without the other. Calls are made with plain HTTPS
 * through services/booking/http.js rather than the googleapis client, so they
 * go through the same address-checked transport as every other outbound call.
 *
 * Scopes: calendar.events to write the appointment, calendar.readonly for
 * free/busy and the calendar's own timezone. Nothing that reads other
 * people's calendars or the account's email.
 */

const crypto = require('crypto');

const http = require('../http');
const time = require('../time');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];

/** How long a consent screen may sit open before its callback is refused. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before Google says the token expires. */
const REFRESH_SKEW_MS = 60 * 1000;

function publicBase() {
  return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function oauthConfig() {
  return {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
    // Never the Sheets redirect: that callback stores tokens for a different
    // purpose against a user, not a company.
    redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI || `${publicBase()}/api/booking/google/callback`
  };
}

function isConfigured() {
  const config = oauthConfig();
  return Boolean(config.clientId && config.clientSecret);
}

// ------------------------------------------------------------------ state

function stateKey() {
  return process.env.JWT_SECRET || 'chatbot-jwt-secret';
}

function stateSignature(payload) {
  // A label in the signed material, so a state minted for the Sheets flow
  // (same secret) can never be replayed here, and the other way round.
  return crypto.createHmac('sha256', stateKey()).update(`booking-google:${payload}`).digest('base64url');
}

/**
 * The OAuth `state`: which company, who started it, a nonce the browser that
 * started it also holds in a cookie, and when.
 *
 * The callback is unauthenticated - Google redirects the browser to it - so
 * the state is the only thing saying whose diary this is. Signed, so it cannot
 * name another company; bound to the starting browser by the nonce, so an
 * attacker cannot start the flow for their own company and get a victim to
 * finish it with the victim's calendar.
 */
function signState({ companyId, userId, nonce }) {
  const payload = Buffer.from(JSON.stringify({
    c: String(companyId), u: String(userId), n: nonce, t: Date.now()
  })).toString('base64url');
  return `${payload}.${stateSignature(payload)}`;
}

/** @returns {{companyId: string, userId: string, nonce: string}|null} */
function verifyState(state) {
  if (typeof state !== 'string' || state.length > 2000) {
    return null;
  }
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra !== undefined) {
    return null;
  }

  const expected = Buffer.from(stateSignature(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const issuedAt = Number(data.t);
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 1000 || Date.now() - issuedAt > STATE_TTL_MS) {
    return null;
  }
  if (!data.c || !data.u || !data.n) {
    return null;
  }
  return { companyId: data.c, userId: data.u, nonce: data.n };
}

/** Where to send the admin to grant access. */
function authUrl(state) {
  const config = oauthConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  // offline + consent: the refresh token is the whole point, and Google only
  // hands one out on a consent screen.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Trade the callback's code for tokens. */
async function exchangeCode(code) {
  const config = oauthConfig();
  const { body } = await http.request(TOKEN_URL, {
    method: 'POST',
    form: {
      code: String(code),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code'
    }
  });

  if (!body || !body.access_token) {
    throw new http.ProviderError('Google did not return an access token', 502, body);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || '',
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000),
    scope: body.scope || SCOPES.join(' ')
  };
}

/**
 * A live access token, refreshed and saved when it is about to expire.
 */
async function accessToken(conn) {
  const credentials = conn.credentials || {};
  const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : 0;

  if (credentials.accessToken && expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return credentials.accessToken;
  }
  if (!credentials.refreshToken) {
    throw new http.ProviderError('Google access has expired. Connect the calendar again.', 401);
  }

  const config = oauthConfig();
  let body;
  try {
    ({ body } = await http.request(TOKEN_URL, {
      method: 'POST',
      form: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token'
      }
    }));
  } catch (error) {
    // invalid_grant: the owner removed our access in their Google account,
    // or changed their password. Only reconnecting fixes it.
    if (error.status === 400 || error.status === 401) {
      throw new http.ProviderError('Google access was withdrawn. Connect the calendar again.', 401, error.body);
    }
    throw error;
  }

  const refreshed = {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000)
  };
  conn.credentials = { ...credentials, ...refreshed };
  if (typeof conn.updateCredentials === 'function') {
    await conn.updateCredentials(refreshed);
  }
  return refreshed.accessToken;
}

async function authHeaders(conn) {
  return { authorization: `Bearer ${await accessToken(conn)}` };
}

function calendarPath(conn) {
  return `${API}/calendars/${encodeURIComponent(conn.calendarId || 'primary')}`;
}

/**
 * Whose calendar this is.
 *
 * @returns {Promise<{name: string, email: string, timezone: string, handle: string}>}
 */
async function verify(credentials, calendarId = 'primary') {
  const conn = { credentials, calendarId };
  const { body } = await http.request(calendarPath(conn), { headers: await authHeaders(conn) });
  return {
    name: (body && body.summary) || 'Google Calendar',
    email: (body && body.id) || '',
    timezone: (body && body.timeZone) || '',
    handle: (body && body.id) || ''
  };
}

/** The services are ours to define for Google; nothing to fetch. */
async function listServices(conn) {
  return conn.services || [];
}

/** What is already in the diary between two moments. */
async function busyBetween(conn, from, to) {
  const calendarId = conn.calendarId || 'primary';
  const { body } = await http.request(`${API}/freeBusy`, {
    method: 'POST',
    headers: await authHeaders(conn),
    json: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: calendarId }]
    }
  });

  const calendar = (body && body.calendars && body.calendars[calendarId]) || {};
  if (Array.isArray(calendar.errors) && calendar.errors.length > 0) {
    // "notFound" usually: the calendar was deleted or unshared. Saying there
    // is nothing busy would offer times on top of real appointments.
    throw new http.ProviderError(`Google could not read that calendar (${calendar.errors[0].reason || 'error'})`, 502, body);
  }
  return Array.isArray(calendar.busy) ? calendar.busy : [];
}

function serviceFor(conn, serviceId, given) {
  return given || (conn.services || []).find(service => service.id === serviceId) || null;
}

/**
 * Free times for one service between two moments.
 *
 * @param {object} [extra]
 * @param {{start: Date, end: Date}} [extra.ignore] an interval that is ours to
 *        reuse - the booking being moved - so it does not block itself
 */
async function slots(conn, { serviceId, service: given, from, to, timezone }, extra = {}) {
  const service = serviceFor(conn, serviceId, given);
  if (!service) {
    return [];
  }

  const duration = Number(service.duration) || 30;
  const buffer = Number(service.buffer) || 0;
  const margin = (duration + buffer) * 60000;

  let busy = await busyBetween(conn, new Date(from.getTime() - margin), new Date(to.getTime() + margin));
  if (extra.ignore) {
    const ignoreStart = new Date(extra.ignore.start).getTime();
    const ignoreEnd = new Date(extra.ignore.end).getTime();
    busy = busy.filter(entry =>
      !(new Date(entry.start).getTime() >= ignoreStart && new Date(entry.end).getTime() <= ignoreEnd));
  }

  return time.openingSlots({
    hours: conn.hours || [],
    timezone,
    from,
    to,
    duration,
    buffer,
    busy,
    closedDates: conn.closedDates || []
  });
}

/**
 * Whether one exact start is still a free slot.
 *
 * Booking re-checks rather than trusting the id it was handed: the id came
 * through a visitor's tap or the model's arguments, a minute or an hour after
 * it was offered, and somebody else may have taken the time since. It also
 * stops an invented id naming 3am on a Sunday.
 */
async function isFree(conn, service, start, timezone, extra = {}) {
  const found = await slots(conn, {
    service,
    from: start,
    to: new Date(start.getTime() + 60000),
    timezone
  }, extra);
  return found.some(slot => slot.start.getTime() === start.getTime());
}

function describe({ name, email, phone, notes, reference }) {
  return [
    'Booked through the website assistant.',
    name ? `Name: ${name}` : null,
    email ? `Email: ${email}` : null,
    phone ? `Phone: ${phone}` : null,
    notes ? `Notes: ${notes}` : null,
    reference ? `Reference: ${reference}` : null
  ].filter(Boolean).join('\n');
}

async function book(conn, { serviceId, service: given, start, name, email, phone, notes, timezone, reference }) {
  const service = serviceFor(conn, serviceId, given);
  if (!service) {
    throw new http.ProviderError('That service is not offered', 404);
  }
  if (!(await isFree(conn, service, start, timezone))) {
    throw new http.ProviderError('That time is no longer free', 409);
  }

  const end = new Date(start.getTime() + (Number(service.duration) || 30) * 60000);
  const invite = Boolean(conn.inviteAttendee && email);

  const { body } = await http.request(`${calendarPath(conn)}/events`, {
    method: 'POST',
    headers: await authHeaders(conn),
    // Google emails the guest only when asked to, and only when there is one.
    query: { sendUpdates: invite ? 'all' : 'none' },
    json: {
      summary: `${service.name}${name ? ` – ${name}` : ''}`.slice(0, 250),
      description: describe({ name, email, phone, notes, reference }),
      start: { dateTime: start.toISOString(), timeZone: timezone },
      end: { dateTime: end.toISOString(), timeZone: timezone },
      ...(invite ? { attendees: [{ email, ...(name ? { displayName: name } : {}) }] } : {}),
      extendedProperties: { private: { bookedBy: 'chatbot', reference: reference || '' } }
    }
  });

  if (!body || !body.id) {
    throw new http.ProviderError('Google did not return the new event', 502, body);
  }

  return {
    providerRef: body.id,
    start,
    end,
    status: 'booked',
    providerData: { htmlLink: body.htmlLink || null, invited: invite }
  };
}

async function cancel(conn, bookingRef, details = {}) {
  try {
    await http.request(`${calendarPath(conn)}/events/${encodeURIComponent(bookingRef)}`, {
      method: 'DELETE',
      headers: await authHeaders(conn),
      query: { sendUpdates: details.invited ? 'all' : 'none' }
    });
  } catch (error) {
    // Already gone from the diary - deleted by hand in Google - is the outcome
    // we wanted, not a failure to report.
    if (error.status !== 404 && error.status !== 410) {
      throw error;
    }
  }
  return { cancelled: true };
}

/**
 * Move the event to a new start. The event keeps its id, so the booking's
 * reference to it stays valid.
 *
 * @param {object} details the booking being moved: service, its current
 *        start and end (so it does not count as busy against itself)
 */
async function reschedule(conn, bookingRef, start, details = {}) {
  const service = serviceFor(conn, details.serviceId, details.service);
  if (!service) {
    throw new http.ProviderError('That service is no longer offered', 404);
  }
  const timezone = details.timezone || 'UTC';
  const ignore = details.start ? { start: details.start, end: details.end || details.start } : null;
  if (!(await isFree(conn, service, start, timezone, { ignore }))) {
    throw new http.ProviderError('That time is not free', 409);
  }

  const end = new Date(start.getTime() + (Number(service.duration) || 30) * 60000);
  await http.request(`${calendarPath(conn)}/events/${encodeURIComponent(bookingRef)}`, {
    method: 'PATCH',
    headers: await authHeaders(conn),
    query: { sendUpdates: details.invited ? 'all' : 'none' },
    json: {
      start: { dateTime: start.toISOString(), timeZone: timezone },
      end: { dateTime: end.toISOString(), timeZone: timezone }
    }
  });

  return { providerRef: bookingRef, start, end, status: 'booked' };
}

/**
 * Give the access back when the tenant disconnects. Best effort: the tokens
 * are deleted on our side whatever Google says.
 */
async function revoke(conn) {
  const token = (conn.credentials && (conn.credentials.refreshToken || conn.credentials.accessToken)) || '';
  if (!token) {
    return;
  }
  try {
    await http.request(REVOKE_URL, { method: 'POST', form: { token } });
  } catch {
    // Expired or already revoked: nothing more to do.
  }
}

module.exports = {
  id: 'google',
  label: 'Google Calendar',
  isConfigured,
  oauthConfig,
  signState,
  verifyState,
  authUrl,
  exchangeCode,
  accessToken,
  verify,
  listServices,
  slots,
  book,
  cancel,
  reschedule,
  revoke,
  SCOPES,
  STATE_TTL_MS
};
