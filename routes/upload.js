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
const fs = require('fs');

const Conversation = require('../models/conversation');
const tenantService = require('../services/tenant');
const { auth, operator } = require('../middleware/auth');
const { canAccessCompany } = require('../utils/query');
const { logger } = require('../services/logging');
const usageService = require('../services/usage');
const sessionToken = require('../services/session-token');
const lifecycle = require('../services/conversation-lifecycle');
const socketManager = require('../socketManager');
const { notice } = require('../services/visitor-notices');
// The layout on disk, the MIME allowlist and the size cap are owned by
// services/uploads.js, so the operator attachment route, erasure and
// retention all agree with this one about what a file is and where it lives.
const uploads = require('../services/uploads');
const { UPLOAD_ROOT, filePath } = uploads;

const router = express.Router();

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const upload = uploads.createUploadParser();

/** What services/session-token.js issues: 32 bytes as hex. */
const SESSION_TOKEN_FORMAT = /^[0-9a-f]{64}$/;

/**
 * Start the conversation an upload is the first sign of.
 *
 * A widget's session has no conversation until the visitor does something
 * (websockets.js), and attaching a file is something. The visitor already
 * holds the token their connection was given; it becomes this conversation's,
 * exactly as a first message would make it. No token, no conversation - so
 * this still cannot be used as an open file drop.
 *
 * @returns {Promise<{conversation?: object, created?: boolean,
 *                    status?: number, body?: object}>}
 */
async function startForUpload(req, sessionId) {
  const presented = req.body.sessionToken;
  if (typeof presented !== 'string' || !SESSION_TOKEN_FORMAT.test(presented)) {
    return { status: 404, body: { success: false, error: 'No conversation for this session' } };
  }

  const origin = req.get('Origin') || req.get('Referer');
  const companyId = await tenantService.resolveCompanyId({ widgetKey: req.body.widgetKey, origin });

  // Checked before anything is created: a conversation started only to be
  // refused its first file would be counted for nothing.
  if (companyId && !(await usageService.hasFeature(companyId, 'fileUploads'))) {
    return {
      status: 402,
      body: { success: false, error: 'File uploads are not available on this plan', code: 'FEATURE_NOT_IN_PLAN' }
    };
  }

  const result = await lifecycle.createConversation({
    sessionId,
    companyId,
    domain: origin || undefined,
    sessionTokenHash: sessionToken.hash(presented)
  });

  if (result.refused) {
    const unavailable = notice('unavailable');
    return { status: 403, body: { success: false, error: unavailable.message, ...unavailable } };
  }

  if (result.duplicate) {
    // Started by the visitor's own message a moment ago; the token check
    // below decides whether it is theirs.
    return { conversation: await Conversation.findOne({ sessionId }).select('+sessionTokenHash'), created: false };
  }

  return { conversation: result.conversation, created: true };
}

/**
 * Upload a file against the caller's chat session.
 *
 * Unauthenticated by design - the uploader is a website visitor - but bound to
 * a session and the token issued for it, so it cannot be used as an open file
 * drop.
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

    let conversation = await Conversation.findOne({ sessionId }).select('+sessionTokenHash');
    let created = false;

    if (!conversation) {
      const started = await startForUpload(req, sessionId);
      if (!started.conversation) {
        return res.status(started.status || 404).json(started.body ||
          { success: false, error: 'No conversation for this session' });
      }
      conversation = started.conversation;
      created = started.created;
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

    const fileId = await uploads.storeFile(companyId, req.file.buffer);
    const originalName = uploads.cleanFileName(req.file.originalname);

    conversation.messages.push({
      content: `[File uploaded: ${originalName}]`,
      sender: 'user',
      fileId,
      fileName: originalName,
      timestamp: new Date()
    });
    // A multipart field arrives as text; `{given, at, text}` as JSON text.
    let consent = req.body.consent;
    if (typeof consent === 'string' && consent.trim().startsWith('{')) {
      try {
        consent = JSON.parse(consent);
      } catch {
        consent = undefined;
      }
    }
    lifecycle.recordConsent(conversation, consent);

    conversation.lastActivity = new Date();
    await conversation.save();

    usageService.record(companyId, { filesUploaded: 1, fileBytes: req.file.size });

    // Operators see the file arrive as they see every other stored message;
    // a conversation this upload started is announced like any other.
    const emit = {
      visitor: (event, payload) => socketManager.emitToVisitor(sessionId, event, payload),
      operators: (event, payload) => socketManager.emitToOperators(companyId, event, payload)
    };
    lifecycle.announceMessages(conversation, [conversation.messages[conversation.messages.length - 1]], emit);
    if (created) {
      await lifecycle.announceStart(conversation, { preview: `[File uploaded: ${originalName}]`, emit });
    }

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
      url: uploads.downloadPath(fileId)
    });
  } catch (error) {
    logger.error('File upload failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to store the file' });
  }
});

/**
 * Whether the request carries the visitor credentials of this conversation:
 * its session id and the token issued for it, as query parameters (a link
 * cannot set headers) or as `x-session-id` / `x-session-token` headers.
 *
 * The widget runs on the tenant's site, so the session cookie that the older
 * check relies on is a third-party cookie there and is often blocked; the
 * token is what the widget actually holds. The query-string name contains
 * "token" on purpose: the request logger redacts such parameters.
 */
async function hasVisitorCredentials(req, conversation) {
  const claimedSession = req.query.sessionId || req.get('x-session-id');
  const presentedToken = req.query.sessionToken || req.get('x-session-token');

  if (!claimedSession || !presentedToken || claimedSession !== conversation.sessionId) {
    return false;
  }

  const withHash = await Conversation.findById(conversation._id).select('+sessionTokenHash').lean();
  // A conversation that was never issued a token has nothing to check a
  // token against, and a session id alone is not a credential.
  return Boolean(withHash && withHash.sessionTokenHash
    && sessionToken.verify(withHash.sessionTokenHash, String(presentedToken)));
}

/**
 * Download a previously uploaded file, whichever side sent it.
 *
 * Either staff of the owning company, or the visitor of the conversation the
 * file belongs to - which covers both a visitor fetching their own upload and
 * a visitor fetching a file an operator sent them.
 *
 * `?inline=1` on a raster image serves it as that image so the widget can
 * show a thumbnail; everything else, and every non-image, is an attachment.
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
    const isOwnSession = (req.session && req.session.sessionId === conversation.sessionId)
      || await hasVisitorCredentials(req, conversation);

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

    const safeName = (message.fileName || 'download').replace(/["\\\r\n]/g, '');
    const imageType = uploads.imageTypeFor(message.fileName);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Private: the URL may carry a visitor token, and a shared cache must not
    // hand one visitor's file to the next person who asks for the same URL.
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.query.inline === '1' && imageType) {
      // A raster image type with nosniff renders as an image or not at all -
      // never as a document - and the sandboxing CSP covers a direct visit.
      res.setHeader('Content-Type', imageType);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    } else {
      // Otherwise always download, never render: an uploaded HTML or SVG file
      // must not be able to execute script on this origin.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }

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
  if (!uploads.sendUploadError(err, res)) {
    next();
  }
});

module.exports = router;
module.exports.operatorGuard = [auth, operator];
