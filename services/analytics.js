/**
 * Analytics beyond volume and response time.
 *
 * The metrics here are chosen to answer questions a support manager actually
 * asks, rather than to fill a dashboard:
 *
 *   "Is the bot pulling its weight?"      -> deflection rate
 *   "Are we answering people?"            -> resolution and abandonment
 *   "When do we need cover?"              -> hour/day heatmap
 *   "Who is carrying the load?"           -> operator leaderboard
 *   "What do people keep asking about?"   -> recurring topics
 *
 * Everything is a single aggregation per metric, scoped by company, so this
 * stays usable as a tenant's history grows.
 */

const Conversation = require('../models/conversation');
const Task = require('../models/task');
const { companyMatch } = require('../utils/query');
const csat = require('./csat');
const { logger } = require('./logging');

/**
 * Words too common to be a useful topic. Deliberately small: an aggressive
 * list hides real subject matter.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'have', 'has', 'with',
  'can', 'was', 'are', 'but', 'not', 'get', 'got', 'want', 'need', 'would',
  'could', 'should', 'about', 'from', 'they', 'them', 'there', 'their', 'what',
  'when', 'where', 'which', 'will', 'been', 'were', 'here', 'just', 'like',
  'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'help', 'know', 'how',
  'any', 'all', 'some', 'more', 'out', 'now', 'one', 'also', 'because', 'into',
  'over', 'very', 'much', 'able', 'still', 'then', 'than', 'its', 'it\'s'
]);

/**
 * Conversations where the bot answered and no operator was ever needed.
 *
 * This is the number that justifies the product's existence, so it is measured
 * conservatively: a conversation only counts as deflected if a bot replied AND
 * no operator ever joined AND the visitor sent more than an opening message
 * (so an abandoned "hi" is not counted as a win).
 */
async function deflection(match, since) {
  const [row] = await Conversation.aggregate([
    { $match: { ...match, startedAt: { $gte: since } } },
    {
      $project: {
        hasOperator: 1,
        userMessages: {
          $size: {
            $filter: { input: '$messages', as: 'm', cond: { $eq: ['$$m.sender', 'user'] } }
          }
        },
        botMessages: {
          $size: {
            $filter: { input: '$messages', as: 'm', cond: { $eq: ['$$m.sender', 'bot'] } }
          }
        }
      }
    },
    // Only conversations where the visitor actually engaged are eligible.
    { $match: { userMessages: { $gte: 2 } } },
    {
      $group: {
        _id: null,
        eligible: { $sum: 1 },
        deflected: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$hasOperator', false] }, { $gt: ['$botMessages', 0] }] }, 1, 0]
          }
        },
        escalated: { $sum: { $cond: ['$hasOperator', 1, 0] } }
      }
    }
  ]);

  const eligible = row ? row.eligible : 0;

  return {
    eligible,
    deflected: row ? row.deflected : 0,
    escalated: row ? row.escalated : 0,
    rate: eligible ? Math.round(((row.deflected / eligible) * 100)) : 0
  };
}

/**
 * Conversations the visitor opened and then left without ever being answered.
 *
 * A high number here means people are giving up while waiting, which no
 * volume or response-time average will reveal on its own.
 */
async function abandonment(match, since) {
  const [row] = await Conversation.aggregate([
    { $match: { ...match, startedAt: { $gte: since } } },
    {
      $project: {
        userMessages: {
          $size: { $filter: { input: '$messages', as: 'm', cond: { $eq: ['$$m.sender', 'user'] } } }
        },
        answered: {
          $gt: [
            { $size: { $filter: { input: '$messages', as: 'm', cond: { $ne: ['$$m.sender', 'user'] } } } },
            0
          ]
        }
      }
    },
    { $match: { userMessages: { $gte: 1 } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        unanswered: { $sum: { $cond: ['$answered', 0, 1] } }
      }
    }
  ]);

  const total = row ? row.total : 0;

  return {
    total,
    unanswered: row ? row.unanswered : 0,
    rate: total ? Math.round((row.unanswered / total) * 100) : 0
  };
}

/**
 * Conversation starts by weekday and hour, for staffing decisions.
 *
 * Returned as a flat list rather than a matrix so the client can render it
 * without knowing the shape, and so empty cells cost nothing.
 */
async function peakHours(match, since) {
  const rows = await Conversation.aggregate([
    { $match: { ...match, startedAt: { $gte: since } } },
    {
      $group: {
        // Mongo's $dayOfWeek is 1=Sunday.
        _id: { day: { $dayOfWeek: '$startedAt' }, hour: { $hour: '$startedAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } }
  ]);

  return rows.map(row => ({
    day: row._id.day - 1, // 0=Sunday, which is what JS Date uses
    hour: row._id.hour,
    count: row.count
  }));
}

/**
 * Per-operator workload and responsiveness.
 *
 * Median is reported alongside the mean because one conversation left open
 * overnight drags an average far enough to be misleading.
 */
async function operatorPerformance(match, since) {
  const conversations = await Conversation.aggregate([
    { $match: { ...match, startedAt: { $gte: since }, hasOperator: true } },
    {
      $project: {
        operatorId: 1,
        operatorName: 1,
        messages: {
          $filter: {
            input: '$messages',
            as: 'm',
            cond: { $in: ['$$m.sender', ['user', 'operator']] }
          }
        }
      }
    }
  ]);

  const byOperator = new Map();

  conversations.forEach(conversation => {
    const key = conversation.operatorName || String(conversation.operatorId || 'Unassigned');

    if (!byOperator.has(key)) {
      byOperator.set(key, { operator: key, conversations: 0, replies: 0, responseTimes: [] });
    }

    const stats = byOperator.get(key);
    stats.conversations += 1;

    const ordered = (conversation.messages || [])
      .slice()
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let awaiting = null;
    ordered.forEach(message => {
      if (message.sender === 'user') {
        // Keep the first unanswered message, so a burst of visitor messages
        // measures time-to-first-reply.
        if (!awaiting) {
          awaiting = new Date(message.timestamp);
        }
      } else if (awaiting) {
        stats.replies += 1;
        stats.responseTimes.push((new Date(message.timestamp) - awaiting) / 1000);
        awaiting = null;
      }
    });
  });

  return [...byOperator.values()]
    .map(stats => {
      const sorted = stats.responseTimes.slice().sort((a, b) => a - b);
      const mean = sorted.length
        ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
        : 0;
      const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0;

      return {
        operator: stats.operator,
        conversations: stats.conversations,
        replies: stats.replies,
        avgResponseSeconds: mean,
        medianResponseSeconds: median
      };
    })
    .sort((a, b) => b.conversations - a.conversations);
}

/**
 * Words that recur across visitor messages.
 *
 * A deliberately simple frequency count rather than clustering or an LLM: it
 * is cheap, explainable, and good enough to answer "what are people asking
 * about this week". The old dashboard hardcoded four categories that nothing
 * ever populated.
 */
async function topics(match, since, limit = 12) {
  const conversations = await Conversation.find(
    { ...match, startedAt: { $gte: since } },
    { 'messages.content': 1, 'messages.sender': 1 }
  ).limit(2000).lean();

  const counts = new Map();

  conversations.forEach(conversation => {
    // Count a term once per conversation, so one chatty visitor repeating a
    // word does not become the top topic.
    const seen = new Set();

    (conversation.messages || [])
      .filter(message => message.sender === 'user')
      .forEach(message => {
        String(message.content || '')
          .toLowerCase()
          .split(/[^a-z0-9']+/)
          .filter(word => word.length > 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
          .forEach(word => seen.add(word));
      });

    seen.forEach(word => counts.set(word, (counts.get(word) || 0) + 1));
  });

  return [...counts.entries()]
    .map(([term, conversationCount]) => ({ term, conversations: conversationCount }))
    .sort((a, b) => b.conversations - a.conversations)
    .slice(0, limit);
}

/**
 * Task throughput, which is where a conversation turns into follow-up work.
 */
async function taskMetrics(match, since) {
  const [row] = await Task.aggregate([
    { $match: { ...match, createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        created: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        overdue: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$status', 'completed'] }, { $lt: ['$dueDate', new Date()] }] },
              1, 0
            ]
          }
        },
        avgCompletionMs: {
          $avg: {
            $cond: [
              { $and: [{ $eq: ['$status', 'completed'] }, { $ne: ['$completedAt', null] }] },
              { $subtract: ['$completedAt', '$createdAt'] },
              null
            ]
          }
        }
      }
    }
  ]);

  return {
    created: row ? row.created : 0,
    completed: row ? row.completed : 0,
    overdue: row ? row.overdue : 0,
    completionRate: row && row.created ? Math.round((row.completed / row.created) * 100) : 0,
    avgCompletionHours: row && row.avgCompletionMs
      ? Math.round(row.avgCompletionMs / 3600000)
      : 0
  };
}

/**
 * Everything above, for one company and one window.
 *
 * @param {object} user  req.user, used for tenant scoping
 * @param {number} days  window size
 */
async function advanced(user, days = 30) {
  const match = companyMatch(user);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Run independently: one slow or failing metric should not deny the caller
  // all the others.
  const [
    deflectionResult, abandonmentResult, peakResult,
    operatorResult, topicResult, taskResult,
    csatResult, csatHandlerResult, csatOperatorResult, csatCommentResult
  ] = await Promise.all([
    deflection(match, since).catch(fail('deflection', { eligible: 0, deflected: 0, escalated: 0, rate: 0 })),
    abandonment(match, since).catch(fail('abandonment', { total: 0, unanswered: 0, rate: 0 })),
    peakHours(match, since).catch(fail('peakHours', [])),
    operatorPerformance(match, since).catch(fail('operatorPerformance', [])),
    topics(match, since).catch(fail('topics', [])),
    taskMetrics(match, since).catch(fail('taskMetrics', {
      created: 0, completed: 0, overdue: 0, completionRate: 0, avgCompletionHours: 0
    })),
    csat.summary(match, since).catch(fail('csat', {
      rated: 0, asked: 0, average: null, csat: null, responseRate: null, distribution: [0, 0, 0, 0, 0]
    })),
    csat.byHandler(match, since).catch(fail('csatByHandler', {
      bot: { rated: 0, average: null, csat: null },
      operator: { rated: 0, average: null, csat: null }
    })),
    csat.byOperator(match, since).catch(fail('csatByOperator', [])),
    csat.comments(match, since).catch(fail('csatComments', []))
  ]);

  return {
    windowDays: days,
    deflection: deflectionResult,
    abandonment: abandonmentResult,
    peakHours: peakResult,
    operators: operatorResult,
    topics: topicResult,
    tasks: taskResult,
    // Deflection and satisfaction are returned together deliberately. A high
    // deflection rate is only good news if the deflected customers were happy,
    // and reading one without the other is how a tenant ends up optimising for
    // a bot that is merely hard to escape.
    satisfaction: {
      ...csatResult,
      byHandler: csatHandlerResult,
      byOperator: csatOperatorResult,
      comments: csatCommentResult
    }
  };
}

function fail(name, fallback) {
  return error => {
    logger.error(`Analytics metric "${name}" failed`, { error: error.message });
    return fallback;
  };
}

module.exports = {
  advanced,
  deflection,
  abandonment,
  peakHours,
  operatorPerformance,
  topics,
  taskMetrics,
  satisfaction: csat.summary
};
