const mongoose = require('mongoose');

/**
 * An appointment the bot (or an operator) put in a tenant's diary.
 *
 * The provider's own record is the real one - this is our note of what we did
 * and why, so the dashboard can list what the bot booked, an operator can see
 * "Booked: Tue 9:15" against a conversation, a reminder goes out once, and a
 * cancellation through us reaches the provider.
 *
 * Statuses:
 *   booked       in the diary
 *   pending      Calendly could not book directly (a free plan, or a
 *                location the visitor has to choose), so the visitor was
 *                given a pre-filled link; it is in the diary only if they
 *                finished there
 *   cancelled    taken out of the diary through us
 *   rescheduled  moved; `rescheduledTo` is the booking it became
 *   no_show      kept for the record; nothing sets it automatically
 *
 * The visitor's name, email and phone are copied here because the booking has
 * to outlive the conversation's retention window; GDPR erasure removes them
 * with everything else held about that person (see services/booking#erase).
 */

const BookingSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /** The conversation it was booked from, when there was one. */
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  sessionId: { type: String, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },

  provider: { type: String, enum: ['calcom', 'google', 'calendly'], required: true },
  /** The provider's id: Cal.com booking uid, Google event id, Calendly event uuid. */
  providerRef: { type: String },
  /** Ours, short enough to read out: what a visitor quotes to cancel. */
  reference: { type: String, required: true },

  serviceId: { type: String },
  serviceName: { type: String, trim: true },
  start: { type: Date, required: true },
  end: { type: Date },
  /** The business's timezone when it was booked, for the times in the reminder. */
  timezone: { type: String },

  name: { type: String, trim: true, maxlength: 200 },
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 40 },
  notes: { type: String, trim: true, maxlength: 1000 },

  status: {
    type: String,
    enum: ['booked', 'pending', 'cancelled', 'rescheduled', 'no_show'],
    default: 'booked'
  },
  /** For a `pending` Calendly booking: where the visitor finishes it. */
  url: { type: String },
  /** Provider links that are not ours to show the visitor unprompted. */
  providerData: { type: mongoose.Schema.Types.Mixed },

  createdBy: { type: String, enum: ['bot', 'operator'], default: 'bot' },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  reminderSentAt: { type: Date, default: null },
  reminderAttempts: { type: Number, default: 0 },

  cancelledAt: { type: Date },
  cancelledBy: { type: String, enum: ['visitor', 'operator'] },
  rescheduledFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  rescheduledTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }
}, { timestamps: true });

// The dashboard's list and the reminder sweep both read by start time.
BookingSchema.index({ company: 1, start: 1 });
BookingSchema.index({ status: 1, reminderSentAt: 1, start: 1 });
// A reference is unique within a tenant; the same six characters may exist
// at two companies without either knowing.
BookingSchema.index({ company: 1, reference: 1 }, { unique: true });

module.exports = mongoose.model('Booking', BookingSchema);
