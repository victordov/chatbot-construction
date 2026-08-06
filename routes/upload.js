/**
 * File uploads from the chat widget.
 *
 * The widget has always had an attachment button that posted to `/api/upload`,
 * but the route never existed, so every attempt failed silently. This
 * implements it, and the matching download route the widget links to.
 *
 * Design notes:
 *  - Files are stored on disk under `uploads/<companyId>/`, keyed by a random
 *    id. The original filename is kept only as metadata, never used as a path,
 *    so a name like `../../server.js` cannot escape the directory.
 *  - Downloads require an authenticated operator scoped to the file's company,
 *    or the visitor whose own session uploaded it. A bare id is not enough.
 *  - Content is always served as an attachment with a fixed content type, so a
 *    visitor cannot upload an HTML file and have it execute on this origin.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const Conversation = require('../models/conversation');
const tenantService = require('../services/tenant');
const { auth, operator } = require('../middleware/auth');
const { canAccessCompany } = require('../utils/query');
const { logger } = require('../services/logging');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const MAX_FILE_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;

/**
 * Types a support conversation legitimately needs. Everything else is refused:
 * an allowlist is the only reliable way to keep executable content out.
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

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Files of type ${file.mimetype} are not accepted`));
    }
    cb(null, true);
  }
});

/**
 * Upload a file against the caller's chat session.
 *
 * Unauthenticated by design - the uploader is a website visitor - but bound to
 * a session that must already have a conversation, so it cannot be used as an
 * open file drop.
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const sessionId = req.body.sessionId || (req.session && req.session.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'No active session' });
    }

    const conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      // Requiring an existing conversation stops this being an anonymous
      // upload endpoint for anyone who can guess the URL.
      return res.status(404).json({ success: false, error: 'No conversation for this session' });
    }

    // Attribute the file to the same tenant as the conversation.
    let companyId = conversation.company;
    if (!companyId) {
      companyId = await tenantService.resolveCompanyId({
        widgetKey: req.body.widgetKey,
        origin: req.get('Origin') || req.get('Referer')
      });
      if (companyId) {
        conversation.company = companyId;
      }
    }

    const fileId = crypto.randomBytes(16).toString('hex');
    const companyDir = path.join(UPLOAD_ROOT, companyId ? companyId.toString() : 'unassigned');
    fs.mkdirSync(companyDir, { recursive: true });

    // The stored name is the random id only. The original filename is never
    // part of a path, so it cannot be used for traversal.
    await fs.promises.writeFile(path.join(companyDir, fileId), req.file.buffer);

    const originalName = path.basename(req.file.originalname).slice(0, 255);

    conversation.messages.push({
      content: `[File uploaded: ${originalName}]`,
      sender: 'user',
      fileId,
      fileName: originalName,
      timestamp: new Date()
    });
    conversation.lastActivity = new Date();
    await conversation.save();

    logger.info('File uploaded', {
      fileId,
      sessionId,
      size: req.file.size,
      mimeType: req.file.mimetype
    });

    res.json({
      success: true,
      fileId,
      fileName: originalName,
      size: req.file.size,
      url: `/api/upload/${fileId}`
    });
  } catch (error) {
    logger.error('File upload failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to store the file' });
  }
});

/**
 * Download a previously uploaded file.
 *
 * Either an operator of the owning company, or the visitor whose session the
 * file belongs to.
 */
router.get('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    // A path segment must be a plain hex id; reject anything else outright
    // rather than relying on path.join to normalise it away.
    if (!/^[a-f0-9]{32}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    const conversation = await Conversation.findOne(
      { 'messages.fileId': fileId },
      { sessionId: 1, company: 1, 'messages.$': 1 }
    );

    if (!conversation) {
      return res.status(404).json({ error: 'File not found' });
    }

    const message = conversation.messages[0];
    const isOwnSession = req.session && req.session.sessionId === conversation.sessionId;

    if (!isOwnSession) {
      // Not the uploader, so authenticate as staff of the owning company.
      const token = req.header('x-auth-token');
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      await new Promise((resolve, reject) => {
        auth(req, res, err => (err ? reject(err) : resolve()));
      });

      if (!req.user || !canAccessCompany(req.user, conversation.company)) {
        return res.status(404).json({ error: 'File not found' });
      }
    }

    const companyDir = conversation.company ? conversation.company.toString() : 'unassigned';
    const filePath = path.join(UPLOAD_ROOT, companyDir, fileId);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Always download, never render: an uploaded HTML or SVG file must not be
    // able to execute script on this origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      `attachment; filename="${(message.fileName || 'download').replace(/["\\]/g, '')}"`);

    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    logger.error('File download failed', { error: error.message });
    res.status(500).json({ error: 'Failed to read the file' });
  }
});

// Multer surfaces size/type problems as errors; translate them into something
// the widget can show the visitor.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `Files must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`
    });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

module.exports = router;
module.exports.operatorGuard = [auth, operator];
