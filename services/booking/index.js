/**
 * Real booking: the bot puts an appointment in the tenant's own diary.
 *
 * A clinic or salon keeps its diary in Cal.com, Calendly or Google Calendar.
 * Connecting one here makes the availability capabilities from
 * config/capabilities.js - list the free times, book one, cancel one - answer
 * from that diary instead of from a connector the tenant would otherwise have
 * had to build and host. services/connector.js hands those capabilities to
 * `dispatch` below whenever the company has an active connection, so the
 * assistant's tools, the workflow "Use your data" node and the widget's slot
 * buttons work unchanged: they still receive Slots and Bookings in the shapes
 * the contract fixes.
 *
 * The guards on a write stay where they are. A preview never books (the
 * connector refuses a simulated write before it gets here, and so does this),
 * the assistant still asks the visitor to confirm, and the workflow only books
 * when the conversation reaches that step for real. On top of those, this
 * module re-checks everything it is handed: a slot id came back through a
 * visitor's tap or a model's arguments, so its service has to be one the bot
 * may book and its time has to still be free.
 *
 * Every booking made through us is recorded (models/booking.js), raises the
 * `booking.created` webhook, and is cancellable from the dashboard.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const CalendarConnection = require('../../models/calendar-connection');
const Booking = require('../../models/booking');
const Company = require('../../models/company');
const Conversation = require('../../models/conversation');
const capabilities = require('../../config/capabilities');
const secrets = require('../secrets');
const usageService = require('../usage');
const audit = require('../audit');
const webhooks = require('../webhooks');
const time = require('./time');
const { ProviderError } = require('./http');
const { logger } = require('../logging');

const PROVIDERS = {
  calcom: require('./providers/calcom'),
  google: require('./providers/google'),
  calendly: require('./providers/calendly')
};

/** The capabilities a connected calendar answers. */
const CAPABILITY_IDS = ['availability.slots', 'availability.book', 'availability.cancel'];

const DEFAULT_SLOT_LIMIT = 6;
const MAX_SLOT_LIMIT = 25;
/** A search across every service asks the provider once per service. */
const MAX_SERVICES_PER_SEARCH = 5;
/** Stops one conversation filling the diary, whatever the model is talked into. */
const MAX_UPCOMING_PER_CONVERSATION = 3;
const MAX_RANGE_DAYS = 31;
const MAX_SERVICES = 30;
/** Free times change when somebody books; a few seconds spares the provider the repeats. */
const SLOT_CACHE_TTL_MS = 10000;
/** Monday to Friday, nine to five, until the tenant says otherwise. */
const DEFAULT_HOURS = [0, 1, 2, 3, 4, 5, 6].map(day => ({
  day, closed: day === 0 || day === 6, opensAt: 540, closesAt: 1020
}));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Something about the request is wrong, in words the visitor's side can use.
 *
 * Distinct from a ProviderError so the message is passed on as it is: these
 * are ours, and written to be read by the model or shown in the dashboard.
 */
class BookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BookingError';
    this.status = status;
  }
}

// ------------------------------------------------------------ credentials

function sealCredentials(plain = {}) {
  const sealed = {};
  ['apiKey', 'accessToken', 'refreshToken'].forEach(field => {
    if (plain[field]) {
      sealed[field] = secrets.encrypt(String(plain[field]));
    }
  });
  if (plain.expiresAt) {
    sealed.expiresAt = new Date(plain.expiresAt);
  }
  if (plain.scope) {
    sealed.scope = String(plain.scope);
  }
  return sealed;
}

function openCredentials(sealed = {}) {
  return {
    apiKey: secrets.decrypt(sealed.apiKey) || '',
    accessToken: secrets.decrypt(sealed.accessToken) || '',
    refreshToken: secrets.decrypt(sealed.refreshToken) || '',
    expiresAt: sealed.expiresAt || null
  };
}

// ---------------------------------------------------------------- context

/**
 * Which timezone the diary runs in.
 *
 * The business's own setting (Channels → Business hours) when it has been
 * set; `UTC` is the schema default there, so it only counts when nothing
 * better is known - the provider account's own zone usually is.
 */
function timezoneFor(company, connection) {
  const configured = company && company.businessHours && company.businessHours.timezone;
  if (configured && configured !== 'UTC' && time.isValidTimezone(configured)) {
    return configured;
  }
  const account = connection && connection.account && connection.account.timezone;
  if (account && time.isValidTimezone(account)) {
    return account;
  }
  return 'UTC';
}

/**
 * Everything a provider needs for one call, with the credentials decrypted.
 *
 * Built per call and never stored, so a decrypted key lives as long as the
 * request that needed it.
 */
function buildContext(connection, company) {
  return {
    id: String(connection._id),
    companyId: String(connection.company),
    provider: connection.provider,
    enabled: connection.enabled !== false,
    account: connection.account || {},
    services: connection.services || [],
    hours: connection.hours && connection.hours.length ? connection.hours : DEFAULT_HOURS,
    calendarId: connection.calendarId || 'primary',
    inviteAttendee: Boolean(connection.inviteAttendee),
    minNoticeMinutes: connection.minNoticeMinutes ?? 120,
    horizonDays: connection.horizonDays || 14,
    timezone: timezoneFor(company, connection),
    closedDates: ((company && company.businessHours && company.businessHours.closedDates) || [])
      .map(entry => entry && entry.date)
      .filter(Boolean),
    companyName: (company && company.name) || '',
    credentials: openCredentials(connection.credentials || {}),
    async updateCredentials(patch) {
      const set = {};
      Object.entries(sealCredentials(patch)).forEach(([field, value]) => {
        set[`credentials.${field}`] = value;
      });
      await CalendarConnection.updateOne({ _id: connection._id }, { $set: set });
    }
  };
}

/**
 * The company's connection as a provider context, or null.
 *
 * @param {object} [options]
 * @param {boolean} [options.requireEnabled=true] a paused connection still
 *        answers the dashboard's test and cancels; it does not answer visitors
 */
async function loadContext(companyId, { requireEnabled = true } = {}) {
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return null;
  }
  const query = { company: companyId };
  if (requireEnabled) {
    query.enabled = true;
  }
  const connection = await CalendarConnection.findOne(query).select('+credentials').lean();
  if (!connection) {
    return null;
  }
  const company = await Company.findById(companyId).select('name businessHours').lean();
  return buildContext(connection, company);
}

/**
 * The live connection visitors' requests go to, or null.
 *
 * Gated on the plan's `actions` feature like every other way the bot acts in
 * a tenant's systems: a company that downgrades keeps its connection, and it
 * starts answering again when the feature comes back.
 */
async function activeContext(companyId) {
  const context = await loadContext(companyId);
  if (!context) {
    return null;
  }
  return (await usageService.hasFeature(companyId, 'actions')) ? context : null;
}

/** Whether `dispatch` answers this capability when a calendar is connected. */
function handles(capabilityId) {
  return CAPABILITY_IDS.includes(capabilityId);
}

/**
 * The capabilities this company's connected calendar answers, or none.
 *
 * Read on every assistant turn (through services/connector.js#settingsFor),
 * so it is one indexed existence check, and it never throws: tools are an
 * addition and must not take the assistant down with them.
 */
async function capabilitiesFor(companyId) {
  try {
    if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
      return [];
    }
    const exists = await CalendarConnection.exists({ company: companyId, enabled: true });
    if (!exists || !(await usageService.hasFeature(companyId, 'actions'))) {
      return [];
    }
    return [...CAPABILITY_IDS];
  } catch (error) {
    logger.warn('Could not check for a calendar connection', { companyId: String(companyId), error: error.message });
    return [];
  }
}

// ------------------------------------------------------------------ cache

const slotCache = new Map();

function clearSlotCache(companyId) {
  if (!companyId) {
    slotCache.clear();
    return;
  }
  [...slotCache.keys()]
    .filter(key => key.startsWith(`${String(companyId)}:`))
    .forEach(key => slotCache.delete(key));
}

// ------------------------------------------------------------------ slots

/** The services a search covers: the one asked for, or every bookable one. */
function servicesFor(context, wanted) {
  const bookable = (context.services || []).filter(service => service.enabled);

  if (bookable.length === 0) {
    throw new BookingError('No services are set up for booking yet');
  }
  if (!wanted) {
    return bookable.slice(0, MAX_SERVICES_PER_SEARCH);
  }

  const text = String(wanted).trim().toLowerCase();
  const exact = bookable.filter(service =>
    service.id.toLowerCase() === text || service.name.toLowerCase() === text);
  if (exact.length > 0) {
    return exact;
  }

  const partial = bookable.filter(service => {
    const name = service.name.toLowerCase();
    return name.includes(text) || text.includes(name);
  });
  if (partial.length > 0) {
    return partial.slice(0, MAX_SERVICES_PER_SEARCH);
  }

  // Said to the model, which can then ask the visitor which they meant.
  throw new BookingError(
    `There is no service called "${String(wanted).slice(0, 60)}". The services are: ${bookable.map(service => service.name).join(', ')}`
  );
}

/**
 * A date the contract gave us, read as the business would mean it.
 *
 * The capability's `date` inputs arrive as ISO strings; a bare day ("Thursday",
 * passed as 2026-10-22) becomes midnight UTC, which for a clinic in New York
 * is eight in the evening the day before. A value at exactly midnight UTC is
 * taken to mean that whole day in the business's own timezone.
 */
function boundary(value, timezone, edge) {
  const text = new Date(value).toISOString();
  if (/T00:00:00\.000Z$/.test(text)) {
    const day = text.slice(0, 10);
    const local = time.zonedTime(edge === 'end' ? time.shiftDate(day, 1) : day, 0, timezone);
    if (local) {
      return local;
    }
  }
  return new Date(text);
}

function rangeFor(context, input) {
  const now = Date.now();
  // Google's diary does not know how much notice the business needs; Cal.com
  // and Calendly apply their own and would only be second-guessed.
  const notice = context.provider === 'google' ? context.minNoticeMinutes : 0;
  const earliest = new Date(now + notice * 60000);

  let from = input.from ? boundary(input.from, context.timezone, 'start') : earliest;
  if (from < earliest) {
    from = earliest;
  }

  let to = input.to
    ? boundary(input.to, context.timezone, 'end')
    : new Date(from.getTime() + context.horizonDays * 86400000);
  to = new Date(Math.min(to.getTime(), from.getTime() + MAX_RANGE_DAYS * 86400000));

  if (to <= from) {
    throw new BookingError('That date has already passed. Ask which day suits them instead.');
  }
  return { from, to };
}

/**
 * Free times as contract Slots, ready for the widget and the model.
 */
async function findSlots(context, input = {}) {
  const key = `${context.companyId}:${JSON.stringify(input)}`;
  const cached = slotCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const services = servicesFor(context, input.service);
  const { from, to } = rangeFor(context, input);
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || DEFAULT_SLOT_LIMIT, 1), MAX_SLOT_LIMIT);
  const provider = PROVIDERS[context.provider];
  const several = services.length > 1;
  const found = [];

  for (const service of services) {
    const slots = await provider.slots(context, {
      serviceId: service.id, service, from, to, timezone: context.timezone
    });

    slots.forEach(slot => {
      // A provider may answer a little outside the window asked for; the
      // window is where our notice rule lives.
      if (slot.start < from || slot.start >= to) {
        return;
      }
      const label = time.formatLabel(slot.start, context.timezone);
      found.push({
        id: time.encodeSlotId(service.id, slot.start),
        startsAt: slot.start.toISOString(),
        ...(slot.end ? { endsAt: new Date(slot.end).toISOString() } : {}),
        label: several ? `${label} · ${service.name}` : label
      });
    });
  }

  const picked = time.pickSlots(found, limit, context.timezone, {
    spread: to.getTime() - from.getTime() > 86400000
  });

  if (slotCache.size > 500) {
    slotCache.delete(slotCache.keys().next().value);
  }
  slotCache.set(key, { value: picked, expires: Date.now() + SLOT_CACHE_TTL_MS });
  return picked;
}

// ---------------------------------------------------------------- booking

function cleanText(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function cleanEmail(value) {
  const text = cleanText(value, 254).toLowerCase();
  return EMAIL.test(text) ? text : '';
}

/** Six characters nobody misreads: no 0/O, no 1/I. */
async function newReference(companyId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
    }
    const reference = `BK-${code}`;
    if (!(await Booking.exists({ company: companyId, reference }))) {
      return reference;
    }
  }
  throw new Error('Could not find a free booking reference');
}

/**
 * The conversation a booking comes from, and who the visitor is.
 *
 * Only ever this company's: a session id is something a visitor's browser
 * holds, and a contact from another tenant vouches for nobody here.
 */
async function conversationFor(companyId, sessionId) {
  if (!sessionId) {
    return { conversation: null, contact: null };
  }
  const conversation = await Conversation.findOne({ company: companyId, sessionId: String(sessionId) })
    .select('_id contact sessionId')
    .lean();
  if (!conversation || !conversation.contact) {
    return { conversation, contact: null };
  }
  const Contact = require('../../models/contact');
  const contact = await Contact.findById(conversation.contact).select('name email phone company').lean();
  const sameTenant = contact && (!contact.company || String(contact.company) === String(companyId));
  return { conversation, contact: sameTenant ? contact : null };
}

/** A booking in the contract's shape, for the widget and the model. */
function toCapabilityBooking(booking, timezone) {
  const label = time.formatLabel(new Date(booking.start), booking.timezone || timezone || 'UTC');
  const status = booking.status === 'pending' ? 'link' : booking.status;
  const lead = status === 'link' ? 'Finish booking' : (status === 'cancelled' ? 'Cancelled' : 'Booked');

  return {
    id: String(booking._id),
    startsAt: new Date(booking.start).toISOString(),
    reference: booking.reference,
    status,
    title: `${lead}: ${label}${booking.serviceName ? ` · ${booking.serviceName}` : ''}`,
    ...(booking.url ? { url: booking.url } : {})
  };
}

/** What a webhook receiver is told. The visitor's details are the tenant's own. */
function webhookPayload(booking) {
  return {
    bookingId: String(booking._id),
    reference: booking.reference,
    provider: booking.provider,
    serviceId: booking.serviceId || null,
    service: booking.serviceName || null,
    startsAt: new Date(booking.start).toISOString(),
    endsAt: booking.end ? new Date(booking.end).toISOString() : null,
    timezone: booking.timezone || null,
    status: booking.status,
    name: booking.name || null,
    email: booking.email || null,
    phone: booking.phone || null,
    sessionId: booking.sessionId || null,
    createdBy: booking.createdBy,
    ...(booking.rescheduledFrom ? { rescheduledFrom: String(booking.rescheduledFrom) } : {}),
    ...(booking.cancelledBy ? { cancelledBy: booking.cancelledBy } : {})
  };
}

function actorFor(options = {}) {
  if (options.req) {
    return {};
  }
  return { actor: { displayName: 'Assistant', role: 'assistant' } };
}

function announceCreated(booking, options = {}) {
  webhooks.dispatch(booking.company, 'booking.created', webhookPayload(booking));
  audit.record({
    ...actorFor(options),
    req: options.req,
    company: booking.company,
    action: 'booking.created',
    target: { type: 'booking', id: String(booking._id), label: booking.reference },
    details: {
      provider: booking.provider,
      service: booking.serviceName,
      startsAt: booking.start,
      createdBy: booking.createdBy,
      ...(booking.sessionId ? { sessionId: booking.sessionId } : {})
    }
  });
}

/**
 * Book the slot a visitor chose.
 *
 * @returns {Promise<{value: object}>} the contract Booking
 */
async function bookSlot(context, input = {}, options = {}) {
  const decoded = time.decodeSlotId(input.slotId);
  if (!decoded) {
    throw new BookingError('That is not one of the times offered. Ask for the free times again.');
  }

  const service = (context.services || []).find(entry => entry.enabled && entry.id === decoded.serviceId);
  if (!service) {
    throw new BookingError('That service cannot be booked here. Ask for the free times again.');
  }

  const now = Date.now();
  const start = decoded.start;
  if (start.getTime() <= now) {
    throw new BookingError('That time has already passed. Ask for the free times again.');
  }
  if (start.getTime() > now + (context.horizonDays + MAX_RANGE_DAYS) * 86400000) {
    throw new BookingError('That time is too far ahead to book here.');
  }

  const sessionId = options.sessionId ? String(options.sessionId) : null;
  const { conversation, contact } = await conversationFor(context.companyId, sessionId);

  // What the visitor said wins; what we already know about them fills gaps.
  const name = cleanText(input.name, 120) || cleanText(contact && contact.name, 120);
  const email = cleanEmail(input.email) || cleanEmail(contact && contact.email);
  const phone = cleanText(input.phone, 40) || cleanText(contact && contact.phone, 40);
  const notes = cleanText(input.notes, 1000);

  if (sessionId) {
    // The same tap twice - a double click, a retry after a slow answer - is
    // one appointment, not two.
    const existing = await Booking.findOne({
      company: context.companyId,
      sessionId,
      serviceId: service.id,
      start,
      status: { $in: ['booked', 'pending'] }
    });
    if (existing) {
      return { value: toCapabilityBooking(existing, context.timezone) };
    }

    const upcoming = await Booking.countDocuments({
      company: context.companyId,
      sessionId,
      status: { $in: ['booked', 'pending'] },
      start: { $gt: new Date(now) }
    });
    if (upcoming >= MAX_UPCOMING_PER_CONVERSATION) {
      throw new BookingError(
        `This conversation already has ${upcoming} upcoming appointments. Offer to pass them to a colleague for more.`
      );
    }
  }

  const reference = await newReference(context.companyId);
  const result = await PROVIDERS[context.provider].book(context, {
    serviceId: service.id,
    service,
    start,
    name,
    email,
    phone,
    notes,
    timezone: context.timezone,
    reference
  });

  const booking = await Booking.create({
    company: context.companyId,
    conversation: conversation ? conversation._id : undefined,
    sessionId: sessionId || undefined,
    contact: contact ? contact._id : undefined,
    provider: context.provider,
    providerRef: result.providerRef || undefined,
    reference,
    serviceId: service.id,
    serviceName: service.name,
    start: result.start || start,
    end: result.end || new Date(start.getTime() + (Number(service.duration) || 30) * 60000),
    timezone: context.timezone,
    name: name || undefined,
    email: email || undefined,
    phone: phone || undefined,
    notes: notes || undefined,
    status: result.status === 'link' ? 'pending' : 'booked',
    url: result.url || undefined,
    providerData: result.providerData || undefined,
    createdBy: options.createdBy === 'operator' ? 'operator' : 'bot',
    createdByUser: options.userId || undefined,
    rescheduledFrom: options.rescheduledFrom || undefined
  });

  clearSlotCache(context.companyId);

  if (booking.status === 'booked') {
    announceCreated(booking, options);
  }

  return { value: toCapabilityBooking(booking, context.timezone), booking };
}

/**
 * Take a booking out of the diary and record that we did.
 */
async function cancelRecord(context, booking, options = {}) {
  if (booking.status === 'booked' && booking.providerRef) {
    if (!context || context.provider !== booking.provider) {
      throw new BookingError(
        `This appointment is in ${PROVIDERS[booking.provider].label}, which is no longer connected. Cancel it there.`,
        409
      );
    }
    await PROVIDERS[booking.provider].cancel(context, booking.providerRef, booking.providerData || {});
  }

  booking.status = 'cancelled';
  booking.cancelledAt = new Date();
  booking.cancelledBy = options.by === 'operator' ? 'operator' : 'visitor';
  await booking.save();

  clearSlotCache(booking.company);

  webhooks.dispatch(booking.company, 'booking.cancelled', webhookPayload(booking));
  audit.record({
    ...actorFor(options),
    req: options.req,
    company: booking.company,
    action: 'booking.cancelled',
    target: { type: 'booking', id: String(booking._id), label: booking.reference },
    details: { provider: booking.provider, startsAt: booking.start, cancelledBy: booking.cancelledBy }
  });

  return booking;
}

/**
 * `availability.cancel` from a conversation.
 *
 * A reference alone is not enough: references are short enough to read out,
 * which makes them short enough to guess. The visitor has to be in the
 * conversation the booking was made from, or give the email it was made
 * under - and a mismatch says the same as "no such booking", so the answer
 * does not confirm a reference exists.
 */
async function cancelByReference(context, input = {}, options = {}) {
  let reference = cleanText(input.reference, 20).toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z0-9]{6}$/.test(reference)) {
    reference = `BK-${reference}`;
  }

  const booking = reference
    ? await Booking.findOne({
      company: context.companyId,
      reference,
      status: { $in: ['booked', 'pending'] }
    })
    : null;

  const sameConversation = Boolean(booking && options.sessionId && booking.sessionId === String(options.sessionId));
  const email = cleanEmail(input.email);
  const sameEmail = Boolean(booking && email && booking.email && booking.email === email);

  if (!booking || !(sameConversation || sameEmail)) {
    throw new BookingError('No upcoming booking matches that reference and email. Check both with the visitor.', 404);
  }
  if (new Date(booking.start).getTime() <= Date.now()) {
    throw new BookingError('That appointment has already happened.');
  }

  await cancelRecord(context, booking, { by: 'visitor' });
  return { value: toCapabilityBooking(booking, context.timezone) };
}

// --------------------------------------------------------------- dispatch

/**
 * Turn a failure into the one line the model or the workflow sees, and note
 * on the connection anything only the admin can fix.
 */
async function failure(context, error) {
  if (error instanceof BookingError || !context) {
    return { ok: false, error: error.message };
  }

  const label = PROVIDERS[context.provider].label;

  if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
    const lastError = `${label} refused our credentials: ${error.message}`.slice(0, 500);
    await CalendarConnection.updateOne({ _id: context.id }, { $set: { lastError } }).catch(() => {});
    logger.warn('Calendar provider refused the credentials', {
      companyId: context.companyId, provider: context.provider, status: error.status
    });
    return { ok: false, error: 'The booking calendar is not available right now' };
  }

  if (error instanceof ProviderError && error.status === 409) {
    return { ok: false, error: 'That time has just been taken. Ask for the free times again.' };
  }

  logger.warn('Calendar provider call failed', {
    companyId: context.companyId, provider: context.provider, error: error.message
  });
  return { ok: false, error: `${label} could not answer: ${String(error.message).slice(0, 160)}` };
}

function validated(capabilityId, value, options = {}) {
  const checked = capabilities.validateResult(capabilityId, value, { maxItems: options.maxItems });
  if (!checked.ok) {
    logger.warn('Booking produced an unusable shape', { capability: capabilityId, errors: checked.errors });
    return { ok: false, error: 'The booking calendar answered with something unusable' };
  }
  return { ok: true, value: checked.value, warnings: checked.warnings, truncated: checked.truncated };
}

/**
 * Answer an availability capability from the connected calendar.
 *
 * Called by services/connector.js#call after it has checked the inputs
 * against the contract and refused a simulated write.
 *
 * @param {object} [options]
 * @param {string} [options.sessionId] the conversation, to record the booking
 *        against and to let its visitor cancel what they booked
 * @param {boolean} [options.simulate] a preview: refuse writes (again)
 * @param {number} [options.maxItems]
 * @returns {Promise<object|null>} the connector's result shape, or null when
 *          there is no active calendar and the hosted connector should answer
 */
async function dispatch(companyId, capabilityId, input = {}, options = {}) {
  if (!handles(capabilityId)) {
    return null;
  }

  let context;
  try {
    context = await activeContext(companyId);
  } catch (error) {
    logger.error('Could not load the calendar connection', { companyId: String(companyId), error: error.message });
    return null;
  }
  if (!context) {
    return null;
  }

  const capability = capabilities.byId(capabilityId);
  if (options.simulate && capability.kind === 'write') {
    return {
      ok: true,
      simulated: [{
        description: `${capability.label} (${capabilityId})`,
        detail: 'Not sent — previews do not change your calendar.'
      }],
      value: null
    };
  }

  try {
    if (capabilityId === 'availability.slots') {
      return validated(capabilityId, await findSlots(context, input), options);
    }
    if (capabilityId === 'availability.book') {
      return validated(capabilityId, (await bookSlot(context, input, options)).value, options);
    }
    return validated(capabilityId, (await cancelByReference(context, input, options)).value, options);
  } catch (error) {
    return failure(context, error);
  }
}

// ----------------------------------------------------- dashboard and API

function presentService(service) {
  return {
    id: service.id,
    name: service.name,
    duration: service.duration,
    buffer: service.buffer || 0,
    enabled: Boolean(service.enabled),
    hidden: Boolean(service.hidden)
  };
}

/** A connection for the dashboard. Never the credentials. */
function presentConnection(connection, company) {
  if (!connection) {
    return null;
  }
  return {
    provider: connection.provider,
    label: PROVIDERS[connection.provider].label,
    enabled: connection.enabled !== false,
    account: {
      name: (connection.account && connection.account.name) || '',
      email: (connection.account && connection.account.email) || ''
    },
    services: (connection.services || []).map(presentService),
    calendarId: connection.calendarId || 'primary',
    hours: connection.hours && connection.hours.length ? connection.hours : DEFAULT_HOURS,
    inviteAttendee: Boolean(connection.inviteAttendee),
    minNoticeMinutes: connection.minNoticeMinutes ?? 120,
    horizonDays: connection.horizonDays || 14,
    reminders: connection.reminders !== false,
    timezone: timezoneFor(company, connection),
    connectedAt: connection.connectedAt,
    lastCheckedAt: connection.lastCheckedAt || null,
    lastError: connection.lastError || null
  };
}

async function getConnection(companyId) {
  const [connection, company] = await Promise.all([
    CalendarConnection.findOne({ company: companyId }).lean(),
    Company.findById(companyId).select('name businessHours').lean()
  ]);
  return presentConnection(connection, company);
}

/**
 * Merge a fresh list of event types into the stored one, keeping the
 * tenant's choices. A new public event type is bookable by default; a hidden
 * one is not until somebody says so.
 */
function mergeServices(previous = [], fresh = []) {
  const before = new Map(previous.map(service => [service.id, service]));
  return fresh.slice(0, MAX_SERVICES).map(service => ({
    ...service,
    enabled: before.has(service.id) ? Boolean(before.get(service.id).enabled) : !service.hidden
  }));
}

/** Hours from Channels → Business hours, when they have been set. */
function hoursFromCompany(company) {
  const days = (company && company.businessHours && company.businessHours.days) || [];
  const usable = days.filter(day => day && Number.isInteger(day.day) &&
    (day.closed || (day.opensAt ?? 0) < (day.closesAt ?? 1440)));
  if (usable.length === 0) {
    return DEFAULT_HOURS;
  }
  return [0, 1, 2, 3, 4, 5, 6].map(day => {
    const rule = usable.find(entry => entry.day === day);
    return rule
      ? { day, closed: Boolean(rule.closed), opensAt: rule.opensAt ?? 0, closesAt: rule.closesAt ?? 1440 }
      : { day, closed: true, opensAt: 540, closesAt: 1020 };
  });
}

/**
 * Replace the company's connection with a new one.
 *
 * One diary per company: connecting a second provider disconnects the first.
 */
async function saveConnection(companyId, { provider, credentials, account, services, extra = {}, userId }) {
  const previous = await CalendarConnection.findOne({ company: companyId }).select('+credentials').lean();

  if (previous && previous.provider === 'google' && provider !== 'google') {
    const company = await Company.findById(companyId).select('name businessHours').lean();
    await PROVIDERS.google.revoke(buildContext(previous, company));
  }

  const keepChoices = previous && previous.provider === provider ? previous.services : [];

  const connection = await CalendarConnection.findOneAndUpdate(
    { company: companyId },
    {
      $set: {
        company: companyId,
        provider,
        enabled: true,
        credentials: sealCredentials(credentials),
        account,
        services: provider === 'google'
          ? ((previous && previous.provider === 'google' && previous.services && previous.services.length)
            ? previous.services
            : [{ id: 'appointment', name: 'Appointment', duration: 30, buffer: 0, enabled: true }])
          : mergeServices(keepChoices, services),
        connectedBy: userId || undefined,
        connectedAt: new Date(),
        lastCheckedAt: new Date(),
        lastError: null,
        ...extra
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  clearSlotCache(companyId);
  return connection;
}

/**
 * Connect Cal.com or Calendly with a key the admin pasted.
 *
 * The key is tried before anything is saved, so a typo is an error on the
 * form rather than a broken bot.
 */
async function connectWithKey(companyId, provider, key, { userId } = {}) {
  if (!['calcom', 'calendly'].includes(provider)) {
    throw new BookingError('Choose Cal.com or Calendly');
  }
  const secret = String(key || '').trim();
  if (secret.length < 10 || secret.length > 4000 || /\s/.test(secret)) {
    throw new BookingError(provider === 'calcom'
      ? 'Paste the whole API key from Cal.com (it starts with cal_)'
      : 'Paste the whole personal access token from Calendly');
  }

  const credentials = { apiKey: secret };
  let account;
  let services;
  try {
    account = await PROVIDERS[provider].verify(credentials);
    services = await PROVIDERS[provider].listServices({ credentials, account });
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
      throw new BookingError(`${PROVIDERS[provider].label} did not accept that ${provider === 'calcom' ? 'API key' : 'token'}`);
    }
    throw new BookingError(`Could not reach ${PROVIDERS[provider].label}: ${error.message}`, 502);
  }

  const connection = await saveConnection(companyId, { provider, credentials, account, services, userId });
  const company = await Company.findById(companyId).select('name businessHours').lean();
  return presentConnection(connection, company);
}

/** Save the Google tokens the OAuth callback received. */
async function connectGoogle(companyId, tokens, { userId } = {}) {
  if (!tokens || !tokens.refreshToken) {
    // Without a refresh token the connection would die in an hour.
    throw new BookingError('Google did not give us lasting access. Remove the app from your Google account and connect again.');
  }
  const account = await PROVIDERS.google.verify(tokens);
  const company = await Company.findById(companyId).select('name businessHours').lean();
  const previous = await CalendarConnection.findOne({ company: companyId }).lean();

  const connection = await saveConnection(companyId, {
    provider: 'google',
    credentials: tokens,
    account,
    services: [],
    userId,
    extra: (previous && previous.provider === 'google' && previous.hours && previous.hours.length)
      ? {}
      : { hours: hoursFromCompany(company), calendarId: 'primary' }
  });
  return presentConnection(connection, company);
}

function minutesValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

/**
 * Check the settings form. Everything is optional; what is sent is checked.
 *
 * @returns {{set: object, errors: string[]}}
 */
function normaliseSettings(connection, body = {}) {
  const set = {};
  const errors = [];

  if (body.enabled !== undefined) {
    set.enabled = Boolean(body.enabled);
  }
  if (body.reminders !== undefined) {
    set.reminders = Boolean(body.reminders);
  }
  if (body.horizonDays !== undefined) {
    const days = minutesValue(body.horizonDays, NaN);
    if (!(days >= 1 && days <= 60)) {
      errors.push('Look ahead between 1 and 60 days');
    } else {
      set.horizonDays = days;
    }
  }

  if (Array.isArray(body.services)) {
    if (connection.provider === 'google') {
      // The tenant's own list: names, lengths and buffers are theirs to edit.
      const services = [];
      const ids = new Set();
      body.services.slice(0, MAX_SERVICES).forEach((service, index) => {
        const name = cleanText(service && service.name, 120);
        const duration = minutesValue(service && service.duration, NaN);
        const buffer = minutesValue(service && service.buffer, 0);
        if (!name) {
          errors.push(`Service ${index + 1} needs a name`);
          return;
        }
        if (!(duration >= 5 && duration <= 480)) {
          errors.push(`"${name}" must last between 5 and 480 minutes`);
          return;
        }
        if (!(buffer >= 0 && buffer <= 240)) {
          errors.push(`"${name}" needs a buffer between 0 and 240 minutes`);
          return;
        }
        let id = /^[a-z0-9_-]{1,40}$/.test(String(service.id || '')) ? String(service.id) : '';
        if (!id || ids.has(id)) {
          id = `svc_${crypto.randomBytes(4).toString('hex')}`;
        }
        ids.add(id);
        services.push({ id, name, duration, buffer, enabled: service.enabled !== false });
      });
      set.services = services;
    } else {
      // Cal.com's and Calendly's lists come from them; only the bot's choice
      // is ours.
      const wanted = new Map(body.services
        .filter(service => service && service.id !== undefined)
        .map(service => [String(service.id), service.enabled !== false]));
      set.services = (connection.services || []).map(service => ({
        ...service,
        enabled: wanted.has(service.id) ? wanted.get(service.id) : service.enabled
      }));
    }
  }

  if (connection.provider === 'google') {
    if (Array.isArray(body.hours)) {
      const hours = [];
      [0, 1, 2, 3, 4, 5, 6].forEach(day => {
        const rule = body.hours.find(entry => entry && Number(entry.day) === day) || { day, closed: true };
        const closed = Boolean(rule.closed);
        const opensAt = minutesValue(rule.opensAt, 540);
        const closesAt = minutesValue(rule.closesAt, 1020);
        if (!closed && !(opensAt >= 0 && closesAt <= 1440 && opensAt < closesAt)) {
          errors.push('Each open day needs a closing time after its opening time');
          return;
        }
        hours.push({ day, closed, opensAt, closesAt });
      });
      set.hours = hours;
    }
    if (body.inviteAttendee !== undefined) {
      set.inviteAttendee = Boolean(body.inviteAttendee);
    }
    if (body.minNoticeMinutes !== undefined) {
      const notice = minutesValue(body.minNoticeMinutes, NaN);
      if (!(notice >= 0 && notice <= 10080)) {
        errors.push('Minimum notice must be between 0 minutes and 7 days');
      } else {
        set.minNoticeMinutes = notice;
      }
    }
    if (body.calendarId !== undefined) {
      const calendarId = cleanText(body.calendarId, 200) || 'primary';
      set.calendarId = calendarId;
    }
  }

  return { set, errors: [...new Set(errors)] };
}

async function updateSettings(companyId, body) {
  const connection = await CalendarConnection.findOne({ company: companyId }).lean();
  if (!connection) {
    throw new BookingError('Connect a calendar first', 404);
  }
  const { set, errors } = normaliseSettings(connection, body);
  if (errors.length > 0) {
    const error = new BookingError(errors[0]);
    error.errors = errors;
    throw error;
  }

  const updated = await CalendarConnection.findOneAndUpdate(
    { company: companyId }, { $set: set }, { new: true }
  ).lean();
  clearSlotCache(companyId);
  const company = await Company.findById(companyId).select('name businessHours').lean();
  return presentConnection(updated, company);
}

/** Fetch the event types again, keeping which ones the bot may book. */
async function refreshServices(companyId) {
  const context = await loadContext(companyId, { requireEnabled: false });
  if (!context) {
    throw new BookingError('Connect a calendar first', 404);
  }
  if (context.provider === 'google') {
    return getConnection(companyId);
  }

  const connection = await CalendarConnection.findOne({ company: companyId }).lean();
  try {
    const services = await PROVIDERS[context.provider].listServices(context);
    await CalendarConnection.updateOne({ company: companyId }, {
      $set: { services: mergeServices(connection.services, services), lastCheckedAt: new Date(), lastError: null }
    });
  } catch (error) {
    const result = await failure(context, error);
    throw new BookingError(result.error, 502);
  }
  clearSlotCache(companyId);
  return getConnection(companyId);
}

/**
 * "Test: show the next 3 slots", from the dashboard. Works while paused, so
 * an admin can check before letting visitors at it.
 */
async function testSlots(companyId) {
  const context = await loadContext(companyId, { requireEnabled: false });
  if (!context) {
    throw new BookingError('Connect a calendar first', 404);
  }
  clearSlotCache(companyId);
  try {
    const slots = await findSlots(context, { limit: 3 });
    await CalendarConnection.updateOne({ company: companyId }, { $set: { lastCheckedAt: new Date(), lastError: null } });
    return { slots, timezone: context.timezone };
  } catch (error) {
    const result = await failure(context, error);
    throw new BookingError(result.error, error instanceof BookingError ? 400 : 502);
  }
}

async function disconnect(companyId) {
  const context = await loadContext(companyId, { requireEnabled: false });
  if (!context) {
    return false;
  }
  if (context.provider === 'google') {
    await PROVIDERS.google.revoke(context);
  }
  await CalendarConnection.deleteOne({ company: companyId });
  clearSlotCache(companyId);
  return true;
}

// ------------------------------------------------------------- bookings

/** A booking for the dashboard and the API. */
function presentBooking(booking) {
  const timezone = booking.timezone || 'UTC';
  return {
    id: String(booking._id),
    reference: booking.reference,
    provider: booking.provider,
    service: booking.serviceName || null,
    start: booking.start,
    end: booking.end || null,
    timezone,
    label: time.formatLabel(new Date(booking.start), timezone),
    name: booking.name || null,
    email: booking.email || null,
    phone: booking.phone || null,
    notes: booking.notes || null,
    status: booking.status,
    url: booking.url || null,
    sessionId: booking.sessionId || null,
    createdBy: booking.createdBy,
    reminderSentAt: booking.reminderSentAt || null,
    cancelledAt: booking.cancelledAt || null,
    cancelledBy: booking.cancelledBy || null,
    createdAt: booking.createdAt
  };
}

/**
 * Bookings for one company, newest appointment last.
 *
 * @param {object} [filter]
 * @param {string} [filter.sessionId] one conversation's
 * @param {boolean} [filter.upcoming] only those still to happen
 * @param {string} [filter.status]
 * @param {number} [filter.limit]
 */
async function listBookings(companyId, filter = {}) {
  const query = { company: companyId };
  if (filter.sessionId) {
    query.sessionId = String(filter.sessionId);
  }
  if (filter.status && ['booked', 'pending', 'cancelled', 'rescheduled', 'no_show'].includes(filter.status)) {
    query.status = filter.status;
  }
  if (filter.upcoming) {
    query.start = { $gte: new Date(Date.now() - 60 * 60000) };
  }
  const limit = Math.min(Math.max(parseInt(filter.limit, 10) || 50, 1), 200);

  const bookings = await Booking.find(query)
    .sort(filter.upcoming ? { start: 1 } : { start: -1 })
    .limit(limit)
    .lean();
  return bookings.map(presentBooking);
}

async function findOwnBooking(companyId, bookingId) {
  if (!mongoose.Types.ObjectId.isValid(String(bookingId))) {
    return null;
  }
  return Booking.findOne({ _id: bookingId, company: companyId });
}

/** An operator cancels from the dashboard. */
async function cancelBooking(companyId, bookingId, options = {}) {
  const booking = await findOwnBooking(companyId, bookingId);
  if (!booking) {
    throw new BookingError('Booking not found', 404);
  }
  if (!['booked', 'pending'].includes(booking.status)) {
    throw new BookingError(`That booking is already ${booking.status.replace('_', ' ')}`, 409);
  }

  const context = await loadContext(companyId, { requireEnabled: false });
  try {
    await cancelRecord(context, booking, { ...options, by: 'operator' });
  } catch (error) {
    if (error instanceof BookingError) {
      throw error;
    }
    const result = await failure(context, error);
    throw new BookingError(result.error, 502);
  }
  return presentBooking(booking);
}

/**
 * Move a booking to a new start. The old record is kept as `rescheduled` and
 * points at the new one, so the history of what the visitor was told stays
 * readable.
 */
async function rescheduleBooking(companyId, bookingId, startValue, options = {}) {
  const booking = await findOwnBooking(companyId, bookingId);
  if (!booking) {
    throw new BookingError('Booking not found', 404);
  }
  if (booking.status !== 'booked' || !booking.providerRef) {
    throw new BookingError('Only a confirmed booking can be moved', 409);
  }
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
    throw new BookingError('Choose a new time in the future');
  }

  const context = await loadContext(companyId, { requireEnabled: false });
  if (!context || context.provider !== booking.provider) {
    throw new BookingError('The calendar this was booked in is no longer connected', 409);
  }
  const service = (context.services || []).find(entry => entry.id === booking.serviceId);

  let moved;
  try {
    moved = await PROVIDERS[context.provider].reschedule(context, booking.providerRef, start, {
      serviceId: booking.serviceId,
      service,
      start: booking.start,
      end: booking.end,
      timezone: context.timezone,
      invited: booking.providerData && booking.providerData.invited,
      name: booking.name,
      email: booking.email,
      phone: booking.phone
    });
  } catch (error) {
    if (error instanceof BookingError) {
      throw error;
    }
    const result = await failure(context, error);
    throw new BookingError(result.error, 502);
  }

  const replacement = await Booking.create({
    company: booking.company,
    conversation: booking.conversation,
    sessionId: booking.sessionId,
    contact: booking.contact,
    provider: booking.provider,
    providerRef: moved.providerRef,
    reference: await newReference(companyId),
    serviceId: booking.serviceId,
    serviceName: booking.serviceName,
    start: moved.start || start,
    end: moved.end || new Date(start.getTime() + (new Date(booking.end) - new Date(booking.start) || 1800000)),
    timezone: context.timezone,
    name: booking.name,
    email: booking.email,
    phone: booking.phone,
    notes: booking.notes,
    status: 'booked',
    providerData: moved.providerData || booking.providerData,
    createdBy: 'operator',
    createdByUser: options.userId || undefined,
    rescheduledFrom: booking._id
  });

  booking.status = 'rescheduled';
  booking.rescheduledTo = replacement._id;
  await booking.save();

  clearSlotCache(companyId);
  announceCreated(replacement, options);
  return presentBooking(replacement);
}

/**
 * Forget the visitor's details, for GDPR erasure.
 *
 * Called by the erasure route with what it has already resolved about the
 * person. The bookings themselves go: an appointment record with the name
 * and email removed would still say who came when.
 *
 * @returns {Promise<number>} how many were removed
 */
async function erase({ companyId, sessionIds = [], contactIds = [], email } = {}) {
  const or = [];
  if (sessionIds.length) {
    or.push({ sessionId: { $in: sessionIds.map(String) } });
  }
  if (contactIds.length) {
    or.push({ contact: { $in: contactIds } });
  }
  if (email) {
    or.push({ email: String(email).toLowerCase() });
  }
  if (or.length === 0) {
    return 0;
  }
  const query = { $or: or };
  if (companyId) {
    query.company = companyId;
  }
  const result = await Booking.deleteMany(query);
  return result.deletedCount || 0;
}

module.exports = {
  dispatch,
  handles,
  capabilitiesFor,
  findSlots,
  bookSlot,
  cancelByReference,
  getConnection,
  connectWithKey,
  connectGoogle,
  updateSettings,
  refreshServices,
  testSlots,
  disconnect,
  listBookings,
  cancelBooking,
  rescheduleBooking,
  erase,
  sendDueReminders: (...args) => require('./reminders').sendDueReminders(...args),
  // Internals the tests and the routes reach for.
  loadContext,
  buildContext,
  sealCredentials,
  openCredentials,
  normaliseSettings,
  timezoneFor,
  toCapabilityBooking,
  presentBooking,
  clearSlotCache,
  BookingError,
  PROVIDERS,
  CAPABILITY_IDS,
  DEFAULT_HOURS,
  MAX_UPCOMING_PER_CONVERSATION
};
