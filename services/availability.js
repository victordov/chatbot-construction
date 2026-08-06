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

  if (!hours || !hours.enabled || !Array.isArray(hours.days) || hours.days.length === 0) {
    return { open: true, enabled: false, offlineMessage: null, opensAt: null, timezone: hours?.timezone || 'UTC' };
  }

  const timezone = hours.timezone || 'UTC';
  const today = weekdayIn(timezone);
  const nowMinutes = minutesNowIn(timezone);
  const rule = hours.days.find(day => day.day === today);

  const open = Boolean(
    rule &&
    !rule.closed &&
    nowMinutes >= (rule.opensAt ?? 0) &&
    nowMinutes < (rule.closesAt ?? 1440)
  );

  return {
    open,
    enabled: true,
    timezone,
    offlineMessage: open ? null : (hours.offlineMessage || null),
    // When they can come back, so the visitor is not left guessing.
    opensAt: open ? null : nextOpening(hours.days, today, nowMinutes)
  };
}

/**
 * A human description of the next opening, e.g. "Monday at 09:00".
 */
function nextOpening(days, today, nowMinutes) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (let offset = 0; offset < 8; offset += 1) {
    const day = (today + offset) % 7;
    const rule = days.find(entry => entry.day === day);

    if (!rule || rule.closed) {
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
    return `${names[day]} at ${when}`;
  }

  return null;
}

/**
 * Is at least one operator connected for this company right now?
 *
 * Read from the socket rooms rather than a presence table, so it cannot drift
 * out of sync with reality when a process dies.
 */
function operatorsOnline(companyId) {
  try {
    const socketManager = require('../socketManager');
    const io = socketManager.getIo();
    const room = io.sockets.adapter.rooms.get(socketManager.operatorRoom(companyId));
    return room ? room.size : 0;
  } catch {
    // Sockets not initialised (tests, scripts).
    return 0;
  }
}

/**
 * The combined answer the widget needs.
 */
async function status(companyId) {
  const hours = await isWithinBusinessHours(companyId);
  const online = operatorsOnline(companyId);

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
  invalidate,
  // Exported for tests and for the settings UI.
  formatMinutes,
  minutesNowIn,
  weekdayIn
};
