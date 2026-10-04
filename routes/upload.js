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
const usageService = require('../services/usage');
const sessionToken = require('../services/session-token');
// The layout on disk is owned by services/uploads.js, so the erasure and
// retention paths that remove files agree with this route about where they are.
const { UPLOAD_ROOT, companyDir, filePath } = require('../services/uploads');

const router = express.Router();

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

    const conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
    if (!conversation) {
      // Requiring an existing conversation stops this being an anonymous
      // upload endpoint for anyone who can guess the URL.
      return res.status(404).json({ success: false, error: 'No conversation for this session' });
    }

    // A session id is not a credential: it appears in dashboard URLs and
    // exports. A conversation that was issued a token only accepts writes
    // from whoever holds it; one without (legacy data) is left as it was.
    if (conversation.sessionTokenHash
        && !sessionToken.verify(conversation.sessionTokenHash, req.body.sessionToken)) {
      return res.status(403).json({ success: false, error: 'This session is not yours to write to' });
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

    // The uploader is an anonymous visitor, so the plan is resolved from the
    // conversation's tenant rather than from req.user, and the quota
    // middleware (which reads req.user) cannot be used here.
    if (companyId && !(await usageService.hasFeature(companyId, 'fileUploads'))) {
      return res.status(402).json({
        success: false,
        error: 'File uploads are not available on this plan',
        code: 'FEATURE_NOT_IN_PLAN'
      });
    }

    const fileId = crypto.randomBytes(16).toString('hex');
    const targetDir = companyDir(companyId);
    fs.mkdirSync(targetDir, { recursive: true });

    // The stored name is the random id only. The original filename is never
    // part of a path, so it cannot be used for traversal.
    await fs.promises.writeFile(path.join(targetDir, fileId), req.file.buffer);

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

    usageService.record(companyId, { filesUploaded: 1, fileBytes: req.file.size });

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

    const target = filePath(conversation.company, fileId);

    if (!target || !fs.existsSync(target)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Always download, never render: an uploaded HTML or SVG file must not be
    // able to execute script on this origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      `attachment; filename="${(message.fileName || 'download').replace(/["\\]/g, '')}"`);

    fs.createReadStream(target).pipe(res);
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
