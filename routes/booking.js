/**
 * Booking: connecting a diary, and the appointments the bot put in it.
 *
 * Mounted at /api/booking. Setting up the connection is for admins and needs
 * the plan's `actions` feature, like every other way the bot acts in a
 * tenant's systems. The list of bookings and cancelling one are open to
 * operators too: "please cancel my appointment" arrives in their inbox.
 *
 * Tenant-scoped by the query itself. A superadmin names the company
 * (`companyId` in the query or body), because a diary belongs to a tenant.
 *
 * Credentials go in and never come out: the connection is presented without
 * them (services/booking#presentConnection).
 */

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/user');
const booking = require('../services/booking');
const google = require('../services/booking/providers/google');
const audit = require('../services/audit');
const { auth, admin, operator } = require('../middleware/auth');
const { requireFeature } = require('../middleware/quota');
const { logger } = require('../services/logging');

const router = express.Router();

/** Holds the Google flow's nonce in the browser that started it. */
const NONCE_COOKIE = 'booking_google_nonce';
const NONCE_PATH = '/api/booking/google';

function companyFor(req) {
  if (req.user.role === 'superadmin') {
    return req.query.companyId || (req.body && req.body.companyId) || null;
  }
  return req.user.company ? req.user.company.id : null;
}

function requireCompany(req, res) {
  const companyId = companyFor(req);

  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    res.status(400).json({
      error: req.user.role === 'superadmin'
        ? 'Name a company: a diary belongs to a tenant, not to the platform'
        : 'Your account is not attached to a company'
    });
    return null;
  }

  return String(companyId);
}

function sendError(res, error, fallback) {
  if (error instanceof booking.BookingError) {
    return res.status(error.status || 400).json({
      error: error.message,
      ...(error.errors ? { errors: error.errors } : {})
    });
  }
  logger.error(fallback, { error: error.message });
  return res.status(500).json({
    // The one server-side failure an admin can act on: no key to encrypt with.
    error: String(error.message || '').startsWith('Cannot store a secret') ? error.message : fallback
  });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function sameText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ---------------------------------------------------------- Google OAuth

/**
 * Where Google sends the admin back to.
 *
 * Unauthenticated - it is a browser redirect from Google - so it trusts only
 * the signed state, and only in the browser that started the flow (the nonce
 * cookie set by /google/start). It always ends on the dashboard's Booking
 * screen, saying what happened.
 */
router.get('/google/callback', async (req, res) => {
  const finish = params => {
    res.clearCookie(NONCE_COOKIE, { path: NONCE_PATH });
    res.redirect(`/admin/?${new URLSearchParams({ section: 'booking', ...params }).toString()}`);
  };

  const { code, state, error } = req.query;

  if (error) {
    return finish({ booking_error: error === 'access_denied'
      ? 'Google Calendar was not connected: access was not granted.'
      : 'Google sign-in did not finish. Try again.' });
  }

  const verified = google.verifyState(state);
  if (!verified || !sameText(readCookie(req, NONCE_COOKIE), verified.nonce)) {
    logger.warn('Refused a Google Calendar callback with a bad or foreign state');
    return finish({ booking_error: 'That Google link has expired or was started elsewhere. Start again here.' });
  }
  if (!code) {
    return finish({ booking_error: 'Google did not send an authorisation code. Try again.' });
  }

  try {
    // Whoever started it must still be an admin of that company.
    const user = await User.findById(verified.userId).select('username displayName role company').lean();
    const stillAdmin = user && (user.role === 'superadmin' ||
      (user.role === 'company_admin' && String(user.company) === verified.companyId));
    if (!stillAdmin) {
      return finish({ booking_error: 'Only an admin of this company can connect its calendar.' });
    }

    const tokens = await google.exchangeCode(code);
    const granted = String(tokens.scope || '').split(/\s+/);
    if (!granted.includes(google.SCOPES[0])) {
      return finish({ booking_error: 'Google Calendar needs permission to add events. Connect again and allow it.' });
    }

    await booking.connectGoogle(verified.companyId, tokens, { userId: verified.userId });

    audit.record({
      company: verified.companyId,
      actor: { id: user._id, username: user.username, displayName: user.displayName || user.username, role: user.role },
      action: 'booking.connected',
      target: { type: 'calendar', label: 'Google Calendar' },
      details: { provider: 'google' },
      ip: req.ip
    });

    return finish({ connected: 'google' });
  } catch (callbackError) {
    logger.error('Google Calendar callback failed', { error: callbackError.message });
    return finish({
      booking_error: callbackError instanceof booking.BookingError
        ? callbackError.message
        : 'Could not connect Google Calendar. Try again.'
    });
  }
});

// ---------------------------------------------- bookings (operators too)

/**
 * Bookings made through us. `?sessionId=` for one conversation's (so the
 * inbox can say "Booked: Tue 9:15"), `?upcoming=1` for what is still to come.
 */
router.get('/bookings', auth, operator, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const bookings = await booking.listBookings(companyId, {
      sessionId: req.query.sessionId ? String(req.query.sessionId).slice(0, 200) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      upcoming: ['1', 'true', 'yes'].includes(String(req.query.upcoming || '').toLowerCase()),
      limit: req.query.limit
    });
    res.json({ bookings });
  } catch (error) {
    sendError(res, error, 'Failed to load the bookings');
  }
});

router.post('/bookings/:id/cancel', auth, operator, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const cancelled = await booking.cancelBooking(companyId, req.params.id, { req });
    res.json({ booking: cancelled });
  } catch (error) {
    sendError(res, error, 'Failed to cancel the booking');
  }
});

router.post('/bookings/:id/reschedule', auth, operator, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const moved = await booking.rescheduleBooking(companyId, req.params.id, req.body && req.body.start, {
      req, userId: req.user.id
    });
    res.json({ booking: moved });
  } catch (error) {
    sendError(res, error, 'Failed to move the booking');
  }
});

// ------------------------------------------------- the connection (admins)

const adminOnly = [auth, admin, requireFeature('actions')];

router.get('/connection', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    res.json({
      connection: await booking.getConnection(companyId),
      // Whether this server has a Google OAuth client at all; without one
      // the Google card explains rather than offering a button that fails.
      providers: {
        calcom: { available: true },
        calendly: { available: true },
        google: { available: google.isConfigured(), redirectUri: google.oauthConfig().redirectUri }
      }
    });
  } catch (error) {
    sendError(res, error, 'Failed to load the booking settings');
  }
});

/** Cal.com (API key) or Calendly (personal access token). */
router.post('/connect', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const provider = String((req.body && req.body.provider) || '');
    const connection = await booking.connectWithKey(companyId, provider, req.body && req.body.key, {
      userId: req.user.id
    });

    audit.record({
      req,
      company: companyId,
      action: 'booking.connected',
      target: { type: 'calendar', label: connection.label },
      details: { provider, services: connection.services.length }
    });

    res.status(201).json({ connection });
  } catch (error) {
    sendError(res, error, 'Failed to connect the calendar');
  }
});

/** The URL of Google's consent screen, bound to this browser. */
router.post('/google/start', ...adminOnly, (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    if (!google.isConfigured()) {
      return res.status(503).json({
        error: 'Google Calendar is not set up on this server (GOOGLE_CALENDAR_CLIENT_ID and _SECRET).'
      });
    }

    const nonce = crypto.randomBytes(16).toString('base64url');
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: google.STATE_TTL_MS,
      path: NONCE_PATH
    });
    res.json({ url: google.authUrl(google.signState({ companyId, userId: req.user.id, nonce })) });
  } catch (error) {
    sendError(res, error, 'Failed to start connecting Google Calendar');
  }
});

router.put('/connection', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const connection = await booking.updateSettings(companyId, req.body || {});

    audit.record({
      req,
      company: companyId,
      action: 'booking.settings_changed',
      target: { type: 'calendar', label: connection.label },
      details: {
        enabled: connection.enabled,
        services: connection.services.filter(service => service.enabled).length,
        reminders: connection.reminders
      }
    });

    res.json({ connection });
  } catch (error) {
    sendError(res, error, 'Failed to save the booking settings');
  }
});

router.post('/connection/refresh', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    res.json({ connection: await booking.refreshServices(companyId) });
  } catch (error) {
    sendError(res, error, 'Failed to fetch the event types');
  }
});

/** "Test: show the next 3 slots". A read; nothing is booked. */
router.post('/test', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    res.json(await booking.testSlots(companyId));
  } catch (error) {
    sendError(res, error, 'Failed to read the calendar');
  }
});

router.delete('/connection', ...adminOnly, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const removed = await booking.disconnect(companyId);
    if (removed) {
      audit.record({
        req,
        company: companyId,
        action: 'booking.disconnected',
        target: { type: 'calendar' }
      });
    }
    res.json({ disconnected: removed });
  } catch (error) {
    sendError(res, error, 'Failed to disconnect the calendar');
  }
});

module.exports = router;
