const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const Contact = require('../models/contact');
const Task = require('../models/task');
const WebhookDelivery = require('../models/webhook-delivery');
const uploads = require('../services/uploads');
const { auth, admin } = require('../middleware/auth');
const { logger } = require('../services/logging');
const { companyFilter } = require('../utils/query');
const audit = require('../services/audit');

const router = express.Router();

/**
 * Find the data subject behind an identifier.
 *
 * This used to be `{ userId: req.params.userId }`. `Conversation.userId` is
 * declared and indexed but *nothing in the application ever writes it*, so
 * every data-subject request matched zero documents: the export produced an
 * empty file, and - much worse - the erasure answered `success: true, "Deleted
 * 0 conversations"` and wrote an audit entry saying an erasure had been
 * carried out. Reporting a completed erasure that never happened is the one
 * failure mode this route must not have.
 *
 * A person is reachable by their Contact record - by its id, or by the email,
 * external id or session ids on it - by a bare `sessionId` for a visitor who
 * never became a contact, and by the legacy `userId`. Whichever the caller
 * supplied, the answer is every contact and every conversation that belongs
 * to that person, because a request to be forgotten is about the person and
 * not about the one session the officer happened to have to hand.
 *
 * @returns {Promise<object|null>} `{ query, contacts, contactIds, sessionIds }`,
 *          or null when the identifier matches no subject - which callers must
 *          treat as "say so", never as "nothing to delete".
 */
async function findSubject(req) {
  const identifier = String(req.params.userId || '').trim();
  const scope = companyFilter(req.user);

  if (!identifier) {
    return null;
  }

  const byContact = [
    { email: identifier.toLowerCase() },
    { externalId: identifier },
    { sessionIds: identifier }
  ];

  if (mongoose.Types.ObjectId.isValid(identifier)) {
    byContact.push({ _id: identifier });
  }

  const contacts = await Contact.find({ $or: byContact, ...scope }).lean();
  const contactIds = contacts.map(contact => contact._id);

  // Every session the person is known by: the one asked about, plus every
  // one their contact record has collected across devices.
  const sessionIds = new Set([identifier]);
  contacts.forEach(contact => (contact.sessionIds || []).forEach(id => sessionIds.add(id)));

  const query = {
    $or: [
      { contact: { $in: contactIds } },
      { sessionId: { $in: Array.from(sessionIds) } },
      { userId: identifier }
    ],
    ...scope
  };

  if (contacts.length === 0 && !(await Conversation.exists(query))) {
    return null;
  }

  return { query, contacts, contactIds, sessionIds: Array.from(sessionIds) };
}

/** The same "we could not identify this person" answer everywhere. */
function unknownSubject(res, identifier) {
  return res.status(404).json({
    error: `No data found for "${identifier}". Use a contact id, email, external id or session id.`
  });
}

/**
 * A conversation as it is handed to the person it is about: everything we
 * hold on them, and nothing about the operators who handled it beyond their
 * display names in the transcript.
 */
function portableConversation(conv) {
  const attachments = [];

  const messages = (conv.messages || []).map(msg => {
    if (msg.fileName || msg.fileId) {
      attachments.push({ fileId: msg.fileId, fileName: msg.fileName, at: msg.timestamp });
    }
    (msg.attachments || []).forEach(attachment => {
      attachments.push({ fileName: attachment.filename, mimeType: attachment.mimeType, at: msg.timestamp });
    });

    return {
      content: msg.content,
      sender: msg.sender,
      timestamp: msg.timestamp,
      fileName: msg.fileName || undefined
    };
  });

  return {
    sessionId: conv.sessionId,
    channel: conv.channel,
    startedAt: conv.startedAt,
    endedAt: conv.endedAt,
    status: conv.status,
    // What the visitor told us about themselves on the pre-chat form. Lean
    // queries return the Map as a plain object.
    metadata: conv.metadata || {},
    email: conv.email ? { from: conv.email.from, to: conv.email.to, subject: conv.email.subject } : undefined,
    rating: conv.rating && conv.rating.score !== undefined
      ? { score: conv.rating.score, comment: conv.rating.comment, ratedAt: conv.rating.ratedAt }
      : undefined,
    workflowAnswers: conv.workflowState ? conv.workflowState.variables : undefined,
    attachments,
    messages
  };
}

function portableContact(contact) {
  return {
    id: String(contact._id),
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    externalId: contact.externalId,
    identityLevel: contact.identityLevel,
    attributes: contact.attributes || {},
    tags: contact.tags || [],
    sessionIds: contact.sessionIds || [],
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt
  };
}

// Get user data
router.get('/user-data/:userId', auth, admin, async (req, res) => {
  try {
    const subject = await findSubject(req);

    if (!subject) {
      return unknownSubject(res, req.params.userId);
    }

    const conversations = await Conversation.find(subject.query).lean();

    // Reading somebody's whole conversation history is worth recording even
    // though it changes nothing: this is the request a data protection officer
    // is asked to account for.
    audit.record({
      req,
      action: 'gdpr.data_read',
      target: { type: 'subject', id: req.params.userId, label: req.params.userId },
      details: { conversations: conversations.length, contacts: subject.contacts.length }
    });

    res.json({ conversations, contacts: subject.contacts });
  } catch (error) {
    logger.error('Error retrieving user data', { error });
    res.status(500).json({ error: 'Failed to retrieve user data' });
  }
});

/**
 * Erase one person, everywhere they are, within the caller's tenant.
 *
 * Deleting the conversations alone was never an erasure. The same person is
 * also the Contact record, the files they sent (on disk, outside the
 * database), the contact details copied onto tasks raised about them, and the
 * webhook deliveries that carried their messages to the tenant's own systems.
 * Each is handled in the way that fits it: tasks are anonymised rather than
 * deleted, because the work an operator did is the tenant's record, and only
 * the part that names the customer has to go.
 *
 * @returns {Promise<object>} what was removed, for the response and the audit
 *          entry - which is the only record of the erasure left afterwards.
 */
async function eraseSubject(req, subject) {
  const scope = companyFilter(req.user);
  const conversations = await Conversation.find(subject.query)
    .select('_id sessionId company contact messages.fileId')
    .lean();

  const conversationIds = conversations.map(conv => conv._id);
  const sessionIds = new Set(subject.sessionIds);
  conversations.forEach(conv => sessionIds.add(conv.sessionId));

  // Files while the messages still say which ones exist.
  let filesDeleted = 0;
  for (const conversation of conversations) {
    filesDeleted += await uploads.deleteFilesForConversation(conversation);
  }

  const tasks = await Task.updateMany(
    { conversationId: { $in: conversationIds }, ...scope },
    { $unset: { 'contactInfo.name': 1, 'contactInfo.email': 1, 'contactInfo.phone': 1 } }
  );

  const webhookDeliveries = await WebhookDelivery.deleteMany({
    ...scope,
    $or: [
      { 'payload.sessionId': { $in: Array.from(sessionIds) } },
      { 'payload.contactId': { $in: subject.contactIds.map(String) } }
    ]
  });

  const deletedConversations = await Conversation.deleteMany({ _id: { $in: conversationIds } });
  const deletedContacts = await Contact.deleteMany({ _id: { $in: subject.contactIds }, ...scope });

  return {
    conversationsDeleted: deletedConversations.deletedCount || 0,
    contactsDeleted: deletedContacts.deletedCount || 0,
    filesDeleted,
    tasksAnonymized: tasks.modifiedCount || 0,
    webhookDeliveriesDeleted: webhookDeliveries.deletedCount || 0
  };
}

// Delete user data (GDPR right to be forgotten)
router.delete('/user-data/:userId', auth, admin, async (req, res) => {
  try {
    const subject = await findSubject(req);

    // Refusing is the honest answer when we cannot identify the person. The
    // alternative - deleting nothing and reporting success - tells a data
    // protection officer the request was carried out when it was not.
    if (!subject) {
      return unknownSubject(res, req.params.userId);
    }

    const result = await eraseSubject(req, subject);

    logger.info('GDPR erasure performed', {
      subject: req.params.userId,
      ...result,
      by: req.user.username
    });

    // The erasure destroys the evidence of itself, so the audit entry is the
    // only remaining record that it was carried out — which is precisely what
    // a regulator asks for.
    audit.record({
      req,
      action: 'gdpr.erased',
      target: { type: 'subject', id: req.params.userId, label: req.params.userId },
      details: result
    });

    res.json({
      success: true,
      message: `Deleted ${result.conversationsDeleted} conversations`,
      deletedCount: result.conversationsDeleted,
      ...result
    });
  } catch (error) {
    logger.error('Error deleting user data', { error });
    res.status(500).json({ error: 'Failed to delete user data' });
  }
});

// Export user data (GDPR right to data portability)
router.get('/export/:userId', auth, admin, async (req, res) => {
  try {
    const { userId } = req.params;
    const subject = await findSubject(req);

    if (!subject) {
      return unknownSubject(res, userId);
    }

    const conversations = await Conversation.find(subject.query).lean();

    audit.record({
      req,
      action: 'gdpr.exported',
      target: { type: 'subject', id: userId, label: userId },
      details: { conversations: conversations.length, contacts: subject.contacts.length }
    });

    const exportData = {
      userId,
      exportDate: new Date(),
      contacts: subject.contacts.map(portableContact),
      conversations: conversations.map(portableConversation)
    };

    // Sanitise the id before putting it in a header to avoid response splitting.
    const safeId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="user-data-${safeId}.json"`);

    res.json(exportData);
  } catch (error) {
    logger.error('Error exporting user data', { error });
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// Get privacy policy
router.get('/privacy-policy', (req, res) => {
  res.sendFile('privacy-policy.html', { root: './public' });
});

// Update consent preferences for the current chat session
router.post('/consent', async (req, res) => {
  try {
    const { marketing = false, analytics = false, storage = false } = req.body;

    if (!req.session) {
      return res.status(400).json({ error: 'No active session' });
    }

    const preferences = {
      marketing: Boolean(marketing),
      analytics: Boolean(analytics),
      storage: Boolean(storage),
      recordedAt: new Date()
    };

    // Persist on the session so the widget and server agree on what the visitor
    // agreed to, and mirror it onto the conversation for audit purposes.
    req.session.consent = preferences;

    if (req.session.sessionId) {
      await Conversation.updateOne(
        { sessionId: req.session.sessionId },
        { $set: { 'metadata.consent': JSON.stringify(preferences) } }
      );
    }

    res.json({
      success: true,
      message: 'Consent preferences updated',
      preferences
    });
  } catch (error) {
    logger.error('Error updating consent preferences', { error });
    res.status(500).json({ error: 'Failed to update consent preferences' });
  }
});

module.exports = router;
