/**
 * Mail the platform sends to the people who use it: confirming an address,
 * inviting a teammate, warning an owner they are near a limit.
 *
 * Separate from the email channel (services/email-channel.js), which is a
 * tenant talking to their customers through their own mail server. This is us
 * talking to the tenant, through ours (SMTP_*), exactly as the password-reset
 * mail in routes/auth.js does.
 *
 * Nothing here throws. A sign-up or an invitation must not fail because a
 * mail relay is down; the caller gets `{ sent: false, reason }` and decides
 * what to tell the person in front of it.
 *
 * Mail about a company an agency runs goes out under the agency's brand:
 * its name where the product's would be, in the sender's name, and its
 * support address to reply to (services/agency.js decides whose brand
 * applies). The sending address itself stays ours - it is the one the mail
 * server is allowed to send as.
 */

const AlertService = require('./alerting');
const { logger } = require('./logging');

/** The product's name, as shown on the sign-in pages, the dashboard and mail. */
function productName() {
  return (process.env.PRODUCT_NAME || '').trim() || 'Support Desk';
}

/**
 * The brand a company's people see - an agency's, or the product's.
 * Never throws.
 */
async function brandFor(companyId) {
  if (!companyId) {
    return { productName: productName(), logoUrl: null, primaryColor: null, supportEmail: null, custom: false };
  }
  // Lazily: services/agency.js reads this file's productName.
  return require('./agency').effectiveBranding(companyId._id || companyId);
}

/**
 * Where links in mail point. PUBLIC_URL is the address customers reach the
 * dashboard on; without it the best guess is this process's own port.
 */
function publicBase() {
  const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  return base.replace(/\/+$/, '');
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.ALERT_FROM_EMAIL || 'no-reply@chatbot-application.com';
}

/**
 * Send one message.
 *
 * Without SMTP the link is written to the log outside production, so a
 * developer can still finish signing up on their laptop; in production it is
 * not, because a log is read by more people than the mailbox it was meant for.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.text
 * @param {string} message.kind what it is, for the log ("verification", "invite")
 * @param {string} [message.link] the one link that matters, for the dev log
 * @param {string} [message.company] the company it is about, for its brand
 * @param {object} [message.brand] that brand, when the caller already has it
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function send({ to, subject, text, kind, link, company, brand: knownBrand }) {
  const transport = AlertService.createSmtpTransport();

  if (!transport) {
    if (process.env.NODE_ENV !== 'production' && link) {
      logger.warn(`SMTP is not configured, so the ${kind} email was not sent. Open this link instead: ${link}`);
    } else {
      logger.warn(`SMTP is not configured, so the ${kind} email was not sent; set SMTP_HOST to send it`);
    }
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    const brand = knownBrand || (company ? await brandFor(company) : null);
    const message = { from: fromAddress(), to, subject, text };
    if (brand && brand.custom) {
      // Their name on our address: the relay is only allowed to send as us.
      message.from = { name: brand.productName, address: fromAddress() };
      if (brand.supportEmail) {
        message.replyTo = brand.supportEmail;
      }
    }
    await transport.sendMail(message);
    logger.info(`Sent the ${kind} email`);
    return { sent: true };
  } catch (error) {
    logger.error(`Failed to send the ${kind} email`, { error: error.message });
    // A development machine with a placeholder SMTP host is the common case;
    // without the link the account could not be finished at all.
    if (process.env.NODE_ENV !== 'production' && link) {
      logger.warn(`The ${kind} email could not be sent. Open this link instead: ${link}`);
    }
    return { sent: false, reason: 'send_failed' };
  }
}

function verificationLink(token) {
  return `${publicBase()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function inviteLink(token) {
  return `${publicBase()}/admin/invite.html?token=${encodeURIComponent(token)}`;
}

/** "Check this is your address", after sign-up or a change of address. */
async function sendVerification(user, token) {
  const link = verificationLink(token);
  const brand = await brandFor(user.company);
  return send({
    to: user.email,
    subject: `Confirm your email for ${brand.productName}`,
    text: `Hello${user.displayName ? ` ${user.displayName}` : ''},\n\n` +
      `Please confirm this is your address by opening the link below:\n${link}\n\n` +
      'Until you do, your account works but you cannot add the websites the chat widget runs on.\n\n' +
      'If you did not sign up, ignore this email and nothing more will happen.',
    kind: 'verification',
    link,
    company: user.company,
    brand
  });
}

/**
 * An invitation to join a team, with a link to choose a password. Under the
 * agency's brand when the company is an agency's client, so a clinic invited
 * by its agency hears from the name it knows.
 */
async function sendInvite(user, token, { companyName, inviterName } = {}) {
  const link = inviteLink(token);
  const team = companyName ? `the ${companyName} team` : 'a team';
  const brand = await brandFor(user.company);
  return send({
    to: user.email,
    subject: `${inviterName || 'Someone'} invited you to ${team} on ${brand.productName}`,
    text: `Hello${user.displayName ? ` ${user.displayName}` : ''},\n\n` +
      `${inviterName || 'Someone'} has invited you to join ${team} on ${brand.productName}, ` +
      'where you will answer customer conversations.\n\n' +
      `Choose a password and sign in here, within the next seven days:\n${link}\n\n` +
      'If you were not expecting this, you can ignore it.',
    kind: 'invite',
    link,
    company: user.company,
    brand
  });
}

module.exports = {
  send,
  sendVerification,
  sendInvite,
  verificationLink,
  inviteLink,
  productName,
  brandFor,
  publicBase
};
