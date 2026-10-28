/**
 * Two sweeps over open conversations, run by the scheduler.
 *
 * Escalation: somebody who asked for a person and has waited longer than the
 * company allows is announced again, to every admin and to everyone taking
 * chats, as a notification that stays in the bell (and reaches a phone where
 * push is on). The queue's waiting timer is easy to miss on a busy afternoon;
 * a visitor who has watched an empty chat for ten minutes is about to leave.
 *
 * Idle close: a chat nobody has written in for a day is ended, so it stops
 * sitting in the queue as "active", reports and the resolution count can treat
 * it as finished, and `conversation.ended` fires for conversations the bot
 * handled alone - before this only an operator ending a chat sent it.
 */

const Company = require('../models/company');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const NotificationService = require('./notification');
const webhookService = require('./webhooks');
const socketManager = require('../socketManager');
const { logger } = require('./logging');

const MINUTE = 60 * 1000;

/** Hours of silence after which a web chat is closed (IDLE_CLOSE_HOURS). */
function idleCloseHours() {
  const hours = parseInt(process.env.IDLE_CLOSE_HOURS, 10);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function visitorName(conversation) {
  const metadata = conversation.metadata || {};
  const read = key => (typeof metadata.get === 'function' ? metadata.get(key) : metadata[key]);
  return read('name') || read('email') || (conversation.followUp && conversation.followUp.email) ||
    `Visitor ${String(conversation.sessionId).slice(0, 6)}`;
}

/**
 * Alert the team about visitors who have waited too long for a person.
 *
 * Each wait is announced once: `handoff.escalatedAt` is claimed atomically
 * before anybody is notified, so two scheduler instances (or a slow run
 * overlapping the next) cannot alert twice.
 *
 * @returns {Promise<number>} how many conversations were escalated
 */
async function escalateLongWaits(now = new Date()) {
  const companies = await Company.find({
    isActive: { $ne: false },
    'routing.escalateAfterMinutes': { $ne: 0 }
  }).select('_id name routing').lean();

  let escalated = 0;

  for (const company of companies) {
    const minutes = company.routing && Number.isFinite(company.routing.escalateAfterMinutes)
      ? company.routing.escalateAfterMinutes
      : 5;
    if (!minutes) {
      continue;
    }
    const before = new Date(now.getTime() - minutes * MINUTE);

    // Waiting means what the inbox's Waiting filter means: nobody holds it,
    // and either it is queued or the visitor asked and no person has
    // answered yet.
    const waiting = await Conversation.find({
      company: company._id,
      status: 'active',
      hasOperator: { $ne: true },
      'handoff.escalatedAt': { $exists: false },
      $or: [
        { awaitingOperatorSince: { $lte: before } },
        { 'handoff.requestedAt': { $lte: before }, operatorEverJoined: { $ne: true } }
      ]
    }).select('sessionId metadata followUp handoff awaitingOperatorSince').limit(50).lean();

    if (!waiting.length) {
      continue;
    }

    const recipients = await User.find({
      company: company._id,
      isActive: true,
      invitePending: { $ne: true },
      $or: [{ role: 'company_admin' }, { role: 'operator', acceptingChats: { $ne: false } }]
    }).select('_id').lean();

    for (const conversation of waiting) {
      const claimed = await Conversation.updateOne(
        { _id: conversation._id, 'handoff.escalatedAt': { $exists: false } },
        { $set: { 'handoff.escalatedAt': now } }
      );
      if (!claimed.modifiedCount) {
        continue;
      }

      const since = conversation.awaitingOperatorSince || (conversation.handoff && conversation.handoff.requestedAt);
      const waited = since ? Math.max(1, Math.round((now - new Date(since)) / MINUTE)) : minutes;
      const message = `${visitorName(conversation)} has waited ${waited} minutes for a person`;

      await Promise.all(recipients.map(user => NotificationService.notifyUser(user._id, {
        type: 'visitor_waiting',
        message,
        sessionId: conversation.sessionId
      })));
      escalated += 1;
    }
  }

  if (escalated) {
    logger.info('Escalated long waits', { escalated });
  }
  return escalated;
}

/**
 * End web chats nobody has written in for IDLE_CLOSE_HOURS (default 24).
 *
 * Only chats nobody holds: an operator with a conversation open has decided
 * it is not finished. Email and messaging-app threads are left alone, because
 * their next message may arrive days later and belongs to the same thread.
 *
 * @returns {Promise<number>} how many conversations were closed
 */
async function closeIdleConversations(now = new Date()) {
  const before = new Date(now.getTime() - idleCloseHours() * 60 * MINUTE);

  const idle = await Conversation.find({
    status: 'active',
    channel: { $in: ['chat', null] },
    hasOperator: { $ne: true },
    lastActivity: { $lt: before }
  }).select('_id company sessionId startedAt tags messages.sender').limit(500).lean();

  let closed = 0;

  for (const conversation of idle) {
    const ended = await Conversation.updateOne(
      { _id: conversation._id, status: 'active', hasOperator: { $ne: true } },
      { $set: { status: 'ended', endedAt: now, awaitingOperatorSince: null } }
    );
    if (!ended.modifiedCount) {
      continue;
    }
    closed += 1;

    if (conversation.company) {
      webhookService.dispatch(conversation.company, 'conversation.ended', {
        sessionId: conversation.sessionId,
        endedBy: 'idle',
        operatorName: null,
        messages: (conversation.messages || []).filter(message => message.sender !== 'system').length,
        startedAt: conversation.startedAt,
        endedAt: now,
        tags: conversation.tags || [],
        outcome: null
      }).catch(error => logger.warn('Could not send conversation.ended for an idle chat', { error: error.message }));
      socketManager.emitToOperators(conversation.company, 'chat-ended', {
        sessionId: conversation.sessionId,
        reason: 'idle'
      });
    }
  }

  if (closed) {
    logger.info('Closed idle conversations', { closed, afterHours: idleCloseHours() });
  }
  return closed;
}

module.exports = { escalateLongWaits, closeIdleConversations, idleCloseHours };
