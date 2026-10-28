/**
 * The three calendar adapters, each against a stubbed provider.
 *
 * Nothing here reaches the internet: services/safe-http.js#request is replaced
 * with a router that answers the way the provider's documentation says it
 * does, and records what was asked, so the tests can check the requests too -
 * the version header Cal.com needs, the free/busy window Google is asked for,
 * the location Calendly is told.
 */

const safeHttp = require('../services/safe-http');
const http = require('../services/booking/http');
const calcom = require('../services/booking/providers/calcom');
const google = require('../services/booking/providers/google');
const calendly = require('../services/booking/providers/calendly');

/**
 * Replace the transport. `handler` gets each call and returns
 * `{ status, json }`; every call is recorded with its parsed body.
 */
function stubHttp(handler) {
  const calls = [];
  jest.spyOn(safeHttp, 'request').mockImplementation(async (url, options, body) => {
    const contentType = (options.headers && options.headers['content-type']) || '';
    let parsed = body;
    if (body && contentType.includes('json')) {
      parsed = JSON.parse(body);
    } else if (body && contentType.includes('urlencoded')) {
      parsed = Object.fromEntries(new URLSearchParams(body));
    }
    const call = { url: new URL(url.toString()), method: options.method, headers: options.headers, body: parsed };
    calls.push(call);
    const answer = (await handler(call)) || {};
    return {
      statusCode: answer.status || 200,
      headers: {},
      body: answer.json === undefined ? '' : JSON.stringify(answer.json)
    };
  });
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the provider transport', () => {
  test('refuses any host that is not a calendar provider', async () => {
    const calls = stubHttp(() => ({ json: {} }));
    await expect(http.request('https://evil.example/steal')).rejects.toThrow(/not a calendar provider/);
    await expect(http.request('http://api.cal.com/v2/me')).rejects.toThrow(/not a calendar provider/);
    expect(calls).toHaveLength(0);
  });

  test('a provider error carries its status and its own message', async () => {
    stubHttp(() => ({ status: 401, json: { status: 'error', error: { message: 'Invalid API key' } } }));
    await expect(http.request('https://api.cal.com/v2/me')).rejects.toMatchObject({
      name: 'ProviderError', status: 401, message: 'Invalid API key'
    });
  });
});

describe('Cal.com', () => {
  const conn = {
    provider: 'calcom',
    credentials: { apiKey: 'cal_live_secret' },
    account: { handle: 'smile-clinic' }
  };

  test('lists event types with the key and the pinned API version', async () => {
    const calls = stubHttp(() => ({
      json: {
        status: 'success',
        data: [
          { id: 11, title: 'Check-up', slug: 'check-up', lengthInMinutes: 30, hidden: false },
          { id: 12, title: 'Staff only', slug: 'staff', lengthInMinutes: 60, hidden: true }
        ]
      }
    }));

    const services = await calcom.listServices(conn);

    expect(services).toEqual([
      { id: '11', name: 'Check-up', duration: 30, hidden: false, providerData: { slug: 'check-up' } },
      { id: '12', name: 'Staff only', duration: 60, hidden: true, providerData: { slug: 'staff' } }
    ]);
    expect(calls[0].url.href).toBe('https://api.cal.com/v2/event-types?username=smile-clinic');
    expect(calls[0].headers.authorization).toBe('Bearer cal_live_secret');
    expect(calls[0].headers['cal-api-version']).toBe(calcom.API_VERSIONS.eventTypes);
  });

  test('flattens the free times Cal.com groups by date', async () => {
    const calls = stubHttp(() => ({
      json: {
        status: 'success',
        data: {
          '2026-11-02': [
            { start: '2026-11-02T09:00:00.000+00:00', end: '2026-11-02T09:30:00.000+00:00' },
            { start: '2026-11-02T09:30:00.000+00:00', end: '2026-11-02T10:00:00.000+00:00' }
          ],
          '2026-11-03': [{ start: '2026-11-03T14:00:00.000+00:00' }]
        }
      }
    }));

    const slots = await calcom.slots(conn, {
      serviceId: '11',
      from: new Date('2026-11-02T00:00:00Z'),
      to: new Date('2026-11-09T00:00:00Z'),
      timezone: 'Europe/London'
    });

    expect(slots.map(slot => slot.start.toISOString())).toEqual([
      '2026-11-02T09:00:00.000Z', '2026-11-02T09:30:00.000Z', '2026-11-03T14:00:00.000Z'
    ]);
    expect(slots[0].end.toISOString()).toBe('2026-11-02T09:30:00.000Z');
    const query = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/v2/slots');
    expect(query.get('eventTypeId')).toBe('11');
    expect(query.get('format')).toBe('range');
    expect(query.get('timeZone')).toBe('Europe/London');
    expect(calls[0].headers['cal-api-version']).toBe('2024-09-04');
  });

  test('books with the attendee, an E.164 phone, and notes kept out of booking fields', async () => {
    const calls = stubHttp(() => ({
      status: 201,
      json: { status: 'success', data: { id: 99, uid: 'bk_uid_1', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T09:30:00.000Z', status: 'accepted' } }
    }));

    const result = await calcom.book(conn, {
      serviceId: '11',
      start: new Date('2026-11-02T09:00:00Z'),
      name: 'Ana Pop',
      email: 'ana@example.com',
      phone: '+44 7700 900123',
      notes: 'First visit',
      timezone: 'Europe/London',
      reference: 'BK-ABCDEF'
    });

    expect(result).toMatchObject({ providerRef: 'bk_uid_1', status: 'booked' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['cal-api-version']).toBe('2026-02-25');
    expect(calls[0].body).toEqual({
      start: '2026-11-02T09:00:00.000Z',
      eventTypeId: 11,
      attendee: {
        name: 'Ana Pop', timeZone: 'Europe/London', language: 'en',
        email: 'ana@example.com', phoneNumber: '+447700900123'
      },
      metadata: { source: 'chatbot', reference: 'BK-ABCDEF', notes: 'First visit' }
    });
  });

  test('a phone number that is not E.164 is left off rather than refused', async () => {
    const calls = stubHttp(() => ({ status: 201, json: { data: { uid: 'u', start: '2026-11-02T09:00:00Z' } } }));
    await calcom.book(conn, { serviceId: '11', start: new Date('2026-11-02T09:00:00Z'), name: 'A', phone: '07700 900123', timezone: 'UTC' });
    expect(calls[0].body.attendee.phoneNumber).toBeUndefined();
  });

  test('cancels and moves by uid; a move returns the new uid', async () => {
    const calls = stubHttp(call => (call.url.pathname.endsWith('/reschedule')
      ? { status: 201, json: { data: { uid: 'bk_uid_2', start: '2026-11-03T10:00:00.000Z' } } }
      : { json: { status: 'success', data: {} } }));

    await calcom.cancel(conn, 'bk_uid_1');
    const moved = await calcom.reschedule(conn, 'bk_uid_1', new Date('2026-11-03T10:00:00Z'));

    expect(calls[0].url.pathname).toBe('/v2/bookings/bk_uid_1/cancel');
    expect(calls[1].url.pathname).toBe('/v2/bookings/bk_uid_1/reschedule');
    expect(calls[1].body.start).toBe('2026-11-03T10:00:00.000Z');
    expect(moved.providerRef).toBe('bk_uid_2');
  });
});

describe('Google Calendar', () => {
  const service = { id: 'cut', name: 'Haircut', duration: 30, buffer: 15, enabled: true };
  const conn = (overrides = {}) => ({
    provider: 'google',
    credentials: { accessToken: 'live-token', refreshToken: 'refresh-token', expiresAt: new Date(Date.now() + 3600000) },
    calendarId: 'primary',
    services: [service],
    hours: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, closed: day === 0, opensAt: 540, closesAt: 720 })),
    closedDates: [],
    inviteAttendee: false,
    ...overrides
  });

  // Monday 2 November 2026, London (GMT, so local = UTC).
  const from = new Date('2026-11-02T00:00:00Z');
  const to = new Date('2026-11-03T00:00:00Z');

  test('free times are opening hours minus free/busy minus the buffer', async () => {
    const calls = stubHttp(() => ({
      json: { calendars: { primary: { busy: [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }] } } }
    }));

    const slots = await google.slots(conn(), { serviceId: 'cut', from, to, timezone: 'Europe/London' });

    expect(slots.map(slot => slot.start.toISOString())).toEqual([
      '2026-11-02T09:00:00.000Z', '2026-11-02T11:30:00.000Z'
    ]);
    expect(calls[0].url.href).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(calls[0].headers.authorization).toBe('Bearer live-token');
    expect(calls[0].body.items).toEqual([{ id: 'primary' }]);
  });

  test('the business timezone decides the hours, across the clocks going back', async () => {
    stubHttp(() => ({ json: { calendars: { primary: { busy: [] } } } }));

    // Saturday 24 October is BST, Monday 26 October is GMT.
    const slots = await google.slots(conn({ services: [{ ...service, buffer: 0, duration: 180 }] }), {
      serviceId: 'cut',
      from: new Date('2026-10-24T00:00:00Z'),
      to: new Date('2026-10-27T00:00:00Z'),
      timezone: 'Europe/London'
    });

    expect(slots.map(slot => slot.start.toISOString())).toEqual([
      '2026-10-24T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z'
    ]);
  });

  test('a calendar Google cannot read is an error, not an empty diary', async () => {
    stubHttp(() => ({ json: { calendars: { primary: { errors: [{ reason: 'notFound' }] } } } }));
    await expect(google.slots(conn(), { serviceId: 'cut', from, to, timezone: 'UTC' })).rejects.toThrow(/notFound/);
  });

  test('an expired access token is refreshed and the new one saved', async () => {
    const calls = stubHttp(call => (call.url.hostname === 'oauth2.googleapis.com'
      ? { json: { access_token: 'fresh-token', expires_in: 3599 } }
      : { json: { calendars: { primary: { busy: [] } } } }));
    const updateCredentials = jest.fn();

    await google.slots(conn({
      credentials: { accessToken: 'stale', refreshToken: 'refresh-token', expiresAt: new Date(Date.now() - 1000) },
      updateCredentials
    }), { serviceId: 'cut', from, to, timezone: 'UTC' });

    expect(calls[0].url.href).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-token' });
    expect(updateCredentials).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(calls[1].headers.authorization).toBe('Bearer fresh-token');
  });

  test('withdrawn access says to reconnect', async () => {
    stubHttp(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    await expect(google.slots(conn({
      credentials: { accessToken: '', refreshToken: 'gone', expiresAt: null }
    }), { serviceId: 'cut', from, to, timezone: 'UTC' })).rejects.toMatchObject({ status: 401, message: /Connect the calendar again/ });
  });

  test('booking re-checks the time and inserts an event with the visitor in it', async () => {
    const calls = stubHttp(call => (call.url.pathname.endsWith('/freeBusy')
      ? { json: { calendars: { primary: { busy: [] } } } }
      : { json: { id: 'evt_1', htmlLink: 'https://calendar.google.com/event?eid=1' } }));

    const result = await google.book(conn(), {
      serviceId: 'cut',
      start: new Date('2026-11-02T09:00:00Z'),
      name: 'Ana Pop',
      email: 'ana@example.com',
      phone: '07700 900123',
      timezone: 'Europe/London',
      reference: 'BK-ABCDEF'
    });

    expect(result).toMatchObject({ providerRef: 'evt_1', status: 'booked' });
    const insert = calls[1];
    expect(insert.method).toBe('POST');
    expect(insert.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    // Not opted in: the visitor is described, not invited.
    expect(insert.url.searchParams.get('sendUpdates')).toBe('none');
    expect(insert.body.attendees).toBeUndefined();
    expect(insert.body.summary).toBe('Haircut – Ana Pop');
    expect(insert.body.description).toContain('Email: ana@example.com');
    expect(insert.body.start).toEqual({ dateTime: '2026-11-02T09:00:00.000Z', timeZone: 'Europe/London' });
    expect(insert.body.end.dateTime).toBe('2026-11-02T09:30:00.000Z');
  });

  test('with the tenant opted in, the visitor is a guest and Google emails them', async () => {
    const calls = stubHttp(call => (call.url.pathname.endsWith('/freeBusy')
      ? { json: { calendars: { primary: { busy: [] } } } }
      : { json: { id: 'evt_2' } }));

    await google.book(conn({ inviteAttendee: true }), {
      serviceId: 'cut', start: new Date('2026-11-02T09:00:00Z'), name: 'Ana', email: 'ana@example.com', timezone: 'UTC'
    });

    expect(calls[1].url.searchParams.get('sendUpdates')).toBe('all');
    expect(calls[1].body.attendees).toEqual([{ email: 'ana@example.com', displayName: 'Ana' }]);
  });

  test('a time that has been taken, or was never offered, is refused before anything is written', async () => {
    const calls = stubHttp(() => ({
      json: { calendars: { primary: { busy: [{ start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z' }] } } }
    }));

    await expect(google.book(conn(), {
      serviceId: 'cut', start: new Date('2026-11-02T09:00:00Z'), timezone: 'UTC'
    })).rejects.toMatchObject({ status: 409 });
    // 03:00 on a Monday is outside opening hours however empty the diary.
    await expect(google.book(conn(), {
      serviceId: 'cut', start: new Date('2026-11-02T03:00:00Z'), timezone: 'UTC'
    })).rejects.toMatchObject({ status: 409 });

    expect(calls.every(call => call.url.pathname.endsWith('/freeBusy'))).toBe(true);
  });

  test('moving an event does not count the event itself as busy', async () => {
    const calls = stubHttp(call => (call.url.pathname.endsWith('/freeBusy')
      ? { json: { calendars: { primary: { busy: [{ start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z' }] } } } }
      : { json: { id: 'evt_1' } }));

    const moved = await google.reschedule(conn({ services: [{ ...service, buffer: 0 }] }), 'evt_1', new Date('2026-11-02T09:30:00Z'), {
      serviceId: 'cut', start: new Date('2026-11-02T09:00:00Z'), end: new Date('2026-11-02T09:30:00Z'), timezone: 'UTC'
    });

    expect(moved.providerRef).toBe('evt_1');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body.start.dateTime).toBe('2026-11-02T09:30:00.000Z');
  });

  test('an event already deleted in Google counts as cancelled', async () => {
    stubHttp(() => ({ status: 410, json: { error: { message: 'Resource has been deleted' } } }));
    await expect(google.cancel(conn(), 'evt_gone')).resolves.toEqual({ cancelled: true });
  });

  describe('the OAuth state', () => {
    test('round-trips, and is refused when tampered with or old', () => {
      const state = google.signState({ companyId: 'c1', userId: 'u1', nonce: 'n1' });
      expect(google.verifyState(state)).toEqual({ companyId: 'c1', userId: 'u1', nonce: 'n1' });

      const [payload, signature] = state.split('.');
      const forged = Buffer.from(JSON.stringify({ c: 'c2', u: 'u1', n: 'n1', t: Date.now() })).toString('base64url');
      expect(google.verifyState(`${forged}.${signature}`)).toBeNull();
      expect(google.verifyState(`${payload}.x${signature.slice(1)}`)).toBeNull();
      expect(google.verifyState('not-a-state')).toBeNull();

      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + google.STATE_TTL_MS + 1000);
      expect(google.verifyState(state)).toBeNull();
    });

    test('asks for offline access to events and free/busy only, on its own redirect', () => {
      const url = new URL(google.authUrl('state-value'));
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly'
      );
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/booking\/google\/callback$/);
      expect(url.searchParams.get('state')).toBe('state-value');
    });

    test('its own client when one is set, the Sheets client otherwise', () => {
      const saved = { ...process.env };
      try {
        delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
        delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
        expect(google.oauthConfig().clientId).toBe(process.env.GOOGLE_CLIENT_ID);
        process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-client';
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-secret';
        process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'https://desk.example/api/booking/google/callback';
        expect(google.oauthConfig()).toEqual({
          clientId: 'calendar-client',
          clientSecret: 'calendar-secret',
          redirectUri: 'https://desk.example/api/booking/google/callback'
        });
      } finally {
        process.env = saved;
      }
    });
  });
});

describe('Calendly', () => {
  const account = { handle: 'https://api.calendly.com/users/USER1' };
  const physical = {
    id: 'ET1',
    name: 'Consultation',
    duration: 45,
    enabled: true,
    providerData: {
      uri: 'https://api.calendly.com/event_types/ET1',
      schedulingUrl: 'https://calendly.com/smile/consultation',
      poolingType: null,
      locations: [{ kind: 'physical', location: '1 High Street' }]
    }
  };
  const conn = (overrides = {}) => ({
    provider: 'calendly', credentials: { apiKey: 'pat_secret' }, account, services: [physical], ...overrides
  });
  const start = new Date('2026-11-02T10:00:00Z');

  test('lists the user\'s active event types', async () => {
    const calls = stubHttp(() => ({
      json: {
        collection: [
          {
            uri: 'https://api.calendly.com/event_types/ET1', name: 'Consultation', duration: 45, secret: false,
            scheduling_url: 'https://calendly.com/smile/consultation', locations: [{ kind: 'physical', location: '1 High Street' }]
          },
          { uri: 'https://api.calendly.com/event_types/ET2', name: 'Private', duration: 30, secret: true }
        ],
        pagination: { next_page_token: null }
      }
    }));

    const services = await calendly.listServices(conn());

    expect(services.map(service => [service.id, service.name, service.duration, service.hidden]))
      .toEqual([['ET1', 'Consultation', 45, false], ['ET2', 'Private', 30, true]]);
    expect(calls[0].headers.authorization).toBe('Bearer pat_secret');
    expect(calls[0].url.searchParams.get('user')).toBe(account.handle);
    expect(calls[0].url.searchParams.get('active')).toBe('true');
  });

  test('asks for available times a week at a time', async () => {
    const calls = stubHttp(call => ({
      json: {
        collection: [{
          status: 'available', invitees_remaining: 1,
          start_time: call.url.searchParams.get('start_time'),
          scheduling_url: 'https://calendly.com/smile/consultation/x'
        }]
      }
    }));

    const from = new Date(Date.now() + 86400000);
    const to = new Date(from.getTime() + 14 * 86400000);
    const slots = await calendly.slots(conn(), { serviceId: 'ET1', from, to });

    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe('/event_type_available_times');
    expect(calls[0].url.searchParams.get('event_type')).toBe(physical.providerData.uri);
    expect(slots).toHaveLength(2);
    expect(slots[0].end - slots[0].start).toBe(45 * 60000);
  });

  test('on a paid plan, books the invitee directly with the event type\'s location', async () => {
    const calls = stubHttp(() => ({
      status: 201,
      json: {
        resource: {
          uri: 'https://api.calendly.com/scheduled_events/EV1/invitees/INV1',
          event: 'https://api.calendly.com/scheduled_events/EV1',
          cancel_url: 'https://calendly.com/cancellations/INV1',
          reschedule_url: 'https://calendly.com/reschedulings/INV1',
          status: 'active'
        }
      }
    }));

    const result = await calendly.book(conn(), {
      serviceId: 'ET1', start, name: 'Ana Pop', email: 'ana@example.com', phone: '+447700900123', timezone: 'Europe/London'
    });

    expect(result).toMatchObject({ providerRef: 'EV1', status: 'booked' });
    expect(calls[0].url.href).toBe('https://api.calendly.com/invitees');
    expect(calls[0].body).toEqual({
      event_type: physical.providerData.uri,
      start_time: '2026-11-02T10:00:00.000Z',
      invitee: { name: 'Ana Pop', email: 'ana@example.com', timezone: 'Europe/London', text_reminder_number: '+447700900123' },
      location: { kind: 'physical', location: '1 High Street' }
    });
  });

  test('on the free plan (403), hands back a single-use link with their details filled in', async () => {
    const calls = stubHttp(call => (call.url.pathname === '/invitees'
      ? { status: 403, json: { title: 'Permission Denied', message: 'This feature requires a paid plan' } }
      : { status: 201, json: { resource: { booking_url: 'https://calendly.com/d/abc-123/consultation' } } }));

    const result = await calendly.book(conn(), {
      serviceId: 'ET1', start, name: 'Ana Pop', email: 'ana@example.com', timezone: 'Europe/London'
    });

    expect(result.status).toBe('link');
    expect(result.providerRef).toBeNull();
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe('https://calendly.com/d/abc-123/consultation');
    expect(url.searchParams.get('name')).toBe('Ana Pop');
    expect(url.searchParams.get('email')).toBe('ana@example.com');
    expect(url.searchParams.get('date')).toBe('2026-11-02');
    expect(calls[1].body).toEqual({ max_event_count: 1, owner: physical.providerData.uri, owner_type: 'EventType' });
  });

  test('without an email, or with a location the visitor must choose, it never tries to book', async () => {
    const calls = stubHttp(() => ({ status: 201, json: { resource: { booking_url: 'https://calendly.com/d/one' } } }));

    const noEmail = await calendly.book(conn(), { serviceId: 'ET1', start, name: 'Ana', timezone: 'UTC' });
    const askInvitee = await calendly.book(conn({
      services: [{ ...physical, providerData: { ...physical.providerData, locations: [{ kind: 'ask_invitee' }] } }]
    }), { serviceId: 'ET1', start, name: 'Ana', email: 'ana@example.com', timezone: 'UTC' });

    expect(noEmail.status).toBe('link');
    expect(askInvitee.status).toBe('link');
    expect(calls.some(call => call.url.pathname === '/invitees')).toBe(false);
  });

  test('location rules: hosted kinds are named, round robin sends none, several means the page', () => {
    const withLocations = (locations, poolingType = null) => ({ providerData: { locations, poolingType } });
    expect(calendly.locationFor(withLocations([{ kind: 'zoom_conference' }]))).toEqual({ location: { kind: 'zoom_conference' } });
    expect(calendly.locationFor(withLocations([{ kind: 'physical', location: 'x' }], 'round_robin'))).toEqual({});
    expect(calendly.locationFor(withLocations([]))).toEqual({});
    expect(calendly.locationFor(withLocations([{ kind: 'physical', location: 'a' }, { kind: 'zoom_conference' }]))).toBeNull();
    expect(calendly.locationFor(withLocations([{ kind: 'outbound_call' }]), '+447700900123'))
      .toEqual({ location: { kind: 'outbound_call', location: '+447700900123' } });
  });

  test('cancels the scheduled event, and an already-cancelled one is fine', async () => {
    const calls = stubHttp(() => ({ status: 201, json: { resource: {} } }));
    await calendly.cancel(conn(), 'EV1');
    expect(calls[0].url.pathname).toBe('/scheduled_events/EV1/cancellation');

    jest.restoreAllMocks();
    stubHttp(() => ({ status: 403, json: { title: 'Permission Denied', message: 'Event is already canceled' } }));
    await expect(calendly.cancel(conn(), 'EV1')).resolves.toEqual({ cancelled: true });
  });

  test('moving books the new time before cancelling the old one', async () => {
    const calls = stubHttp(call => (call.url.pathname === '/invitees'
      ? { status: 201, json: { resource: { uri: 'x/invitees/INV2', event: 'https://api.calendly.com/scheduled_events/EV2' } } }
      : { status: 201, json: { resource: {} } }));

    const moved = await calendly.reschedule(conn(), 'EV1', new Date('2026-11-03T10:00:00Z'), {
      serviceId: 'ET1', name: 'Ana', email: 'ana@example.com', timezone: 'UTC'
    });

    expect(moved.providerRef).toBe('EV2');
    expect(calls.map(call => call.url.pathname)).toEqual(['/invitees', '/scheduled_events/EV1/cancellation']);
  });
});
