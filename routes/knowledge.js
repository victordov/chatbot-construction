/**
 * The knowledge base: what a tenant's bot is allowed to know.
 *
 * Everything under here already existed except the way in. Ingestion
 * (`knowledge-connector.processKnowledgeSource`), embedding
 * (`services/embeddings.js`), storage and retrieval across three backends
 * (`services/vector-store.js`) were all built and tested - and no route, form
 * or button anywhere in the product called any of it. A tenant could not put a
 * single sentence into their own knowledge base, so the assistant and every
 * workflow knowledge node searched an empty collection and found nothing,
 * silently, forever.
 *
 * These are the things somebody needs: put something in, see what is in and
 * how much the bot uses it, try a question against it, correct it, keep it
 * current, and take something out again. "Put something in" is a URL, pasted
 * text, an uploaded file, or a whole site crawled in the background.
 */

const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const router = express.Router();

const { auth, admin } = require('../middleware/auth');
const { enforceLimit, requireFeature } = require('../middleware/quota');
const { getVectorStore } = require('../services/vector-store');
const KnowledgeChunk = require('../models/knowledge-chunk');
const KnowledgeSource = require('../models/knowledge-source');
const KnowledgeCrawl = require('../models/knowledge-crawl');
const Conversation = require('../models/conversation');
const { logger } = require('../services/logging');
const audit = require('../services/audit');
const knowledgeFiles = require('../services/knowledge-files');
const knowledgeCrawler = require('../services/knowledge-crawler');
const knowledgeText = require('../services/knowledge-text');
const { toObjectId } = require('../utils/query');

/**
 * The largest file a tenant may upload into the knowledge base. Separate from
 * the chat attachment cap (MAX_UPLOAD_BYTES): a visitor's photo and a
 * company's product manual are different things with different limits.
 */
const MAX_KNOWLEDGE_FILE_BYTES =
  parseInt(process.env.KNOWLEDGE_UPLOAD_MAX_BYTES, 10) || 10 * 1024 * 1024;

/** The window "used in N answers" counts over. */
const USAGE_WINDOW_DAYS = 30;

/**
 * Held in memory, never written to disk: the file is read once into text and
 * chunks and the bytes are dropped. Keeping the original would be a second
 * copy of the tenant's document to secure, back up and erase.
 */
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_KNOWLEDGE_FILE_BYTES, files: 1 }
}).single('file');

/** Run multer, translating its errors into answers a person can act on. */
function receiveFile(req, res) {
  return new Promise(resolve => {
    knowledgeUpload(req, res, error => {
      if (!error) {
        return resolve(true);
      }
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `Files must be under ${Math.round(MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024)} MB`
        });
      } else {
        res.status(400).json({ error: error.message });
      }
      resolve(false);
    });
  });
}

/**
 * The tenant this request belongs to.
 *
 * A superadmin has no company of their own, and knowledge is tenant-scoped by
 * construction - there is nowhere to put a platform-wide chunk - so they are
 * asked which company they mean rather than silently writing somewhere.
 */
function companyFor(req) {
  if (req.user.role === 'superadmin') {
    return req.query.companyId || req.body.companyId || null;
  }
  return req.user.company ? req.user.company.id : null;
}

/** Chunks are stored per company; without one there is nothing to do. */
function requireCompany(req, res) {
  const companyId = companyFor(req);

  if (!companyId) {
    res.status(400).json({
      error: req.user.role === 'superadmin'
        ? 'Name a company: knowledge belongs to a tenant, not to the platform'
        : 'Your account is not attached to a company'
    });
    return null;
  }

  return companyId;
}

/** A superadmin manages the platform and is not subject to a tenant's plan. */
function quotaApplies(req) {
  return req.user.role !== 'superadmin';
}

/** Who did it, for audit entries a background job writes after the request. */
function actorOf(req) {
  return {
    id: req.user.id,
    username: req.user.username,
    displayName: req.user.displayName || req.user.username,
    role: req.user.role
  };
}

/** Send a quota refusal in the same shape as the middleware, or a 400. */
function importFailed(res, error) {
  if (error.status === 402) {
    return res.status(402).json({
      error: error.message,
      code: error.code,
      meter: error.meter,
      limit: error.limit,
      used: error.used
    });
  }

  // The message is the tenant's to act on: a bad URL, a scanned PDF, a
  // site that refused us. A generic 500 would send them to us instead.
  return res.status(error.status && error.status < 500 ? error.status : 400).json({ error: error.message });
}

/**
 * How many bot answers cited each source over the last month.
 *
 * Messages record their citations as `{title, url}` rather than a source id,
 * because that is what the visitor is shown. So a web page is matched by its
 * address and anything else by its title; two notes with the same title share
 * one count, which is the price of not storing ids on every message. One
 * aggregation for the whole list, not one per source.
 *
 * @returns {Promise<{byUrl: Map<string, number>, byTitle: Map<string, number>}>}
 */
async function answerCounts(companyId) {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const byUrl = new Map();
  const byTitle = new Map();

  try {
    const rows = await Conversation.aggregate([
      { $match: { company: toObjectId(companyId), lastActivity: { $gte: since }, 'messages.sources.0': { $exists: true } } },
      { $unwind: '$messages' },
      {
        $match: {
          'messages.sender': 'bot',
          'messages.timestamp': { $gte: since },
          'messages.sources.0': { $exists: true }
        }
      },
      { $unwind: '$messages.sources' },
      {
        $group: {
          _id: { title: '$messages.sources.title', url: '$messages.sources.url' },
          count: { $sum: 1 }
        }
      }
    ]);

    rows.forEach(row => {
      const { title, url } = row._id || {};
      if (url) {
        byUrl.set(url, (byUrl.get(url) || 0) + row.count);
      } else if (title) {
        byTitle.set(title, (byTitle.get(title) || 0) + row.count);
      }
    });
  } catch (error) {
    // A count is a nicety; the list must still load without it.
    logger.warn('Could not count knowledge use', { error: error.message });
  }

  return { byUrl, byTitle };
}

// What this tenant's bot can draw on.
router.get('/', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const store = getVectorStore();
    const [stats, sources, settings, sites, counts] = await Promise.all([
      store.stats(companyId),
      store.sources(companyId),
      KnowledgeSource.find({ company: companyId })
        .select('sourceId refreshWeekly lastRefreshedAt lastError').lean(),
      KnowledgeCrawl.find({ company: companyId }).sort({ createdAt: -1 }).lean(),
      answerCounts(companyId)
    ]);

    const settingsById = new Map(settings.map(row => [row.sourceId, row]));
    const siteOf = new Map();
    sites.forEach(site => (site.pages || []).forEach(sourceId => siteOf.set(sourceId, site.origin)));

    // `stats.sources` is a count and `sources` is the list. Spreading one over
    // the other left a single ambiguous field, which the dashboard duly
    // rendered as "[object Object] sources".
    const { sources: sourceCount, ...rest } = stats;

    res.json({
      ...rest,
      sourceCount,
      sources: sources.map(source => {
        const setting = settingsById.get(source.sourceId) || {};
        const usedInAnswers = source.url
          ? (counts.byUrl.get(source.url) || 0)
          : (counts.byTitle.get(source.title) || 0);
        return {
          ...source,
          usedInAnswers,
          editable: knowledgeText.isTextSource(source.sourceId),
          refreshable: /^(url|pdf):/.test(source.sourceId),
          refreshWeekly: Boolean(setting.refreshWeekly),
          lastRefreshedAt: setting.lastRefreshedAt || null,
          lastError: setting.lastError || null,
          site: siteOf.get(source.sourceId) || null
        };
      }),
      sites: sites.map(knowledgeCrawler.presentJob),
      usageWindowDays: USAGE_WINDOW_DAYS,
      // Without an API key the embedding service falls back to hashed
      // bag-of-words, which matches words rather than meaning. Saying so here
      // is the difference between "search is poor" and a support ticket.
      note: stats.semantic
        ? null
        : 'No embedding model is configured, so matching is by wording rather ' +
          'than meaning. Set OPENAI_API_KEY for semantic search.',
      // The Google Sheets import is kept while its place in the product is
      // decided, and shown only where an operator has switched it on: the
      // assistant does not answer from it yet, so it is not where anyone
      // should start.
      features: { googleSheets: process.env.GOOGLE_SHEETS_UI === 'true' }
    });
  } catch (error) {
    logger.error('Could not list knowledge sources', { error: error.message });
    res.status(500).json({ error: 'Could not read the knowledge base' });
  }
});

/**
 * Add something to the knowledge base.
 *
 * Either `{ url }` - a web page or a PDF we fetch - or `{ text, title }`,
 * pasted straight in, which is what most people actually want for a returns
 * policy or a set of opening hours.
 */
router.post(
  '/sources',
  auth,
  admin,
  requireFeature('knowledgeBase'),
  enforceLimit('knowledgeChunks'),
  async (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) {
        return;
      }

      const { url, text, title } = req.body;

      if (!url && !String(text || '').trim()) {
        return res.status(400).json({ error: 'Provide a URL or some text' });
      }

      if (url) {
        const result = await knowledgeCrawler.fetchSource({
          companyId, url: String(url), enforceQuota: quotaApplies(req)
        });

        await audit.record({ req, action: 'knowledge.imported', details: { sourceId: result.sourceId, url } });

        return res.status(201).json(result);
      }

      // Pasted text takes the same chunking as a fetched document, so a long
      // policy is retrieved a paragraph at a time rather than whole.
      const stored = await knowledgeText.storeText({
        companyId,
        text,
        title: title || 'Note',
        enforceQuota: quotaApplies(req),
        by: req.user.id
      });

      await audit.record({ req, action: 'knowledge.imported', details: { sourceId: stored.sourceId, title: stored.title } });

      res.status(201).json({ sourceId: stored.sourceId, sourceType: 'manual', chunks: stored.chunks });
    } catch (error) {
      logger.error('Could not import a knowledge source', { error: error.message });
      importFailed(res, error);
    }
  }
);

/**
 * A pasted note's text, for editing.
 *
 * Only notes: a web page or a file is edited where it lives and fetched again.
 */
router.get('/sources/:sourceId/text', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    if (!knowledgeText.isTextSource(req.params.sourceId)) {
      return res.status(400).json({ error: 'Only pasted text can be edited here' });
    }

    const note = await knowledgeText.readText(companyId, req.params.sourceId);
    if (!note) {
      return res.status(404).json({ error: 'No such source' });
    }

    res.json(note);
  } catch (error) {
    logger.error('Could not read a knowledge note', { error: error.message });
    res.status(500).json({ error: 'Could not read that note' });
  }
});

/**
 * Replace a pasted note's text.
 *
 * The new chunks are written before the old ones are removed, so the bot
 * answers from one version or the other throughout, never from nothing.
 */
router.put('/sources/:sourceId', auth, admin, requireFeature('knowledgeBase'), async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { sourceId } = req.params;
    if (!knowledgeText.isTextSource(sourceId)) {
      return res.status(400).json({ error: 'Only pasted text can be edited. Re-fetch a page or upload the file again.' });
    }

    const { text, title } = req.body;
    if (!String(text || '').trim()) {
      return res.status(400).json({ error: 'The note is empty. Remove the source instead.' });
    }

    // Scoped to this company: an id from another tenant is simply not found.
    const exists = await KnowledgeChunk.exists({ company: companyId, sourceId });
    if (!exists) {
      return res.status(404).json({ error: 'No such source' });
    }

    const stored = await knowledgeText.storeText({
      companyId,
      sourceId,
      text,
      title,
      enforceQuota: quotaApplies(req),
      by: req.user.id
    });

    await audit.record({
      req,
      action: 'knowledge.updated',
      target: { type: 'knowledge', id: sourceId, label: stored.title },
      details: { sourceId, chunks: stored.chunks }
    });

    res.json({ sourceId, sourceType: 'manual', title: stored.title, chunks: stored.chunks });
  } catch (error) {
    logger.error('Could not update a knowledge note', { error: error.message });
    importFailed(res, error);
  }
});

/**
 * Per-source settings: for now, whether to fetch a page again every week.
 */
router.patch('/sources/:sourceId', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { sourceId } = req.params;
    if (!/^(url|pdf):/.test(sourceId)) {
      return res.status(400).json({ error: 'Only a web page or a PDF link can be refreshed' });
    }
    if (typeof req.body.refreshWeekly !== 'boolean') {
      return res.status(400).json({ error: 'Say whether to refresh it weekly (true or false)' });
    }

    const exists = await KnowledgeChunk.exists({ company: companyId, sourceId });
    if (!exists) {
      return res.status(404).json({ error: 'No such source' });
    }

    const setting = await KnowledgeSource.findOneAndUpdate(
      { company: companyId, sourceId },
      {
        $set: { refreshWeekly: req.body.refreshWeekly, updatedBy: req.user.id, updatedAt: new Date() },
        // The page was fetched when it was imported; the week starts then.
        $setOnInsert: { company: companyId, sourceId, lastRefreshedAt: new Date() }
      },
      { upsert: true, new: true }
    ).lean();

    await audit.record({
      req,
      action: 'knowledge.updated',
      target: { type: 'knowledge', id: sourceId },
      details: { sourceId, refreshWeekly: setting.refreshWeekly }
    });

    res.json({ sourceId, refreshWeekly: setting.refreshWeekly, lastRefreshedAt: setting.lastRefreshedAt || null });
  } catch (error) {
    logger.error('Could not change a knowledge source', { error: error.message });
    res.status(500).json({ error: 'Could not change that source' });
  }
});

/**
 * Upload a document into the knowledge base.
 *
 * Multipart, field `file`, optional `title`. PDF, text, Markdown, CSV and HTML
 * are read; anything else is a 415 that says what is accepted. The source is
 * keyed by file name, so uploading a new version of `prices.csv` replaces the
 * old one - which is what somebody updating their price list expects - rather
 * than leaving the bot two contradictory price lists.
 */
router.post(
  '/upload',
  auth,
  admin,
  requireFeature('knowledgeBase'),
  enforceLimit('knowledgeChunks'),
  async (req, res) => {
    try {
      if (!(await receiveFile(req, res))) {
        return;
      }

      const companyId = requireCompany(req, res);
      if (!companyId) {
        return;
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Choose a file to upload (form field "file")' });
      }

      // The original name is a label only, never a path.
      const filename = path.basename(String(req.file.originalname || 'upload')).slice(0, 255);
      const parsed = await knowledgeFiles.parseFile(req.file);
      const title = String(req.body.title || '').trim().slice(0, 200) || parsed.title || filename;
      const sourceId = `file:${filename}`;

      if (quotaApplies(req)) {
        await knowledgeText.assertRoom(companyId, sourceId, parsed.chunks.length);
      }

      const stored = await getVectorStore().store(
        parsed.chunks.map((chunk, index) => ({
          content: chunk.content,
          chunkIndex: index,
          metadata: { ...(chunk.metadata || {}), title, filename, format: parsed.format, source: 'file' }
        })),
        { companyId, sourceId, sourceType: 'file' }
      );

      await audit.record({
        req,
        action: 'knowledge.imported',
        details: { sourceId, filename, format: parsed.format, bytes: req.file.size }
      });

      res.status(201).json({
        sourceId,
        sourceType: 'file',
        title,
        filename,
        format: parsed.format,
        chunks: stored.stored
      });
    } catch (error) {
      if (error.status === 415) {
        return res.status(415).json({ error: error.message, code: error.code });
      }
      logger.error('Could not import an uploaded file', { error: error.message });
      importFailed(res, error);
    }
  }
);

/**
 * Crawl a website into the knowledge base, in the background.
 *
 * `{ url, maxPages, refreshWeekly? }` answers 202 with a job id straight away;
 * `GET /crawl/:jobId` reports progress ("12 of 20 pages") and, once done, what
 * was imported, skipped and removed. Every page becomes its own `url:` source,
 * exactly as if it had been imported by hand, so each can be refreshed or
 * removed on its own and a second crawl replaces the pages rather than
 * doubling them - and drops the ones the site no longer has.
 */
router.post(
  '/crawl',
  auth,
  admin,
  requireFeature('knowledgeBase'),
  enforceLimit('knowledgeChunks'),
  async (req, res) => {
    try {
      const companyId = requireCompany(req, res);
      if (!companyId) {
        return;
      }

      const { url, maxPages, refreshWeekly } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Provide the address of the site to read' });
      }

      const { job, alreadyRunning } = await knowledgeCrawler.startCrawl({
        companyId,
        url,
        maxPages,
        refreshWeekly: typeof refreshWeekly === 'boolean' ? refreshWeekly : undefined,
        enforceQuota: quotaApplies(req),
        actor: actorOf(req),
        createdBy: req.user.id
      });

      res.status(202).json({
        jobId: String(job._id),
        alreadyRunning,
        job: knowledgeCrawler.presentJob(job)
      });
    } catch (error) {
      logger.error('Could not start a site crawl', { error: error.message });
      importFailed(res, error);
    }
  }
);

/** Find a crawl record of this company's, or answer 404. */
async function crawlOf(req, res, companyId) {
  if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) {
    res.status(404).json({ error: 'No such crawl' });
    return null;
  }
  const job = await KnowledgeCrawl.findOne({ _id: req.params.jobId, company: companyId });
  if (!job) {
    res.status(404).json({ error: 'No such crawl' });
    return null;
  }
  return job;
}

// How a crawl is getting on.
router.get('/crawl/:jobId', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    const job = await crawlOf(req, res, companyId);
    if (job) {
      res.json(knowledgeCrawler.presentJob(job));
    }
  } catch (error) {
    logger.error('Could not read a crawl', { error: error.message });
    res.status(500).json({ error: 'Could not read that crawl' });
  }
});

// A site's settings: whether to read it again every week.
router.patch('/crawl/:jobId', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }
    if (typeof req.body.refreshWeekly !== 'boolean') {
      return res.status(400).json({ error: 'Say whether to refresh it weekly (true or false)' });
    }
    const job = await crawlOf(req, res, companyId);
    if (!job) {
      return;
    }

    job.refreshWeekly = req.body.refreshWeekly;
    await job.save();

    await audit.record({
      req,
      action: 'knowledge.updated',
      target: { type: 'knowledge', id: job.origin },
      details: { site: job.origin, refreshWeekly: job.refreshWeekly }
    });

    res.json(knowledgeCrawler.presentJob(job));
  } catch (error) {
    logger.error('Could not change a crawl', { error: error.message });
    res.status(500).json({ error: 'Could not change that site' });
  }
});

// Fetch a source again, in place, so a changed page updates rather than doubles.
router.post('/sources/:sourceId/refresh', auth, admin, requireFeature('knowledgeBase'), async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { sourceId } = req.params;
    if (!/^(url|pdf):/.test(sourceId)) {
      return res.status(400).json({ error: 'Only a URL source can be refreshed' });
    }

    const result = await knowledgeCrawler.fetchSource({
      companyId, sourceId, enforceQuota: quotaApplies(req)
    });

    await audit.record({ req, action: 'knowledge.refreshed', details: { sourceId } });

    res.json({ sourceId, chunks: result.chunks });
  } catch (error) {
    logger.error('Could not refresh a knowledge source', { error: error.message });
    importFailed(res, error);
  }
});

/**
 * Ask the knowledge base a question without involving a visitor.
 *
 * The point is to let somebody check what their bot will actually find before
 * they discover it from a customer - and which source it came from, so a wrong
 * passage can be traced to the page or note to fix.
 */
router.post('/search', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { query, limit } = req.body;

    if (!String(query || '').trim()) {
      return res.status(400).json({ error: 'Ask something' });
    }

    const results = await getVectorStore().search(query, {
      companyId,
      limit: Math.min(parseInt(limit, 10) || 5, 20)
    });

    res.json({
      query,
      results: results.map(result => {
        const metadata = result.metadata instanceof Map
          ? Object.fromEntries(result.metadata)
          : (result.metadata || {});
        const url = /^https?:\/\//i.test(String(metadata.url || '')) ? metadata.url : null;
        return {
          content: result.content,
          score: Number(result.score.toFixed(3)),
          sourceId: result.sourceId,
          sourceType: result.sourceType,
          title: metadata.title || metadata.filename || url || result.sourceId || 'Knowledge base',
          url
        };
      })
    });
  } catch (error) {
    logger.error('Knowledge search failed', { error: error.message });
    res.status(500).json({ error: 'Search failed' });
  }
});

// Remove a source and every chunk that came from it.
router.delete('/sources/:sourceId', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { sourceId } = req.params;
    const removed = await getVectorStore().deleteSource(companyId, sourceId);

    if (removed === 0) {
      return res.status(404).json({ error: 'No such source' });
    }

    // Its settings go with it, and a site stops counting it as one of its
    // pages, so the next crawl brings it back only if the site still has it.
    await Promise.all([
      knowledgeText.forget(companyId, sourceId),
      KnowledgeCrawl.updateMany({ company: companyId }, { $pull: { pages: sourceId } })
    ]);

    await audit.record({ req, action: 'knowledge.deleted', details: { sourceId, chunks: removed } });

    res.json({ sourceId, removed });
  } catch (error) {
    logger.error('Could not delete a knowledge source', { error: error.message });
    res.status(500).json({ error: 'Could not delete that source' });
  }
});

module.exports = router;
