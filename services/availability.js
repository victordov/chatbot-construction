/**
 * Whether a company is open, and whether anyone is actually at the desk.
 *
 * These are two different questions and the widget needs both:
 *
 *   "are you open?"      — the schedule the company published
 *   "is anyone there?"   — whether an operator is connected right now
 *
 * A company can be inside its hours with nobody logged in, and can have an
 * operator online at midnight. Promising a human when neither holds is how a
 * visitor ends up waiting for a reply that never comes.
 */

const Company = require('../models/company');
const { logger } = require('./logging');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function invalidate(companyId) {
  if (companyId) {
    cache.delete(String(companyId));
  } else {
    cache.clear();
  }
}

/**
 * Minutes past midnight in a given IANA timezone.
 *
 * Uses Intl rather than manual offset arithmetic so daylight saving is handled
 * by the platform: a company on Europe/London is open 09:00 local all year,
 * not 09:00 UTC for half of it.
 */
function minutesNowIn(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());

    const hour = Number(parts.find(part => part.type === 'hour').value);
    const minute = Number(parts.find(part => part.type === 'minute').value);
    return hour * 60 + minute;
  } catch (error) {
    logger.warn(`Unknown timezone "${timezone}", falling back to UTC`, { error: error.message });
    const now = new Date();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * Weekday (0 = Sunday) in a given timezone.
 */
function weekdayIn(timezone) {
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short'
    }).format(new Date());

    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  } catch {
    return new Date().getUTCDay();
  }
}

/**
 * A date as `YYYY-MM-DD` in a given timezone, the form closed dates are kept in.
 */
function localDateIn(timezone, at = new Date()) {
  try {
    // en-CA formats as ISO year-month-day.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** `YYYY-MM-DD` moved by whole days, without any timezone getting involved. */
function shiftDate(date, days) {
  const moved = new Date(`${date}T12:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * Whether a rule runs past midnight: open Friday 22:00, closed Saturday 06:00.
 */
function overnight(rule) {
  return (rule.closesAt ?? 1440) < (rule.opensAt ?? 0);
}

/**
 * Is a moment inside the schedule?
 *
 * Today's rule covers from its opening time to its closing time, or to
 * midnight when it runs overnight; yesterday's overnight rule covers this
 * morning up to its closing time. A closed date closes the whole calendar
 * day, including the morning tail of the night before.
 */
function openAt(days, closed, weekday, minutes, date) {
  if (closed.has(date)) {
    return false;
  }

  const today = days.find(day => day.day === weekday);
  if (today && !today.closed) {
    const opens = today.opensAt ?? 0;
    const closes = today.closesAt ?? 1440;
    if (overnight(today) ? minutes >= opens : minutes >= opens && minutes < closes) {
      return true;
    }
  }

  const yesterday = days.find(day => day.day === (weekday + 6) % 7);
  return Boolean(
    yesterday && !yesterday.closed && overnight(yesterday) &&
    !closed.has(shiftDate(date, -1)) && minutes < (yesterday.closesAt ?? 0)
  );
}

/**
 * Format minutes-past-midnight as HH:MM, for telling a visitor when to return.
 */
function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Is this company inside its published hours right now?
 *
 * @returns {Promise<{open: boolean, enabled: boolean, offlineMessage: string,
 *                    opensAt: string|null, timezone: string}>}
 */
async function isWithinBusinessHours(companyId) {
  if (!companyId) {
    // No tenant means no schedule to be outside of.
    return { open: true, enabled: false, offlineMessage: null, opensAt: null, timezone: 'UTC' };
  }

  const key = String(companyId);
  const hit = cache.get(key);
  let hours;

  if (hit && hit.expires > Date.now()) {
    hours = hit.value;
  } else {
    try {
      const company = await Company.findById(companyId).select('businessHours').lean();
      hours = company?.businessHours || null;
      cache.set(key, { value: hours, expires: Date.now() + CACHE_TTL_MS });
    } catch (error) {
      logger.error('Could not read business hours', { companyId: key, error: error.message });
      // Fail open: treating a company as closed because of a database blip
      // would silently stop conversations.
      return { open: true, enabled: false, offlineMessage: null, opensAt: null, timezone: 'UTC' };
    }
  }

  const closedDates = Array.isArray(hours?.closedDates) ? hours.closedDates : [];
  const hasSchedule = Array.isArray(hours?.days) && hours.days.length > 0;

  if (!hours || !hours.enabled || (!hasSchedule && closedDates.length === 0)) {
    return { open: true, enabled: false, offlineMessage: null, opensAt: null, timezone: hours?.timezone || 'UTC' };
  }

  const timezone = hours.timezone || 'UTC';
  const today = weekdayIn(timezone);
  const nowMinutes = minutesNowIn(timezone);
  const date = localDateIn(timezone);
  const closed = new Set(closedDates.map(entry => entry && entry.date).filter(Boolean));
  // With no weekly schedule but some holidays, every other day is open all day.
  const days = hasSchedule
    ? hours.days
    : [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, opensAt: 0, closesAt: 1440, closed: false }));

  const open = openAt(days, closed, today, nowMinutes, date);
  const holiday = closed.has(date) ? closedDates.find(entry => entry.date === date) : null;

  return {
    open,
    enabled: true,
    timezone,
    offlineMessage: open ? null : (hours.offlineMessage || null),
    // Named, so the admin's "Right now" line can say why it is closed today.
    closedToday: holiday ? (holiday.label || 'Closed today') : null,
    // When they can come back, so the visitor is not left guessing.
    opensAt: open ? null : nextOpening(days, today, nowMinutes, { closed, date })
  };
}

/**
 * A human description of the next opening, e.g. "Monday at 09:00".
 *
 * Closed dates are skipped, so the day after a bank holiday is the answer
 * rather than the holiday itself. Looks a little over two weeks ahead, which
 * covers a long holiday shutdown without walking the calendar for ever.
 */
function nextOpening(days, today, nowMinutes, options = {}) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const closed = options.closed || new Set();
  const date = options.date || null;

  for (let offset = 0; offset < 16; offset += 1) {
    const day = (today + offset) % 7;
    const rule = days.find(entry => entry.day === day);

    if (!rule || rule.closed) {
      continue;
    }

    if (date && closed.has(shiftDate(date, offset))) {
      continue;
    }

    // Later today only counts if we have not passed opening time yet.
    if (offset === 0 && nowMinutes >= (rule.opensAt ?? 0)) {
      continue;
    }

    const when = formatMinutes(rule.opensAt ?? 0);
    if (offset === 0) {
      return `today at ${when}`;
    }
    if (offset === 1) {
      return `tomorrow at ${when}`;
    }
    if (offset >= 7 && date) {
      // A week or more away: the weekday alone would be ambiguous.
      return `${names[day]} ${shiftDate(date, offset)} at ${when}`;
    }
    return `${names[day]} at ${when}`;
  }

  return null;
}

/**
 * The distinct operators connected for this company right now.
 *
 * Read from the socket rooms rather than a presence table, so it cannot drift
 * out of sync with reality when a process dies. Counted by user rather than
 * by socket: one person with the dashboard open in three tabs is one person,
 * and telling a visitor "3 operators online" when there is one is the same
 * broken promise as telling them there are any when there are none.
 *
 * A socket whose user has switched off `acceptingChats` is skipped when that
 * flag has been put on the socket; the database is the authority and is
 * consulted in `status()`.
 *
 * @returns {string[]} user ids
 */
function connectedOperatorIds(companyId) {
  try {
    const socketManager = require('../socketManager');
    const io = socketManager.getIo();
    const room = io.sockets.adapter.rooms.get(socketManager.operatorRoom(companyId));

    if (!room) {
      return [];
    }

    const ids = new Set();
    room.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      const user = socket && socket.user;
      if (!user || !user.id || user.acceptingChats === false) {
        return;
      }
      ids.add(String(user.id));
    });

    return [...ids];
  } catch {
    // Sockets not initialised (tests, scripts).
    return [];
  }
}

/**
 * How many distinct operators are connected for this company right now.
 */
function operatorsOnline(companyId) {
  return connectedOperatorIds(companyId).length;
}

/**
 * Of the connected operators, how many are actually taking chats.
 *
 * `acceptingChats` lives on the user and changes while they are connected, so
 * the socket's copy can be stale; the database is asked.
 */
async function operatorsAccepting(companyId) {
  const ids = connectedOperatorIds(companyId);

  if (ids.length === 0) {
    return 0;
  }

  try {
    const User = require('../models/user');
    return await User.countDocuments({
      _id: { $in: ids },
      isActive: { $ne: false },
      // `$ne: false` so a user written before the field existed still counts;
      // defaults apply on write, not on read.
      acceptingChats: { $ne: false }
    });
  } catch (error) {
    logger.warn('Could not check who is accepting chats; using connection count', { error: error.message });
    return ids.length;
  }
}

/**
 * The combined answer the widget needs.
 */
async function status(companyId) {
  const hours = await isWithinBusinessHours(companyId);
  const online = await operatorsAccepting(companyId);

  return {
    ...hours,
    operatorsOnline: online,
    // Only promise a person when one could actually pick up.
    canReachOperator: hours.open && online > 0
  };
}

module.exports = {
  status,
  isWithinBusinessHours,
  operatorsOnline,
  operatorsAccepting,
  connectedOperatorIds,
  invalidate,
  // Exported for tests and for the settings UI.
  formatMinutes,
  minutesNowIn,
  weekdayIn,
  localDateIn,
  openAt,
  nextOpening
};
