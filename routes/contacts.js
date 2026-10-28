/**
 * People, as opposed to conversations.
 *
 * Everything here is scoped to the caller's company by the query itself, not
 * by a check after the fetch, so a guessed id cannot reach another tenant's
 * customer records.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const Company = require('../models/company');
const Task = require('../models/task');
const { toCsv } = require('../utils/csv-export');
const contactService = require('../services/contacts');
const { auth, operator, admin } = require('../middleware/auth');
const { companyFilter, containsRegex, parsePagination, canAccessCompany } = require('../utils/query');
const { logger } = require('../services/logging');
const audit = require('../services/audit');

router.use(auth, operator);

/**
 * Shape a contact for the dashboard. `attributes` is a Map on the document.
 */
function present(contact) {
  return {
    _id: contact._id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    identityLevel: contact.identityLevel,
    // Surfaced explicitly: an operator about to discuss an account needs to
    // know whether this person's identity was proven or merely typed in.
    verified: contact.identityLevel === 'verified',
    externalId: contact.externalId,
    // How it was proven: signed by the tenant (jwt / hmac) or an email code.
    // An operator may discuss an account with the first, a booking with the
    // second, and should know which they have.
    verifiedBy: contact.identityLevel === 'verified' ? (contact.verifiedBy || (contact.externalId ? 'hmac' : null)) : null,
    verifiedAt: contact.verifiedAt,
    tags: contact.tags || [],
    attributes: contact.attributes
      ? (contact.attributes instanceof Map
        ? Object.fromEntries(contact.attributes)
        : contact.attributes)
      : {},
    // The same, saying which values the tenant signed (and so can be trusted).
    attributeList: contactService.attributeList(contact),
    conversationCount: contact.conversationCount || 0,
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt
  };
}

/** The list's filter, from the query string; shared with the export. */
function listFilter(req) {
  const conditions = [companyFilter(req.user)];

  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    const term = containsRegex(req.query.search.trim());
    conditions.push({ $or: [{ name: term }, { email: term }, { phone: term }] });
  }

  if (typeof req.query.tag === 'string' && req.query.tag.trim()) {
    conditions.push({ tags: req.query.tag.trim().toLowerCase() });
  }

  if (req.query.verified === 'true') {
    conditions.push({ identityLevel: 'verified' });
  }

  const query = conditions.filter(c => Object.keys(c).length > 0);
  return query.length ? { $and: query } : {};
}

// List and search
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
    const filter = listFilter(req);

    const [contacts, total] = await Promise.all([
      Contact.find(filter).sort({ lastSeenAt: -1 }).skip(skip).limit(limit),
      Contact.countDocuments(filter)
    ]);

    res.json({
      contacts: contacts.map(present),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
    });
  } catch (error) {
    logger.error('Failed to list contacts', { error: error.message });
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

/**
 * The tags people carry, most used first, for the list's tag filter.
 */
router.get('/tags', async (req, res) => {
  try {
    const scope = companyFilter(req.user);
    const match = scope.company
      ? { company: new mongoose.Types.ObjectId(String(scope.company)) }
      : scope;

    const rows = await Contact.aggregate([
      { $match: { ...match, tags: { $exists: true, $ne: [] } } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 }
    ]);

    res.json({ tags: rows.map(row => ({ tag: row._id, count: row.count })) });
  } catch (error) {
    logger.error('Failed to list contact tags', { error: error.message });
    res.status(500).json({ error: 'Failed to load the tags' });
  }
});

/**
 * Everyone, as CSV, with the list's search and filters.
 *
 * A file of every customer's name, address and phone number: admin-only and
 * audited, and built to be opened in a spreadsheet safely - a visitor who
 * calls themselves `=HYPERLINK(...)` stays text (utils/csv-export.js).
 */
router.get('/export', admin, async (req, res) => {
  try {
    const contacts = await Contact.find(listFilter(req)).sort({ lastSeenAt: -1 }).limit(10000).lean();

    const header = [
      'Name', 'Email', 'Phone', 'Identity', 'External ID', 'Tags',
      'Conversations', 'First Seen', 'Last Seen'
    ];
    const rows = contacts.map(contact => [
      contact.name,
      contact.email,
      contact.phone,
      contact.identityLevel,
      contact.externalId,
      (contact.tags || []).join('; '),
      contact.conversationCount || 0,
      contact.firstSeenAt ? new Date(contact.firstSeenAt).toISOString() : '',
      contact.lastSeenAt ? new Date(contact.lastSeenAt).toISOString() : ''
    ]);

    audit.record({
      req,
      action: 'contacts.exported',
      target: { type: 'export', id: 'contacts', label: 'People' },
      details: {
        rows: rows.length,
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : undefined,
        tag: typeof req.query.tag === 'string' ? req.query.tag.slice(0, 40) : undefined,
        verified: req.query.verified === 'true' || undefined
      }
    });

    const filename = `people-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(header, rows));
  } catch (error) {
    logger.error('Failed to export contacts', { error: error.message });
    res.status(500).json({ error: 'Failed to export people' });
  }
});

/**
 * One person, with the conversations they have had.
 *
 * This is the view that did not exist before: an operator answering someone
 * can see what the same customer asked last week, on a different device -
 * and, on the timeline, the tasks raised about them and how they rated us.
 */
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = await Contact.findOne({ _id: req.params.id, ...companyFilter(req.user) });

    if (!contact) {
      // 404 rather than 403: a 403 would confirm the contact exists.
      return res.status(404).json({ error: 'Contact not found' });
    }

    // What was said, without the operator-only event lines.
    const spoken = {
      $filter: {
        input: { $ifNull: ['$messages', []] },
        as: 'm',
        cond: { $ne: ['$$m.sender', 'system'] }
      }
    };

    const conversations = await Conversation.aggregate([
      { $match: { contact: contact._id } },
      { $sort: { startedAt: -1 } },
      { $limit: 50 },
      {
        $project: {
          sessionId: 1,
          startedAt: 1,
          endedAt: 1,
          status: 1,
          channel: 1,
          operatorName: 1,
          'rating.score': 1,
          'rating.comment': 1,
          'rating.ratedAt': 1,
          'outcome.status': 1,
          messageCount: { $size: spoken },
          lastMessage: {
            $substrCP: [
              { $ifNull: [{ $let: { vars: { last: { $last: spoken } }, in: '$$last.content' } }, ''] },
              0,
              200
            ]
          }
        }
      }
    ]);

    // Tasks about this person: raised from one of their conversations, or
    // carrying their address.
    const taskConditions = [{ conversationId: { $in: conversations.map(c => c._id) } }];
    if (contact.email) {
      taskConditions.push({ 'contactInfo.email': contact.email });
    }
    const tasks = await Task.find({ ...companyFilter(req.user), $or: taskConditions })
      .select('title status priority dueDate createdAt assigneeName createdByBot conversationId')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const timeline = [
      ...conversations.map(conversation => ({
        type: 'conversation',
        at: conversation.startedAt,
        sessionId: conversation.sessionId,
        status: conversation.status,
        channel: conversation.channel || 'chat',
        messageCount: conversation.messageCount,
        summary: conversation.lastMessage || null,
        outcome: conversation.outcome && conversation.outcome.status ? conversation.outcome.status : null
      })),
      ...conversations
        .filter(conversation => conversation.rating && conversation.rating.score)
        .map(conversation => ({
          type: 'rating',
          at: conversation.rating.ratedAt || conversation.endedAt || conversation.startedAt,
          sessionId: conversation.sessionId,
          score: conversation.rating.score,
          comment: conversation.rating.comment || null
        })),
      ...tasks.map(task => ({
        type: 'task',
        at: task.createdAt,
        taskId: String(task._id),
        title: task.title,
        status: task.status,
        dueDate: task.dueDate,
        assignee: task.assigneeName || null,
        createdByBot: Boolean(task.createdByBot)
      }))
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    res.json({
      contact: present(contact),
      conversations: conversations.map(conversation => ({
        ...conversation,
        rating: undefined,
        outcome: undefined,
        ratingScore: conversation.rating && conversation.rating.score ? conversation.rating.score : null,
        outcomeStatus: conversation.outcome && conversation.outcome.status ? conversation.outcome.status : null
      })),
      tasks,
      timeline
    });
  } catch (error) {
    logger.error('Failed to load contact', { error: error.message });
    res.status(500).json({ error: 'Failed to load the contact' });
  }
});

// Edit the details an operator can correct by hand
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = await Contact.findOne({ _id: req.params.id, ...companyFilter(req.user) });

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const { name, email, phone, tags, attributes } = req.body;

    if (email !== undefined) {
      const trimmed = String(email).trim();
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      contact.email = trimmed.toLowerCase() || undefined;
    }

    if (name !== undefined) {
      contact.name = String(name).trim() || undefined;
    }
    if (phone !== undefined) {
      contact.phone = String(phone).trim() || undefined;
    }

    if (Array.isArray(tags)) {
      contact.tags = [...new Set(
        tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean)
      )];
    }

    if (attributes && typeof attributes === 'object') {
      contact.attributes = new Map(
        Object.entries(attributes).map(([key, value]) => [String(key), String(value)])
      );
    }

    // Editing by hand never grants verification: an operator typing an email
    // is not the tenant vouching for an identity.
    await contact.save();

    // Somebody else with the same address is usually the same person twice -
    // a second device, a session before they gave their email. Said, so the
    // dashboard can offer to merge them, rather than refused: two people can
    // share an inbox.
    const duplicates = contact.email
      ? await Contact.find({
        company: contact.company,
        email: contact.email,
        _id: { $ne: contact._id }
      }).select('name email conversationCount').limit(5).lean()
      : [];

    res.json({
      contact: present(contact),
      duplicates: duplicates.map(duplicate => ({
        _id: String(duplicate._id),
        name: duplicate.name || null,
        email: duplicate.email,
        conversationCount: duplicate.conversationCount || 0
      }))
    });
  } catch (error) {
    logger.error('Failed to update contact', { error: error.message });
    res.status(500).json({ error: 'Failed to update the contact' });
  }
});

/**
 * Fold one person into another, for the duplicates that arise when somebody
 * uses two email addresses.
 */
router.post('/:id/merge', async (req, res) => {
  try {
    const { sourceId } = req.body;

    if (!sourceId || !mongoose.Types.ObjectId.isValid(sourceId)) {
      return res.status(400).json({ error: 'Choose a contact to merge in' });
    }

    if (sourceId === req.params.id) {
      return res.status(400).json({ error: 'A contact cannot be merged into itself' });
    }

    // Both sides are fetched with the tenant filter, so a cross-tenant merge
    // is impossible rather than merely discouraged.
    const [target, source] = await Promise.all([
      Contact.findOne({ _id: req.params.id, ...companyFilter(req.user) }),
      Contact.findOne({ _id: sourceId, ...companyFilter(req.user) })
    ]);

    if (!target || !source) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const sourceLabel = source.name || source.email || String(source._id);
    const movedConversations = source.conversationCount || 0;

    await contactService.mergeInto(target, source);

    // One record is gone for good and another now owns its history; someone
    // will want to know who decided that.
    audit.record({
      req,
      action: 'contact.merged',
      company: target.company,
      target: { type: 'contact', id: String(target._id), label: target.name || target.email || String(target._id) },
      details: {
        mergedFrom: String(sourceId),
        mergedFromLabel: sourceLabel,
        conversations: movedConversations
      }
    });

    res.json({ success: true, contact: present(target) });
  } catch (error) {
    logger.error('Failed to merge contacts', { error: error.message });
    res.status(500).json({ error: 'Failed to merge the contacts' });
  }
});

/**
 * The identity secret, and how to use it.
 *
 * Admin only, and returned in full because a tenant has to copy it into their
 * own backend. It is never sent to a browser widget.
 */
router.get('/identity/secret', admin, async (req, res) => {
  try {
    if (!req.user.company) {
      return res.status(400).json({ error: 'Your account is not linked to a company' });
    }

    const company = await Company.findById(req.user.company.id).select('+identitySecret');

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (!company.identitySecret) {
      // Companies created before identity verification existed have none yet.
      company.rotateIdentitySecret();
      await company.save();
    }

    res.json({
      secret: company.identitySecret,
      // Worked examples beat prose for something a developer has to implement
      // exactly right, in a language we do not know.
      examples: {
        node: "crypto.createHmac('sha256', SECRET).update(String(userId)).digest('hex')",
        ruby: "OpenSSL::HMAC.hexdigest('sha256', SECRET, user_id.to_s)",
        python: 'hmac.new(SECRET.encode(), str(user_id).encode(), hashlib.sha256).hexdigest()',
        php: "hash_hmac('sha256', (string) $userId, SECRET)"
      }
    });
  } catch (error) {
    logger.error('Failed to load identity secret', { error: error.message });
    res.status(500).json({ error: 'Failed to load the identity secret' });
  }
});

router.post('/identity/secret/rotate', admin, async (req, res) => {
  try {
    const company = await Company.findById(req.user.company.id).select('+identitySecret');

    if (!company || !canAccessCompany(req.user, company._id)) {
      return res.status(404).json({ error: 'Company not found' });
    }

    company.rotateIdentitySecret();
    await company.save();

    logger.info('Identity secret rotated', {
      companyId: company._id.toString(),
      by: req.user.username
    });

    // The value is never recorded, only that it changed: rotating invalidates
    // every signature the tenant's backend is currently producing, so somebody
    // needs to be able to find out when that happened and who did it.
    audit.record({
      req,
      action: 'identity_secret.rotated',
      company: company._id,
      target: { type: 'company', id: String(company._id), label: company.name }
    });

    res.json({ secret: company.identitySecret });
  } catch (error) {
    logger.error('Failed to rotate identity secret', { error: error.message });
    res.status(500).json({ error: 'Failed to rotate the secret' });
  }
});

module.exports = router;
