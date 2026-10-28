/**
 * The questions the bot could not answer, grouped so the list is short enough
 * to act on.
 *
 * Every product in this space has a "missed questions" screen, because it is
 * the loop that makes a bot better: see what it got wrong, add the answer, and
 * the same question is answered next time. The raw material was already being
 * written - a bot message knows whether it was an "I don't know", whether the
 * visitor gave it a thumbs down, and the conversation knows why it was handed
 * to a person - but nothing read it back.
 *
 * An occurrence is one visitor question whose bot answer
 *
 *   - said it did not know (`unanswered`, or a fallback line),
 *   - got a thumbs down,
 *   - was followed by a handover: the bot gave up (`bot_unanswered`), the
 *     model failed (`model_error`), or the visitor asked for a person within a
 *     few minutes of reading the answer (`visitor_request`) - which is what a
 *     visitor does when the answer did not help.
 *
 * Answers somebody already corrected ("Teach the bot") are skipped: they have
 * been dealt with.
 *
 * Similar questions are merged on their words: lower-cased, punctuation and
 * filler words removed, plurals and -ing folded, then compared by overlap. It
 * is crude next to embeddings, but it is free, deterministic, needs no model
 * and is right for the case that matters - the same question asked twenty
 * slightly different ways.
 */

const crypto = require('crypto');
const Conversation = require('../models/conversation');
const GapDismissal = require('../models/gap-dismissal');

/** How long after a bot answer a request for a person still counts against it. */
const HANDOFF_WINDOW_MS = 3 * 60 * 1000;

/** Two questions with at least this much word overlap (Dice) are one group. */
const SIMILARITY = 0.6;

/** Conversations read per request, newest first. */
const MAX_CONVERSATIONS = 2000;

/** Examples shown per group. */
const MAX_EXAMPLES = 5;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

/**
 * Words that carry no meaning of their own in a support question. Without
 * them "what are your opening hours" and "when are you open" share the one
 * word that matters.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'anyone', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'hello',
  'help', 'hey', 'hi', 'how', 'i', 'if', 'im', 'in', 'is', 'it', 'its', 'just', 'know', 'let',
  'like', 'me', 'my', 'need', 'no', 'not', 'of', 'ok', 'okay', 'on', 'or', 'our', 'please', 'pls',
  'so', 'some', 'tell', 'thank', 'thanks', 'that', 'the', 'their', 'there', 'they', 'this', 'to',
  'u', 'up', 'us', 'want', 'was', 'we', 'what', 'whats', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'would', 'yes', 'you', 'your', 'yours'
]);

/** "Can I talk to a person?" is a request, not a question the bot missed. */
const ASKS_FOR_PERSON = /\b(human|person|agent|operator|somebody|someone|representative|real people|staff member|talk to|speak to|speak with|talk with)\b/i;

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) {
    return word.slice(0, -3);
  }
  if (word.length > 4 && word.endsWith('ed')) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The words a question is recognised by: sorted, unique, meaningful.
 *
 * @returns {string[]}
 */
function tokens(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  return [...new Set(words.filter(word => !STOP_WORDS.has(word)).map(stem))].sort();
}

/** Dice coefficient of two token lists: 1 is identical, 0 shares nothing. */
function similarity(a, b) {
  if (!a.length || !b.length) {
    return 0;
  }
  const set = new Set(a);
  const shared = b.filter(word => set.has(word)).length;
  return (2 * shared) / (a.length + b.length);
}

/** A stable name for a group, derived from the words it was built around. */
function keyFor(groupTokens) {
  return crypto.createHash('sha1').update(groupTokens.join(' ')).digest('hex').slice(0, 16);
}

function clampDays(days) {
  const value = parseInt(days, 10);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_DAYS;
  }
  return Math.min(value, MAX_DAYS);
}

function idOf(message) {
  if (!message) {
    return null;
  }
  return message._id ? String(message._id) : (message.messageId || null);
}

/**
 * Read the occurrences out of one conversation.
 *
 * @returns {Array<object>} one per visitor question, with the reasons it is here
 */
function occurrencesIn(conversation, since) {
  const messages = (conversation.messages || []).filter(message => message.sender !== 'system');
  const found = new Map();

  const questionBefore = index => {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].sender === 'user') {
        return i;
      }
    }
    return -1;
  };

  const add = (botIndex, questionIndex, reason) => {
    if (questionIndex < 0) {
      return;
    }
    const question = messages[questionIndex];
    const answer = botIndex >= 0 ? messages[botIndex] : null;

    if (answer && answer.correction && answer.correction.kind) {
      return;
    }

    const existing = found.get(questionIndex);
    if (existing) {
      existing.reasons.add(reason);
      return;
    }

    found.set(questionIndex, {
      sessionId: conversation.sessionId,
      // The bot's answer is what gets corrected; when the model failed there
      // may be none, and the question itself is the thing to point at.
      messageId: idOf(answer) || idOf(question),
      question: String(question.content || '').slice(0, 500),
      answer: answer ? String(answer.content || '').slice(0, 1000) : null,
      at: new Date((answer && answer.timestamp) || question.timestamp || conversation.lastActivity),
      reasons: new Set([reason])
    });
  };

  messages.forEach((message, index) => {
    if (message.sender !== 'bot' || !message.timestamp || new Date(message.timestamp) < since) {
      return;
    }
    if (message.unanswered === true || message.path === 'fallback') {
      add(index, questionBefore(index), 'unanswered');
    }
    if (message.feedback && message.feedback.rating === 'down') {
      add(index, questionBefore(index), 'thumbs_down');
    }
  });

  const handoff = conversation.handoff;
  const requestedAt = handoff && handoff.requestedAt ? new Date(handoff.requestedAt) : null;

  if (requestedAt && requestedAt >= since) {
    // The last thing said before the handover, by either side.
    let lastBot = -1;
    let lastUser = -1;
    messages.forEach((message, index) => {
      if (!message.timestamp || new Date(message.timestamp) > requestedAt) {
        return;
      }
      if (message.sender === 'bot') {
        lastBot = index;
      }
      if (message.sender === 'user') {
        lastUser = index;
      }
    });

    if (handoff.reason === 'model_error' && lastUser >= 0) {
      // The model never answered; whatever the bot said after the question
      // (the hand-over line, if any) is the answer on record.
      const after = messages.findIndex((message, index) => index > lastUser && message.sender === 'bot');
      add(after, lastUser, 'failed');
    } else if (handoff.reason === 'bot_unanswered' && lastBot >= 0) {
      add(lastBot, questionBefore(lastBot), 'handoff');
    } else if (handoff.reason === 'visitor_request' && lastBot >= 0) {
      const answer = messages[lastBot];
      const question = questionBefore(lastBot);
      const soon = requestedAt - new Date(answer.timestamp) <= HANDOFF_WINDOW_MS;
      // Only a real answer counts: a greeting or the bot's own hand-over line
      // being followed by a request for a person says nothing about a gap.
      const answered = !answer.path || ['assistant', 'canned', 'workflow'].includes(answer.path);
      if (soon && answered && question >= 0 && !ASKS_FOR_PERSON.test(messages[question].content || '')) {
        add(lastBot, question, 'handoff');
      }
    }
  }

  return [...found.values()];
}

/**
 * Merge occurrences into groups of the same question.
 *
 * Newest first, so each group is named after the latest way it was asked.
 */
function group(occurrences) {
  const groups = [];

  [...occurrences]
    .sort((a, b) => b.at - a.at)
    .forEach(occurrence => {
      const words = tokens(occurrence.question);
      if (!words.length) {
        // "hi?", "ok" - nothing to answer, nothing to group.
        return;
      }

      let best = null;
      let bestScore = 0;
      groups.forEach(candidate => {
        const score = similarity(candidate.tokens, words);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      });

      if (best && bestScore >= SIMILARITY) {
        best.occurrences.push(occurrence);
      } else {
        groups.push({ tokens: words, occurrences: [occurrence] });
      }
    });

  return groups;
}

/** Drop what was dismissed: matching groups, up to when they were dismissed. */
function applyDismissals(groups, dismissals) {
  return groups
    .map(entry => {
      const cutoff = dismissals
        .filter(dismissal => similarity(dismissal.tokens || [], entry.tokens) >= SIMILARITY)
        .reduce((latest, dismissal) => Math.max(latest, new Date(dismissal.at).getTime()), 0);

      return cutoff
        ? { ...entry, occurrences: entry.occurrences.filter(occurrence => occurrence.at.getTime() > cutoff) }
        : entry;
    })
    .filter(entry => entry.occurrences.length > 0);
}

function summarise(entry) {
  const reasons = { unanswered: 0, thumbs_down: 0, handoff: 0, failed: 0 };
  entry.occurrences.forEach(occurrence => {
    occurrence.reasons.forEach(reason => {
      reasons[reason] = (reasons[reason] || 0) + 1;
    });
  });

  const latest = entry.occurrences[0];

  return {
    key: keyFor(entry.tokens),
    question: latest.question,
    count: entry.occurrences.length,
    lastAt: latest.at,
    reasons,
    examples: entry.occurrences.slice(0, MAX_EXAMPLES).map(occurrence => ({
      sessionId: occurrence.sessionId,
      messageId: occurrence.messageId,
      question: occurrence.question,
      answer: occurrence.answer,
      at: occurrence.at
    })),
    tokens: entry.tokens
  };
}

/**
 * Every group over the window, most asked first, dismissals applied.
 *
 * @returns {Promise<Array<object>>} groups with their `tokens` still attached
 */
async function computeGroups(companyId, { days = DEFAULT_DAYS } = {}) {
  const since = new Date(Date.now() - clampDays(days) * 24 * 60 * 60 * 1000);

  const [conversations, dismissals] = await Promise.all([
    Conversation.find({
      company: companyId,
      lastActivity: { $gte: since },
      // An anonymised conversation's words are gone; there is nothing to show.
      anonymizedAt: null,
      $or: [
        { 'messages.unanswered': true },
        { 'messages.feedback.rating': 'down' },
        { 'messages.path': 'fallback' },
        { 'handoff.reason': { $in: ['bot_unanswered', 'model_error', 'visitor_request'] } }
      ]
    })
      .select({
        sessionId: 1,
        handoff: 1,
        lastActivity: 1,
        'messages._id': 1,
        'messages.messageId': 1,
        'messages.sender': 1,
        'messages.content': 1,
        'messages.timestamp': 1,
        'messages.path': 1,
        'messages.unanswered': 1,
        'messages.feedback': 1,
        'messages.correction': 1
      })
      .sort({ lastActivity: -1 })
      .limit(MAX_CONVERSATIONS)
      .lean(),
    GapDismissal.find({ company: companyId, at: { $gte: since } })
      .select('tokens at')
      .sort({ at: -1 })
      .limit(1000)
      .lean()
  ]);

  const occurrences = conversations.flatMap(conversation => occurrencesIn(conversation, since));

  return applyDismissals(group(occurrences), dismissals)
    .map(summarise)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/** A group as the API returns it: the matching words are an internal detail. */
function withoutTokens(entry) {
  const copy = { ...entry };
  delete copy.tokens;
  return copy;
}

/**
 * The unanswered-questions list.
 *
 * @param {string} companyId
 * @param {object} [options]
 * @param {number} [options.days=30]
 * @param {number} [options.limit=50]
 * @returns {Promise<{groups: Array, total: number, occurrences: number, days: number}>}
 *          `total` is the number of groups before `limit`, so a short list can
 *          say how many more there are.
 */
async function list(companyId, { days = DEFAULT_DAYS, limit = 50 } = {}) {
  const groups = await computeGroups(companyId, { days });
  const max = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  return {
    groups: groups.slice(0, max).map(withoutTokens),
    total: groups.length,
    occurrences: groups.reduce((sum, entry) => sum + entry.count, 0),
    days: clampDays(days)
  };
}

/**
 * Hide a group: "not worth answering", or answered by teaching the bot.
 *
 * Looked up over the longest window, so a group seen on a 90-day list can be
 * dismissed even though the default list is 30 days.
 *
 * @param {object} [options]
 * @param {string} [options.question] the question as taught, used when the
 *        key no longer names a group (the list changed in between), so the
 *        same question is still cleared by its own words
 * @returns {Promise<object|null>} the dismissal, or null when no group has
 *          that key (already dismissed, or never existed) and no usable
 *          question was given
 */
async function dismiss(companyId, key, { by = null, reason = 'dismissed', question = null } = {}) {
  const groups = await computeGroups(companyId, { days: MAX_DAYS });
  const match = groups.find(entry => entry.key === key);
  const words = match ? match.tokens : tokens(question);

  if (!words.length) {
    return null;
  }

  return GapDismissal.create({
    company: companyId,
    key,
    tokens: words,
    question: match ? match.question : String(question).slice(0, 500),
    reason,
    by
  });
}

module.exports = {
  list,
  dismiss,
  computeGroups,
  // Exported for tests.
  tokens,
  similarity,
  occurrencesIn,
  group,
  keyFor,
  HANDOFF_WINDOW_MS,
  SIMILARITY,
  MAX_DAYS
};
