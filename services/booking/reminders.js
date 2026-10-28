/**
 * The email a visitor gets about a day before their appointment.
 *
 * Missed appointments are what a clinic or salon loses most money on, and a
 * reminder the day before is the cheapest thing that prevents them. It goes
 * out through the same transport and under the same sender as an operator's
 * follow-up (services/email-channel.js): the tenant's name, the platform's
 * verified address, replies to the tenant's support address. No second mailer
 * with its own settings to get wrong.
 *
 * Once per booking. A run claims each booking atomically before sending, so
 * two scheduler instances, or a run that overlaps the next, cannot both send
 * it; a failed send gives the claim back for the next run, up to three tries.
 *
 * Not for bookings made in the last few hours before the appointment - the
 * visitor has only just arranged it - nor for anyone without an email, nor
 * for a company that has switched reminders off.
 *
 * The scheduler runs `sendDueReminders` (wired by whoever runs
 * services/scheduler.js); it is safe to run as often as every few minutes.
 */

const Booking = require('../../models/booking');
const CalendarConnection = require('../../models/calendar-connection');
const Company = require('../../models/company');
const emailChannel = require('../email-channel');
const time = require('./time');
const { logger } = require('../logging');

const REMIND_BEFORE_MS = 24 * 60 * 60 * 1000;
/** Booked closer to the appointment than this: no reminder, it is fresh in their mind. */
const MIN_LEAD_MS = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function longLabel(booking) {
  const timezone = booking.timezone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(booking.start));
  } catch {
    return time.formatLabel(new Date(booking.start), 'UTC');
  }
}

function compose(booking, company, sender) {
  const companyName = (company && company.name) || 'us';
  const when = longLabel(booking);
  const lines = [
    booking.name ? `Hello ${booking.name},` : 'Hello,',
    `This is a reminder of your appointment with ${companyName}:`,
    [
      booking.serviceName ? `  ${booking.serviceName}` : null,
      `  ${when} (${booking.timezone || 'UTC'})`,
      `  Reference: ${booking.reference}`
    ].filter(Boolean).join('\n'),
    sender.replyTo
      ? 'If you need to change or cancel it, reply to this email.'
      : `If you need to change or cancel it, chat with us and quote your reference ${booking.reference}.`
  ];

  return {
    subject: `Reminder: your appointment with ${companyName} on ${time.formatLabel(new Date(booking.start), booking.timezone || 'UTC')}`.slice(0, 200),
    text: lines.join('\n\n')
  };
}

/**
 * Send the reminders that are due.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.limit] most to send in one run
 * @returns {Promise<{sent: number, failed: number, skipped?: string}>}
 */
async function sendDueReminders({ now = new Date(), limit = 200 } = {}) {
  const transport = emailChannel.buildTransport();
  if (!transport) {
    return { sent: 0, failed: 0, skipped: 'no outbound email configured (EMAIL_HOST)' };
  }

  const switchedOff = await CalendarConnection.find({ reminders: false }).distinct('company');

  const due = await Booking.find({
    status: 'booked',
    reminderSentAt: null,
    reminderAttempts: { $lt: MAX_ATTEMPTS },
    email: { $nin: [null, ''] },
    start: { $gt: now, $lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
    ...(switchedOff.length ? { company: { $nin: switchedOff } } : {}),
    // Made at least twelve hours before it starts.
    $expr: { $lte: ['$createdAt', { $subtract: ['$start', MIN_LEAD_MS] }] }
  })
    .sort({ start: 1 })
    .limit(limit)
    .lean();

  const companies = new Map();
  let sent = 0;
  let failed = 0;

  for (const candidate of due) {
    // Claimed before sending: whoever sets it first sends it.
    const booking = await Booking.findOneAndUpdate(
      { _id: candidate._id, reminderSentAt: null, status: 'booked' },
      { $set: { reminderSentAt: now } },
      { new: true }
    ).lean();
    if (!booking) {
      continue;
    }

    const key = String(booking.company);
    if (!companies.has(key)) {
      companies.set(key, await Company.findById(booking.company).select('name emailChannel').lean());
    }
    const company = companies.get(key);
    const sender = emailChannel.senderFor(company, (company && company.emailChannel) || {});

    if (!sender) {
      // No address to send from: nothing will change on the next run either.
      logger.warn('Booking reminders skipped: no sender address (EMAIL_FROM)');
      await Booking.updateOne({ _id: booking._id }, { $set: { reminderSentAt: null } });
      return { sent, failed, skipped: 'no sender address is configured (EMAIL_FROM)' };
    }

    const message = compose(booking, company, sender);
    try {
      await transport.sendMail({
        from: sender.from,
        to: booking.email,
        replyTo: sender.replyTo,
        subject: message.subject,
        text: message.text
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error('Booking reminder failed to send', { bookingId: String(booking._id), error: error.message });
      await Booking.updateOne(
        { _id: booking._id },
        { $set: { reminderSentAt: null }, $inc: { reminderAttempts: 1 } }
      );
    }
  }

  if (sent || failed) {
    logger.info('Booking reminders run', { sent, failed });
  }
  return { sent, failed };
}

module.exports = { sendDueReminders, compose, REMIND_BEFORE_MS, MIN_LEAD_MS };
