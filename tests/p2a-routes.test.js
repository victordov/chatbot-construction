/**
 * /api/booking: connecting a calendar from the dashboard, the Google OAuth
 * round trip, the settings form, the test button, and the bookings list that
 * operators read and cancel from.
 *
 * Providers are stubbed at services/safe-http.js; nothing leaves the machine.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const Company = require('../models/company');
const Booking = require('../models/booking');
const CalendarConnection = require('../models/calendar-connection');
const AuditLog = require('../models/audit-log');
const booking = require('../services/booking');
const google = require('../services/booking/providers/google');
const usageService = require('../services/usage');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/booking', require('../routes/booking'));
  return app;
};

describe('/api/booking', () => {
  let app;
  let clinic;
  let rival;
  let adminToken;
  let operatorToken;
  let rivalToken;
  let calls;
  let providerAnswers;

  const as = token => ({ 'x-auth-token': token });
  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  function installStub() {
    jest.spyOn(safeHttp, 'request').mockImplementation(async (url, options, body) => {
      const parsedUrl = new URL(url.toString());
      const type = (options.headers && options.headers['content-type']) || '';
      const parsed = body && type.includes('json') ? JSON.parse(body)
        : (body ? Object.fromEntries(new URLSearchParams(body)) : null);
      calls.push({ url: parsedUrl, method: options.method, headers: options.headers, body: parsed });

      const answer = providerAnswers(parsedUrl, options.method, parsed) || { status: 404, json: { error: 'no stub' } };
      return { statusCode: answer.status || 200, headers: {}, body: JSON.stringify(answer.json || {}) };
    });
  }

  const calcomAnswers = (url, method) => {
    if (url.pathname === '/v2/me') {
      return { json: { status: 'success', data: { username: 'smile', email: 'desk@smile.example', timeZone: 'Europe/London' } } };
    }
    if (url.pathname === '/v2/event-types') {
      return {
        json: {
          status: 'success',
          data: [
            { id: 11, title: 'Check-up', lengthInMinutes: 30, hidden: false },
            { id: 12, title: 'Staff only', lengthInMinutes: 60, hidden: true }
          ]
        }
      };
    }
    if (url.pathname === '/v2/slots') {
      const start = new Date(Date.now() + 2 * 86400000);
      start.setUTCHours(9, 0, 0, 0);
      const times = [0, 30, 60, 90].map(minutes => new Date(start.getTime() + minutes * 60000).toISOString());
      return { json: { status: 'success', data: { [times[0].slice(0, 10)]: times.map(time => ({ start: time })) } } };
    }
    if (/\/cancel$/.test(url.pathname) && method === 'POST') {
      return { json: { status: 'success', data: {} } };
    }
    return null;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    app = buildApp();
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-p2a-routes-suite';
    secrets.resetForTests();

    clinic = await Company.create({
      name: 'P2AR Clinic',
      businessHours: {
        timezone: 'Europe/London',
        days: [1, 2, 3, 4, 5].map(day => ({ day, opensAt: 480, closesAt: 960 }))
      }
    });
    rival = await Company.create({ name: 'P2AR Rival' });

    await User.create([
      { username: 'p2ar-admin', email: 'admin@p2ar.example', password: 'TestPassword123!', role: 'company_admin', displayName: 'Dana', company: clinic._id },
      { username: 'p2ar-operator', email: 'op@p2ar.example', password: 'TestPassword123!', role: 'operator', displayName: 'Olu', company: clinic._id },
      { username: 'p2ar-rival', email: 'rex@p2ar.example', password: 'TestPassword123!', role: 'company_admin', displayName: 'Rex', company: rival._id }
    ]);
    adminToken = await login('p2ar-admin');
    operatorToken = await login('p2ar-operator');
    rivalToken = await login('p2ar-rival');
  });

  afterAll(async () => {
    const ids = [clinic._id, rival._id];
    await Promise.all([
      Booking.deleteMany({ company: { $in: ids } }),
      CalendarConnection.deleteMany({ company: { $in: ids } }),
      AuditLog.deleteMany({ company: { $in: ids } }),
      User.deleteMany({ username: /^p2ar-/ })
    ]);
    await Company.deleteMany({ _id: { $in: ids } });
  });

  beforeEach(async () => {
    calls = [];
    providerAnswers = calcomAnswers;
    installStub();
    booking.clearSlotCache();
    await CalendarConnection.deleteMany({ company: { $in: [clinic._id, rival._id] } });
    await Booking.deleteMany({ company: { $in: [clinic._id, rival._id] } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('connecting Cal.com', () => {
    test('checks the key, lists the event types, and never shows the key again', async () => {
      const response = await request(app).post('/api/booking/connect').set(as(adminToken))
        .send({ provider: 'calcom', key: 'cal_live_0123456789abcdef' });

      expect(response.status).toBe(201);
      expect(response.body.connection).toMatchObject({
        provider: 'calcom', label: 'Cal.com', enabled: true,
        account: { name: 'smile', email: 'desk@smile.example' },
        timezone: 'Europe/London'
      });
      // Hidden event types start off; public ones on.
      expect(response.body.connection.services.map(service => [service.id, service.enabled]))
        .toEqual([['11', true], ['12', false]]);
      expect(JSON.stringify(response.body)).not.toContain('cal_live_0123456789abcdef');
      expect(calls[0].headers.authorization).toBe('Bearer cal_live_0123456789abcdef');

      const fetched = await request(app).get('/api/booking/connection').set(as(adminToken));
      expect(JSON.stringify(fetched.body)).not.toMatch(/cal_live|credentials/);
      expect(fetched.body.providers.google.available).toBe(true);

      expect(await AuditLog.exists({ company: clinic._id, action: 'booking.connected' })).toBeTruthy();
    });

    test('a key Cal.com refuses is an error on the form, and nothing is saved', async () => {
      providerAnswers = () => ({ status: 401, json: { status: 'error', error: { message: 'Invalid API Key' } } });
      const response = await request(app).post('/api/booking/connect').set(as(adminToken))
        .send({ provider: 'calcom', key: 'cal_live_wrongwrongwrong' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/did not accept that API key/);
      expect(await CalendarConnection.exists({ company: clinic._id })).toBeNull();
    });

    test('an obviously incomplete key is refused before calling anybody', async () => {
      const response = await request(app).post('/api/booking/connect').set(as(adminToken))
        .send({ provider: 'calcom', key: 'cal_' });
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe('settings and the test button', () => {
    beforeEach(async () => {
      const connected = await request(app).post('/api/booking/connect').set(as(adminToken))
        .send({ provider: 'calcom', key: 'cal_live_0123456789abcdef' });
      // Said out loud: a connect that failed here used to surface three
      // tests later as "there was nothing to disconnect".
      expect([200, 201]).toContain(connected.status);
      calls = [];
    });

    test('which event types the bot may book, and the switches, are saved', async () => {
      const response = await request(app).put('/api/booking/connection').set(as(adminToken))
        .send({ services: [{ id: '11', enabled: false }, { id: '12', enabled: true }], reminders: false, horizonDays: 21 });

      expect(response.status).toBe(200);
      expect(response.body.connection.services.map(service => service.enabled)).toEqual([false, true]);
      expect(response.body.connection).toMatchObject({ reminders: false, horizonDays: 21 });
    });

    test('nonsense is refused with a reason', async () => {
      const response = await request(app).put('/api/booking/connection').set(as(adminToken)).send({ horizonDays: 0 });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/between 1 and 60 days/);
    });

    test('Test shows the next three free times and books nothing', async () => {
      const response = await request(app).post('/api/booking/test').set(as(adminToken));

      expect(response.status).toBe(200);
      expect(response.body.slots).toHaveLength(3);
      expect(response.body.timezone).toBe('Europe/London');
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('operators cannot change the connection', async () => {
      expect((await request(app).get('/api/booking/connection').set(as(operatorToken))).status).toBe(403);
      expect((await request(app).put('/api/booking/connection').set(as(operatorToken)).send({ enabled: false })).status).toBe(403);
    });

    test('disconnecting removes the connection and its credentials', async () => {
      const response = await request(app).delete('/api/booking/connection').set(as(adminToken));
      expect(response.body.disconnected).toBe(true);
      expect(await CalendarConnection.exists({ company: clinic._id })).toBeNull();
    });
  });

  test('without the actions feature the screen says which plan has it', async () => {
    jest.spyOn(usageService, 'hasFeature').mockResolvedValue(false);
    const response = await request(app).get('/api/booking/connection').set(as(adminToken));
    expect(response.status).toBe(402);
    expect(response.body.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  describe('Google Calendar', () => {
    const googleAnswers = (url, method) => {
      if (url.href === 'https://oauth2.googleapis.com/token') {
        return {
          json: {
            access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3599,
            scope: google.SCOPES.join(' ')
          }
        };
      }
      if (url.href === 'https://oauth2.googleapis.com/revoke') {
        return { json: {} };
      }
      if (url.pathname === '/calendar/v3/calendars/primary' && method === 'GET') {
        return { json: { id: 'owner@smile.example', summary: 'Smile Clinic', timeZone: 'Europe/London' } };
      }
      return null;
    };

    async function startFlow() {
      const response = await request(app).post('/api/booking/google/start').set(as(adminToken));
      expect(response.status).toBe(200);
      const state = new URL(response.body.url).searchParams.get('state');
      const cookie = response.headers['set-cookie'].find(value => value.startsWith('booking_google_nonce='));
      return { state, cookie: cookie.split(';')[0] };
    }

    beforeEach(() => {
      providerAnswers = googleAnswers;
    });

    test('the round trip connects the calendar with hours from the business and tokens encrypted', async () => {
      const { state, cookie } = await startFlow();

      const response = await request(app).get('/api/booking/google/callback')
        .query({ code: 'auth-code', state }).set('Cookie', cookie);

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/admin/?section=booking&connected=google');

      const token = calls.find(call => call.url.href === 'https://oauth2.googleapis.com/token');
      expect(token.body).toMatchObject({ code: 'auth-code', grant_type: 'authorization_code' });
      expect(token.body.redirect_uri).toMatch(/\/api\/booking\/google\/callback$/);

      const raw = await CalendarConnection.collection.findOne({ company: clinic._id });
      expect(raw.provider).toBe('google');
      expect(raw.credentials.refreshToken).toMatch(/^enc:v1:/);
      expect(secrets.decrypt(raw.credentials.refreshToken)).toBe('1//refresh');
      expect(raw.account.email).toBe('owner@smile.example');
      expect(raw.services).toEqual([expect.objectContaining({ name: 'Appointment', duration: 30, enabled: true })]);
      // Monday to Friday 08:00-16:00 from Business hours; the weekend closed.
      expect(raw.hours.find(rule => rule.day === 1)).toMatchObject({ closed: false, opensAt: 480, closesAt: 960 });
      expect(raw.hours.find(rule => rule.day === 0)).toMatchObject({ closed: true });
    });

    test('a callback finished in another browser (no nonce cookie) is refused', async () => {
      const { state } = await startFlow();
      const response = await request(app).get('/api/booking/google/callback').query({ code: 'auth-code', state });

      expect(response.status).toBe(302);
      expect(response.headers.location).toMatch(/booking_error=/);
      expect(calls.some(call => call.url.hostname === 'oauth2.googleapis.com')).toBe(false);
      expect(await CalendarConnection.exists({ company: clinic._id })).toBeNull();
    });

    test('a forged state is refused', async () => {
      const { cookie } = await startFlow();
      const response = await request(app).get('/api/booking/google/callback')
        .query({ code: 'auth-code', state: 'eyJjIjoieCJ9.forged' }).set('Cookie', cookie);
      expect(response.headers.location).toMatch(/booking_error=/);
      expect(await CalendarConnection.exists({ company: clinic._id })).toBeNull();
    });

    test('access without a refresh token is refused rather than dying in an hour', async () => {
      providerAnswers = (url, method) => (url.href === 'https://oauth2.googleapis.com/token'
        ? { json: { access_token: 'ya29.access', expires_in: 3599, scope: google.SCOPES.join(' ') } }
        : googleAnswers(url, method));
      const { state, cookie } = await startFlow();

      const response = await request(app).get('/api/booking/google/callback')
        .query({ code: 'auth-code', state }).set('Cookie', cookie);

      const said = new URL(response.headers.location, 'http://desk.example').searchParams.get('booking_error');
      expect(said).toMatch(/lasting access/);
      expect(await CalendarConnection.exists({ company: clinic._id })).toBeNull();
    });

    test('services and opening hours are the tenant\'s to edit, and checked', async () => {
      const { state, cookie } = await startFlow();
      await request(app).get('/api/booking/google/callback').query({ code: 'c', state }).set('Cookie', cookie);

      const saved = await request(app).put('/api/booking/connection').set(as(adminToken)).send({
        services: [
          { name: 'Haircut', duration: 30, buffer: 10 },
          { name: 'Colour', duration: 120, buffer: 15, enabled: false }
        ],
        hours: [{ day: 6, closed: false, opensAt: 600, closesAt: 840 }],
        minNoticeMinutes: 240,
        inviteAttendee: true
      });

      expect(saved.status).toBe(200);
      expect(saved.body.connection.services.map(service => [service.name, service.duration, service.buffer, service.enabled]))
        .toEqual([['Haircut', 30, 10, true], ['Colour', 120, 15, false]]);
      expect(saved.body.connection.hours.filter(rule => !rule.closed).map(rule => rule.day)).toEqual([6]);
      expect(saved.body.connection).toMatchObject({ minNoticeMinutes: 240, inviteAttendee: true });

      const backwards = await request(app).put('/api/booking/connection').set(as(adminToken))
        .send({ hours: [{ day: 1, closed: false, opensAt: 900, closesAt: 600 }] });
      expect(backwards.status).toBe(400);
      expect(backwards.body.error).toMatch(/closing time after its opening time/);
    });

    test('disconnecting gives Google its access back', async () => {
      const { state, cookie } = await startFlow();
      await request(app).get('/api/booking/google/callback').query({ code: 'c', state }).set('Cookie', cookie);
      calls = [];

      await request(app).delete('/api/booking/connection').set(as(adminToken));

      const revoke = calls.find(call => call.url.href === 'https://oauth2.googleapis.com/revoke');
      expect(revoke.body).toEqual({ token: '1//refresh' });
    });
  });

  describe('bookings', () => {
    let mine;

    beforeEach(async () => {
      await request(app).post('/api/booking/connect').set(as(adminToken))
        .send({ provider: 'calcom', key: 'cal_live_0123456789abcdef' });
      mine = await Booking.create({
        company: clinic._id, provider: 'calcom', providerRef: 'uid-77', reference: 'BK-ROUTE1',
        serviceName: 'Check-up', start: new Date(Date.now() + 2 * 86400000), timezone: 'Europe/London',
        name: 'Ana', email: 'ana@example.com', sessionId: 'p2ar-session', status: 'booked'
      });
      await Booking.create({
        company: rival._id, provider: 'calcom', reference: 'BK-ROUTE2', start: new Date(Date.now() + 86400000),
        sessionId: 'p2ar-session', status: 'booked'
      });
      calls = [];
    });

    test('operators read one conversation\'s bookings, and only their company\'s', async () => {
      const response = await request(app).get('/api/booking/bookings')
        .query({ sessionId: 'p2ar-session' }).set(as(operatorToken));

      expect(response.status).toBe(200);
      expect(response.body.bookings).toHaveLength(1);
      expect(response.body.bookings[0]).toMatchObject({
        reference: 'BK-ROUTE1', service: 'Check-up', status: 'booked', sessionId: 'p2ar-session'
      });
      expect(response.body.bookings[0].label).toBeTruthy();
    });

    test('an operator cancels in the calendar; another company cannot', async () => {
      const refused = await request(app).post(`/api/booking/bookings/${mine._id}/cancel`).set(as(rivalToken));
      expect(refused.status).toBe(404);
      expect(calls).toHaveLength(0);

      const response = await request(app).post(`/api/booking/bookings/${mine._id}/cancel`).set(as(operatorToken));
      expect(response.status).toBe(200);
      expect(response.body.booking).toMatchObject({ status: 'cancelled', cancelledBy: 'operator' });
      expect(calls[0].url.pathname).toBe('/v2/bookings/uid-77/cancel');

      const again = await request(app).post(`/api/booking/bookings/${mine._id}/cancel`).set(as(operatorToken));
      expect(again.status).toBe(409);
    });
  });
});
