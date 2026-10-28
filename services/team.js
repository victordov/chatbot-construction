/**
 * The people on a team: inviting them, and making sure that removing one
 * actually removes them.
 *
 * Deactivating an account used to flip `isActive` and stop there. The person's
 * eight-hour token kept working until it expired, their socket stayed
 * connected and kept receiving the queue, and the conversations they held sat
 * assigned to somebody who could no longer answer them. Everything here exists
 * so that "deactivate" means what an admin thinks it means.
 */

const crypto = require('crypto');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const accountEmail = require('./account-email');
const { logger } = require('./logging');

/** How long an invitation link works. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Roles an invitation can carry. Superadmins are never invited into a tenant. */
const INVITABLE_ROLES = ['operator', 'company_admin'];

class TeamError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * A password nobody knows, for an account that must not be signed into until
 * its owner chooses one. Longer than any minimum, and never shown to anyone.
 */
function unusablePassword() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A username nobody has, made from an email address.
 *
 * People sign in with their address now, so the username is mostly a handle
 * for logs and mentions; it only has to be unique and readable.
 */
async function usernameFromEmail(email) {
  const local = String(email || '').split('@')[0].toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 30) || 'user';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? local : `${local}-${crypto.randomInt(1000, 9999)}`;
    if (!(await User.exists({ username: candidate }))) {
      return candidate;
    }
  }

  return `${local}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Invite somebody to a company.
 *
 * The account exists from this moment - so it holds a seat and appears on the
 * team - but its password is random and `invitePending` refuses every
 * sign-in until the link is opened.
 *
 * @param {object} options
 * @param {string} options.email
 * @param {string} [options.name]
 * @param {'operator'|'company_admin'} [options.role]
 * @param {object} options.company a company document (for its id and name)
 * @param {object} [options.invitedBy] the inviting user, `{ id, displayName, username }`
 * @returns {Promise<{user: object, sent: boolean, link?: string}>} `link` only
 *   when the email could not be sent, so the admin can pass it on by hand
 * @throws {TeamError}
 */
async function invite({ email, name, role = 'operator', company, invitedBy }) {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!EMAIL_PATTERN.test(address)) {
    throw new TeamError('Enter a valid email address');
  }
  if (!INVITABLE_ROLES.includes(role)) {
    throw new TeamError('An invitation is for an operator or an admin');
  }
  if (!company) {
    throw new TeamError('Choose the company to invite them to');
  }

  if (await User.exists({ email: address })) {
    throw new TeamError('Someone with that address already has an account', 409, 'EMAIL_TAKEN');
  }

  const token = newToken();
  const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined;

  const user = new User({
    username: await usernameFromEmail(address),
    email: address,
    displayName,
    password: unusablePassword(),
    role,
    company: company._id,
    isActive: true,
    invitePending: true,
    inviteTokenHash: hashToken(token),
    inviteExpires: new Date(Date.now() + INVITE_TTL_MS),
    invitedBy: invitedBy && invitedBy.id ? invitedBy.id : undefined,
    createdBy: invitedBy && invitedBy.id ? invitedBy.id : undefined
  });

  await user.save();

  const delivery = await accountEmail.sendInvite(user, token, {
    companyName: company.name,
    inviterName: invitedBy && (invitedBy.displayName || invitedBy.username)
  });

  return {
    user,
    sent: delivery.sent,
    link: delivery.sent ? undefined : accountEmail.inviteLink(token)
  };
}

/**
 * Send a fresh invitation. The old link stops working: two live links for one
 * account is one more than anybody needs.
 */
async function resendInvite(user, { companyName, inviterName } = {}) {
  if (!user.invitePending) {
    throw new TeamError('This person has already accepted their invitation', 409);
  }

  const token = newToken();
  user.inviteTokenHash = hashToken(token);
  user.inviteExpires = new Date(Date.now() + INVITE_TTL_MS);
  await user.save();

  const delivery = await accountEmail.sendInvite(user, token, { companyName, inviterName });
  return { sent: delivery.sent, link: delivery.sent ? undefined : accountEmail.inviteLink(token) };
}

/**
 * The pending account an invitation token belongs to, or null when the token
 * is unknown, already used or out of date.
 */
async function findInvite(token) {
  if (typeof token !== 'string' || !token) {
    return null;
  }

  return User.findOne({
    inviteTokenHash: hashToken(token),
    invitePending: true,
    inviteExpires: { $gt: new Date() },
    isActive: true
  }).select('+inviteTokenHash').populate('company', 'name isActive');
}

/**
 * Close every door a person has open: their tokens and their sockets.
 *
 * Bumping `tokenVersion` kills every JWT they hold at the next request, and
 * disconnecting the sockets stops the queue arriving in a tab that was left
 * open. `disconnectUser` belongs to the socket layer; when it is not there
 * (tests, scripts, an older build) the tokens alone still do the job on the
 * socket's next reconnect.
 */
async function endSessions(userId, reason = 'account_disabled') {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  return disconnect(userId, reason);
}

/**
 * Disconnect every socket of one user, if the socket layer can.
 *
 * The reason travels to the open dashboard (as `session-expired`), so the
 * sign-in page it lands on can say why: `account_disabled`,
 * `company_inactive`, `signed_out` or `password_changed`.
 */
function disconnect(userId, reason = 'signed_out') {
  try {
    const socketManager = require('../socketManager');
    if (typeof socketManager.disconnectUser === 'function') {
      socketManager.disconnectUser(userId, reason);
      return true;
    }
  } catch (error) {
    logger.warn('Could not disconnect a user\'s sockets', { error: error.message });
  }
  return false;
}

/**
 * Hand the conversations somebody holds back to the queue.
 *
 * The same release the socket layer uses when an operator drops and does not
 * come back: the conversation is visibly waiting first, then offered to a
 * colleague, and the bot picks it up if nobody does. The visitor and the
 * other operators are told, so nobody waits on a person who has gone.
 *
 * @returns {Promise<number>} how many were released
 */
async function releaseChats(user, { reason = 'deactivated' } = {}) {
  const assignmentService = require('./assignment');
  const socketManager = require('../socketManager');

  const held = await Conversation.find({ operatorId: user._id, status: 'active' });

  for (const conversation of held) {
    try {
      const result = await assignmentService.release(conversation, { exclude: [user._id] });
      const reassignedTo = result.assigned && result.operator
        ? (result.operator.displayName || result.operator.username)
        : null;

      socketManager.emitToSession(conversation.sessionId, 'operator-left', {
        sessionId: conversation.sessionId,
        code: 'operator_left',
        params: {},
        message: reassignedTo
          ? `${reassignedTo} has joined the conversation and will assist you.`
          : 'Your operator is no longer available. Someone will be with you shortly; in the meantime the assistant can help.',
        timestamp: new Date()
      });

      socketManager.emitToOperators(conversation.company, 'operator-left', {
        sessionId: conversation.sessionId,
        operatorId: String(user._id),
        operatorName: user.displayName || user.username,
        reason,
        reassignedTo,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Could not release a conversation', {
        sessionId: conversation.sessionId,
        error: error.message
      });
    }
  }

  return held.length;
}

/**
 * Everything deactivation means: no sign-in, no live session, no chats.
 *
 * Call after `isActive: false` has been saved.
 *
 * @returns {Promise<{released: number, disconnected: boolean}>}
 */
async function lockOut(user, options = {}) {
  const disconnected = await endSessions(user._id, 'account_disabled');
  const released = await releaseChats(user, options);
  return { released, disconnected };
}

/**
 * Remove somebody from the team without erasing the history they are part of.
 *
 * Their conversations, notes, tasks and audit entries keep pointing at this
 * row, so it stays - deactivated, with its name, address and login replaced -
 * and stops being anyone. The address is freed so the person can be invited
 * again later.
 */
async function softDelete(user) {
  const id = String(user._id);
  user.isActive = false;
  user.deletedAt = new Date();
  user.displayName = 'Removed user';
  user.name = undefined;
  user.username = `removed-${id}`;
  user.email = `removed-${id}@users.invalid`;
  user.password = unusablePassword();
  user.invitePending = false;
  user.inviteTokenHash = undefined;
  user.inviteExpires = undefined;
  user.acceptingChats = false;
  await user.save();
  return lockOut(user, { reason: 'removed' });
}

module.exports = {
  invite,
  resendInvite,
  findInvite,
  endSessions,
  disconnect,
  releaseChats,
  lockOut,
  softDelete,
  usernameFromEmail,
  unusablePassword,
  hashToken,
  newToken,
  TeamError,
  INVITE_TTL_MS,
  INVITABLE_ROLES,
  EMAIL_PATTERN
};
