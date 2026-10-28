/**
 * Time arithmetic for appointments, in the business's own timezone.
 *
 * A clinic open 09:00 to 17:00 in London is open 09:00 to 17:00 London time in
 * January and in July, which is 09:00 UTC for half the year and 08:00 UTC for
 * the other half. Everything here works in wall-clock time in a named IANA
 * zone and converts at the last moment, using Intl rather than hand-written
 * offset tables, so the platform's own timezone data decides when the clocks
 * change. No date library: the conversions needed are few, and each one is
 * tested against the days the clocks go forward and back.
 */

const formatters = new Map();

/** A cached formatter that gives every field of a moment in one zone. */
function partsFormatter(timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    }));
  }
  return formatters.get(timezone);
}

/** Whether Intl knows the zone. A typo would otherwise throw on every slot. */
function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') {
    return false;
  }
  try {
    partsFormatter(timezone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A moment as the wall clock in `timezone` shows it.
 *
 * @returns {{date: string, weekday: number, minutes: number, year: number,
 *            month: number, day: number, hour: number, minute: number, second: number}}
 */
function localParts(at, timezone) {
  const parts = partsFormatter(timezone).formatToParts(at);
  const get = type => (parts.find(part => part.type === type) || {}).value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // Some engines say 24 for midnight even with h23.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));

  return {
    year, month, day, hour, minute, second,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minutes: hour * 60 + minute
  };
}

/** How far `timezone` is ahead of UTC at a moment, in minutes. */
function offsetMinutes(timezone, at) {
  const parts = localParts(at, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const whole = at.getTime() - (((at.getTime() % 1000) + 1000) % 1000);
  return Math.round((asUtc - whole) / 60000);
}

/**
 * The moment a wall-clock time happens in a zone.
 *
 * `minutes` may run past 1440, which rolls into the next day. Returns null for
 * a time that does not exist - 01:30 in London on the morning the clocks go
 * forward - rather than inventing one an hour off. A time that happens twice
 * when the clocks go back resolves to one of the two, which is all a slot
 * needs.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {number} minutes past that midnight
 * @returns {Date|null}
 */
function zonedTime(date, minutes, timezone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, minutes);

  let guess = wall - offsetMinutes(timezone, new Date(wall)) * 60000;
  const corrected = wall - offsetMinutes(timezone, new Date(guess)) * 60000;
  if (corrected !== guess) {
    guess = corrected;
  }

  if (guess + offsetMinutes(timezone, new Date(guess)) * 60000 !== wall) {
    return null;
  }
  return new Date(guess);
}

/** `YYYY-MM-DD` moved by whole days, with no timezone involved. */
function shiftDate(date, days) {
  const moved = new Date(`${date}T12:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** Day of the week (0 = Sunday) of a calendar date, wherever it is. */
function weekdayOf(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * A slot as somebody would say it, in the business's time.
 *
 * Without the zone, "Tue 21 Oct, 09:15" would be the server's idea of 09:15,
 * which on a server in UTC is wrong for every clinic east or west of it.
 */
function formatLabel(at, timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}

/**
 * The free times inside opening hours.
 *
 * Starts are laid on a grid from each day's opening time, every `step`
 * minutes; a start survives if the whole appointment ends by closing time,
 * falls inside [from, to), and neither it nor its buffer either side touches
 * anything already in the diary. The buffer is the gap a practitioner needs
 * between two appointments - cleaning a chair, writing up notes - so it is
 * applied around existing events rather than added to the appointment.
 *
 * @param {object} options
 * @param {Array<{day: number, opensAt: number, closesAt: number, closed?: boolean}>} options.hours
 * @param {string} options.timezone IANA zone the hours are in
 * @param {Date} options.from
 * @param {Date} options.to
 * @param {number} options.duration minutes
 * @param {number} [options.buffer] minutes either side
 * @param {number} [options.step] minutes between possible starts
 * @param {Array<{start: Date|string, end: Date|string}>} [options.busy]
 * @param {string[]} [options.closedDates] `YYYY-MM-DD`, closed all day
 * @param {number} [options.max] stop after this many
 * @returns {Array<{start: Date, end: Date}>}
 */
function openingSlots(options) {
  const {
    hours = [], timezone, from, to, duration,
    buffer = 0, busy = [], closedDates = [], max = 500
  } = options;
  const step = options.step || Math.min(Math.max(duration, 15), 60);

  if (!duration || duration <= 0 || !(from < to)) {
    return [];
  }

  const busyMs = busy
    .map(entry => ({ start: new Date(entry.start).getTime(), end: new Date(entry.end).getTime() }))
    .filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end));
  const closed = new Set(closedDates);
  const bufferMs = (buffer || 0) * 60000;
  const slots = [];

  const lastDate = localParts(to, timezone).date;
  // A day before `from`'s local date as well: nothing is lost by looking,
  // and an evening that is "tomorrow" in UTC is still covered.
  for (let date = shiftDate(localParts(from, timezone).date, -1); date <= lastDate; date = shiftDate(date, 1)) {
    if (closed.has(date)) {
      continue;
    }
    const rule = hours.find(entry => Number(entry.day) === weekdayOf(date));
    if (!rule || rule.closed) {
      continue;
    }
    const opens = Number(rule.opensAt) || 0;
    const closes = Number(rule.closesAt ?? 1440);

    for (let minute = opens; minute + duration <= closes; minute += step) {
      const start = zonedTime(date, minute, timezone);
      if (!start) {
        continue;
      }
      const end = new Date(start.getTime() + duration * 60000);
      if (start < from || start >= to) {
        continue;
      }
      const clash = busyMs.some(entry =>
        start.getTime() - bufferMs < entry.end && end.getTime() + bufferMs > entry.start);
      if (clash) {
        continue;
      }
      slots.push({ start, end });
      if (slots.length >= max) {
        return slots;
      }
    }
  }

  return slots;
}

/**
 * A slot's id: which service, and when.
 *
 * Self-contained on purpose. The id travels through a button in the widget or
 * through the model's arguments and comes back as the only thing the booking
 * step is given, and nothing has to be remembered between the two. It is not
 * trusted for that: booking re-checks the service is one the bot may book and
 * the time is still free.
 */
function encodeSlotId(serviceId, start) {
  return `${serviceId}@${new Date(start).toISOString()}`;
}

/** @returns {{serviceId: string, start: Date}|null} */
function decodeSlotId(slotId) {
  const text = String(slotId || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const serviceId = text.slice(0, at);
  const start = new Date(text.slice(at + 1));
  if (Number.isNaN(start.getTime())) {
    return null;
  }
  return { serviceId, start };
}

/**
 * The first few slots, spread over more than one day.
 *
 * Six times all on tomorrow morning is a poor offer to somebody who works
 * mornings. When the range covers several days, no day takes more than half
 * the places.
 */
function pickSlots(slots, limit, timezone, { spread = true } = {}) {
  const seen = new Set();
  const sorted = slots
    .filter(slot => {
      if (seen.has(slot.id)) {
        return false;
      }
      seen.add(slot.id);
      return true;
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  const perDay = spread ? Math.max(1, Math.ceil(limit / 2)) : Infinity;
  const counts = new Map();
  const picked = [];

  for (const slot of sorted) {
    if (picked.length >= limit) {
      break;
    }
    const day = localParts(new Date(slot.startsAt), timezone).date;
    if ((counts.get(day) || 0) >= perDay) {
      continue;
    }
    counts.set(day, (counts.get(day) || 0) + 1);
    picked.push(slot);
  }

  // Fewer days than places: fill from what was skipped rather than offer less.
  if (picked.length < limit) {
    const taken = new Set(picked.map(slot => slot.id));
    sorted.filter(slot => !taken.has(slot.id)).slice(0, limit - picked.length)
      .forEach(slot => picked.push(slot));
    picked.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  }

  return picked;
}

module.exports = {
  isValidTimezone,
  localParts,
  offsetMinutes,
  zonedTime,
  shiftDate,
  weekdayOf,
  formatLabel,
  openingSlots,
  encodeSlotId,
  decodeSlotId,
  pickSlots
};
