/**
 * Where uploaded files live, and how they leave.
 *
 * `routes/upload.js` writes files to `uploads/<companyId>/<fileId>` and keeps
 * the original name only as metadata on the message. That layout used to be
 * known to the route alone, which meant nothing else could remove a file: an
 * erasure deleted the conversation and left the attachment on disk, and the
 * retention sweep did the same. A file a visitor sent is as much their data as
 * anything they typed, so every path that removes a conversation removes its
 * files through here.
 *
 * Deleting a file that is already gone is not an error. The message record
 * may outlive the file (a manual clean-up, a restore from a backup that never
 * held the uploads directory), and a scrub that stops at the first missing
 * file leaves everything after it behind.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logging');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

/** Conversations with no tenant share one directory. */
const UNASSIGNED = 'unassigned';

/** A stored file id is 16 random bytes as hex; anything else is not ours. */
const FILE_ID = /^[a-f0-9]{32}$/;

function companyDir(companyId) {
  return path.join(UPLOAD_ROOT, companyId ? String(companyId) : UNASSIGNED);
}

/**
 * The on-disk path of one file, or null when the id is not a file id. The
 * check is here rather than in each caller because a fileId reaches this
 * from the database, and a database is not a trust boundary.
 */
function filePath(companyId, fileId) {
  if (!FILE_ID.test(String(fileId || ''))) {
    return null;
  }
  return path.join(companyDir(companyId), fileId);
}

async function unlinkQuietly(target) {
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Could not delete an uploaded file', { file: target, error: error.message });
    }
    return false;
  }
}

/** Every file id a conversation's messages refer to. */
function fileIdsOf(conversation) {
  const messages = (conversation && conversation.messages) || [];
  return messages.map(message => message && message.fileId).filter(Boolean);
}

/**
 * Remove every file attached to one conversation.
 *
 * Accepts a document or a lean object; it only needs `company` and the
 * messages' `fileId`s.
 *
 * @returns {Promise<number>} files actually removed
 */
async function deleteFilesForConversation(conversation) {
  if (!conversation) {
    return 0;
  }

  let removed = 0;

  for (const fileId of fileIdsOf(conversation)) {
    const target = filePath(conversation.company, fileId);
    if (target && await unlinkQuietly(target)) {
      removed += 1;
    }
  }

  return removed;
}

/**
 * Remove the files of one session, looked up within a company.
 *
 * The company is part of the lookup rather than read off the conversation so
 * a caller scoped to one tenant cannot reach another tenant's files with a
 * guessed session id.
 */
async function deleteFilesForSession(companyId, sessionId) {
  const Conversation = require('../models/conversation');
  const scope = companyId ? { company: companyId } : { company: { $exists: false } };
  const conversation = await Conversation.findOne({ ...scope, sessionId })
    .select('company messages.fileId')
    .lean();

  return deleteFilesForConversation(conversation);
}

/**
 * Remove a company's whole upload directory.
 *
 * @returns {Promise<boolean>} whether there was anything to remove
 */
async function deleteCompanyFiles(companyId) {
  if (!companyId) {
    // "No company" is the shared directory, and one tenant leaving is not a
    // reason to empty it.
    return false;
  }

  const dir = companyDir(companyId);

  if (!fs.existsSync(dir)) {
    return false;
  }

  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Everything a company left behind, gone.
 *
 * The company document itself is deliberately not deleted here: the caller
 * that owns the company route decides that, and may want to keep the record
 * while emptying it. What this removes is the data the tenant's customers
 * gave them, which no longer has anyone to answer for it once the tenant is
 * gone.
 *
 * @returns {Promise<object>} how many of each were removed
 */
async function purgeCompanyData(companyId) {
  if (!companyId) {
    throw new Error('A company id is required to purge');
  }

  const Conversation = require('../models/conversation');
  const Contact = require('../models/contact');
  const Task = require('../models/task');
  const WebhookDelivery = require('../models/webhook-delivery');
  const KnowledgeChunk = require('../models/knowledge-chunk');
  const Usage = require('../models/usage');
  const Subscription = require('../models/subscription');

  const scope = { company: companyId };
  const count = result => (result && result.deletedCount) || 0;

  // Files first, while the directory is still the only thing that needs
  // removing: nothing here depends on the database rows that go next.
  const files = await deleteCompanyFiles(companyId);

  const [conversations, contacts, tasks, webhookDeliveries, knowledgeChunks, usage, subscriptions] =
    await Promise.all([
      Conversation.deleteMany(scope),
      Contact.deleteMany(scope),
      Task.deleteMany(scope),
      WebhookDelivery.deleteMany(scope),
      KnowledgeChunk.deleteMany(scope),
      Usage.deleteMany(scope),
      Subscription.deleteMany(scope)
    ]);

  const result = {
    companyId: String(companyId),
    files,
    conversations: count(conversations),
    contacts: count(contacts),
    tasks: count(tasks),
    webhookDeliveries: count(webhookDeliveries),
    knowledgeChunks: count(knowledgeChunks),
    usage: count(usage),
    subscriptions: count(subscriptions)
  };

  logger.warn('Purged a company\'s data', result);
  return result;
}

module.exports = {
  UPLOAD_ROOT,
  companyDir,
  filePath,
  deleteFilesForConversation,
  deleteFilesForSession,
  deleteCompanyFiles,
  purgeCompanyData
};
