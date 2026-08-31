/**
 * The public read API.
 *
 * Outbound webhooks push events as they happen and action nodes call out, but
 * until now a tenant could not *pull* their own data — for a backfill, for a
 * warehouse, or simply to check that what they see in the dashboard is what
 * they can build on. This is that: read-only, scoped, per-key rate limited,
 * and versioned at `/api/v1` so it can be changed without breaking whatever
 * somebody built against it last year.
 *
 * Every query is scoped to the key's company by construction rather than by a
 * filter a future route might forget: `scope()` is the only way a handler gets
 * a query, and it always starts with the tenant.
 *
 * Reads are shaped explicitly rather than returned as stored documents. A
 * lean() document would hand out internal ids, mongoose internals and any
 * field a future migration adds — including the next credential somebody puts
 * on a model.
 */

const express = require('express');
const mongoose = require('mongoose');

const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Task = require('../models/task');
const { apiKeyAuth, requireScope } = require('../middleware/api-key');
const { publicApiLimiter } = require('../middleware/rateLimiter');
const { logger } = require('../services/logging');

const router = express.Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

router.use(apiKeyAuth, publicApiLimiter);

/** A query that can only ever see one tenant's data. */
function scope(req, extra = {}) {
  return { company: new mongoose.Types.ObjectId(req.apiCompanyId), ...extra };
}

/**
 * Cursor paging by `_id`.
 *
 * Not page numbers: a backfill that takes an hour would see rows shift between
 * pages as new conversations arrive, silently skipping some and repeating
 * others. An `_id` cursor is stable under writes, which is the whole point of
 * an API somebody syncs from.
 */
function paging(req) {
  const requested = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT), MAX_LIMIT);
  const query = {};

  if (req.query.cursor) {
    if (!mongoose.Types.ObjectId.isValid(req.query.cursor)) {
      const error = new Error('Invalid cursor');
      error.status = 400;
      throw error;
    }
    query._id = { $gt: new mongoose.Types.ObjectId(req.query.cursor) };
  }

  return { limit, query };
}

/** A date range on one field, from `since` / `until`. */
function dateRange(req, field) {
  const range = {};

  if (req.query.since) {
    const since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) {
      const error = new Error('"since" is not a date');
      error.status = 400;
      throw error;
    }
    range.$gte = since;
  }

  if (req.query.until) {
    const until = new Date(req.query.until);
    if (Number.isNaN(until.getTime())) {
      const error = new Error('"until" is not a date');
      error.status = 400;
      throw error;
    }
    range.$lte = until;
  }

  return Object.keys(range).length ? { [field]: range } : {};
}

function page(rows, limit) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  return {
    data,
    // The cursor is the last id of this page, so a caller resumes by passing
    // back what they were given rather than by counting.
    nextCursor: hasMore && data.length ? String(data[data.length - 1].id) : null,
    hasMore
  };
}

const asConversation = (conversation) => ({
  id: String(conversation._id),
  sessionId: conversation.sessionId,
  channel: conversation.channel,
  status: conversation.status,
  startedAt: conversation.startedAt,
  endedAt: conversation.endedAt,
  lastActivity: conversation.lastActivity,
  tags: conversation.tags || [],
  messageCount: (conversation.messages || []).length,
  handledByOperator: Boolean(conversation.operatorName),
  operatorName: conversation.operatorName || null,
  contactId: conversation.contact ? String(conversation.contact) : null,
  rating: conversation.rating && conversation.rating.score
    ? { score: conversation.rating.score, comment: conversation.rating.comment || null, ratedAt: conversation.rating.ratedAt }
    : null,
  // Said plainly rather than left for somebody to infer from a transcript of
  // "[removed]": this conversation is past its tenant's retention window.
  anonymizedAt: conversation.anonymizedAt || null
});

const asMessage = (message) => ({
  id: String(message._id),
  sender: message.sender,
  content: message.content,
  timestamp: message.timestamp,
  operatorName: message.operatorName || null
});

const asContact = (contact) => ({
  id: String(contact._id),
  externalId: contact.externalId || null,
  identityLevel: contact.identityLevel,
  name: contact.name || null,
  email: contact.email || null,
  phone: contact.phone || null,
  tags: contact.tags || [],
  conversationCount: contact.conversationCount,
  firstSeenAt: contact.firstSeenAt,
  lastSeenAt: contact.lastSeenAt
});

const asTask = (task) => ({
  id: String(task._id),
  title: task.title,
  description: task.description,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate,
  assigneeName: task.assigneeName || null,
  createdAt: task.createdAt,
  completedAt: task.completedAt || null,
  conversationId: task.conversationId ? String(task.conversationId) : null,
  contact: task.contactInfo || null
});

/**
 * What this key is and what it can do. The first call anybody integrating
 * makes, and the one that tells them a 403 later is a missing scope rather
 * than a broken key.
 */
router.get('/me', async (req, res) => {
  res.json({
    company: req.apiCompanyId,
    key: { name: req.apiKey.name, prefix: req.apiKey.prefix, scopes: req.apiKey.scopes }
  });
});

router.get('/conversations', requireScope('conversations:read'), async (req, res, next) => {
  try {
    const { limit, query } = paging(req);

    const filters = {
      ...query,
      ...dateRange(req, 'lastActivity')
    };

    if (req.query.status) {
      filters.status = req.query.status;
    }
    if (req.query.tag) {
      filters.tags = req.query.tag;
    }

    const rows = await Conversation.find(scope(req, filters))
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean();

    res.json(page(rows.map(asConversation), limit));
  } catch (error) {
    next(error);
  }
});

/**
 * One conversation with its transcript.
 *
 * By session id, because that is the identifier a tenant already holds — it is
 * in their widget snippet and on their own records — rather than an internal
 * one they would have to have listed us first to learn.
 */
router.get('/conversations/:sessionId', requireScope('conversations:read'), async (req, res, next) => {
  try {
    const conversation = await Conversation.findOne(scope(req, { sessionId: req.params.sessionId })).lean();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      ...asConversation(conversation),
      messages: (conversation.messages || []).map(asMessage)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/contacts', requireScope('contacts:read'), async (req, res, next) => {
  try {
    const { limit, query } = paging(req);
    const filters = { ...query, ...dateRange(req, 'lastSeenAt') };

    if (req.query.email) {
      filters.email = String(req.query.email).toLowerCase();
    }
    if (req.query.externalId) {
      filters.externalId = req.query.externalId;
    }

    const rows = await Contact.find(scope(req, filters))
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean();

    res.json(page(rows.map(asContact), limit));
  } catch (error) {
    next(error);
  }
});

router.get('/tasks', requireScope('tasks:read'), async (req, res, next) => {
  try {
    const { limit, query } = paging(req);
    const filters = { ...query, ...dateRange(req, 'createdAt') };

    if (req.query.status) {
      filters.status = req.query.status;
    }

    const rows = await Task.find(scope(req, filters))
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean();

    res.json(page(rows.map(asTask), limit));
  } catch (error) {
    next(error);
  }
});

// A bad cursor or date is the caller's mistake and says so; anything else is
// ours and does not explain itself to them.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error.status === 400) {
    return res.status(400).json({ error: error.message });
  }

  logger.error('Public API request failed', { path: req.path, error: error.message });
  res.status(500).json({ error: 'Request failed' });
});

module.exports = router;
