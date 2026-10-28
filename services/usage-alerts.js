/**
 * Telling an owner they are running out, before they have.
 *
 * Hitting a limit used to be the first anybody heard of it: the bot stopped
 * answering, and a customer said so. The billing screen shows the meters, but
 * nobody visits a billing screen to find out whether they should have. So once
 * a meter reaches 80% of its limit, and again at 100%, each admin of the
 * company gets an email and a notification in the dashboard bell.
 *
 * Once per meter, per level, per billing period. Which ones have gone out is
 * kept on the company (`usageAlerts`), and claimed with a conditional update
 * before anything is sent, so two instances checking the same company at the
 * same moment cannot both send it. A new month starts with a clean slate.
 *
 * `checkCompany` and `runAll` are what the scheduler calls; nothing here
 * throws.
 */

const Company = require('../models/company');
const User = require('../models/user');
const Usage = require('../models/usage');
const Notification = require('../models/notification');
const usageService = require('./usage');
const accountEmail = require('./account-email');
const { logger } = require('./logging');

const FULL_AT_PERCENT = 100;

/** The two lines, highest first, so a meter that jumped past both sends one. */
const LEVELS = [
  { percent: FULL_AT_PERCENT, field: 'warned100' },
  { percent: usageService.WARN_AT_PERCENT, field: 'warned80' }
];

/**
 * Make sure the record is for this period, starting it afresh when the month
 * has turned. Conditional, so a reset cannot wipe a claim another instance
 * made a moment ago for the new month.
 */
async function startPeriod(companyId, period) {
  await Company.updateOne(
    { _id: companyId, 'usageAlerts.period': { $ne: period } },
    { $set: { usageAlerts: { period, warned80: [], warned100: [] } } }
  );
}

/**
 * Claim the right to send one warning. True for exactly one caller.
 */
async function claim(companyId, period, field, meter) {
  const result = await Company.updateOne(
    { _id: companyId, 'usageAlerts.period': period, [`usageAlerts.${field}`]: { $ne: meter } },
    {
      $addToSet: field === 'warned100'
        // Reaching 100% also settles 80%: nobody needs that one afterwards.
        ? { 'usageAlerts.warned100': meter, 'usageAlerts.warned80': meter }
        : { 'usageAlerts.warned80': meter }
    }
  );
  return result.modifiedCount === 1;
}

/** "$82.32": the spending cap is the one meter counted in money. */
function money(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

function describe(warning, full, company) {
  // The spending cap is not a limit anything stops at: past it the bot keeps
  // answering and resolutions are no longer billed. The warning says so,
  // because "limit reached" would read as the opposite.
  if (warning.money) {
    return full
      ? {
        subject: `${company.name}: you have reached your resolution spending cap`,
        line: `${company.name}'s resolutions this month have reached the ${money(warning.limit)} cap you set.`,
        advice: 'The bot keeps answering. Resolutions past the cap are not billed this month; raise the cap on Plan & billing if you would rather they were.'
      }
      : {
        subject: `${company.name}: ${warning.percent}% of your resolution spending cap used`,
        line: `${company.name}'s resolutions this month come to ${money(warning.used)} of the ${money(warning.limit)} cap you set (${warning.percent}%).`,
        advice: 'Nothing stops at the cap: past it the bot keeps answering and resolutions are not billed.'
      };
  }

  const scope = warning.resets === 'monthly' ? 'this month' : 'on your plan';
  if (full) {
    return {
      subject: `${company.name}: you have reached your ${warning.label.toLowerCase()} limit`,
      line: `${company.name} has used all ${warning.limit.toLocaleString()} ${warning.label.toLowerCase()} ${scope}.`,
      advice: warning.meter === 'conversationsPerMonth' || warning.meter === 'aiResponsesPerMonth'
        ? 'The bot stops answering new questions until the month resets or the plan is upgraded.'
        : 'Nothing more of this kind can be added until the plan is upgraded or something is removed.'
    };
  }
  return {
    subject: `${company.name}: ${warning.percent}% of your ${warning.label.toLowerCase()} used`,
    line: `${company.name} has used ${warning.used.toLocaleString()} of ${warning.limit.toLocaleString()} ${warning.label.toLowerCase()} ${scope} (${warning.percent}%).`,
    advice: 'Upgrading before the limit keeps the bot answering without a gap.'
  };
}

/**
 * Put a notification in each admin's bell.
 *
 * Through the notification service when it offers `notifyUser` (which also
 * pushes it to an open dashboard); otherwise written directly, which shows on
 * the next refresh.
 */
async function notify(admins, message) {
  let NotificationService = null;
  try {
    NotificationService = require('./notification');
  } catch {
    NotificationService = null;
  }

  for (const admin of admins) {
    try {
      if (NotificationService && typeof NotificationService.notifyUser === 'function') {
        await NotificationService.notifyUser(admin._id, {
          type: 'usage_warning',
          message,
          link: '?section=billing'
        });
      } else {
        await Notification.create({
          type: 'usage_warning',
          userId: admin._id,
          message,
          link: '?section=billing'
        });
      }
    } catch (error) {
      logger.warn('Could not create a usage notification', { userId: String(admin._id), error: error.message });
    }
  }
}

/**
 * Check one company and send whatever warnings are due.
 *
 * @returns {Promise<{sent: Array<{meter: string, level: number}>}>}
 */
async function checkCompany(companyId) {
  const sent = [];

  try {
    const company = await Company.findById(companyId).select('name isActive usageAlerts').lean();
    if (!company || company.isActive === false) {
      return { sent };
    }

    const warnings = await usageService.warnings(companyId);
    if (warnings.length === 0) {
      return { sent };
    }

    const period = Usage.currentPeriod();
    await startPeriod(companyId, period);

    let admins = null;

    for (const warning of warnings) {
      const level = LEVELS.find(candidate => warning.percent >= candidate.percent);
      if (!level || !(await claim(companyId, period, level.field, warning.meter))) {
        continue;
      }

      if (!admins) {
        admins = await User.find({
          company: companyId,
          role: 'company_admin',
          isActive: true,
          invitePending: { $ne: true },
          deletedAt: { $exists: false }
        }).select('email displayName username').lean();
      }

      const full = level.percent >= FULL_AT_PERCENT;
      const text = describe(warning, full, company);
      const link = `${accountEmail.publicBase()}/admin/?section=billing`;

      await notify(admins, `${text.line} ${text.advice}`);

      for (const admin of admins) {
        await accountEmail.send({
          to: admin.email,
          subject: text.subject,
          text: `Hello${admin.displayName ? ` ${admin.displayName}` : ''},\n\n${text.line}\n\n${text.advice}\n\n` +
            `See your usage and plans here:\n${link}\n`,
          kind: 'usage warning',
          link,
          // Sent under the agency's brand when the company is an agency's
          // client (services/account-email.js).
          company: companyId
        });
      }

      sent.push({ meter: warning.meter, level: level.percent });
      logger.info('Sent a usage warning', {
        companyId: String(companyId),
        meter: warning.meter,
        level: level.percent,
        admins: admins.length
      });
    }
  } catch (error) {
    logger.error('Usage alert check failed', { companyId: String(companyId), error: error.message });
  }

  return { sent };
}

/**
 * Check every active company. One company's failure does not stop the rest.
 *
 * @returns {Promise<{companies: number, sent: number}>}
 */
async function runAll() {
  let companies = 0;
  let sent = 0;

  try {
    const cursor = Company.find({ isActive: { $ne: false } }).select('_id').lean().cursor();
    for await (const company of cursor) {
      companies += 1;
      const result = await checkCompany(company._id);
      sent += result.sent.length;
    }
  } catch (error) {
    logger.error('Usage alert sweep failed', { error: error.message });
  }

  if (sent > 0) {
    logger.info('Usage alert sweep complete', { companies, sent });
  }

  return { companies, sent };
}

module.exports = { checkCompany, runAll, LEVELS };
