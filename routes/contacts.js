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
const contactService = require('../services/contacts');
const { auth, operator, admin } = require('../middleware/auth');
const { companyFilter, containsRegex, parsePagination, canAccessCompany } = require('../utils/query');
const { logger } = require('../services/logging');

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
    tags: contact.tags || [],
    attributes: contact.attributes
      ? (contact.attributes instanceof Map
        ? Object.fromEntries(contact.attributes)
        : contact.attributes)
      : {},
    conversationCount: contact.conversationCount || 0,
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt
  };
}

// List and search
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
    const conditions = [companyFilter(req.user)];

    if (req.query.search) {
      const term = containsRegex(req.query.search);
      conditions.push({ $or: [{ name: term }, { email: term }, { phone: term }] });
    }

    if (req.query.tag) {
      conditions.push({ tags: String(req.query.tag).toLowerCase() });
    }

    if (req.query.verified === 'true') {
      conditions.push({ identityLevel: 'verified' });
    }

    const query = conditions.filter(c => Object.keys(c).length > 0);
    const filter = query.length ? { $and: query } : {};

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
 * One person, with the conversations they have had.
 *
 * This is the view that did not exist before: an operator answering someone
 * can see what the same customer asked last week, on a different device.
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
          messageCount: { $size: { $ifNull: ['$messages', []] } },
          lastMessage: { $last: '$messages.content' }
        }
      }
    ]);

    res.json({ contact: present(contact), conversations });
  } catch (error) {
    logger.error('Failed to load contact', { error: error.message });
    res.status(500).json({ error: 'Failed to load the contact' });
  }
});

// Edit the details an operator can correct by hand
router.put('/:id', async (req, res) => {
  try {
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

    res.json({ contact: present(contact) });
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

    await contactService.mergeInto(target, source);

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
        python: "hmac.new(SECRET.encode(), str(user_id).encode(), hashlib.sha256).hexdigest()",
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

    res.json({ secret: company.identitySecret });
  } catch (error) {
    logger.error('Failed to rotate identity secret', { error: error.message });
    res.status(500).json({ error: 'Failed to rotate the secret' });
  }
});

module.exports = router;
