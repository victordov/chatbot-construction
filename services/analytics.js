/**
 * Analytics beyond volume and response time.
 *
 * The metrics here are chosen to answer questions a support manager actually
 * asks, rather than to fill a dashboard:
 *
 *   "Is the bot pulling its weight?"      -> deflection rate, the value report
 *   "Are we answering people?"            -> resolution and abandonment
 *   "When do we need cover?"              -> hour/day heatmap
 *   "Who is carrying the load?"           -> operator leaderboard
 *   "What do people keep asking about?"   -> recurring topics
 *
 * Everything is a single aggregation per metric, scoped by company, so this
 * stays usable as a tenant's history grows.
 *
 * Two rules hold for every number below, because a report that is wrong in a
 * flattering direction is worse than none:
 *
 *   - empty conversations do not count. A widget that was opened and closed
 *     again used to create a conversation, and those rows - no visitor
 *     message, no contact details - padded every total and diluted every rate
 *   - "a person took part" is read from what is kept after the chat ends
 *     (`operatorEverJoined`, or an operator message on legacy rows), never
 *     from `hasOperator`, which is cleared when a chat ends and so made every
 *     finished human conversation look like a bot win
 */

const Conversation = require('../models/conversation');
const Task = require('../models/task');
const { companyMatch } = require('../utils/query');
const csat = require('./csat');
const { logger } = require('./logging');

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a person answering one of these would have spent, unless the company says otherwise. */
const DEFAULT_MINUTES_PER_CONVERSATION = 6;

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
 * A conversation somebody actually started: a visitor wrote something, or
 * left contact details. The legacy rows this excludes were created by opening
 * the widget, and say nothing about anybody's service.
 */
const ENGAGED = {
  $or: [
    { 'messages.sender': 'user' },
    { contact: { $exists: true, $ne: null } },
    { 'metadata.name': { $exists: true, $nin: ['', null] } },
    { 'metadata.email': { $exists: true, $nin: ['', null] } },
    { 'metadata.phone': { $exists: true, $nin: ['', null] } },
    { 'metadata.visitorName': { $exists: true, $nin: ['', null] } },
    { 'metadata.visitorEmail': { $exists: true, $nin: ['', null] } },
    { 'followUp.email': { $exists: true, $nin: ['', null] } }
  ]
};

/**
 * Add the "not empty" condition to a match. Under `$and`, so it cannot collide
 * with an `$or` the caller already has.
 */
function engaged(match = {}) {
  return { ...match, $and: [...(match.$and || []), ENGAGED] };
}

/** Messages of one sender, as an aggregation expression. */
function messagesFrom(sender) {
  return {
    $filter: { input: { $ifNull: ['$messages', []] }, as: 'm', cond: { $eq: ['$$m.sender', sender] } }
  };
}

function countFrom(sender) {
  return { $size: messagesFrom(sender) };
}

/**
 * Whether a person ever took part. `operatorEverJoined` on new rows; on rows
 * from before it existed, an operator message, or `hasOperator` for a chat a
 * person is in right now.
 */
const PERSON_JOINED = {
  $or: [
    { $eq: ['$operatorEverJoined', true] },
    { $eq: ['$hasOperator', true] },
    { $gt: [countFrom('operator'), 0] }
  ]
};

/** Whether anybody - the visitor, the bot, a workflow - asked for a person. */
const HANDOFF_REQUESTED = {
  $ne: [{ $ifNull: ['$handoff.requestedAt', null] }, null]
};

/** When the first person first replied: the stored time, or the transcript's. */
const FIRST_PERSON_REPLY = {
  $ifNull: [
    '$firstOperatorReplyAt',
    { $min: { $map: { input: messagesFrom('operator'), as: 'm', in: '$$m.timestamp' } } }
  ]
};

/**
 * Conversations where the bot answered and no operator was ever needed.
 *
 * This is the number that justifies the product's existence, so it is measured
 * conservatively: a conversation only counts as deflected if a bot replied AND
 * no person ever joined AND nobody asked for one AND the visitor sent more
 * than an opening message (so an abandoned "hi" is not counted as a win).
 */
async function deflection(match, since) {
  const [row] = await Conversation.aggregate([
    { $match: { ...engaged(match), startedAt: { $gte: since } } },
    {
      $project: {
        joined: PERSON_JOINED,
        handoff: HANDOFF_REQUESTED,
        userMessages: countFrom('user'),
        botMessages: countFrom('bot')
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
            $cond: [
              { $and: [{ $not: ['$joined'] }, { $not: ['$handoff'] }, { $gt: ['$botMessages', 0] }] },
              1, 0
            ]
          }
        },
        escalated: { $sum: { $cond: ['$joined', 1, 0] } },
        // Asked for a person and never got one: the number nobody wants to
        // find hidden inside "deflected".
        unmetHandoffs: { $sum: { $cond: [{ $and: ['$handoff', { $not: ['$joined'] }] }, 1, 0] } }
      }
    }
  ]);

  const eligible = row ? row.eligible : 0;

  return {
    eligible,
    deflected: row ? row.deflected : 0,
    escalated: row ? row.escalated : 0,
    unmetHandoffs: row ? row.unmetHandoffs : 0,
    rate: eligible ? Math.round(((row.deflected / eligible) * 100)) : 0
  };
}

/**
 * Conversations the visitor opened and then left without ever being answered.
 *
 * A high number here means people are giving up while waiting, which no
 * volume or response-time average will reveal on its own. A system line in
 * the transcript is not an answer.
 */
async function abandonment(match, since) {
  const [row] = await Conversation.aggregate([
    { $match: { ...engaged(match), startedAt: { $gte: since } } },
    {
      $project: {
        userMessages: countFrom('user'),
        answered: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ['$messages', []] },
                  as: 'm',
                  cond: { $in: ['$$m.sender', ['bot', 'operator']] }
                }
              }
            },
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
 * In the company's own timezone: a heatmap in UTC tells a team in Sydney that
 * their busiest hour is midnight. Returned as a flat list rather than a matrix
 * so the client can render it without knowing the shape, and so empty cells
 * cost nothing.
 */
async function peakHours(match, since, timezone = 'UTC') {
  const tz = validTimezone(timezone);
  const rows = await Conversation.aggregate([
    { $match: { ...engaged(match), startedAt: { $gte: since } } },
    {
      $group: {
        // Mongo's $dayOfWeek is 1=Sunday.
        _id: {
          day: { $dayOfWeek: { date: '$startedAt', timezone: tz } },
          hour: { $hour: { date: '$startedAt', timezone: tz } }
        },
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
 * Includes conversations that have ended: who answered is read from the
 * operator messages themselves, because ending a chat clears its operator
 * fields and the old filter on `hasOperator` left out every finished one.
 * Median is reported alongside the mean because one conversation left open
 * overnight drags an average far enough to be misleading.
 */
async function operatorPerformance(match, since) {
  const conversations = await Conversation.aggregate([
    {
      $match: {
        ...engaged(match),
        startedAt: { $gte: since },
        $or: [{ operatorEverJoined: true }, { hasOperator: true }, { 'messages.sender': 'operator' }]
      }
    },
    {
      $project: {
        operatorId: 1,
        operatorName: 1,
        messages: {
          $filter: {
            input: { $ifNull: ['$messages', []] },
            as: 'm',
            cond: { $in: ['$$m.sender', ['user', 'operator']] }
          }
        }
      }
    }
  ]);

  const byOperator = new Map();
  const statsFor = key => {
    if (!byOperator.has(key)) {
      byOperator.set(key, { operator: key, conversations: 0, replies: 0, responseTimes: [] });
    }
    return byOperator.get(key);
  };

  const keyOf = (message, conversation) => message.operatorName
    || conversation.operatorName
    || (message.operatorId ? String(message.operatorId) : null)
    || (conversation.operatorId ? String(conversation.operatorId) : 'Unknown');

  conversations.forEach(conversation => {
    const ordered = (conversation.messages || [])
      .slice()
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const involved = new Set(ordered.filter(message => message.sender === 'operator')
      .map(message => keyOf(message, conversation)));

    // Joined and never said anything: still their conversation.
    if (involved.size === 0) {
      involved.add(conversation.operatorName || (conversation.operatorId ? String(conversation.operatorId) : 'Unknown'));
    }

    involved.forEach(key => {
      statsFor(key).conversations += 1;
    });

    let awaiting = null;
    ordered.forEach(message => {
      if (message.sender === 'user') {
        // Keep the first unanswered message, so a burst of visitor messages
        // measures time-to-first-reply.
        if (!awaiting) {
          awaiting = new Date(message.timestamp);
        }
      } else if (awaiting) {
        const stats = statsFor(keyOf(message, conversation));
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
 * about this week". Words are letters in any script - a tenant whose
 * customers write in Romanian, Greek or Russian used to get an empty cloud,
 * because only a-z counted as a letter.
 */
async function topics(match, since, limit = 12) {
  const conversations = await Conversation.find(
    { ...engaged(match), startedAt: { $gte: since } },
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
          .split(/[^\p{L}\p{N}']+/u)
          .map(word => word.replace(/^'+|'+$/g, ''))
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

/** A zone Mongo will accept, or UTC. */
function validTimezone(timezone) {
  if (!timezone) {
    return 'UTC';
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** Today's date, `YYYY-MM-DD`, in a timezone. */
function localDate(timezone, at = new Date()) {
  // en-CA formats as ISO year-month-day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

/** The window's days as `YYYY-MM-DD`, oldest first, so a chart has every day. */
function daysOf(days, timezone, now = new Date()) {
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    list.push(localDate(timezone, new Date(now.getTime() - offset * DAY_MS)));
  }
  return [...new Set(list)];
}

function pctChange(current, previous) {
  if (!previous) {
    return current ? null : 0;
  }
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Everything Home and the top of Reports show, for one window.
 *
 * One window for every number and chart: the 7/30/90 switch used to move two
 * of the cards and leave the rest on fixed periods, under a title that always
 * said "last 7 days".
 *
 * @param {object} match tenant scope (see utils/query companyMatch)
 * @param {number} days
 * @param {object} [options]
 * @param {string} [options.timezone] the company's, for "today" and per-day buckets
 */
async function overview(match, days = 7, options = {}) {
  const timezone = validTimezone(options.timezone);
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const previousSince = new Date(since.getTime() - days * DAY_MS);
  const scope = engaged(match);
  const today = localDate(timezone, now);
  const dayKey = { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone } };

  const windowMetrics = (start, end) => [
    { $match: { startedAt: { $gte: start, $lt: end } } },
    {
      $project: {
        messagesCount: {
          $size: {
            $filter: {
              input: { $ifNull: ['$messages', []] },
              as: 'm',
              cond: { $ne: ['$$m.sender', 'system'] }
            }
          }
        },
        durationMs: { $subtract: [{ $ifNull: ['$endedAt', '$lastActivity'] }, '$startedAt'] }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        avgDurationMs: { $avg: '$durationMs' },
        avgMessages: { $avg: '$messagesCount' }
      }
    }
  ];

  const [facets] = await Conversation.aggregate([
    { $match: { ...scope, $or: [{ startedAt: { $gte: previousSince } }, { status: 'active' }] } },
    {
      $facet: {
        today: [
          { $match: { startedAt: { $gte: new Date(now.getTime() - 2 * DAY_MS) } } },
          { $project: { day: dayKey } },
          { $match: { day: today } },
          { $count: 'count' }
        ],
        active: [
          { $match: { status: 'active' } },
          { $count: 'count' }
        ],
        // Waiting for a person: somebody asked, and nobody has picked it up.
        // Not every open chat without an operator - most of those are the bot
        // doing its job - and not one a person already answered and handed
        // back to the bot. The same rule the inbox's Waiting filter uses.
        waiting: [
          {
            $match: {
              status: 'active',
              hasOperator: { $ne: true },
              $or: [
                { awaitingOperatorSince: { $exists: true, $ne: null } },
                {
                  'handoff.requestedAt': { $exists: true, $ne: null },
                  operatorEverJoined: { $ne: true }
                }
              ]
            }
          },
          { $count: 'count' }
        ],
        perDay: [
          { $match: { startedAt: { $gte: since } } },
          { $project: { day: dayKey, joined: PERSON_JOINED } },
          {
            $group: {
              _id: '$day',
              count: { $sum: 1 },
              reachedPerson: { $sum: { $cond: ['$joined', 1, 0] } }
            }
          }
        ],
        sources: [
          { $match: { startedAt: { $gte: since } } },
          { $group: { _id: { $ifNull: ['$domain', 'Unknown'] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 6 }
        ],
        // First response from a person, measured from when they were asked
        // for (or from the start, when nobody recorded asking). The bot's
        // reply time is not a response time anybody waits on.
        firstResponse: [
          { $match: { startedAt: { $gte: since } } },
          {
            $project: {
              day: dayKey,
              waitMs: {
                $subtract: [FIRST_PERSON_REPLY, { $ifNull: ['$handoff.requestedAt', '$startedAt'] }]
              }
            }
          },
          { $match: { waitMs: { $gte: 0 } } },
          { $group: { _id: '$day', avgMs: { $avg: '$waitMs' }, count: { $sum: 1 }, totalMs: { $sum: '$waitMs' } } }
        ],
        current: windowMetrics(since, now),
        previous: windowMetrics(previousSince, since)
      }
    }
  ]);

  const count = list => (list && list[0] ? list[0].count : 0);
  const empty = { total: 0, avgDurationMs: 0, avgMessages: 0 };
  const current = (facets.current && facets.current[0]) || empty;
  const previous = (facets.previous && facets.previous[0]) || empty;

  const perDay = new Map((facets.perDay || []).map(row => [row._id, row]));
  const responseByDay = new Map((facets.firstResponse || []).map(row => [row._id, row]));
  const responseTotals = (facets.firstResponse || []).reduce(
    (acc, row) => ({ totalMs: acc.totalMs + row.totalMs, count: acc.count + row.count }),
    { totalMs: 0, count: 0 }
  );

  const shapeWindow = window => ({
    total: window.total,
    avgDurationMinutes: Math.round((window.avgDurationMs || 0) / 60000),
    avgMessages: Math.round(window.avgMessages || 0)
  });

  return {
    range: { days, since, timezone },
    totalChatsToday: count(facets.today),
    activeChats: count(facets.active),
    waitingForPerson: count(facets.waiting),
    chatVolumePerDay: daysOf(days, timezone, now).map(day => {
      const row = perDay.get(day);
      return {
        date: day,
        count: row ? row.count : 0,
        reachedPerson: row ? row.reachedPerson : 0,
        botOnly: row ? row.count - row.reachedPerson : 0
      };
    }),
    firstResponseOverTime: daysOf(days, timezone, now).map(day => {
      const row = responseByDay.get(day);
      return { date: day, avgSeconds: row ? Math.round(row.avgMs / 1000) : null, count: row ? row.count : 0 };
    }),
    avgFirstResponseSeconds: responseTotals.count
      ? Math.round(responseTotals.totalMs / responseTotals.count / 1000)
      : null,
    firstResponseCount: responseTotals.count,
    topSources: (facets.sources || []).map(source => ({
      // Show just the host; a full referer URL is unreadable in a legend.
      label: (() => {
        try {
          return new URL(source._id).host;
        } catch {
          return source._id || 'Unknown';
        }
      })(),
      count: source.count
    })),
    conversationMetrics: {
      current: shapeWindow(current),
      previous: shapeWindow(previous),
      change: {
        total: pctChange(current.total, previous.total),
        duration: pctChange(current.avgDurationMs || 0, previous.avgDurationMs || 0),
        messages: pctChange(current.avgMessages || 0, previous.avgMessages || 0)
      }
    }
  };
}

/** "Resolved by the bot", in words: the value report and billing both show it. */
const RESOLVED_DEFINITION = 'A conversation where the visitor wrote at least once, the bot answered, no person joined and nobody asked for one, the bot\'s last answer was not one it could not give, and the visitor did not rate it 1 or 2.';

/**
 * "Resolved by the bot", as an aggregation over the conversations `match`
 * selects. Answers one row: `conversations` (those the visitor wrote in) and
 * `botResolved`, plus `handedOver`.
 *
 * The definition is deliberately strict - every condition below is a way a
 * conversation can look handled without the visitor having been helped:
 *
 *   - the visitor wrote at least once
 *   - the bot answered
 *   - no person ever joined, and nobody asked for one
 *   - the bot's last answer was not one it flagged as "I don't know"
 *   - the visitor did not rate it 1 or 2
 *
 * One pipeline for every reader: the value report shows it and
 * per-resolution billing (services/resolutions.js) charges for it, and two
 * copies of a definition that decides what a customer pays would drift.
 */
function resolvedPipeline(match) {
  return [
    { $match: { ...match, 'messages.sender': 'user' } },
    {
      $project: {
        joined: PERSON_JOINED,
        handoff: HANDOFF_REQUESTED,
        lastBot: { $arrayElemAt: [messagesFrom('bot'), -1] },
        score: { $ifNull: ['$rating.score', null] }
      }
    },
    {
      $project: {
        joined: 1,
        handoff: 1,
        botAnswered: { $ne: [{ $ifNull: ['$lastBot', null] }, null] },
        lastUnanswered: { $eq: ['$lastBot.unanswered', true] },
        ratedLow: { $and: [{ $ne: ['$score', null] }, { $lte: ['$score', 2] }] }
      }
    },
    {
      $group: {
        _id: null,
        conversations: { $sum: 1 },
        botResolved: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $not: ['$joined'] }, { $not: ['$handoff'] }, '$botAnswered',
                  { $not: ['$lastUnanswered'] }, { $not: ['$ratedLow'] }
                ]
              },
              1, 0
            ]
          }
        },
        handedOver: { $sum: { $cond: [{ $or: ['$joined', '$handoff'] }, 1, 0] } }
      }
    }
  ];
}

/**
 * What the bot is worth, in the terms somebody paying for it uses.
 *
 * "Resolved by the bot" is `resolvedPipeline` above, over the conversations
 * started in the window.
 *
 * @param {object} match tenant scope
 * @param {number} days
 * @param {object} [options]
 * @param {number} [options.minutesPerConversation]
 * @param {number|null} [options.monthlyPrice] the plan's price, for cost per resolution
 */
async function value(match, days = 30, options = {}) {
  const since = new Date(Date.now() - days * DAY_MS);
  const minutes = Number(options.minutesPerConversation) > 0
    ? Number(options.minutesPerConversation)
    : DEFAULT_MINUTES_PER_CONVERSATION;

  const [row] = await Conversation.aggregate(resolvedPipeline({ ...match, startedAt: { $gte: since } }));

  // Replies a model wrote: the assistant and workflow model steps. Rows from
  // before replies were labelled have no path and are counted, as they were
  // almost all the assistant's.
  const [ai] = await Conversation.aggregate([
    { $match: { ...match, lastActivity: { $gte: since }, 'messages.sender': 'bot' } },
    { $unwind: '$messages' },
    {
      $match: {
        'messages.sender': 'bot',
        'messages.timestamp': { $gte: since },
        $or: [{ 'messages.path': { $in: ['assistant', 'workflow'] } }, { 'messages.path': { $exists: false } }]
      }
    },
    { $count: 'count' }
  ]);

  const handlers = await csat.byHandler(engaged(match), since).catch(error => {
    logger.error('Analytics metric "csatByHandler" failed', { error: error.message });
    return null;
  });

  const conversations = row ? row.conversations : 0;
  const botResolved = row ? row.botResolved : 0;
  const price = Number.isFinite(options.monthlyPrice) && options.monthlyPrice > 0 ? options.monthlyPrice : null;

  return {
    days,
    since,
    conversations,
    botResolved,
    handedOver: row ? row.handedOver : 0,
    resolutionRate: conversations ? Math.round((botResolved / conversations) * 100) : null,
    minutesPerConversation: minutes,
    hoursSaved: Math.round((botResolved * minutes / 60) * 10) / 10,
    aiReplies: ai ? ai.count : 0,
    // The plan's price for the period, spread over what the bot resolved in
    // it: a week's report is charged a week's share of a month.
    costPerResolution: price && botResolved
      ? Math.round((price * (days / 30) / botResolved) * 100) / 100
      : null,
    monthlyPrice: price,
    csatBot: handlers ? handlers.bot : null,
    csatHuman: handlers ? handlers.operator : null,
    definition: {
      botResolved: RESOLVED_DEFINITION,
      hoursSaved: `Conversations resolved by the bot × ${minutes} minutes, the time a person would have spent on each. Change the minutes on this screen.`,
      costPerResolution: 'Your plan\'s monthly price for the period shown, divided by the conversations the bot resolved in it.',
      aiReplies: 'Replies written by the AI model in the period: the assistant\'s answers and workflow AI steps. Canned replies and fixed workflow messages are not counted.',
      handedOver: 'Conversations where a person joined, or somebody asked for one.'
    }
  };
}

/**
 * Everything above, for one company and one window.
 *
 * Each metric runs on its own: one slow or failing metric should not deny the
 * caller all the others. A metric that failed comes back as `null` and is
 * named in `unavailable`, so the screen can say so - a failure shown as 0%
 * is a lie that looks like a result.
 *
 * @param {object} user  req.user, used for tenant scoping
 * @param {number} days  window size
 * @param {object} [options]
 * @param {object} [options.match] scope to use instead of the user's
 * @param {string} [options.timezone] for the heatmap
 */
async function advanced(user, days = 30, options = {}) {
  const match = options.match || companyMatch(user);
  const since = new Date(Date.now() - days * DAY_MS);
  const unavailable = [];
  const engagedMatch = engaged(match);

  const guard = (name, promise) => promise.catch(error => {
    logger.error(`Analytics metric "${name}" failed`, { error: error.message });
    unavailable.push(name);
    return null;
  });

  const [
    deflectionResult, abandonmentResult, peakResult,
    operatorResult, topicResult, taskResult,
    csatResult, csatHandlerResult, csatOperatorResult, csatCommentResult
  ] = await Promise.all([
    guard('deflection', deflection(match, since)),
    guard('abandonment', abandonment(match, since)),
    guard('peakHours', peakHours(match, since, options.timezone)),
    guard('operators', operatorPerformance(match, since)),
    guard('topics', topics(match, since)),
    guard('tasks', taskMetrics(match, since)),
    guard('satisfaction', csat.summary(engagedMatch, since)),
    guard('satisfaction', csat.byHandler(engagedMatch, since)),
    guard('satisfaction', csat.byOperator(engagedMatch, since)),
    guard('satisfaction', csat.comments(engagedMatch, since))
  ]);

  return {
    windowDays: days,
    timezone: validTimezone(options.timezone),
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
    satisfaction: csatResult ? {
      ...csatResult,
      byHandler: csatHandlerResult,
      byOperator: csatOperatorResult,
      comments: csatCommentResult
    } : null,
    unavailable: [...new Set(unavailable)]
  };
}

module.exports = {
  advanced,
  overview,
  value,
  deflection,
  abandonment,
  peakHours,
  operatorPerformance,
  topics,
  taskMetrics,
  engaged,
  localDate,
  validTimezone,
  satisfaction: csat.summary,
  resolvedPipeline,
  RESOLVED_DEFINITION,
  ENGAGED,
  DEFAULT_MINUTES_PER_CONVERSATION
};
