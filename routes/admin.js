const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const User = require('../models/user');
const Company = require('../models/company');
const { auth, operator, admin, requireString } = require('../middleware/auth');
const { enforceLimit } = require('../middleware/quota');
const analyticsService = require('../services/analytics');
const usageService = require('../services/usage');
const { logger } = require('../services/logging');
const socketManager = require('../socketManager');
const csatService = require('../services/csat');
const assignmentService = require('../services/assignment');
const audit = require('../services/audit');
const webhookService = require('../services/webhooks');
const uploads = require('../services/uploads');
const Contact = require('../models/contact');
const contactService = require('../services/contacts');
const NotificationService = require('../services/notification');
const { toCsv } = require('../utils/csv-export');
const {
  containsRegex,
  companyFilter,
  companyMatch,
  canAccessCompany,
  parsePagination
} = require('../utils/query');

const router = express.Router();

// Apply auth middleware to all routes
router.use(auth);
router.use(operator);

/**
 * Load a conversation by sessionId, enforcing tenant isolation.
 * Returns null and sends the response when access should be denied, so callers
 * can simply `if (!conversation) return;`.
 */
async function loadScopedConversation(req, res) {
  const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  if (!canAccessCompany(req.user, conversation.company)) {
    // Do not disclose that the conversation exists for another tenant.
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  return conversation;
}

function isAdmin(user) {
  return Boolean(user) && (user.role === 'company_admin' || user.role === 'superadmin');
}

/**
 * A conversation somebody actually started.
 *
 * Opening a page with the widget used to create a conversation on the spot,
 * so the queue and the history filled with rows nobody had typed a word in.
 * New ones are only created on first engagement; this keeps the old ones out
 * of every list: no visitor message, no name or address, not an email.
 */
const ENGAGED = {
  $or: [
    { channel: 'email' },
    { 'messages.sender': 'user' },
    { 'metadata.name': { $nin: [null, ''] } },
    { 'metadata.email': { $nin: [null, ''] } },
    { 'followUp.email': { $nin: [null, ''] } },
    { 'handoff.requestedAt': { $ne: null } }
  ]
};

/**
 * The messages a person reads. `system` lines record events for operators
 * ("transferred to Bea") and are not part of what was said, so they count
 * towards nothing and are never the preview.
 */
const SPOKEN_MESSAGES = {
  $filter: {
    input: { $ifNull: ['$messages', []] },
    as: 'm',
    cond: { $ne: ['$$m.sender', 'system'] }
  }
};

const PREVIEW_LENGTH = 140;

/** A single string from a query parameter, or ''. */
function queryString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The visitor's name and address, from wherever this conversation has them. */
function visitorDetails(chat, contact) {
  const metadata = chat.metadata || {};
  const email = metadata.email ||
    (chat.followUp && chat.followUp.email) ||
    (chat.email && chat.email.from) ||
    (contact && contact.email) ||
    null;
  return {
    name: metadata.name || (contact && contact.name) || null,
    email: email || null
  };
}

/** Contacts by id, for the rows that have one. */
async function contactsFor(rows) {
  const ids = rows.map(row => row.contact).filter(Boolean);
  if (ids.length === 0) {
    return new Map();
  }
  const contacts = await Contact.find({ _id: { $in: ids } }).select('name email').lean();
  return new Map(contacts.map(contact => [String(contact._id), contact]));
}

/**
 * Who is connected and taking chats, by user id.
 *
 * Read from the socket rooms, like auto-assignment does: a presence flag in
 * the database drifts the moment a process dies, and then a chat is handed to
 * somebody who went home.
 */
async function presenceFor(companyId, userIds) {
  const online = new Set(assignmentService.connectedOperators(companyId).map(person => person.id));
  const users = await User.find({ _id: { $in: userIds } }).select('acceptingChats').lean();
  const accepting = new Map(users.map(user => [String(user._id), user.acceptingChats !== false]));
  return id => ({
    online: online.has(String(id)),
    accepting: accepting.get(String(id)) !== false
  });
}

/** Whether the visitor of a web chat has the widget open right now. */
function visitorConnected(sessionId) {
  try {
    const io = socketManager.getIo();
    const members = io.sockets.adapter.rooms.get(sessionId);
    if (!members) {
      return false;
    }
    return [...members].some(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      // Staff sockets carry a user id; a visitor's does not.
      return Boolean(socket) && (!socket.user || !socket.user.id);
    });
  } catch {
    // Sockets are not running (tests, scripts): nobody is connected.
    return false;
  }
}

/**
 * Refuse to act on a conversation somebody else holds, unless an admin says
 * they mean it.
 *
 * Any operator could end or transfer a colleague's chat from under them; the
 * colleague found out when their next reply went nowhere. An admin may still
 * do it - reassigning work is part of the job - but only deliberately, with
 * `force`, after the dashboard has named who holds it.
 *
 * @returns {boolean} true when the caller may continue; otherwise the
 *          response has been sent
 */
function mayActOn(req, res, conversation) {
  const holder = conversation.operatorId ? String(conversation.operatorId) : null;
  if (!holder || holder === String(req.user.id)) {
    return true;
  }
  if (isAdmin(req.user) && req.body && req.body.force === true) {
    return true;
  }
  res.status(409).json({
    error: `${conversation.operatorName || 'Another operator'} is handling this conversation`,
    code: 'HELD_BY_ANOTHER',
    heldBy: { id: holder, name: conversation.operatorName || null }
  });
  return false;
}

/**
 * Record an event in the transcript, for operators only.
 *
 * `system` lines are never sent to the visitor and never fed to the model;
 * they are how a transcript explains itself later ("transferred from Al to
 * Bea"), where a note in the side panel is easy to miss.
 */
function systemLine(conversation, content) {
  conversation.messages.push({
    content,
    sender: 'system',
    path: 'system',
    timestamp: new Date()
  });
  return conversation.messages[conversation.messages.length - 1];
}

/** Every operator viewing the conversation sees a persisted message appear. */
function announceMessage(conversation, message) {
  if (!message) {
    return;
  }
  socketManager.emitToOperators(conversation.company, 'conversation-message', {
    sessionId: conversation.sessionId,
    message: {
      _id: message._id ? String(message._id) : undefined,
      sender: message.sender,
      content: message.content,
      operatorName: message.operatorName,
      operatorId: message.operatorId ? String(message.operatorId) : undefined,
      timestamp: message.timestamp,
      path: message.path
    }
  });
}

/**
 * The live queue.
 *
 * Shaped for triage: who is waiting for a person and since when, why they
 * reached one, what was last said, and how much has been said. The queue used
 * to show "0 messages" for a chat with three and no reason at all.
 */
router.get('/active-chats', async (req, res) => {
  try {
    const query = { status: 'active', ...companyFilter(req.user), ...ENGAGED };

    // A find() projection of `{'messages.length': {$size: '$messages'}}` does
    // not produce a count - it rewrites `messages` into one `{length: N}` entry
    // per message. An aggregation gives a real scalar and avoids shipping the
    // message bodies over the wire at all.
    const activeChats = await Conversation.aggregate([
      { $match: query },
      { $sort: { lastActivity: -1 } },
      { $limit: 200 },
      {
        $project: {
          sessionId: 1,
          startedAt: 1,
          lastActivity: 1,
          domain: 1,
          hasOperator: 1,
          operatorName: 1,
          metadata: 1,
          company: 1,
          channel: 1,
          email: 1,
          contact: 1,
          tags: 1,
          operatorId: 1,
          handoff: 1,
          followUp: 1,
          operatorEverJoined: 1,
          awaitingOperatorSince: 1,
          messageCount: { $size: SPOKEN_MESSAGES },
          lastMessage: {
            $let: {
              vars: { last: { $last: SPOKEN_MESSAGES } },
              in: {
                sender: '$$last.sender',
                content: { $substrCP: [{ $ifNull: ['$$last.content', ''] }, 0, PREVIEW_LENGTH] },
                timestamp: '$$last.timestamp'
              }
            }
          }
        }
      }
    ]);

    await Company.populate(activeChats, { path: 'company', select: 'name' });
    const contacts = await contactsFor(activeChats);
    const me = String(req.user.id);

    const chats = activeChats.map(chat => {
      const contact = chat.contact ? contacts.get(String(chat.contact)) : null;
      const visitor = visitorDetails(chat, contact);
      const operatorId = chat.operatorId ? String(chat.operatorId) : null;

      return {
        sessionId: chat.sessionId,
        startedAt: chat.startedAt,
        lastActivity: chat.lastActivity,
        domain: chat.domain,
        channel: chat.channel || 'chat',
        visitorName: visitor.name,
        email: visitor.email,
        // Kept for older dashboard code: an email thread has no pre-chat
        // form, so the sender address is the best name we have.
        userName: visitor.name || (chat.email && chat.email.from) || null,
        subject: chat.email && chat.email.subject,
        contactId: chat.contact,
        tags: chat.tags || [],
        // Needed so the dashboard can mark the rows this operator owns without
        // matching on the display name, which is not unique.
        operatorId,
        operatorName: operatorId ? chat.operatorName : null,
        hasOperator: Boolean(operatorId),
        assignedToMe: operatorId === me,
        operatorEverJoined: Boolean(chat.operatorEverJoined),
        handoff: chat.handoff && chat.handoff.requestedAt
          ? { reason: chat.handoff.reason || null, requestedAt: chat.handoff.requestedAt }
          : null,
        waitingSince: chat.awaitingOperatorSince || null,
        lastMessage: chat.lastMessage && chat.lastMessage.sender ? chat.lastMessage : null,
        messageCount: chat.messageCount,
        company: chat.company ? {
          id: chat.company._id,
          name: chat.company.name
        } : null
      };
    });

    // Whoever has waited longest for a person first, then the most recent
    // activity: the order the queue should be worked in.
    const waitingSince = chat => (chat.waitingSince && !chat.operatorId
      ? new Date(chat.waitingSince).getTime()
      : null);
    chats.sort((a, b) => {
      const waitA = waitingSince(a);
      const waitB = waitingSince(b);
      if (waitA !== null && waitB !== null) {
        return waitA - waitB;
      }
      if (waitA !== null || waitB !== null) {
        return waitA === null ? 1 : -1;
      }
      return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
    });

    res.json({ chats });
  } catch (error) {
    logger.error('Error fetching active chats', { error });
    res.status(500).json({ error: 'Failed to retrieve active chats' });
  }
});

const OUTCOMES = ['resolved', 'follow_up', 'unresolved', 'spam'];

/**
 * The history's filter, from the query string. Shared with the export, so the
 * file holds exactly what the screen showed.
 */
async function historyFilter(req) {
  const conditions = [companyFilter(req.user), ENGAGED];
  const query = req.query || {};

  const search = queryString(query.search);
  if (search) {
    // Escaped so a search term cannot inject regex syntax or trigger ReDoS.
    const term = containsRegex(search);
    const anyOf = [
      { sessionId: term },
      { domain: term },
      { operatorName: term },
      { 'messages.operatorName': term },
      { 'messages.content': term },
      { 'metadata.name': term },
      { 'metadata.email': term },
      { 'email.from': term },
      { 'email.subject': term },
      { 'followUp.email': term },
      { tags: term }
    ];

    // People known by a name or address on their contact record rather than
    // on this conversation: somebody who identified themselves on a later
    // visit.
    const people = await Contact.find({
      ...companyFilter(req.user),
      $or: [{ name: term }, { email: term }]
    }).select('_id').limit(200).lean();
    if (people.length) {
      anyOf.push({ contact: { $in: people.map(person => person._id) } });
    }

    conditions.push({ $or: anyOf });
  }

  const from = queryString(query.from);
  const to = queryString(query.to);
  const range = {};
  if (from && !Number.isNaN(new Date(from).getTime())) {
    range.$gte = new Date(from);
  }
  if (to && !Number.isNaN(new Date(to).getTime())) {
    const end = new Date(to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      // A bare date means the whole of that day.
      end.setUTCDate(end.getUTCDate() + 1);
      range.$lt = end;
    } else {
      range.$lte = end;
    }
  }
  if (Object.keys(range).length) {
    conditions.push({ startedAt: range });
  }

  const channel = queryString(query.channel);
  if (channel === 'email') {
    conditions.push({ channel: 'email' });
  } else if (channel === 'chat') {
    // Older conversations have no channel at all; they are all web chats.
    conditions.push({ channel: { $in: ['chat', null] } });
  } else if (['whatsapp', 'messenger', 'instagram'].includes(channel)) {
    conditions.push({ channel });
  }

  const status = queryString(query.status);
  if (['active', 'ended', 'archived'].includes(status)) {
    conditions.push({ status });
  }

  const handledBy = queryString(query.handledBy);
  if (handledBy === 'bot') {
    conditions.push({ operatorEverJoined: { $ne: true }, 'messages.sender': { $ne: 'operator' } });
  } else if (handledBy === 'person') {
    conditions.push({ $or: [{ operatorEverJoined: true }, { 'messages.sender': 'operator' }] });
  }

  const rating = queryString(query.rating);
  if (rating === 'low') {
    conditions.push({ 'rating.score': { $lte: 2 } });
  } else if (rating === 'high') {
    conditions.push({ 'rating.score': { $gte: 4 } });
  } else if (rating === 'none') {
    conditions.push({ 'rating.score': null });
  }

  const outcome = queryString(query.outcome);
  if (OUTCOMES.includes(outcome)) {
    conditions.push({ 'outcome.status': outcome });
  } else if (outcome === 'none') {
    conditions.push({ 'outcome.status': null });
  }

  const tag = queryString(query.tag);
  if (tag) {
    conditions.push({ tags: tag.toLowerCase() });
  }

  const filtered = conditions.filter(condition => Object.keys(condition).length > 0);
  return filtered.length ? { $and: filtered } : {};
}

/**
 * The operators who wrote in a conversation. Read from the transcript because
 * the conversation's own operator fields are cleared when it ends.
 */
const OPERATORS_WHO_WROTE = {
  $setUnion: [{
    $map: {
      input: {
        $filter: {
          input: { $ifNull: ['$messages', []] },
          as: 'm',
          cond: { $eq: ['$$m.sender', 'operator'] }
        }
      },
      as: 'm',
      in: '$$m.operatorName'
    }
  }]
};

/** One row of the history or the export, from an aggregated conversation. */
function historyRow(chat, contact) {
  const visitor = visitorDetails(chat, contact);
  const operators = (chat.operators || []).filter(Boolean);

  return {
    sessionId: chat.sessionId,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    status: chat.status,
    domain: chat.domain,
    channel: chat.channel || 'chat',
    subject: chat.email && chat.email.subject,
    userName: visitor.name,
    email: visitor.email,
    phone: (chat.metadata && chat.metadata.phone) || null,
    tags: chat.tags || [],
    messageCount: chat.messageCount,
    handledBy: chat.operatorEverJoined || operators.length ? 'person' : 'bot',
    operators,
    rating: chat.rating && chat.rating.score ? chat.rating.score : null,
    ratingComment: (chat.rating && chat.rating.comment) || null,
    outcome: chat.outcome && chat.outcome.status ? chat.outcome.status : null,
    outcomeNote: (chat.outcome && chat.outcome.note) || null,
    company: chat.company && chat.company._id ? {
      id: chat.company._id,
      name: chat.company.name
    } : null
  };
}

const HISTORY_PROJECTION = {
  sessionId: 1,
  startedAt: 1,
  endedAt: 1,
  status: 1,
  domain: 1,
  company: 1,
  metadata: 1,
  channel: 1,
  email: 1,
  followUp: 1,
  contact: 1,
  tags: 1,
  operatorEverJoined: 1,
  rating: 1,
  outcome: 1,
  messageCount: { $size: SPOKEN_MESSAGES },
  operators: OPERATORS_WHO_WROTE
};

// Get chat history
router.get('/chat-history', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
    const effectiveQuery = await historyFilter(req);

    const [chatHistory, total] = await Promise.all([
      Conversation.aggregate([
        { $match: effectiveQuery },
        { $sort: { startedAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: HISTORY_PROJECTION }
      ]),
      Conversation.countDocuments(effectiveQuery)
    ]);

    await Company.populate(chatHistory, { path: 'company', select: 'name' });
    const contacts = await contactsFor(chatHistory);

    const history = chatHistory.map(chat =>
      historyRow(chat, chat.contact ? contacts.get(String(chat.contact)) : null));

    res.json({
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    logger.error('Error fetching chat history', { error });
    res.status(500).json({ error: 'Failed to retrieve chat history' });
  }
});

// Get specific chat
router.get('/chat/:sessionId', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const userName =
      conversation.metadata &&
      (conversation.metadata.name ||
        (conversation.metadata.get && conversation.metadata.get('name')));

    // Convert Map fields like `metadata` into plain objects
    const convoObj = conversation.toObject({ flattenMaps: true });
    convoObj.userName = userName;

    const contact = conversation.contact
      ? await Contact.findById(conversation.contact).select('name email').lean()
      : null;
    const companyId = conversation.company;

    // What the dashboard may offer in this conversation. "Suggest a reply" on
    // a plan without suggestions used to say "Drafting…" forever, and the
    // attach button on an email thread was refused by the server.
    const [aiSuggestions, fileUploads] = await Promise.all([
      usageService.hasFeature(companyId, 'aiSuggestions').catch(() => false),
      usageService.hasFeature(companyId, 'fileUploads').catch(() => false)
    ]);
    convoObj.features = {
      aiSuggestions: Boolean(aiSuggestions),
      // Only the widget can receive a file from an operator.
      fileUploads: Boolean(fileUploads) && (!conversation.channel || conversation.channel === 'chat')
    };

    convoObj.heldByMe = Boolean(conversation.operatorId) &&
      String(conversation.operatorId) === String(req.user.id);
    // Asking for details only reaches somebody with the widget open.
    convoObj.visitorOnline = conversation.channel !== 'email' && visitorConnected(conversation.sessionId);
    // Where "Reply by email" would send to, if anywhere.
    convoObj.followUpEmail = visitorDetails(convoObj, contact).email;

    res.json(convoObj);
  } catch (error) {
    logger.error('Error fetching chat', { error });
    res.status(500).json({ error: 'Failed to retrieve chat' });
  }
});

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Correct who the customer is.
 *
 * The conversation and the person behind it are two records, and People read
 * the second: correcting a name here used to leave People showing the old one
 * forever. Both are written. Editing never grants verification - an operator
 * typing an address is not the tenant vouching for an identity.
 */
router.post('/chat/:sessionId/contact-info', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const clean = value => (typeof value === 'string' ? value.trim() : '');
    const name = clean(req.body.name);
    const email = clean(req.body.email).toLowerCase();
    const phone = clean(req.body.phone);

    if (email && !EMAIL_ADDRESS.test(email)) {
      return res.status(400).json({ error: 'That email address does not look right' });
    }
    if (name.length > 200 || phone.length > 50) {
      return res.status(400).json({ error: 'That is longer than a name or phone number can be' });
    }
    if (phone && !/^[\d\s+\-().]{5,50}$/.test(phone)) {
      return res.status(400).json({ error: 'A phone number can only have digits, spaces and + - ( )' });
    }

    // Initialize metadata if it doesn't exist
    if (!conversation.metadata) {
      conversation.metadata = new Map();
    }

    // Update metadata with contact information
    conversation.metadata.set('name', name);
    conversation.metadata.set('email', email);
    conversation.metadata.set('phone', phone);

    let contact = conversation.contact
      ? await Contact.findOne({ _id: conversation.contact, company: conversation.company })
      : null;

    if (contact) {
      // Only what was given: clearing a field in the chat panel should not
      // wipe what the person's record learned elsewhere.
      if (name) {
        contact.name = name;
      }
      // A verified address is the tenant's word for who this is; a typed one
      // does not replace it.
      if (email && contact.identityLevel !== 'verified') {
        contact.email = email;
        if (contact.identityLevel === 'anonymous') {
          contact.identityLevel = 'claimed';
        }
      }
      if (phone) {
        contact.phone = phone;
      }
      contact.lastSeenAt = new Date();
      await contact.save();
    } else if (conversation.company && (name || email || phone)) {
      // An older conversation with nobody behind it: now there is somebody.
      contact = await contactService.resolve({
        companyId: conversation.company,
        sessionId: conversation.sessionId,
        email: email || undefined,
        name: name || undefined,
        phone: phone || undefined
      });
      if (contact) {
        await contactService.linkConversation(contact, conversation);
      }
    }

    await conversation.save();

    // Everyone else looking at the queue or this conversation sees the change.
    socketManager.emitToOperators(conversation.company, 'user-details-updated', {
      sessionId: conversation.sessionId,
      name,
      email,
      phone,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Contact information updated successfully',
      contactId: contact ? String(contact._id) : null
    });
  } catch (error) {
    logger.error('Error updating contact information', { error });
    res.status(500).json({ error: 'Failed to update contact information' });
  }
});

/**
 * Internal notes.
 *
 * Operator-only: never sent to the visitor, and deliberately never fed to the
 * model. This is where you write "customer was abusive on the phone earlier"
 * or "billing already refunded this" so the next person picking the chat up
 * is not starting cold.
 */
/**
 * The audit log.
 *
 * Read-only by design: there is no route that edits or deletes an entry, here
 * or anywhere else. A record that can be rewritten is not evidence.
 *
 * A company admin sees their own company's history. Platform-level entries -
 * a superadmin changing somebody's plan, a failed sign-in against a username
 * that does not exist - carry no company and are visible only to superadmins.
 */
/** The filters the log screen sends, the same for the page and the export. */
function auditFilters(req) {
  return {
    action: typeof req.query.action === 'string' ? req.query.action : undefined,
    actorId: typeof req.query.actorId === 'string' ? req.query.actorId : undefined,
    outcome: typeof req.query.outcome === 'string' ? req.query.outcome : undefined,
    since: req.query.since,
    until: req.query.until,
    // A superadmin narrowing the platform's log to one tenant.
    company: req.user.role === 'superadmin' && mongoose.isValidObjectId(String(req.query.companyId || ''))
      ? String(req.query.companyId)
      : undefined
  };
}

router.get('/audit', admin, async (req, res) => {
  try {
    const result = await audit.search(req.user, {
      ...auditFilters(req),
      limit: req.query.limit,
      skip: req.query.skip
    });

    // The retention window is reported so the page can state it rather than
    // implying entries are kept forever.
    res.json({ ...result, retentionDays: require('../models/audit-log').RETENTION_DAYS });
  } catch (error) {
    logger.error('Error reading the audit log', { error });
    res.status(500).json({ error: 'Failed to load the audit log' });
  }
});

router.get('/audit/actions', admin, async (req, res) => {
  try {
    const actions = (await audit.actions(req.user)).sort();
    // The words for each, from the one list the export uses too.
    res.json({ actions, descriptions: audit.descriptionsFor(actions) });
  } catch (error) {
    logger.error('Error listing audit actions', { error });
    res.status(500).json({ error: 'Failed to load the actions' });
  }
});

/** Who appears in the log, for the "who" filter. */
router.get('/audit/actors', admin, async (req, res) => {
  try {
    res.json({ actors: await audit.actors(req.user) });
  } catch (error) {
    logger.error('Error listing audit actors', { error });
    res.status(500).json({ error: 'Failed to load the people' });
  }
});

/**
 * The log as a CSV, with the same filters as the screen. Capped, because an
 * export is for an auditor's question, not a backup of the collection.
 */
router.get('/audit/export', admin, async (req, res) => {
  try {
    const csv = await audit.exportCsv(req.user, auditFilters(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  } catch (error) {
    logger.error('Error exporting the audit log', { error });
    res.status(500).json({ error: 'Failed to export the audit log' });
  }
});

/**
 * Tags on a conversation.
 *
 * Sent as the complete list rather than as add/remove operations: the UI is a
 * set of chips the operator edits, and add/remove would need conflict handling
 * for the case where two operators are looking at the same conversation.
 */
router.put('/chat/:sessionId/tags', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    conversation.tags = assignmentService.normaliseTags(req.body.tags);
    await conversation.save();

    socketManager.emitToOperators(conversation.company, 'conversation-tagged', {
      sessionId: conversation.sessionId,
      tags: conversation.tags,
      by: req.user.displayName || req.user.username
    });

    webhookService.dispatch(conversation.company, 'conversation.tagged', {
      sessionId: conversation.sessionId,
      tags: conversation.tags,
      taggedBy: req.user.displayName || req.user.username
    });

    res.json({ tags: conversation.tags });
  } catch (error) {
    logger.error('Error updating conversation tags', { error });
    res.status(500).json({ error: 'Failed to update the tags' });
  }
});

/**
 * The tags this company already uses, most used first.
 *
 * Offered as suggestions while tagging. This is the entire mechanism that stops
 * "billing", "Billing" and "billin" all existing side by side.
 */
router.get('/tags', async (req, res) => {
  try {
    if (!req.user.company?.id && req.user.role !== 'superadmin') {
      return res.json({ tags: [] });
    }

    const companyId = req.user.company?.id
      ? new mongoose.Types.ObjectId(req.user.company.id)
      : null;

    res.json({ tags: companyId ? await assignmentService.knownTags(companyId) : [] });
  } catch (error) {
    logger.error('Error loading tags', { error });
    res.status(500).json({ error: 'Failed to load the tags' });
  }
});

/**
 * Whether this operator is taking new conversations, and how many at once.
 *
 * Being connected and being available are not the same thing: someone can have
 * the dashboard open while finishing a difficult conversation, or five minutes
 * before they leave.
 *
 * Read as well as written: the dashboard's switch used to start "on" for
 * everybody, so someone who had switched off yesterday saw themselves taking
 * conversations while the queue skipped them.
 */
router.get('/me/availability', async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('acceptingChats maxConcurrentChats').lean();
    res.json({
      // Unset on accounts that predate the field, which means "yes".
      acceptingChats: !user || user.acceptingChats !== false,
      maxConcurrentChats: (user && user.maxConcurrentChats) || null
    });
  } catch (error) {
    logger.error('Error reading availability', { error });
    res.status(500).json({ error: 'Failed to load your availability' });
  }
});

router.put('/me/availability', async (req, res) => {
  try {
    const update = {};

    if (req.body.acceptingChats !== undefined) {
      update.acceptingChats = Boolean(req.body.acceptingChats);
    }

    if (req.body.maxConcurrentChats !== undefined) {
      const max = parseInt(req.body.maxConcurrentChats, 10);
      // Null clears the personal override and falls back to the company's cap.
      if (req.body.maxConcurrentChats === null || Number.isNaN(max)) {
        update.maxConcurrentChats = null;
      } else if (max < 1 || max > 20) {
        return res.status(400).json({ error: 'Choose a limit between 1 and 20' });
      } else {
        update.maxConcurrentChats = max;
      }
    }

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true })
      .select('acceptingChats maxConcurrentChats');

    res.json({
      acceptingChats: user.acceptingChats,
      maxConcurrentChats: user.maxConcurrentChats
    });
  } catch (error) {
    logger.error('Error updating availability', { error });
    res.status(500).json({ error: 'Failed to update your availability' });
  }
});

/**
 * Take a conversation by hand.
 *
 * Auto-assignment does not replace this: somebody has to be able to pick up the
 * one that has been sitting there, or reassign the one that went to the wrong
 * person.
 */
router.post('/chat/:sessionId/claim', async (req, res) => {
  try {
    const operatorId = req.user.id;
    const operatorName = req.user.displayName || req.user.username;

    // One update, conditional on nobody holding it: two operators clicking
    // "take" in the same instant used to both read an empty `operatorId`,
    // both write theirs, and the second silently won. The database now
    // decides, and the loser is told.
    const claimed = await Conversation.findOneAndUpdate(
      {
        sessionId: req.params.sessionId,
        ...companyFilter(req.user),
        $or: [{ operatorId: null }, { operatorId: { $exists: false } }]
      },
      {
        $set: {
          operatorId,
          operatorName,
          hasOperator: true,
          assignment: { method: 'manual', at: new Date() }
        },
        // No longer waiting: a person has it.
        $unset: { awaitingOperatorSince: 1 }
      },
      { new: true }
    );

    if (!claimed) {
      // Either it does not exist for this tenant, or somebody has it.
      const existing = await loadScopedConversation(req, res);
      if (!existing) {
        return;
      }

      if (String(existing.operatorId) === String(operatorId)) {
        // Already theirs; claiming twice is not an error.
        return res.json({ operatorName: existing.operatorName });
      }

      return res.status(409).json({
        error: `${existing.operatorName || 'Another operator'} is already handling this conversation`
      });
    }

    // The same announcements services/assignment.js makes, so the queue and
    // the new owner learn about a manual claim exactly as about an automatic
    // one.
    socketManager.emitToOperators(claimed.company, 'chat-assigned', {
      sessionId: claimed.sessionId,
      operatorId,
      operatorName,
      method: 'manual',
      timestamp: new Date()
    });
    socketManager.emitToUser(operatorId, 'chat-assigned-to-you', {
      sessionId: claimed.sessionId,
      timestamp: new Date()
    });

    webhookService.dispatch(claimed.company, 'operator.assigned', {
      sessionId: claimed.sessionId,
      operatorId: String(operatorId),
      operatorName,
      method: 'manual'
    });

    res.json({ operatorName: claimed.operatorName });
  } catch (error) {
    logger.error('Error claiming conversation', { error });
    res.status(500).json({ error: 'Failed to claim the conversation' });
  }
});

/**
 * An operator sending the visitor a file: a form, a label, a screenshot of
 * where the setting is.
 *
 * The same rules as a visitor's upload - one allowlist, one size cap, one
 * directory per tenant, the plan's `fileUploads` feature - and the message it
 * produces travels the same way a typed operator reply does: `operator-message`
 * to the visitor's room, `new-message` to the company's operators, each with
 * the file's id, name and download path added. The visitor downloads it with
 * their session token (`GET /api/upload/:fileId`).
 */
const attachmentParser = uploads.createUploadParser().single('file');

router.post('/conversations/:sessionId/files', (req, res, next) => {
  attachmentParser(req, res, err => {
    if (uploads.sendUploadError(err, res)) {
      return;
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    if (conversation.channel && conversation.channel !== 'chat') {
      // Email and the messaging apps have no attachment support yet, and
      // storing a file the customer never receives would read as sent.
      return res.status(409).json({
        error: conversation.channel === 'email'
          ? 'Attachments cannot be sent on email conversations yet'
          : 'Attachments cannot be sent in messaging-app conversations yet'
      });
    }

    const companyId = conversation.company;

    if (companyId && !(await usageService.hasFeature(companyId, 'fileUploads'))) {
      return res.status(402).json({
        error: 'File uploads are not available on this plan',
        code: 'FEATURE_NOT_IN_PLAN'
      });
    }

    const fileId = await uploads.storeFile(companyId, req.file.buffer);
    const fileName = uploads.cleanFileName(req.file.originalname);
    const fileUrl = uploads.downloadPath(fileId);
    const operatorName = req.user.displayName || req.user.username;
    const timestamp = new Date();

    conversation.messages.push({
      content: fileName,
      sender: 'operator',
      fileId,
      fileName,
      operatorId: req.user.id,
      operatorName,
      timestamp
    });
    conversation.lastActivity = timestamp;
    await conversation.save();

    usageService.record(companyId, {
      operatorMessages: 1,
      messages: 1,
      filesUploaded: 1,
      fileBytes: req.file.size
    });

    const saved = conversation.messages[conversation.messages.length - 1];
    const messageId = saved && saved._id ? saved._id.toString() : undefined;

    // What a typed operator reply sends the visitor, plus the file.
    socketManager.emitToSession(conversation.sessionId, 'operator-message', {
      id: messageId,
      text: fileName,
      senderName: operatorName,
      timestamp,
      fileId,
      fileName,
      fileUrl
    });

    // And what the other operators hear about any message in the chat.
    socketManager.emitToOperators(companyId, 'new-message', {
      sessionId: conversation.sessionId,
      message: fileName,
      sender: 'operator',
      messageId,
      operatorId: String(req.user.id),
      operatorName,
      timestamp,
      fileId,
      fileName,
      fileUrl
    });

    logger.info('Operator sent a file', {
      fileId,
      sessionId: conversation.sessionId,
      size: req.file.size,
      mimeType: req.file.mimetype
    });

    res.status(201).json({
      success: true,
      message: {
        id: messageId,
        content: fileName,
        sender: 'operator',
        operatorName,
        timestamp,
        fileId,
        fileName,
        fileUrl,
        size: req.file.size
      }
    });
  } catch (error) {
    logger.error('Operator file upload failed', { error: error.message });
    res.status(500).json({ error: 'Failed to send the file' });
  }
});

router.post('/chat/:sessionId/notes', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const body = String(req.body.body || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'A note cannot be empty' });
    }
    if (body.length > 5000) {
      return res.status(400).json({ error: 'Notes are limited to 5000 characters' });
    }

    conversation.notes.push({
      body,
      author: req.user.id,
      authorName: req.user.displayName || req.user.username,
      createdAt: new Date()
    });
    await conversation.save();

    // The saved note, with its id: the author's own screen adds it from this
    // response and then hears the broadcast too, and without an id there was
    // nothing to tell the two apart, so every note appeared twice.
    const saved = conversation.notes[conversation.notes.length - 1];
    const note = {
      _id: String(saved._id),
      body: saved.body,
      author: String(saved.author),
      authorName: saved.authorName,
      system: false,
      createdAt: saved.createdAt
    };

    // Other operators viewing this conversation should see it appear.
    socketManager.emitToOperators(conversation.company, 'conversation-note', {
      sessionId: conversation.sessionId,
      note
    });

    res.status(201).json({ note });
  } catch (error) {
    logger.error('Error adding conversation note', { error });
    res.status(500).json({ error: 'Failed to add the note' });
  }
});

router.delete('/chat/:sessionId/notes/:noteId', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const note = conversation.notes.id(req.params.noteId);
    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Only the author may remove a note, or an admin cleaning up. A note is a
    // record other people may be relying on.
    const isAuthor = note.author && note.author.toString() === req.user.id.toString();

    if (!isAuthor && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'You can only delete your own notes' });
    }

    note.deleteOne();
    await conversation.save();

    // Gone for everyone looking at it, not only for whoever deleted it.
    socketManager.emitToOperators(conversation.company, 'conversation-note-deleted', {
      sessionId: conversation.sessionId,
      noteId: String(req.params.noteId)
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting conversation note', { error });
    res.status(500).json({ error: 'Failed to delete the note' });
  }
});

/**
 * The people a conversation could be handed to, and whether each could take
 * it now.
 *
 * Company admins answer chats too, and the transfer route always accepted
 * them, but the pick-list was built from operators only. Presence is shown so
 * nobody hands a customer to a colleague who went home an hour ago.
 */
router.get('/chat/:sessionId/transfer-targets', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    if (!conversation.company) {
      return res.json({ operators: [] });
    }

    const people = await User.find({
      company: conversation.company,
      role: { $in: ['operator', 'company_admin'] },
      isActive: true,
      _id: { $ne: req.user.id }
    }).select('username displayName role acceptingChats').lean();

    const presence = await presenceFor(conversation.company, people.map(person => person._id));
    const load = await assignmentService.currentLoad(conversation.company);

    const operators = people.map(person => {
      const state = presence(person._id);
      return {
        _id: String(person._id),
        username: person.username,
        displayName: person.displayName || person.username,
        role: person.role,
        online: state.online,
        accepting: state.accepting,
        // What they are already carrying, so the choice can be a fair one.
        load: load.get(String(person._id)) || 0
      };
    });

    // Who can take it now first, then by name.
    operators.sort((a, b) =>
      Number(b.online && b.accepting) - Number(a.online && a.accepting) ||
      a.displayName.localeCompare(b.displayName));

    res.json({ operators });
  } catch (error) {
    logger.error('Error listing transfer targets', { error });
    res.status(500).json({ error: 'Failed to load your colleagues' });
  }
});

/**
 * Hand a conversation to a colleague.
 *
 * There was previously no way to do this: an operator who picked up a chat
 * they could not resolve had to leave it and hope someone else noticed.
 *
 * The colleague has to be there. Handing a waiting customer to somebody who
 * is offline, or who has said they are not taking chats, parks them with
 * nobody - and nothing is changed until that has been checked, so a refused
 * transfer leaves the conversation exactly as it was.
 */
router.post('/chat/:sessionId/transfer', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const { operatorId, note } = req.body;
    if (!operatorId) {
      return res.status(400).json({ error: 'Choose an operator to transfer to' });
    }

    if (typeof operatorId !== 'string' || !mongoose.Types.ObjectId.isValid(operatorId)) {
      return res.status(400).json({ error: 'Invalid operator' });
    }

    if (conversation.status === 'ended') {
      return res.status(409).json({ error: 'This conversation has ended' });
    }

    const target = await User.findById(operatorId)
      .select('username displayName company isActive role acceptingChats');

    if (!target || !target.isActive) {
      return res.status(404).json({ error: 'That operator is not available' });
    }

    // The receiving person must belong to the conversation's own company, or
    // the transfer hands another tenant's conversation to them. Checked
    // against the conversation rather than the caller, because a superadmin
    // can reach every conversation and must still not move one across
    // tenants. Company admins take chats too, so they are valid targets; a
    // superadmin has no company and is not.
    const sameCompany = target.company && conversation.company
      && String(target.company) === String(conversation.company);
    if (!sameCompany || !['operator', 'company_admin'].includes(target.role)) {
      return res.status(403).json({ error: 'You can only transfer within your own company' });
    }

    if (target._id.toString() === req.user.id.toString()) {
      return res.status(400).json({ error: 'That conversation is already yours' });
    }

    if (!mayActOn(req, res, conversation)) {
      return;
    }

    const targetName = target.displayName || target.username;
    const presence = await presenceFor(conversation.company, [target._id]);
    const { online, accepting } = presence(target._id);

    if (!online) {
      return res.status(409).json({
        error: `${targetName} is not online right now. Choose someone who is, or leave it in the queue.`,
        code: 'TARGET_OFFLINE'
      });
    }
    if (!accepting) {
      return res.status(409).json({
        error: `${targetName} is not taking new conversations at the moment.`,
        code: 'TARGET_NOT_ACCEPTING'
      });
    }

    const from = {
      operatorId: req.user.id,
      operatorName: req.user.displayName || req.user.username,
      at: new Date()
    };
    const handoverNote = typeof note === 'string' ? note.trim().slice(0, 2000) : '';

    conversation.transferredFrom = from;
    conversation.operatorId = target._id;
    conversation.operatorName = targetName;
    conversation.hasOperator = true;
    conversation.awaitingOperatorSince = undefined;
    conversation.assignment = { method: 'manual', at: new Date() };

    // Recorded as a system note so the history explains itself later.
    conversation.notes.push({
      body: handoverNote
        ? `Transferred from ${from.operatorName} to ${targetName}: ${handoverNote}`
        : `Transferred from ${from.operatorName} to ${targetName}`,
      author: req.user.id,
      authorName: from.operatorName,
      system: true,
      createdAt: new Date()
    });
    const line = systemLine(conversation, `${from.operatorName} transferred the conversation to ${targetName}`);

    await conversation.save();

    // The receiving operator gets a direct nudge; everyone else just sees the
    // assignment change in their queue.
    socketManager.emitToUser(target._id, 'chat-transferred-to-you', {
      sessionId: conversation.sessionId,
      from: from.operatorName,
      note: handoverNote || null
    });

    // And in their bell, so it is there if they were on another screen.
    NotificationService.notifyUser(target._id, {
      type: 'chat_transferred',
      message: handoverNote
        ? `${from.operatorName} transferred a conversation to you: ${handoverNote}`
        : `${from.operatorName} transferred a conversation to you`,
      sessionId: conversation.sessionId
    });

    socketManager.emitToOperators(conversation.company, 'chat-assigned', {
      sessionId: conversation.sessionId,
      operatorId: String(target._id),
      operatorName: targetName,
      from: from.operatorName
    });
    announceMessage(conversation, line);

    // The handover note is in the notes panel of everyone looking at it.
    const savedNote = conversation.notes[conversation.notes.length - 1];
    socketManager.emitToOperators(conversation.company, 'conversation-note', {
      sessionId: conversation.sessionId,
      note: {
        _id: String(savedNote._id),
        body: savedNote.body,
        author: String(savedNote.author),
        authorName: savedNote.authorName,
        system: true,
        createdAt: savedNote.createdAt
      }
    });

    // The visitor is told as well, so the widget can say who they are now
    // talking to instead of messages arriving under a new name unexplained.
    socketManager.emitToSession(conversation.sessionId, 'chat-transferred', {
      sessionId: conversation.sessionId,
      operatorName: targetName,
      timestamp: new Date()
    });

    logger.info('Conversation transferred', {
      sessionId: conversation.sessionId,
      from: from.operatorName,
      to: targetName
    });

    res.json({ success: true, operatorName: targetName, operatorId: String(target._id) });
  } catch (error) {
    logger.error('Error transferring conversation', { error });
    res.status(500).json({ error: 'Failed to transfer the conversation' });
  }
});

/**
 * Delete a conversation for good: the transcript, its notes and its files.
 *
 * Admins only. An operator could delete any conversation from every row of
 * the history, and the files stayed on disk although the dialog said they
 * went with it.
 */
router.delete('/chat/:sessionId', admin, async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    // Files first, while the messages still say which ones there are.
    const filesDeleted = await uploads.deleteFilesForConversation(conversation);

    await Conversation.deleteOne({ _id: conversation._id });

    logger.info('Conversation deleted', {
      sessionId: conversation.sessionId,
      filesDeleted,
      by: req.user.username
    });

    // Irreversible, and the transcript is gone with it, so this is exactly the
    // kind of thing someone asks about three months later.
    audit.record({
      req,
      action: 'conversation.deleted',
      company: conversation.company,
      target: { type: 'conversation', id: conversation.sessionId, label: conversation.sessionId },
      details: {
        messages: conversation.messages.length,
        files: filesDeleted,
        startedAt: conversation.startedAt
      }
    });

    // Anyone with it open, or in their queue, should stop seeing it.
    socketManager.emitToOperators(conversation.company, 'conversation-deleted', {
      sessionId: conversation.sessionId
    });

    res.json({ success: true, message: 'Chat deleted successfully', filesDeleted });
  } catch (error) {
    logger.error('Error deleting chat', { error });
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

/**
 * How it ended, from the request: `{outcome: {status, note}}`, or the same
 * two fields at the top level.
 *
 * @returns {{status?: string, note?: string}|{error: string}}
 */
function outcomeFrom(body = {}) {
  const source = body.outcome && typeof body.outcome === 'object' ? body.outcome : body;
  const status = typeof source.status === 'string' ? source.status : '';
  const note = typeof source.note === 'string' ? source.note.trim() : '';

  if (!status && !note) {
    return {};
  }
  if (status && !OUTCOMES.includes(status)) {
    return { error: 'Choose how the conversation ended' };
  }
  if (note.length > 500) {
    return { error: 'Keep the closing note under 500 characters' };
  }
  return { status: status || undefined, note: note || undefined };
}

const OUTCOME_LABELS = {
  resolved: 'Resolved',
  follow_up: 'Needs follow-up',
  unresolved: 'Not resolved',
  spam: 'Spam'
};

// End chat
router.post('/chat/:sessionId/end', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const outcome = outcomeFrom(req.body);
    if (outcome.error) {
      return res.status(400).json({ error: outcome.error });
    }

    if (!mayActOn(req, res, conversation)) {
      return;
    }

    // Decided before the operator fields are cleared, and before the save, so
    // the check sees the conversation as the visitor experienced it.
    // Only the widget can show a rating; email and the messaging apps cannot.
    const askForRating = (!conversation.channel || conversation.channel === 'chat') &&
      csatService.shouldRequestRating(conversation);
    const operatorName = req.user.displayName || req.user.username;
    const previousHolder = conversation.operatorId ? String(conversation.operatorId) : null;

    conversation.status = 'ended';
    conversation.endedAt = new Date();
    conversation.hasOperator = false;
    conversation.operatorId = null;
    conversation.operatorName = null;
    conversation.awaitingOperatorSince = undefined;
    // A visitor returning days later should not be answered as though they
    // were still half way through answering a workflow's question.
    conversation.workflowState = { awaiting: null, variables: {}, updatedAt: new Date() };

    if (outcome.status || outcome.note) {
      conversation.outcome = {
        status: outcome.status,
        note: outcome.note,
        by: req.user.id,
        at: new Date()
      };
    }

    if (askForRating) {
      conversation.ratingRequestedAt = new Date();
    }

    const line = systemLine(conversation, outcome.status
      ? `${operatorName} ended the conversation · ${OUTCOME_LABELS[outcome.status]}`
      : `${operatorName} ended the conversation`);

    await conversation.save();

    // The socket path told the visitor their chat had ended; this one did not,
    // so a chat closed from the dashboard left the widget looking live and the
    // customer waiting for a reply that was never coming.
    webhookService.dispatch(conversation.company, 'conversation.ended', {
      sessionId: conversation.sessionId,
      endedBy: 'operator',
      operatorName,
      messages: conversation.messages.filter(message => message.sender !== 'system').length,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      tags: conversation.tags || [],
      outcome: outcome.status || null
    });

    socketManager.emitToSession(conversation.sessionId, 'chat-ended', {
      code: 'chat_ended',
      params: {},
      message: 'This conversation has been ended by the operator.',
      requestRating: askForRating,
      timestamp: new Date()
    });

    // The queue drops it everywhere, as it does when the socket path ends one.
    socketManager.emitToOperators(conversation.company, 'chat-ended', {
      sessionId: conversation.sessionId,
      outcome: outcome.status || null,
      timestamp: new Date()
    });
    if (previousHolder) {
      socketManager.emitToOperators(conversation.company, 'operator-left', {
        sessionId: conversation.sessionId,
        operatorId: previousHolder,
        operatorName,
        timestamp: new Date()
      });
    }
    announceMessage(conversation, line);

    res.json({ success: true, message: 'Chat ended successfully', outcome: conversation.outcome || null });
  } catch (error) {
    logger.error('Error ending chat', { error });
    res.status(500).json({ error: 'Failed to end chat' });
  }
});

/**
 * Answer a visitor who has gone, by email.
 *
 * A chat that ended with a question unanswered - or a visitor who left a
 * message while nobody was free - used to be a dead end: the operator could
 * read it and do nothing. The email channel sends it, threads it, and records
 * it in the transcript.
 */
router.post('/chat/:sessionId/follow-up', async (req, res) => {
  try {
    const conversation = await loadScopedConversation(req, res);
    if (!conversation) {
      return;
    }

    const text = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Write the reply first' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: 'Keep the reply under 5000 characters' });
    }

    const emailChannel = require('../services/email-channel');
    if (typeof emailChannel.sendFollowUp !== 'function') {
      return res.status(501).json({ error: 'Replying by email is not available yet' });
    }

    const result = await emailChannel.sendFollowUp(conversation, text, req.user);

    if (!result || !result.sent) {
      return res.status(422).json({
        error: (result && result.reason) || 'The email could not be sent',
        reason: result && result.reason
      });
    }

    res.json({ success: true, sent: true, to: result.to || null });
  } catch (error) {
    logger.error('Error sending a follow-up email', { error: error.message });
    res.status(500).json({ error: 'Failed to send the email' });
  }
});

/**
 * The tenant a report is about, its timezone, and the match that scopes it.
 *
 * Company staff always see their own company. A superadmin picks one with
 * `?companyId=`; without it they get every tenant together, which is the
 * platform's view rather than anybody's report, and is said as much on the
 * screen.
 *
 * @returns {Promise<{match: object, companyId: string|null, company: object|null}|null>}
 *   null when the response has already been sent
 */
async function reportScope(req, res) {
  let companyId = null;

  if (req.user.role === 'superadmin') {
    if (req.query.companyId) {
      if (!mongoose.isValidObjectId(String(req.query.companyId))) {
        res.status(400).json({ error: 'That is not a company id' });
        return null;
      }
      companyId = String(req.query.companyId);
    }
  } else {
    if (!req.user.company) {
      res.status(400).json({ error: 'Your account is not linked to a company' });
      return null;
    }
    companyId = String(req.user.company.id);
  }

  const company = companyId
    ? await Company.findById(companyId).select('name businessHours.timezone reports').lean()
    : null;

  if (companyId && !company) {
    res.status(404).json({ error: 'Company not found' });
    return null;
  }

  return {
    match: req.user.role === 'superadmin'
      ? (companyId ? { company: new mongoose.Types.ObjectId(companyId) } : {})
      : companyMatch(req.user),
    companyId,
    company,
    timezone: (company && company.businessHours && company.businessHours.timezone) || 'UTC'
  };
}

/** The report window, in days: what was asked for, within reason. */
function reportDays(value, fallback) {
  return Math.min(365, Math.max(1, parseInt(value, 10) || fallback));
}

/**
 * Home's numbers and the top of Reports, for one window.
 *
 * `?days=` moves every number and chart together, and empty conversations
 * (a widget opened and closed) are not counted anywhere.
 */
router.get('/analytics', async (req, res) => {
  try {
    const scope = await reportScope(req, res);
    if (!scope) {
      return;
    }

    const days = reportDays(req.query.days, 7);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await analyticsService.overview(scope.match, days, { timezone: scope.timezone });

    res.json({
      ...data,
      // Satisfaction is returned on every plan. It is the customer's own
      // verdict on the tenant's own service - gating it behind an upgrade
      // would hide from a trial the one number that tells them whether any of
      // this is working. The breakdowns (per operator, bot vs human, the
      // comments) stay in the advanced report.
      satisfaction: await csatService.summary(analyticsService.engaged(scope.match), since)
        .catch(() => null),
      company: scope.company ? { id: scope.company._id, name: scope.company.name } : null
    });
  } catch (error) {
    logger.error('Error fetching analytics', { error });
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});

/**
 * Deeper analytics: deflection, abandonment, staffing, operator performance,
 * recurring topics and task throughput.
 *
 * Gated on the plan's analytics tier - it is a headline feature of the paid
 * plans, and the queries are heavier than the basic dashboard's.
 */
router.get('/analytics/advanced', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      const subscription = await usageService.getSubscription(req.user.company?.id);
      const tier = require('../config/plans').getPlan(subscription.planId).features.analytics;

      if (tier !== 'advanced') {
        return res.status(402).json({
          error: 'Advanced analytics are available on the Professional plan and above.',
          code: 'FEATURE_NOT_IN_PLAN',
          feature: 'analytics'
        });
      }
    }

    const scope = await reportScope(req, res);
    if (!scope) {
      return;
    }

    const days = reportDays(req.query.days, 30);
    res.json(await analyticsService.advanced(req.user, days, { match: scope.match, timezone: scope.timezone }));
  } catch (error) {
    logger.error('Error building advanced analytics', { error });
    res.status(500).json({ error: 'Failed to build analytics' });
  }
});

/**
 * The value report: what the bot resolved, the hours that saved and what each
 * resolution cost. On every plan, because it is the case for paying at all.
 */
async function valueReport(req, res) {
  const scope = await reportScope(req, res);
  if (!scope) {
    return null;
  }

  const days = reportDays(req.query.days, 30);
  let monthlyPrice = null;

  if (scope.companyId) {
    const subscription = await usageService.getSubscription(scope.companyId);
    monthlyPrice = require('../config/plans').getPlan(subscription.planId).price;
  }

  return analyticsService.value(scope.match, days, {
    minutesPerConversation: scope.company && scope.company.reports
      ? scope.company.reports.minutesPerConversation
      : undefined,
    monthlyPrice
  });
}

router.get('/analytics/value', async (req, res) => {
  try {
    const report = await valueReport(req, res);
    if (report) {
      res.json(report);
    }
  } catch (error) {
    logger.error('Error building the value report', { error });
    res.status(500).json({ error: 'Failed to build the value report' });
  }
});

/** The value report as a CSV, for whoever has to put it in a slide. */
router.get('/analytics/value/export', async (req, res) => {
  try {
    const report = await valueReport(req, res);
    if (!report) {
      return;
    }

    const escapeCsv = value => `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
    const rows = [
      ['Metric', 'Value', 'How it is counted'],
      ['Period (days)', report.days, `From ${new Date(report.since).toISOString().slice(0, 10)}`],
      ['Conversations', report.conversations, 'Conversations where the visitor wrote at least once'],
      ['Resolved by the bot', report.botResolved, report.definition.botResolved],
      ['Resolution rate (%)', report.resolutionRate, 'Resolved by the bot ÷ conversations'],
      ['Handed to a person', report.handedOver, report.definition.handedOver],
      ['Minutes per conversation', report.minutesPerConversation, 'Set on the Reports screen'],
      ['Hours saved', report.hoursSaved, report.definition.hoursSaved],
      ['AI replies', report.aiReplies, report.definition.aiReplies],
      ['Cost per resolution', report.costPerResolution, report.definition.costPerResolution],
      ['Satisfaction, bot (% 4 or 5)', report.csatBot ? report.csatBot.csat : '', report.csatBot ? `${report.csatBot.rated} ratings` : ''],
      ['Satisfaction, person (% 4 or 5)', report.csatHuman ? report.csatHuman.csat : '', report.csatHuman ? `${report.csatHuman.rated} ratings` : '']
    ];

    const csv = rows.map(row => row.map(escapeCsv).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bot-value-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  } catch (error) {
    logger.error('Error exporting the value report', { error });
    res.status(500).json({ error: 'Failed to export the value report' });
  }
});

/**
 * How Reports values the bot's time. A company's own number, because a
 * dentist's receptionist and a software support engineer do not spend the
 * same six minutes on a question.
 */
router.put('/analytics/settings', admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const minutes = Number(req.body && req.body.minutesPerConversation);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      return res.status(400).json({ error: 'Choose a whole number of minutes between 1 and 240' });
    }

    const company = await Company.findById(req.user.company.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const previous = company.reports && company.reports.minutesPerConversation;
    company.reports = { ...(company.reports ? company.reports.toObject() : {}), minutesPerConversation: minutes };
    await company.save();

    audit.record({
      req,
      action: 'reports.settings_changed',
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { minutesPerConversation: { from: previous, to: minutes } }
    });

    res.json({ minutesPerConversation: minutes });
  } catch (error) {
    logger.error('Error saving report settings', { error });
    res.status(500).json({ error: 'Failed to save the report settings' });
  }
});

/**
 * The history as CSV: what the History screen shows, with the same search and
 * filters, for an admin.
 *
 * It is every customer's name, address and transcript summary in one file, so
 * it is admin-only and audited; and every cell was typed by a stranger, so the
 * file is built to be opened in a spreadsheet safely (utils/csv-export.js).
 */
router.get('/export', admin, async (req, res) => {
  try {
    const { type = 'conversations' } = req.query;

    if (type !== 'conversations') {
      return res.status(400).json({ error: 'Unsupported export type' });
    }

    const filter = await historyFilter(req);
    const conversations = await Conversation.aggregate([
      { $match: filter },
      { $sort: { startedAt: -1 } },
      { $limit: 5000 },
      { $project: HISTORY_PROJECTION }
    ]);
    const contacts = await contactsFor(conversations);
    const rows = conversations.map(chat =>
      historyRow(chat, chat.contact ? contacts.get(String(chat.contact)) : null));

    const header = [
      'Session ID', 'Started At', 'Ended At', 'Status', 'Channel', 'Domain',
      'Customer Name', 'Customer Email', 'Customer Phone', 'Handled By', 'Operators',
      'Outcome', 'Outcome Note', 'Rating', 'Rating Comment', 'Tags', 'Messages'
    ];

    const lines = rows.map(row => [
      row.sessionId,
      row.startedAt ? new Date(row.startedAt).toISOString() : '',
      row.endedAt ? new Date(row.endedAt).toISOString() : '',
      row.status,
      row.channel,
      row.domain,
      row.userName,
      row.email,
      row.phone,
      row.handledBy === 'person' ? 'Person' : 'Bot',
      row.operators.join('; '),
      row.outcome ? OUTCOME_LABELS[row.outcome] : '',
      row.outcomeNote,
      row.rating,
      row.ratingComment,
      row.tags.join('; '),
      row.messageCount
    ]);

    const filters = ['search', 'from', 'to', 'channel', 'status', 'handledBy', 'rating', 'outcome', 'tag']
      .reduce((applied, key) => {
        const value = queryString(req.query[key]);
        if (value) {
          applied[key] = value.slice(0, 100);
        }
        return applied;
      }, {});

    // Customer data leaving the product is exactly what an audit is for.
    audit.record({
      req,
      action: 'conversations.exported',
      target: { type: 'export', id: 'conversations', label: 'Conversation history' },
      details: { rows: lines.length, filters }
    });

    const filename = `conversations-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(header, lines));
  } catch (error) {
    logger.error('Error exporting data', { error });
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Get operators for task assignment
router.get('/operators', async (req, res) => {
  try {
    const query = { role: 'operator', isActive: true, ...companyFilter(req.user) };

    const operators = await User.find(
      query,
      { _id: 1, username: 1, displayName: 1, email: 1, company: 1 }
    ).populate('company', 'name');

    res.json({ operators });
  } catch (error) {
    logger.error('Error fetching operators', { error });
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

// Only the team routes below use these, so they are required beside them.
const team = require('../services/team');
const { checkLimit } = require('../middleware/quota');

/**
 * Shape a member of staff for the team screen. Never the password, the token
 * hashes, or anything else the person did not choose to show colleagues.
 */
function presentMember(user, viewer) {
  const company = user.company && user.company._id ? user.company : null;
  return {
    _id: user._id,
    username: user.username,
    displayName: user.displayName,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    invitePending: Boolean(user.invitePending),
    inviteExpires: user.invitePending ? user.inviteExpires : undefined,
    inviteExpired: Boolean(user.invitePending && user.inviteExpires && user.inviteExpires < new Date()),
    maxConcurrentChats: user.maxConcurrentChats ?? null,
    acceptingChats: user.acceptingChats !== false,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    isSelf: Boolean(viewer && String(viewer.id) === String(user._id)),
    company: company ? { id: company._id, name: company.name } : null
  };
}

/**
 * Everyone on the team, for the team screen: operators and admins, active,
 * deactivated and invited. Removed people are gone from it.
 *
 * Admin only. It carries everybody's address, which a colleague answering
 * chats has no use for.
 */
router.get('/all-operators', admin, async (req, res) => {
  try {
    const query = {
      role: { $in: ['operator', 'company_admin'] },
      deletedAt: { $exists: false },
      ...companyFilter(req.user)
    };

    const people = await User.find(query)
      .select('username displayName name email role isActive invitePending inviteExpires maxConcurrentChats acceptingChats createdAt lastLogin company')
      .populate('company', 'name')
      .sort({ invitePending: -1, role: 1, displayName: 1, username: 1 });

    res.json({ operators: people.map(person => presentMember(person, req.user)) });
  } catch (error) {
    logger.error('Error fetching operators', { error });
    res.status(500).json({ error: 'Failed to retrieve operators' });
  }
});

/**
 * Everything below manages operator accounts. Plain operators must not be able
 * to create accounts, change roles, or reset their colleagues' passwords, so
 * these routes require admin (company_admin or superadmin) privileges.
 */
router.use('/operators', admin);

/**
 * Who is connected and taking chats right now, for Home.
 *
 * Read from the socket rooms, as the widget's "is anyone there?" is, so the
 * two cannot disagree.
 */
router.get('/operators/online', async (req, res) => {
  try {
    const companyId = req.user.role === 'superadmin'
      ? (req.query.companyId ? String(req.query.companyId) : null)
      : (req.user.company ? String(req.user.company.id) : null);

    if (!companyId || !mongoose.isValidObjectId(companyId)) {
      return res.json({ online: [] });
    }

    const availabilityService = require('../services/availability');
    const ids = availabilityService.connectedOperatorIds(companyId);

    if (ids.length === 0) {
      return res.json({ online: [] });
    }

    const [people, load] = await Promise.all([
      User.find({ _id: { $in: ids }, isActive: true })
        .select('username displayName role acceptingChats maxConcurrentChats').lean(),
      Conversation.aggregate([
        {
          $match: {
            company: new mongoose.Types.ObjectId(companyId),
            status: 'active',
            operatorId: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) }
          }
        },
        { $group: { _id: '$operatorId', count: { $sum: 1 } } }
      ])
    ]);

    const chats = new Map(load.map(row => [String(row._id), row.count]));

    res.json({
      online: people.map(person => ({
        id: person._id,
        name: person.displayName || person.username,
        role: person.role,
        acceptingChats: person.acceptingChats !== false,
        chats: chats.get(String(person._id)) || 0,
        maxConcurrentChats: person.maxConcurrentChats ?? null
      }))
    });
  } catch (error) {
    logger.error('Error listing who is online', { error });
    res.status(500).json({ error: 'Failed to list who is online' });
  }
});

/**
 * Load a managed user, enforcing that company admins stay within their company.
 *
 * @param {object} [options]
 * @param {boolean} [options.pendingAdmins] let a company admin act on a fellow
 *   admin who has not accepted their invitation yet - resending or revoking
 *   an invitation is not acting on a peer's account, because nobody is in it
 */
async function loadManagedOperator(req, res, options = {}) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Operator not found' });
    return null;
  }

  const target = await User.findById(req.params.id).populate('company');

  if (!target || target.deletedAt) {
    res.status(404).json({ error: 'Operator not found' });
    return null;
  }

  const targetCompanyId = target.company ? target.company._id : null;
  if (!canAccessCompany(req.user, targetCompanyId)) {
    res.status(403).json({ error: 'You can only manage users from your own company' });
    return null;
  }

  // A company admin manages operators. Their fellow admins are peers, not
  // reports: letting one rename, re-address or deactivate another is how one
  // compromised admin account becomes all of them.
  const pendingPeer = options.pendingAdmins && target.invitePending;
  if (req.user.role !== 'superadmin' && target.role !== 'operator' && !pendingPeer) {
    res.status(403).json({ error: 'Company admins can only manage operators' });
    return null;
  }

  return target;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Roles the team screen can give: an operator, or another admin. */
const TEAM_ROLES = ['operator', 'company_admin'];

/**
 * Run the operators quota check for a user who is being switched from
 * inactive to active. Deactivated accounts do not occupy a seat, so
 * reactivating one is the same billable act as creating one.
 *
 * @returns {Promise<boolean>} true when the request may proceed; false when
 *   the quota middleware has already answered with a 402.
 */
function seatAvailable(req, res) {
  return new Promise(resolve => {
    enforceLimit('operators')(req, res, () => resolve(true));
    // enforceLimit either calls next or ends the response.
    res.once('finish', () => resolve(false));
  });
}

/**
 * Apply an `isActive` change, refusing a reactivation the plan has no seat
 * for. Sends the response itself on refusal. Only operators are seats, so an
 * admin comes back without one.
 *
 * @returns {Promise<boolean>} whether the caller should continue
 */
async function applyActivation(req, res, target, isActive) {
  const wanted = Boolean(isActive);

  if (!target.isActive && wanted && target.role === 'operator' && !(await seatAvailable(req, res))) {
    return false;
  }

  target.isActive = wanted;
  return true;
}

/**
 * The company a new member of staff joins: the admin's own, or - for a
 * superadmin - the one they named. Sends the response itself on refusal.
 */
async function targetCompany(req, res, companyId) {
  if (companyId) {
    if (typeof companyId !== 'string' || !mongoose.isValidObjectId(companyId)) {
      res.status(400).json({ error: 'Company not found' });
      return null;
    }
    if (!canAccessCompany(req.user, companyId)) {
      res.status(403).json({ error: 'You can only create operators for your own company' });
      return null;
    }
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(400).json({ error: 'Company not found' });
      return null;
    }
    return company;
  }

  if (req.user.role === 'company_admin' && req.user.company) {
    return Company.findById(req.user.company.id);
  }

  res.status(400).json({ error: 'Company is required' });
  return null;
}

/**
 * Invite somebody to the team.
 *
 * The way people join now: an email with a link where they choose their own
 * password, so nobody has to send one over chat. An operator holds a seat
 * from the moment they are invited; another admin does not.
 */
router.post('/operators/invite', async (req, res) => {
  try {
    const { email, name, companyId } = req.body || {};
    const role = (req.body && req.body.role) || 'operator';

    if (!TEAM_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Choose operator or admin' });
    }

    const company = await targetCompany(req, res, companyId);
    if (!company) {
      return;
    }

    if (role === 'operator' && req.user.role !== 'superadmin') {
      const seat = await checkLimit(company._id, 'operators');
      if (!seat.allowed) {
        await usageService.recordLimitHit(company._id);
        return res.status(402).json({
          error: seat.reason,
          code: 'PLAN_LIMIT_REACHED',
          meter: 'operators',
          limit: seat.limit,
          used: seat.used,
          planId: seat.planId
        });
      }
    }

    const result = await team.invite({
      email: requireString(email),
      name,
      role,
      company,
      invitedBy: req.user
    });

    audit.record({
      req,
      action: 'operator.invited',
      company: company._id,
      target: { type: 'user', id: String(result.user._id), label: result.user.displayName || result.user.email },
      details: { role, email: result.user.email, emailed: result.sent }
    });

    result.user.company = company;
    res.status(201).json({
      success: true,
      operator: presentMember(result.user, req.user),
      inviteSent: result.sent,
      // Only when the email could not go: the admin can pass it on by hand.
      inviteLink: result.link
    });
  } catch (error) {
    if (error instanceof team.TeamError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error('Error inviting a teammate', { error });
    res.status(500).json({ error: 'Failed to send the invitation' });
  }
});

/** Send an invitation again, with a fresh link and a fresh week. */
router.post('/operators/:id/resend-invite', async (req, res) => {
  try {
    const target = await loadManagedOperator(req, res, { pendingAdmins: true });
    if (!target) {
      return;
    }

    const result = await team.resendInvite(target, {
      companyName: target.company && target.company.name,
      inviterName: req.user.displayName || req.user.username
    });

    audit.record({
      req,
      action: 'operator.invite_resent',
      company: target.company ? target.company._id : null,
      target: { type: 'user', id: String(target._id), label: target.displayName || target.email },
      details: { emailed: result.sent }
    });

    res.json({ success: true, inviteSent: result.sent, inviteLink: result.link });
  } catch (error) {
    if (error instanceof team.TeamError) {
      return res.status(error.status).json({ error: error.message });
    }
    logger.error('Error resending an invitation', { error });
    res.status(500).json({ error: 'Failed to resend the invitation' });
  }
});

/**
 * Withdraw an invitation. Nobody ever signed in to the account, so it is
 * deleted outright and its seat and address are free again.
 */
router.delete('/operators/:id/invite', async (req, res) => {
  try {
    const target = await loadManagedOperator(req, res, { pendingAdmins: true });
    if (!target) {
      return;
    }

    if (!target.invitePending) {
      return res.status(409).json({ error: 'This person has already accepted; deactivate or remove them instead' });
    }

    await User.deleteOne({ _id: target._id });

    audit.record({
      req,
      action: 'operator.invite_revoked',
      company: target.company ? target.company._id : null,
      target: { type: 'user', id: String(target._id), label: target.displayName || target.email },
      details: { email: target.email, role: target.role }
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error revoking an invitation', { error });
    res.status(500).json({ error: 'Failed to withdraw the invitation' });
  }
});

/**
 * Create an account with a password the admin chooses.
 *
 * The secondary way in, for a team that would rather hand somebody a password
 * than wait on an email. An operator takes a seat; another admin does not, so
 * the plan is only consulted for operators.
 */
router.post('/operators', async (req, res) => {
  try {
    const { password, confirmPassword, name, displayName, companyId } = req.body;
    const role = req.body.role || 'operator';
    const email = requireString(req.body.email);
    let username = req.body.username === undefined || req.body.username === ''
      ? undefined
      : requireString(req.body.username);
    const currentUser = req.user;

    if (!TEAM_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Choose operator or admin' });
    }

    if (username === null || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Email, password, and confirm password are required' });
    }

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Email address is not valid' });
    }

    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    if (role === 'operator' && !(await seatAvailable(req, res))) {
      return;
    }

    if (!username) {
      username = await team.usernameFromEmail(email);
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email: String(email).toLowerCase() }]
    });

    if (existingUser) {
      return res.status(400).json({
        error: 'User with this username or email already exists'
      });
    }

    const company = await targetCompany(req, res, companyId);
    if (!company) {
      return;
    }

    const newOperator = new User({
      username,
      name,
      displayName: displayName || name,
      email,
      password,
      role,
      company: company._id,
      isActive: true,
      createdBy: currentUser.id
    });

    await newOperator.save();

    audit.record({
      req,
      action: 'operator.created',
      company: company._id,
      target: { type: 'user', id: String(newOperator._id), label: newOperator.displayName || newOperator.username },
      details: { role, email: newOperator.email }
    });

    newOperator.company = company;
    res.status(201).json({
      success: true,
      message: 'Operator created successfully',
      operator: presentMember(newOperator, req.user)
    });
  } catch (error) {
    logger.error('Error creating operator', { error });
    res.status(500).json({ error: 'Failed to create operator' });
  }
});

/**
 * Turn the deactivation into what an admin means by it: the person is signed
 * out everywhere, their dashboard disconnects, and their conversations go back
 * to the queue rather than waiting on somebody who has gone.
 */
async function afterDeactivation(target) {
  try {
    return await team.lockOut(target);
  } catch (error) {
    logger.error('Could not complete a deactivation', { userId: String(target._id), error: error.message });
    return { released: 0, disconnected: false };
  }
}

// Update operator status (active/inactive)
router.patch('/operators/:id', async (req, res) => {
  try {
    const { isActive } = req.body;

    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive status is required' });
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    if (String(target._id) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const wasActive = target.isActive;

    if (!(await applyActivation(req, res, target, isActive))) {
      return;
    }
    await target.save();

    const effect = wasActive && !target.isActive ? await afterDeactivation(target) : null;

    audit.record({
      req,
      action: target.isActive ? 'operator.activated' : 'operator.deactivated',
      company: target.company,
      target: { type: 'user', id: String(target._id), label: target.displayName || target.username },
      details: effect ? { chatsReturnedToQueue: effect.released } : undefined
    });

    res.json({
      success: true,
      message: `Operator ${target.isActive ? 'activated' : 'deactivated'} successfully`,
      chatsReturnedToQueue: effect ? effect.released : 0,
      operator: presentMember(target, req.user)
    });
  } catch (error) {
    logger.error('Error updating operator status', { error });
    res.status(500).json({ error: 'Failed to update operator status' });
  }
});

// Update operator details
const OPERATOR_UPDATE_FIELDS = [
  'username', 'name', 'displayName', 'email', 'isActive', 'role', 'companyId', 'maxConcurrentChats'
];

router.put('/operators/:id', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Anything not on the list is refused rather than ignored. Ignoring is how
    // a `password` or `tokenVersion` slipped in here would go unnoticed for
    // exactly as long as it did nothing.
    const unknown = Object.keys(body).filter(field => !OPERATOR_UPDATE_FIELDS.includes(field));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown field: ${unknown.join(', ')}` });
    }

    const { name, displayName, role, companyId, isActive, maxConcurrentChats } = body;
    const email = requireString(body.email);
    const currentUser = req.user;

    if (!email) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    if (body.username !== undefined && !requireString(body.username)) {
      return res.status(400).json({ error: 'Username and email are required' });
    }

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Email address is not valid' });
    }

    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be true or false' });
    }

    if (companyId !== undefined && companyId !== null && typeof companyId !== 'string') {
      return res.status(400).json({ error: 'Company not found' });
    }

    // Null means "use the company's setting"; otherwise a whole number of
    // conversations, the same bounds as the company-wide limit.
    if (maxConcurrentChats !== undefined && maxConcurrentChats !== null && maxConcurrentChats !== '') {
      const value = Number(maxConcurrentChats);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        return res.status(400).json({ error: 'Choose a chat limit between 1 and 20, or leave it empty to use the team setting' });
      }
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    const username = body.username === undefined ? target.username : body.username;

    if (currentUser.role === 'company_admin') {
      if (role && !TEAM_ROLES.includes(role)) {
        return res.status(403).json({ error: 'Company admins can only manage operators' });
      }
      if (companyId && !canAccessCompany(currentUser, companyId)) {
        return res.status(403).json({ error: 'Company admins can only assign operators to their own company' });
      }
    }

    if (String(target._id) === String(currentUser.id) && isActive === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const existingUser = await User.findOne({
      $and: [
        { _id: { $ne: target._id } },
        { $or: [{ username }, { email: String(email).toLowerCase() }] }
      ]
    });

    if (existingUser) {
      if (existingUser.username === username) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
      return res.status(400).json({ error: 'Email is already taken' });
    }

    let company = target.company;
    const newRole = role || target.role;

    if (newRole === 'superadmin' && currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmins can create other superadmins' });
    }

    if (companyId && (newRole === 'company_admin' || newRole === 'operator')) {
      company = await Company.findById(companyId);
      if (!company) {
        return res.status(400).json({ error: 'Company not found' });
      }
    } else if (!companyId && (newRole === 'company_admin' || newRole === 'operator') && !target.company) {
      return res.status(400).json({ error: 'Company is required for company admin and operator roles' });
    }

    const previousRole = target.role;
    const wasActive = target.isActive;

    if (isActive !== undefined && !(await applyActivation(req, res, target, isActive))) {
      return;
    }

    target.username = username;
    if (name !== undefined) {
      target.name = name;
    }
    if (displayName !== undefined) {
      target.displayName = displayName;
    }
    target.email = email;

    if (maxConcurrentChats !== undefined) {
      target.maxConcurrentChats = maxConcurrentChats === null || maxConcurrentChats === ''
        ? null
        : Number(maxConcurrentChats);
    }

    if (role && (currentUser.role === 'superadmin' || (currentUser.role === 'company_admin' && TEAM_ROLES.includes(role)))) {
      target.role = role;
    }

    if (newRole === 'superadmin') {
      target.company = null;
    } else if (company) {
      target.company = company._id;
    }

    const roleChanged = previousRole !== target.role;

    await target.save();

    const effect = wasActive && !target.isActive ? await afterDeactivation(target) : null;

    audit.record({
      req,
      action: effect ? 'operator.deactivated' : roleChanged ? 'operator.role_changed' : 'operator.updated',
      company: target.company,
      target: { type: 'user', id: String(target._id), label: target.displayName || target.username },
      // A privilege change is the entry people come looking for, so the before
      // and after are both recorded rather than only the result.
      details: roleChanged
        ? { from: previousRole, to: target.role }
        : { email: target.email, maxConcurrentChats: target.maxConcurrentChats }
    });

    res.json({
      success: true,
      message: 'Operator details updated successfully',
      operator: {
        _id: target._id,
        username: target.username,
        displayName: target.displayName,
        name: target.name,
        email: target.email,
        role: target.role,
        maxConcurrentChats: target.maxConcurrentChats ?? null,
        company: company ? {
          id: company._id,
          name: company.name
        } : null,
        isActive: target.isActive
      }
    });
  } catch (error) {
    logger.error('Error updating operator details', { error });
    res.status(500).json({ error: 'Failed to update operator details' });
  }
});

/**
 * Remove somebody from the team.
 *
 * Deactivated and anonymised rather than deleted: the conversations, notes and
 * audit entries they are part of keep pointing at the account. An invitation
 * nobody accepted has no such history and is simply withdrawn.
 */
router.delete('/operators/:id', async (req, res) => {
  try {
    const target = await loadManagedOperator(req, res, { pendingAdmins: true });
    if (!target) {
      return;
    }

    if (String(target._id) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot remove your own account' });
    }

    const label = target.displayName || target.username;
    const email = target.email;

    if (target.invitePending) {
      await User.deleteOne({ _id: target._id });
      audit.record({
        req,
        action: 'operator.invite_revoked',
        company: target.company ? target.company._id : null,
        target: { type: 'user', id: String(target._id), label },
        details: { email }
      });
      return res.json({ success: true, removed: 'invitation' });
    }

    const effect = await team.softDelete(target);

    audit.record({
      req,
      action: 'operator.deleted',
      company: target.company ? target.company._id : null,
      target: { type: 'user', id: String(target._id), label },
      details: { email, role: target.role, chatsReturnedToQueue: effect.released }
    });

    res.json({ success: true, removed: 'account', chatsReturnedToQueue: effect.released });
  } catch (error) {
    logger.error('Error removing a teammate', { error });
    res.status(500).json({ error: 'Failed to remove them' });
  }
});

// Reset operator password
router.post('/operators/:id/reset-password', async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;

    if (!password || !confirmPassword) {
      return res.status(400).json({ error: 'Password and confirm password are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const target = await loadManagedOperator(req, res);
    if (!target) {
      return;
    }

    if (target.role !== 'operator' && req.user.role !== 'superadmin') {
      return res.status(400).json({ error: 'User is not an operator' });
    }

    target.password = password;
    // Whatever sessions the old password had opened end with it, and so does
    // an invitation nobody has used: the admin has chosen the password now.
    target.tokenVersion = (target.tokenVersion || 0) + 1;
    target.invitePending = false;
    target.inviteTokenHash = undefined;
    target.inviteExpires = undefined;
    await target.save();
    team.disconnect(target._id, 'password_changed');

    audit.record({
      req,
      action: 'operator.password_reset',
      company: target.company ? target.company._id : null,
      target: { type: 'user', id: String(target._id), label: target.displayName || target.username }
    });

    res.json({
      success: true,
      message: 'Operator password reset successfully'
    });
  } catch (error) {
    logger.error('Error resetting operator password', { error });
    res.status(500).json({ error: 'Failed to reset operator password' });
  }
});

module.exports = router;
