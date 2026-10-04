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
const crypto = require('crypto');
const multer = require('multer');
const { logger } = require('./logging');

const MAX_FILE_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;

/**
 * Types a support conversation legitimately needs. Everything else is refused:
 * an allowlist is the only reliable way to keep executable content out. One
 * list for both directions, so an operator cannot send a visitor anything a
 * visitor could not have sent them.
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

/**
 * Raster image types by extension, for showing a thumbnail. SVG is absent on
 * purpose: it can carry script, and it is not on the upload allowlist either.
 */
const IMAGE_TYPES_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

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

/**
 * A multer instance for one file in memory, held to the allowlist and the
 * size cap. Memory rather than disk so nothing is written until the caller
 * has decided the upload is allowed at all.
 */
function createUploadParser() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    fileFilter(req, file, cb) {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error(`Files of type ${file.mimetype} are not accepted`));
      }
      cb(null, true);
    }
  });
}

/**
 * Translate a multer error into the response a client can show. Returns
 * false when the error is not one of ours to answer.
 */
function sendUploadError(err, res) {
  if (!err) {
    return false;
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      success: false,
      error: `Files must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`
    });
    return true;
  }
  res.status(400).json({ success: false, error: err.message });
  return true;
}

/** The original name, reduced to something safe to keep as metadata. */
function cleanFileName(originalName) {
  return path.basename(String(originalName || 'file')).slice(0, 255) || 'file';
}

/**
 * Write one file under its company and return the id it is stored as. The
 * stored name is the random id only; the original filename is never part of
 * a path, so it cannot be used for traversal.
 */
async function storeFile(companyId, buffer) {
  const fileId = crypto.randomBytes(16).toString('hex');
  const targetDir = companyDir(companyId);
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, fileId), buffer);
  return fileId;
}

/** Where a file is downloaded from, relative to the server. */
function downloadPath(fileId) {
  return `/api/upload/${fileId}`;
}

/** The image type of a file name, or null when it is not a raster image. */
function imageTypeFor(fileName) {
  return IMAGE_TYPES_BY_EXTENSION[path.extname(String(fileName || '')).toLowerCase()] || null;
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
  MAX_FILE_BYTES,
  ALLOWED_MIME_TYPES,
  createUploadParser,
  sendUploadError,
  cleanFileName,
  storeFile,
  downloadPath,
  imageTypeFor,
  UPLOAD_ROOT,
  companyDir,
  filePath,
  deleteFilesForConversation,
  deleteFilesForSession,
  deleteCompanyFiles,
  purgeCompanyData
};
