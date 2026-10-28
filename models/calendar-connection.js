const mongoose = require('mongoose');

/**
 * A tenant's diary: the calendar the bot books real appointments in.
 *
 * Before this, "book an appointment" collected a free-text time and raised a
 * task, unless a developer hosted the connector SDK in front of the tenant's
 * booking system. Most clinics and salons already keep their diary in one of
 * three places, so the platform talks to those directly:
 *
 *   calcom     an API key. Cal.com owns availability and the booking.
 *   calendly   a personal access token. Calendly owns availability; a paid
 *              plan books directly, a free one gets a pre-filled link.
 *   google     OAuth. Google only knows what is already in the diary, so the
 *              services, opening hours and buffers are defined here and the
 *              free times are worked out from Google's free/busy.
 *
 * One per company. Credentials are encrypted with services/secrets.js and
 * `select: false`, so a listing never carries them by accident.
 *
 * Tenant-scoped through `company`, so services/tenant-backup.js picks it up
 * without being told.
 */

const ServiceSchema = new mongoose.Schema({
  /** The provider's event type id, or ours for Google. Part of every slot id. */
  id: { type: String, required: true, trim: true, maxlength: 200 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  /** Minutes. */
  duration: { type: Number, min: 5, max: 480, default: 30 },
  /** Minutes kept clear either side (Google only; the others own this). */
  buffer: { type: Number, min: 0, max: 240, default: 0 },
  /** Whether the bot may offer and book it. */
  enabled: { type: Boolean, default: true },
  /** Hidden from the provider's public page; off for the bot by default. */
  hidden: { type: Boolean, default: false },
  /**
   * What the provider needs to book it and nothing else: Calendly's event
   * type URI, scheduling page and location, Cal.com's slug.
   */
  providerData: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const HoursSchema = new mongoose.Schema({
  day: { type: Number, min: 0, max: 6, required: true },
  closed: { type: Boolean, default: false },
  /** Minutes from midnight in the company's timezone. */
  opensAt: { type: Number, min: 0, max: 1440, default: 540 },
  closesAt: { type: Number, min: 0, max: 1440, default: 1020 }
}, { _id: false });

const CalendarConnectionSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true
  },
  provider: {
    type: String,
    enum: ['calcom', 'google', 'calendly'],
    required: true
  },
  /** Off pauses booking without throwing the connection away. */
  enabled: { type: Boolean, default: true },

  /** Encrypted. Which fields are set depends on the provider. */
  credentials: {
    type: new mongoose.Schema({
      apiKey: { type: String },
      accessToken: { type: String },
      refreshToken: { type: String },
      expiresAt: { type: Date },
      scope: { type: String }
    }, { _id: false }),
    select: false
  },

  /** Whose diary it is, for the dashboard: never used to authorise anything. */
  account: {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    timezone: { type: String, trim: true },
    /** Cal.com username, Calendly user URI. */
    handle: { type: String, trim: true }
  },

  services: { type: [ServiceSchema], default: [] },

  // ---- Google only: what the other providers already know for themselves.
  calendarId: { type: String, trim: true, default: 'primary', maxlength: 200 },
  hours: { type: [HoursSchema], default: undefined },
  /** Put the visitor on the event as a guest, so Google emails them an invite. */
  inviteAttendee: { type: Boolean, default: false },

  /** Nothing sooner than this, so nobody books the next ten minutes. */
  minNoticeMinutes: { type: Number, min: 0, max: 10080, default: 120 },
  /** How far ahead the bot looks for free times. */
  horizonDays: { type: Number, min: 1, max: 60, default: 14 },
  /** Email the visitor about a day before. */
  reminders: { type: Boolean, default: true },

  connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  connectedAt: { type: Date, default: Date.now },
  lastCheckedAt: { type: Date },
  /** The last thing the provider refused, in words an admin can act on. */
  lastError: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

module.exports = mongoose.model('CalendarConnection', CalendarConnectionSchema);
