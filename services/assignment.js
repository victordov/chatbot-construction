/**
 * Deciding who answers.
 *
 * Without this a queue is a free-for-all: whoever happens to be watching picks
 * up what they fancy, the same person ends up taking everything, and the
 * visitor nobody fancied waits until they leave.
 *
 * The rule is least-loaded first, oldest-idle as the tie-break.
 *
 * Strict round-robin is the usual first instinct, and it is worse: it hands the
 * next conversation to whoever is next in the list regardless of the four they
 * are already holding, so the load it produces is only even if every
 * conversation takes the same effort, which none of them do. Least-loaded
 * self-corrects — someone stuck on a hard one stops being handed more — and
 * falls back to round-robin exactly when it should, which is when everyone is
 * carrying the same amount.
 *
 * Availability is read from the socket rooms rather than a presence table, for
 * the same reason as everywhere else here: a presence table drifts the moment a
 * process dies, and then the queue assigns work to somebody who went home.
 */

const Conversation = require('../models/conversation');
const Company = require('../models/company');
const User = require('../models/user');
const socketManager = require('../socketManager');
const { logger } = require('./logging');

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * The operators connected for this company right now.
 *
 * @returns {Array<{id: string, username: string, displayName: string}>}
 */
function connectedOperators(companyId) {
  let io;

  try {
    io = socketManager.getIo();
  } catch {
    // Sockets are not initialised in tests and scripts.
    return [];
  }

  const seen = new Map();

  const collect = room => {
    const members = io.sockets.adapter.rooms.get(room);
    if (!members) {
      return;
    }

    members.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      const user = socket && socket.user;

      if (!user || !user.id) {
        return;
      }

      // Someone with two tabs open is one operator, not two.
      seen.set(String(user.id), {
        id: String(user.id),
        username: user.username,
        displayName: user.displayName || user.username
      });
    });
  };

  collect(socketManager.operatorRoom(companyId));

  return [...seen.values()];
}

/**
 * How many active conversations each operator is holding.
 *
 * Counted from the conversations themselves rather than tracked in memory, so
 * a restart does not reset everyone's load to zero and flood whoever
 * reconnects first.
 */
async function currentLoad(companyId) {
  const rows = await Conversation.aggregate([
    {
      $match: {
        company: companyId,
        status: 'active',
        operatorId: { $ne: null }
      }
    },
    { $group: { _id: '$operatorId', count: { $sum: 1 } } }
  ]);

  const load = new Map();
  rows.forEach(row => load.set(String(row._id), row.count));
  return load;
}

/**
 * When each operator last had something handed to them.
 *
 * This is the round-robin part: among people carrying the same load, the one
 * who has been waiting longest goes next.
 */
async function lastAssigned(companyId) {
  const rows = await Conversation.aggregate([
    { $match: { company: companyId, operatorId: { $ne: null }, 'assignment.at': { $ne: null } } },
    { $group: { _id: '$operatorId', at: { $max: '$assignment.at' } } }
  ]);

  const times = new Map();
  rows.forEach(row => times.set(String(row._id), row.at));
  return times;
}

/**
 * Who should take this conversation.
 *
 * @returns {Promise<{id: string, displayName: string}|null>} null when nobody
 *          is available, which is a normal outcome and not an error: the
 *          conversation stays in the queue for someone to pick up.
 */
async function pickOperator(companyId, options = {}) {
  const online = connectedOperators(companyId);

  if (online.length === 0) {
    return null;
  }

  const [company, users, load, idleSince] = await Promise.all([
    Company.findById(companyId).select('routing').lean(),
    // `$ne: false` rather than `=== true`, because a document written before
    // these fields existed has neither, and mongoose defaults apply on write,
    // not on read. Matching on `true` excluded every operator who predated the
    // feature — so switching auto-assignment on for an existing account would
    // silently find nobody, forever, and look like the feature simply did not
    // work.
    User.find({
      _id: { $in: online.map(o => o.id) },
      isActive: { $ne: false },
      acceptingChats: { $ne: false }
    }).select('displayName username maxConcurrentChats role').lean(),
    currentLoad(companyId),
    lastAssigned(companyId)
  ]);

  const companyMax = company?.routing?.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  const exclude = new Set((options.exclude || []).map(String));

  const candidates = users
    .filter(user => !exclude.has(String(user._id)))
    .map(user => {
      const id = String(user._id);
      return {
        id,
        displayName: user.displayName || user.username,
        // A personal cap wins over the company's: a team is not uniform, and
        // someone new should not be handed the same six chats as the person
        // who has been doing this for three years.
        capacity: user.maxConcurrentChats || companyMax,
        load: load.get(id) || 0,
        idleSince: idleSince.get(id) || new Date(0)
      };
    })
    .filter(candidate => candidate.load < candidate.capacity);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) =>
    a.load - b.load ||
    a.idleSince - b.idleSince ||
    // Final tie-break on id, so the order is stable rather than whatever the
    // database happened to return. Without it two conversations arriving in
    // the same millisecond could both go to the same person.
    a.id.localeCompare(b.id));

  return candidates[0];
}

/**
 * Hand a conversation to an operator and tell everyone who needs to know.
 *
 * @returns {Promise<{assigned: boolean, operator?: object, reason?: string}>}
 */
async function assign(conversation, operator, method = 'auto') {
  if (!conversation || !operator) {
    return { assigned: false, reason: 'nothing to assign' };
  }

  if (conversation.operatorId) {
    // Somebody got there first. Two operators claiming one conversation is
    // worse than an unassigned one, so the first claim stands.
    return { assigned: false, reason: 'already assigned' };
  }

  conversation.operatorId = operator.id;
  conversation.operatorName = operator.displayName;
  conversation.hasOperator = true;
  conversation.assignment = { method, at: new Date() };

  await conversation.save();

  socketManager.emitToOperators(conversation.company, 'chat-assigned', {
    sessionId: conversation.sessionId,
    operatorId: operator.id,
    operatorName: operator.displayName,
    method,
    timestamp: new Date()
  });

  // Directly to the person who now owns it, so it surfaces even if they are
  // not looking at the queue.
  socketManager.emitToSession(`user:${operator.id}`, 'chat-assigned-to-you', {
    sessionId: conversation.sessionId,
    timestamp: new Date()
  });

  logger.info('Conversation assigned', {
    sessionId: conversation.sessionId,
    operator: operator.displayName,
    method
  });

  return { assigned: true, operator };
}

/**
 * Find someone and hand it over, if the company has asked for that.
 *
 * Never throws: a routing failure must not take the conversation down with it.
 * The conversation simply stays in the queue, which is where it would have been
 * anyway without this feature.
 */
async function autoAssign(conversation) {
  try {
    if (!conversation || !conversation.company || conversation.operatorId) {
      return { assigned: false, reason: 'not eligible' };
    }

    const company = await Company.findById(conversation.company).select('routing').lean();

    if (!company?.routing?.autoAssign) {
      return { assigned: false, reason: 'auto-assignment is off' };
    }

    const operator = await pickOperator(conversation.company);

    if (!operator) {
      return { assigned: false, reason: 'nobody available' };
    }

    return assign(conversation, operator, 'auto');
  } catch (error) {
    logger.error('Auto-assignment failed', { error: error.message });
    return { assigned: false, reason: error.message };
  }
}

/**
 * The tags already in use by a company, most used first.
 *
 * Offered as suggestions in the tagging UI. This is the whole mechanism that
 * stops "billing", "Billing" and "billin" all existing — a fixed list would be
 * wrong for most businesses, but an empty box with no memory is worse.
 */
async function knownTags(companyId, limit = 50) {
  const rows = await Conversation.aggregate([
    { $match: { company: companyId, tags: { $exists: true, $ne: [] } } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit }
  ]);

  return rows.map(row => ({ tag: row._id, count: row.count }));
}

/**
 * Normalise a list of tags into what gets stored.
 *
 * Lowercased and de-duplicated so casing does not fragment a tag, and capped
 * so a tag list cannot become a paragraph.
 */
function normaliseTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return [...new Set(
    tags
      .map(tag => String(tag).trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(tag => tag.length > 0 && tag.length <= 40)
  )].slice(0, 20);
}

module.exports = {
  pickOperator,
  assign,
  autoAssign,
  connectedOperators,
  currentLoad,
  knownTags,
  normaliseTags,
  DEFAULT_MAX_CONCURRENT
};
