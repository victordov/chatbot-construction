/**
 * Real booking, end to end inside the platform: a connected calendar answers
 * the availability capabilities instead of the hosted connector, previews
 * never book, every booking is recorded against its conversation and
 * announced, a visitor can cancel only their own, plan gating switches it all
 * off, credentials are encrypted at rest, reminders go once, and the shipped
 * "Book or change an appointment" template books a real slot.
 *
 * Cal.com and the tenant's hosted connector are both stubbed at
 * services/safe-http.js; nothing leaves the machine.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Booking = require('../models/booking');
const CalendarConnection = require('../models/calendar-connection');
const AuditLog = require('../models/audit-log');
const connector = require('../services/connector');
const booking = require('../services/booking');
const reminders = require('../services/booking/reminders');
const assistantTools = require('../services/assistant-tools');
const webhooks = require('../services/webhooks');
const emailChannel = require('../services/email-channel');
const usageService = require('../services/usage');
const safeHttp = require('../services/safe-http');
const secrets = require('../services/secrets');
const templates = require('../config/workflow-templates');
const WorkflowCompilerService = require('../services/workflow-compiler');
const eventually = require('./eventually');

const DAY = 86400000;

/** Tomorrow and the day after at fixed UTC hours, always in the future. */
function futureAt(daysAhead, hour, minute = 0) {
  const date = new Date(Date.now() + daysAhead * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

describe('P2A booking', () => {
  let clinic;
  let calls;
  let calcomBehaviour;
  let bookingCounter;

  /** Cal.com and the hosted connector, answering as documented. */
  function installStub() {
    jest.spyOn(safeHttp, 'request').mockImplementation(async (url, options, body) => {
      const parsedUrl = new URL(url.toString());
      const parsed = body ? JSON.parse(body) : null;
      calls.push({ url: parsedUrl, method: options.method, headers: options.headers, body: parsed });
      const reply = (status, json) => ({ statusCode: status, headers: {}, body: JSON.stringify(json) });

      if (parsedUrl.hostname === 'connector.example') {
        return reply(200, {
          result: parsed.capability === 'catalog.search'
            ? [{ id: 'p1', title: 'Whitening kit' }]
            : [{ id: 'hosted-slot', startsAt: futureAt(1, 15).toISOString() }]
        });
      }

      if (parsedUrl.hostname !== 'api.cal.com') {
        return reply(404, { error: 'unexpected host' });
      }
      if (calcomBehaviour.unauthorised) {
        return reply(401, { status: 'error', error: { message: 'Invalid API Key' } });
      }

      const path = parsedUrl.pathname;
      if (path === '/v2/slots') {
        const first = futureAt(1, 9);
        const second = futureAt(1, 9, 30);
        const third = futureAt(2, 10);
        const day = date => date.toISOString().slice(0, 10);
        return reply(200, {
          status: 'success',
          data: {
            [day(first)]: [{ start: first.toISOString(), end: new Date(first.getTime() + 1800000).toISOString() },
              { start: second.toISOString(), end: new Date(second.getTime() + 1800000).toISOString() }],
            [day(third)]: [{ start: third.toISOString(), end: new Date(third.getTime() + 1800000).toISOString() }]
          }
        });
      }
      if (path === '/v2/bookings' && options.method === 'POST') {
        if (calcomBehaviour.taken) {
          return reply(409, { status: 'error', error: { message: 'Attendee has a conflicting booking' } });
        }
        bookingCounter += 1;
        return reply(201, {
          status: 'success',
          data: { id: bookingCounter, uid: `uid-${bookingCounter}`, start: parsed.start, status: 'accepted' }
        });
      }
      if (/^\/v2\/bookings\/[^/]+\/cancel$/.test(path)) {
        return reply(200, { status: 'success', data: {} });
      }
      return reply(404, { status: 'error', error: { message: `no stub for ${path}` } });
    });
  }

  const calcomCalls = () => calls.filter(call => call.url.hostname === 'api.cal.com');
  const bookingPosts = () => calcomCalls().filter(call => call.url.pathname === '/v2/bookings');

  async function connectCalendar(company, overrides = {}) {
    return CalendarConnection.create({
      company: company._id,
      provider: 'calcom',
      credentials: booking.sealCredentials({ apiKey: 'cal_live_supersecret' }),
      account: { name: 'Smile Clinic', handle: 'smile', timezone: 'Europe/London' },
      services: [
        { id: '11', name: 'Check-up', duration: 30, enabled: true },
        { id: '12', name: 'Staff only', duration: 60, enabled: false, hidden: true }
      ],
      ...overrides
    });
  }

  async function slotIds(companyId, options = {}) {
    const result = await connector.call(companyId, 'availability.slots', {}, options);
    expect(result.ok).toBe(true);
    return result.value.map(slot => slot.id);
  }

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    process.env.SECRETS_KEY = 'test-secrets-key-for-the-p2a-suite';
    secrets.resetForTests();
  });

  beforeEach(async () => {
    calls = [];
    calcomBehaviour = {};
    bookingCounter = 0;
    installStub();
    jest.spyOn(webhooks, 'dispatch').mockResolvedValue([]);
    connector.clearCache();
    booking.clearSlotCache();

    clinic = await Company.create({
      name: 'P2A Smile Clinic',
      businessHours: { timezone: 'Europe/London' },
      connector: {
        enabled: true,
        url: 'https://connector.example/hook',
        secret: secrets.encrypt('csec_hosted'),
        capabilities: ['catalog.search', 'availability.slots', 'availability.book']
      }
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const companies = await Company.find({ name: /^P2A / }).select('_id').lean();
    const ids = companies.map(company => company._id);
    await Promise.all([
      Booking.deleteMany({ company: { $in: ids } }),
      CalendarConnection.deleteMany({ company: { $in: ids } }),
      Conversation.deleteMany({ company: { $in: ids } }),
      Contact.deleteMany({ company: { $in: ids } }),
      AuditLog.deleteMany({ company: { $in: ids } })
    ]);
    await Company.deleteMany({ _id: { $in: ids } });
  });

  describe('dispatch', () => {
    test('with no calendar, availability still goes to the hosted connector', async () => {
      const result = await connector.call(clinic._id, 'availability.slots', {});
      expect(result.ok).toBe(true);
      expect(result.value[0].id).toBe('hosted-slot');
      expect(calcomCalls()).toHaveLength(0);
    });

    test('with a calendar connected, availability goes to it and nothing else changes', async () => {
      await connectCalendar(clinic);

      const slots = await connector.call(clinic._id, 'availability.slots', {});
      const search = await connector.call(clinic._id, 'catalog.search', { query: 'kit' });

      expect(slots.ok).toBe(true);
      expect(slots.value.map(slot => slot.id)).toEqual([
        `11@${futureAt(1, 9).toISOString()}`,
        `11@${futureAt(1, 9, 30).toISOString()}`,
        `11@${futureAt(2, 10).toISOString()}`
      ]);
      // Labelled in the clinic's own time, ready to be a button.
      expect(slots.value[0].label).toMatch(/^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}$/);
      expect(search.value[0].title).toBe('Whitening kit');
      expect(calls.filter(call => call.url.hostname === 'connector.example')
        .map(call => call.body.capability)).toEqual(['catalog.search']);
      // Only bookable services are asked about.
      expect(calcomCalls().map(call => call.url.searchParams.get('eventTypeId'))).toEqual(['11']);
    });

    test('a paused calendar hands back to the hosted connector', async () => {
      await connectCalendar(clinic, { enabled: false });
      const result = await connector.call(clinic._id, 'availability.slots', {});
      expect(result.value[0].id).toBe('hosted-slot');
    });

    test('the assistant is offered the calendar\'s tools even with no hosted connector', async () => {
      clinic.connector = { enabled: false };
      await clinic.save();
      await connectCalendar(clinic);

      const settings = await connector.settingsFor(clinic._id);
      expect(settings).toMatchObject({ url: null, calendar: true });
      expect(settings.capabilities).toEqual(['availability.slots', 'availability.book', 'availability.cancel']);

      const session = await assistantTools.prepare({ companyId: clinic._id, client: {}, message: 'book me in' });
      const names = session.definitions().map(tool => tool.function.name);
      expect(names).toEqual(expect.arrayContaining([
        'connector_availability_slots', 'connector_availability_book', 'connector_availability_cancel'
      ]));
      expect(names).not.toContain('connector_catalog_search');
    });

    test('a hosted connector\'s own list is extended with what the calendar answers', async () => {
      await connectCalendar(clinic);
      const settings = await connector.settingsFor(clinic._id);
      expect(settings.url).toBe('https://connector.example/hook');
      expect(settings.capabilities).toEqual(expect.arrayContaining(['catalog.search', 'availability.cancel']));
    });

    test('an unknown service is explained to the model, with the real names', async () => {
      await connectCalendar(clinic);
      const result = await connector.call(clinic._id, 'availability.slots', { service: 'massage' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no service called "massage".*Check-up/);
    });

    test('a refused key is a quiet error for the visitor and a note for the admin', async () => {
      await connectCalendar(clinic);
      calcomBehaviour.unauthorised = true;

      const result = await connector.call(clinic._id, 'availability.slots', {});

      expect(result).toEqual({ ok: false, error: 'The booking calendar is not available right now' });
      const saved = await CalendarConnection.findOne({ company: clinic._id }).lean();
      expect(saved.lastError).toMatch(/Cal\.com refused our credentials/);
    });
  });

  describe('previews never book', () => {
    test('a simulated booking reaches no calendar and records nothing', async () => {
      await connectCalendar(clinic);
      const [slotId] = await slotIds(clinic._id);

      const viaConnector = await connector.call(clinic._id, 'availability.book', { slotId, name: 'Ana' }, { simulate: true });
      const direct = await booking.dispatch(clinic._id, 'availability.book', { slotId, name: 'Ana' }, { simulate: true });
      const cancel = await booking.dispatch(clinic._id, 'availability.cancel', { reference: 'BK-AAAAAA' }, { simulate: true });

      [viaConnector, direct, cancel].forEach(result => {
        expect(result.ok).toBe(true);
        expect(result.value).toBeNull();
        expect(result.simulated).toHaveLength(1);
      });
      expect(bookingPosts()).toHaveLength(0);
      expect(await Booking.countDocuments({ company: clinic._id })).toBe(0);
    });

    test('the booking template run as a preview offers real times and books nothing', async () => {
      await connectCalendar(clinic);
      const compiler = new WorkflowCompilerService();
      const template = templates.byId('booking');
      const { compiledChain } = await compiler.compileWorkflow(template.nodes, template.edges, String(clinic._id));
      const context = { simulate: true, sessionId: 'p2a-preview' };

      let result = await compiler.executeWorkflow(compiledChain, 'I want to book', [], context);
      result = await compiler.executeWorkflow(compiledChain, 'A new appointment', [], { ...context, state: result.state });
      result = await compiler.executeWorkflow(compiledChain, 'Ana Pop', [], { ...context, state: result.state });
      expect(result.choices.length).toBe(3);
      result = await compiler.executeWorkflow(compiledChain, result.choices[0].label, [], { ...context, state: result.state });
      result = await compiler.executeWorkflow(compiledChain, 'ana@example.com', [], { ...context, state: result.state });

      expect(result.response).toMatch(/All booked/);
      expect(bookingPosts()).toHaveLength(0);
      expect(await Booking.countDocuments({ company: clinic._id })).toBe(0);
    });
  });

  describe('booking', () => {
    let conversation;
    let contact;

    beforeEach(async () => {
      await connectCalendar(clinic);
      contact = await Contact.create({ company: clinic._id, email: 'ana@example.com', name: 'Ana Pop', identityLevel: 'claimed' });
      conversation = await Conversation.create({ sessionId: `p2a-${Date.now()}-${Math.random()}`, company: clinic._id, contact: contact._id });
    });

    test('is recorded against the conversation, filled from the contact, and announced', async () => {
      const [slotId] = await slotIds(clinic._id);
      const result = await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId });

      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ status: 'booked', reference: expect.stringMatching(/^BK-[A-Z2-9]{6}$/) });
      expect(result.value.title).toMatch(/^Booked: .* · Check-up$/);

      const post = bookingPosts()[0];
      expect(post.body.eventTypeId).toBe(11);
      expect(post.body.attendee).toMatchObject({ name: 'Ana Pop', email: 'ana@example.com', timeZone: 'Europe/London' });

      const saved = await Booking.findOne({ company: clinic._id }).lean();
      expect(saved).toMatchObject({
        sessionId: conversation.sessionId,
        provider: 'calcom',
        providerRef: 'uid-1',
        serviceId: '11',
        serviceName: 'Check-up',
        email: 'ana@example.com',
        status: 'booked',
        createdBy: 'bot',
        timezone: 'Europe/London'
      });
      expect(String(saved.conversation)).toBe(String(conversation._id));
      expect(String(saved.contact)).toBe(String(contact._id));
      expect(saved.start.toISOString()).toBe(futureAt(1, 9).toISOString());

      expect(webhooks.dispatch).toHaveBeenCalledWith(saved.company, 'booking.created', expect.objectContaining({
        reference: saved.reference, service: 'Check-up', sessionId: conversation.sessionId, email: 'ana@example.com'
      }));
      // Written without waiting, like every audit entry.
      const entry = await eventually(() => AuditLog.findOne({ company: clinic._id, action: 'booking.created' }).lean());
      expect(entry.actor.role).toBe('assistant');

      const listed = await booking.listBookings(clinic._id, { sessionId: conversation.sessionId });
      expect(listed).toHaveLength(1);
      expect(listed[0].label).toBeTruthy();
    });

    test('the same tap twice is one appointment', async () => {
      const [slotId] = await slotIds(clinic._id);
      const first = await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId });
      const second = await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId });

      expect(second.value.reference).toBe(first.value.reference);
      expect(bookingPosts()).toHaveLength(1);
    });

    test('one conversation cannot fill the diary', async () => {
      const ids = await slotIds(clinic._id);
      for (const slotId of ids) {
        expect((await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId })).ok).toBe(true);
      }
      const later = `11@${futureAt(3, 11).toISOString()}`;
      const fourth = await connector.call(clinic._id, 'availability.book', { slotId: later }, { sessionId: conversation.sessionId });
      expect(fourth.ok).toBe(false);
      expect(fourth.error).toMatch(/already has 3 upcoming appointments/);
    });

    test('a slot id is re-checked rather than trusted', async () => {
      const disabled = await connector.call(clinic._id, 'availability.book', { slotId: `12@${futureAt(1, 9).toISOString()}` });
      const past = await connector.call(clinic._id, 'availability.book', { slotId: `11@${new Date(Date.now() - DAY).toISOString()}` });
      const garbage = await connector.call(clinic._id, 'availability.book', { slotId: 'tomorrow at nine' });

      expect(disabled.error).toMatch(/cannot be booked here/);
      expect(past.error).toMatch(/already passed/);
      expect(garbage.error).toMatch(/not one of the times offered/);
      expect(bookingPosts()).toHaveLength(0);
    });

    test('a time taken in the meantime asks for fresh times', async () => {
      const [slotId] = await slotIds(clinic._id);
      calcomBehaviour.taken = true;
      const result = await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId });
      expect(result).toEqual({ ok: false, error: 'That time has just been taken. Ask for the free times again.' });
      expect(await Booking.countDocuments({ company: clinic._id })).toBe(0);
    });

    describe('cancelling from a conversation', () => {
      let reference;

      beforeEach(async () => {
        const [slotId] = await slotIds(clinic._id);
        reference = (await connector.call(clinic._id, 'availability.book', { slotId }, { sessionId: conversation.sessionId })).value.reference;
        webhooks.dispatch.mockClear();
      });

      test('a reference alone, from somebody else\'s conversation, is not enough', async () => {
        const result = await connector.call(clinic._id, 'availability.cancel', { reference }, { sessionId: 'someone-else' });
        const wrongEmail = await connector.call(clinic._id, 'availability.cancel', { reference, email: 'mallory@example.com' });

        expect(result.ok).toBe(false);
        expect(wrongEmail.error).toBe(result.error);
        expect(result.error).toMatch(/No upcoming booking matches/);
        expect((await Booking.findOne({ reference }).lean()).status).toBe('booked');
      });

      test('the same conversation, or the right email, cancels it in the calendar', async () => {
        const result = await connector.call(clinic._id, 'availability.cancel', {
          reference: reference.replace('BK-', '').toLowerCase(), email: 'ANA@example.com'
        });

        expect(result.ok).toBe(true);
        expect(result.value.status).toBe('cancelled');
        expect(calcomCalls().some(call => call.url.pathname === '/v2/bookings/uid-1/cancel')).toBe(true);

        const saved = await Booking.findOne({ reference }).lean();
        expect(saved).toMatchObject({ status: 'cancelled', cancelledBy: 'visitor' });
        expect(webhooks.dispatch).toHaveBeenCalledWith(saved.company, 'booking.cancelled', expect.objectContaining({ reference }));
      });
    });

    test('the shipped template books the slot the visitor tapped', async () => {
      const compiler = new WorkflowCompilerService();
      const template = templates.byId('booking');
      const { compiledChain } = await compiler.compileWorkflow(template.nodes, template.edges, String(clinic._id));
      const context = { sessionId: conversation.sessionId };
      const turn = async (message, previous) =>
        compiler.executeWorkflow(compiledChain, message, [], { ...context, state: previous && previous.state });

      let result = await turn('I need an appointment');
      expect(result.response).toMatch(/new appointment or a change/);
      result = await turn('A new appointment', result);
      expect(result.response).toMatch(/What name/);
      result = await turn('Ana Pop', result);
      expect(result.response).toMatch(/next free times/);
      expect(result.choices).toHaveLength(3);

      const picked = result.choices[1];
      result = await turn(picked.label, result);
      expect(result.response).toMatch(/What email/);
      result = await turn('ana@example.com', result);

      const saved = await Booking.findOne({ company: clinic._id }).lean();
      expect(saved.start.toISOString()).toBe(futureAt(1, 9, 30).toISOString());
      expect(saved.sessionId).toBe(conversation.sessionId);
      expect(result.response).toContain(`Your reference is ${saved.reference}`);
      expect(result.response).toContain(picked.label);
    });
  });

  test('without a calendar the template falls back to taking a preferred time', async () => {
    clinic.connector = { enabled: false };
    await clinic.save();
    const compiler = new WorkflowCompilerService();
    const template = templates.byId('booking');
    const { compiledChain } = await compiler.compileWorkflow(template.nodes, template.edges, String(clinic._id));

    let result = await compiler.executeWorkflow(compiledChain, 'book please', [], {});
    result = await compiler.executeWorkflow(compiledChain, 'A new appointment', [], { state: result.state });
    result = await compiler.executeWorkflow(compiledChain, 'Ana Pop', [], { state: result.state });

    expect(result.response).toMatch(/When would suit you/);
    expect(calcomCalls()).toHaveLength(0);
  });

  describe('plan gating', () => {
    test('without the actions feature the calendar is not consulted at all', async () => {
      await connectCalendar(clinic);
      clinic.connector = { enabled: false };
      await clinic.save();
      jest.spyOn(usageService, 'hasFeature').mockResolvedValue(false);

      expect(await booking.capabilitiesFor(clinic._id)).toEqual([]);
      expect(await connector.settingsFor(clinic._id)).toBeNull();
      const result = await connector.call(clinic._id, 'availability.slots', {});
      expect(result).toEqual({ ok: false, error: 'No connector is set up for this company' });
      expect(calcomCalls()).toHaveLength(0);
    });
  });

  describe('credentials', () => {
    test('are encrypted at rest and never presented', async () => {
      await connectCalendar(clinic);

      const raw = await CalendarConnection.collection.findOne({ company: clinic._id });
      expect(raw.credentials.apiKey).toMatch(/^enc:v1:/);
      expect(JSON.stringify(raw)).not.toContain('cal_live_supersecret');

      const presented = await booking.getConnection(clinic._id);
      expect(JSON.stringify(presented)).not.toMatch(/credentials|supersecret|enc:v1/);

      const context = await booking.loadContext(clinic._id);
      expect(context.credentials.apiKey).toBe('cal_live_supersecret');
    });

    test('a Google token refreshed mid-call is saved encrypted', async () => {
      const connection = await CalendarConnection.create({
        company: clinic._id, provider: 'google', credentials: booking.sealCredentials({ refreshToken: 'r' })
      });
      const context = await booking.loadContext(clinic._id);
      await context.updateCredentials({ accessToken: 'ya29.fresh', expiresAt: new Date(Date.now() + 3600000) });

      const raw = await CalendarConnection.collection.findOne({ _id: connection._id });
      expect(raw.credentials.accessToken).toMatch(/^enc:v1:/);
      expect(secrets.decrypt(raw.credentials.accessToken)).toBe('ya29.fresh');
      expect(secrets.decrypt(raw.credentials.refreshToken)).toBe('r');
    });
  });

  describe('reminders', () => {
    let sendMail;
    const savedFrom = process.env.EMAIL_FROM;

    beforeEach(() => {
      process.env.EMAIL_FROM = 'desk@platform.example';
      sendMail = jest.fn().mockResolvedValue({});
      jest.spyOn(emailChannel, 'buildTransport').mockReturnValue({ sendMail });
    });

    afterAll(() => {
      process.env.EMAIL_FROM = savedFrom;
    });

    async function seed(overrides) {
      const doc = await Booking.create({
        company: clinic._id,
        provider: 'calcom',
        reference: `BK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        serviceName: 'Check-up',
        start: new Date(Date.now() + 20 * 3600000),
        timezone: 'Europe/London',
        name: 'Ana Pop',
        email: 'ana@example.com',
        status: 'booked',
        ...overrides
      });
      // Booked well in advance unless the test says otherwise.
      const createdAt = overrides.createdAt || new Date(Date.now() - 3 * DAY);
      await Booking.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
      return doc;
    }

    test('go once, to bookings due within a day that have an email', async () => {
      const due = await seed({});
      await seed({ email: undefined });
      await seed({ status: 'cancelled' });
      await seed({ start: new Date(Date.now() + 3 * DAY) });
      // Booked an hour ago for this afternoon: they have not forgotten yet.
      await seed({ start: new Date(Date.now() + 5 * 3600000), createdAt: new Date(Date.now() - 3600000) });

      const first = await reminders.sendDueReminders();
      const second = await reminders.sendDueReminders();

      expect(first).toEqual({ sent: 1, failed: 0 });
      expect(second).toEqual({ sent: 0, failed: 0 });
      expect(sendMail).toHaveBeenCalledTimes(1);
      const message = sendMail.mock.calls[0][0];
      expect(message.to).toBe('ana@example.com');
      expect(message.from).toContain('P2A Smile Clinic');
      expect(message.text).toContain(due.reference);
      expect(message.text).toContain('Check-up');
      expect((await Booking.findById(due._id).lean()).reminderSentAt).toBeTruthy();
    });

    test('a failed send is retried on the next run, up to three times', async () => {
      const due = await seed({});
      sendMail.mockRejectedValue(new Error('SMTP down'));

      for (let run = 0; run < 4; run += 1) {
        await reminders.sendDueReminders();
      }

      expect(sendMail).toHaveBeenCalledTimes(3);
      const saved = await Booking.findById(due._id).lean();
      expect(saved.reminderSentAt).toBeNull();
      expect(saved.reminderAttempts).toBe(3);
    });

    test('a company that switched them off gets none', async () => {
      await connectCalendar(clinic, { reminders: false });
      await seed({});
      expect(await reminders.sendDueReminders()).toEqual({ sent: 0, failed: 0 });
    });

    test('without outbound email nothing is claimed', async () => {
      emailChannel.buildTransport.mockReturnValue(null);
      const due = await seed({});
      expect((await booking.sendDueReminders()).skipped).toMatch(/EMAIL_HOST/);
      expect((await Booking.findById(due._id).lean()).reminderSentAt).toBeNull();
    });
  });

  test('the webhook catalogue lists the booking events', () => {
    expect(webhooks.EVENT_IDS.has('booking.created')).toBe(true);
    expect(webhooks.EVENT_IDS.has('booking.cancelled')).toBe(true);
    expect(webhooks.EVENTS.find(event => event.id === 'booking.created').label).toBeTruthy();
  });

  test('GDPR erasure removes a person\'s bookings and nobody else\'s', async () => {
    const mine = await Booking.create({ company: clinic._id, provider: 'calcom', reference: 'BK-ERASE1', start: new Date(), sessionId: 's-me', email: 'me@example.com' });
    const theirs = await Booking.create({ company: clinic._id, provider: 'calcom', reference: 'BK-KEEP11', start: new Date(), sessionId: 's-them' });

    expect(await booking.erase({ companyId: clinic._id, sessionIds: ['s-me'] })).toBe(1);
    expect(await Booking.exists({ _id: mine._id })).toBeNull();
    expect(await Booking.exists({ _id: theirs._id })).toBeTruthy();
  });
});
