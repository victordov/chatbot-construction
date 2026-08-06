/**
 * Customer satisfaction.
 *
 * Deflection tells a tenant how many conversations the bot handled without an
 * operator. On its own that is a number you can improve by making the bot
 * harder to escape, which is exactly the wrong incentive. CSAT is the other
 * half: whether the people it handled were actually helped.
 *
 * The rating comes from the visitor, so nothing here trusts the caller. The
 * session id is the only handle they have, a conversation can be rated once,
 * and who gets the credit is decided from the transcript rather than from
 * anything the browser sends.
 */

const Conversation = require('../models/conversation');
const { logger } = require('./logging');

/** Scores at or above this count as satisfied, which is what CSAT % measures. */
const SATISFIED_FROM = 4;

/** A conversation this short was not really a conversation. */
const MIN_VISITOR_MESSAGES = 2;

/**
 * Whether it is worth asking this visitor to rate.
 *
 * Asking after a single "hi" annoys people and produces noise, and asking twice
 * is worse than not asking at all.
 */
function shouldRequestRating(conversation) {
  if (!conversation || conversation.rating?.score || conversation.ratingRequestedAt) {
    return false;
  }

  const visitorMessages = (conversation.messages || [])
    .filter(message => message.sender === 'user').length;

  return visitorMessages >= MIN_VISITOR_MESSAGES;
}

/**
 * Mark that we have asked, so a reconnect does not ask again.
 *
 * Deliberately a targeted update rather than a save on a loaded document: the
 * conversation is usually being ended by another write at the same moment, and
 * a full save would clobber it.
 */
async function markRequested(sessionId) {
  await Conversation.updateOne(
    { sessionId, ratingRequestedAt: { $exists: false } },
    { $set: { ratingRequestedAt: new Date() } }
  );
}

/**
 * Who should the score be attributed to.
 *
 * Read from the transcript, because ending a chat clears the conversation's
 * operator fields — attributing from those would credit every rating to nobody.
 * The last operator to speak is the one the customer is rating; earlier ones
 * handed the conversation on and were, by then, someone else's problem.
 */
function attribute(conversation) {
  const operatorMessages = (conversation.messages || [])
    .filter(message => message.sender === 'operator');

  if (operatorMessages.length === 0) {
    return { handledBy: 'bot' };
  }

  const last = operatorMessages[operatorMessages.length - 1];

  return {
    handledBy: 'operator',
    operatorId: last.operatorId || conversation.operatorId,
    operatorName: last.operatorName || conversation.operatorName
  };
}

/**
 * Record a visitor's rating.
 *
 * @returns {Promise<{ok: boolean, error?: string, rating?: object}>}
 */
async function record(sessionId, score, comment) {
  const numeric = Number(score);

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 5) {
    return { ok: false, error: 'A rating must be a whole number from 1 to 5' };
  }

  const conversation = await Conversation.findOne({ sessionId });

  if (!conversation) {
    return { ok: false, error: 'Conversation not found' };
  }

  if (conversation.rating?.score) {
    // Already scored. The widget records the score the moment it is tapped and
    // only then offers a comment box, so this second call is the normal way a
    // comment arrives — treating it purely as a duplicate silently threw away
    // every comment anyone wrote.
    //
    // The score itself is never revised: allowing that would let anyone still
    // holding the session overwrite a rating at will.
    if (comment && !conversation.rating.comment) {
      conversation.rating.comment = String(comment).trim().slice(0, 1000);
      await conversation.save();

      return { ok: true, rating: conversation.rating, company: conversation.company, commentAdded: true };
    }

    return { ok: true, rating: conversation.rating, company: conversation.company, duplicate: true };
  }

  conversation.rating = {
    score: numeric,
    // The comment is a visitor's free text. Trimmed and capped here; anywhere
    // it is displayed escapes it, so it is stored as written.
    comment: comment ? String(comment).trim().slice(0, 1000) : undefined,
    ratedAt: new Date(),
    ...attribute(conversation)
  };

  if (!conversation.ratingRequestedAt) {
    conversation.ratingRequestedAt = new Date();
  }

  await conversation.save();

  logger.info('Conversation rated', {
    sessionId,
    score: numeric,
    handledBy: conversation.rating.handledBy
  });

  // Not awaited: a customer pressing a rating button must not wait on a
  // tenant's endpoint, and a failed delivery is the webhook system's problem
  // to retry rather than this one's to report.
  require('./webhooks').dispatch(conversation.company, 'conversation.rated', {
    sessionId,
    score: numeric,
    comment: conversation.rating.comment,
    handledBy: conversation.rating.handledBy,
    operatorName: conversation.rating.operatorName,
    ratedAt: conversation.rating.ratedAt
  });

  // The company comes back so the caller can address the right operator room:
  // a rating broadcast to every tenant's operators would be a leak, and one
  // broadcast to no room at all would never arrive.
  return { ok: true, rating: conversation.rating, company: conversation.company };
}

/**
 * CSAT for a company over a period.
 *
 * Reported next to the response rate on purpose: an average of four ratings is
 * not a satisfaction score, and a tenant looking at a bare "4.8" has no way to
 * know that.
 */
async function summary(match, since) {
  const [result] = await Conversation.aggregate([
    { $match: { ...match, startedAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        conversations: { $sum: 1 },
        asked: { $sum: { $cond: [{ $ifNull: ['$ratingRequestedAt', false] }, 1, 0] } },
        rated: { $sum: { $cond: [{ $ifNull: ['$rating.score', false] }, 1, 0] } },
        total: { $sum: { $ifNull: ['$rating.score', 0] } },
        satisfied: {
          $sum: { $cond: [{ $gte: [{ $ifNull: ['$rating.score', 0] }, SATISFIED_FROM] }, 1, 0] }
        },
        scores: { $push: '$rating.score' }
      }
    }
  ]);

  if (!result || result.rated === 0) {
    return {
      rated: 0,
      asked: result ? result.asked : 0,
      average: null,
      csat: null,
      responseRate: null,
      distribution: [0, 0, 0, 0, 0]
    };
  }

  const distribution = [0, 0, 0, 0, 0];
  result.scores.filter(Boolean).forEach(score => {
    distribution[score - 1] += 1;
  });

  return {
    rated: result.rated,
    asked: result.asked,
    average: Number((result.total / result.rated).toFixed(2)),
    // The percentage satisfied, which is what "CSAT" conventionally means -
    // not the mean, which people confuse it with.
    csat: Math.round((result.satisfied / result.rated) * 100),
    // Without this a tenant cannot tell 5.0 from four people apart from 5.0
    // from four hundred.
    responseRate: result.asked > 0 ? Math.round((result.rated / result.asked) * 100) : null,
    distribution
  };
}

/**
 * CSAT split by who handled the conversation.
 *
 * The number a tenant actually wants: whether the conversations the bot kept
 * were ones the customer was happy with, or ones they gave up on.
 */
async function byHandler(match, since) {
  const rows = await Conversation.aggregate([
    {
      $match: {
        ...match,
        startedAt: { $gte: since },
        'rating.score': { $exists: true }
      }
    },
    {
      $group: {
        _id: '$rating.handledBy',
        rated: { $sum: 1 },
        total: { $sum: '$rating.score' },
        satisfied: { $sum: { $cond: [{ $gte: ['$rating.score', SATISFIED_FROM] }, 1, 0] } }
      }
    }
  ]);

  const shape = handler => {
    const row = rows.find(r => r._id === handler);
    if (!row) {
      return { rated: 0, average: null, csat: null };
    }
    return {
      rated: row.rated,
      average: Number((row.total / row.rated).toFixed(2)),
      csat: Math.round((row.satisfied / row.rated) * 100)
    };
  };

  return { bot: shape('bot'), operator: shape('operator') };
}

/**
 * CSAT per operator, for the people-management view.
 *
 * Everyone is listed with their count so a 5.0 from two ratings is visibly not
 * the same as a 4.6 from ninety.
 */
async function byOperator(match, since) {
  const rows = await Conversation.aggregate([
    {
      $match: {
        ...match,
        startedAt: { $gte: since },
        'rating.score': { $exists: true },
        'rating.handledBy': 'operator'
      }
    },
    {
      $group: {
        _id: { $ifNull: ['$rating.operatorName', 'Unknown'] },
        rated: { $sum: 1 },
        total: { $sum: '$rating.score' },
        satisfied: { $sum: { $cond: [{ $gte: ['$rating.score', SATISFIED_FROM] }, 1, 0] } }
      }
    },
    { $sort: { rated: -1 } },
    { $limit: 50 }
  ]);

  return rows.map(row => ({
    operator: row._id,
    rated: row.rated,
    average: Number((row.total / row.rated).toFixed(2)),
    csat: Math.round((row.satisfied / row.rated) * 100)
  }));
}

/**
 * The comments, newest first.
 *
 * The scores tell a tenant something is wrong; only the comments say what.
 */
async function comments(match, since, limit = 25) {
  return Conversation.find({
    ...match,
    startedAt: { $gte: since },
    'rating.comment': { $exists: true, $ne: '' }
  })
    .select('sessionId rating startedAt')
    .sort({ 'rating.ratedAt': -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  record,
  summary,
  byHandler,
  byOperator,
  comments,
  shouldRequestRating,
  markRequested,
  attribute,
  SATISFIED_FROM,
  MIN_VISITOR_MESSAGES
};
