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
 * These are the four things somebody needs: put something in, see what is in,
 * try a question against it, and take something out again.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { auth, admin } = require('../middleware/auth');
const { enforceLimit, requireFeature } = require('../middleware/quota');
const KnowledgeConnectorService = require('../services/knowledge-connector');
const { isPdfUrl } = require('../services/knowledge-connector');
const { getVectorStore } = require('../services/vector-store');
const KnowledgeChunk = require('../models/knowledge-chunk');
const usageService = require('../services/usage');
const { logger } = require('../services/logging');
const audit = require('../services/audit');

const connector = new KnowledgeConnectorService();

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

/**
 * What kind of thing a URL points at.
 *
 * Only used to label the source. The loader makes the same call from the path
 * and, failing that, from the response's content type, so a PDF served from a
 * URL without the extension is still read as one.
 */
function sourceTypeFor(url) {
  return isPdfUrl(url) ? 'pdf' : 'url';
}

/**
 * Refuse an import that would take the tenant over their chunk allowance.
 *
 * The `enforceLimit` middleware on the route checks for room for one more
 * chunk before anything is fetched, which stops an exhausted tenant early but
 * says nothing about a 400-chunk PDF against a 50-chunk remainder. This runs
 * after chunking and before embedding - the expensive part - with the real
 * number. Chunks the same source already has are being replaced, so they do
 * not count against it.
 */
async function assertRoomFor(req, companyId, sourceId, chunkCount) {
  if (req.user.role === 'superadmin') {
    return;
  }

  const replacing = await KnowledgeChunk.countDocuments({ company: companyId, sourceId });
  const requested = Math.max(0, chunkCount - replacing);
  const result = await usageService.check(companyId, 'knowledgeChunks', requested);

  if (!result.allowed) {
    await usageService.recordLimitHit(companyId);
    const error = new Error(
      `${result.reason || 'Knowledge limit reached.'} This import would add ${requested} chunk${requested === 1 ? '' : 's'}.`
    );
    error.status = 402;
    error.code = 'PLAN_LIMIT_REACHED';
    error.meter = 'knowledgeChunks';
    error.limit = result.limit;
    error.used = result.used;
    throw error;
  }
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
  return res.status(400).json({ error: error.message });
}

// What this tenant's bot can draw on.
router.get('/', auth, admin, async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const store = getVectorStore();
    const [stats, sources] = await Promise.all([
      store.stats(companyId),
      store.sources(companyId)
    ]);

    // `stats.sources` is a count and `sources` is the list. Spreading one over
    // the other left a single ambiguous field, which the dashboard duly
    // rendered as "[object Object] sources".
    const { sources: sourceCount, ...rest } = stats;

    res.json({
      ...rest,
      sourceCount,
      sources,
      // Without an API key the embedding service falls back to hashed
      // bag-of-words, which matches words rather than meaning. Saying so here
      // is the difference between "search is poor" and a support ticket.
      note: stats.semantic
        ? null
        : 'No embedding model is configured, so matching is by wording rather ' +
          'than meaning. Set OPENAI_API_KEY for semantic search.'
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
        const sourceType = sourceTypeFor(url);
        const sourceId = `${sourceType}:${url}`;
        const result = await connector.processKnowledgeSource(
          { sourceType, config: { url }, sourceId },
          companyId,
          { beforeStore: documents => assertRoomFor(req, companyId, sourceId, documents.length) }
        );

        await audit.record({ req, action: 'knowledge.imported', details: { sourceId: result.sourceId, url } });

        return res.status(201).json({
          sourceId: result.sourceId,
          sourceType,
          chunks: result.vectorResults ? result.vectorResults.stored : 0
        });
      }

      // Pasted text takes the same chunking as a fetched document, so a long
      // policy is retrieved a paragraph at a time rather than whole.
      //
      // The id is random, not derived from the title. It used to be, so two
      // notes both called "Opening hours" - one per branch, say - silently
      // replaced each other. The title is kept as the display name.
      const sourceId = `text:${crypto.randomUUID()}`;
      const chunks = connector.splitIntoChunks(String(text), 1000);

      await assertRoomFor(req, companyId, sourceId, chunks.length);

      const stored = await getVectorStore().store(
        chunks.map((content, index) => ({
          content,
          chunkIndex: index,
          metadata: { title: title || 'Note', source: 'manual' }
        })),
        { companyId, sourceId, sourceType: 'manual' }
      );

      await audit.record({ req, action: 'knowledge.imported', details: { sourceId, title: title || 'Note' } });

      res.status(201).json({ sourceId, sourceType: 'manual', chunks: stored.stored });
    } catch (error) {
      logger.error('Could not import a knowledge source', { error: error.message });
      importFailed(res, error);
    }
  }
);

// Fetch a source again, in place, so a changed page updates rather than doubles.
router.post('/sources/:sourceId/refresh', auth, admin, requireFeature('knowledgeBase'), async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) {
      return;
    }

    const { sourceId } = req.params;
    const [type, ...rest] = sourceId.split(':');
    const target = rest.join(':');

    if (type !== 'url' && type !== 'pdf') {
      return res.status(400).json({ error: 'Only a URL source can be refreshed' });
    }

    const result = await connector.processKnowledgeSource(
      { sourceType: type, config: { url: target }, sourceId },
      companyId,
      { beforeStore: documents => assertRoomFor(req, companyId, sourceId, documents.length) }
    );

    await audit.record({ req, action: 'knowledge.refreshed', details: { sourceId } });

    res.json({ sourceId, chunks: result.vectorResults ? result.vectorResults.stored : 0 });
  } catch (error) {
    logger.error('Could not refresh a knowledge source', { error: error.message });
    importFailed(res, error);
  }
});

/**
 * Ask the knowledge base a question without involving a visitor.
 *
 * The point is to let somebody check what their bot will actually find before
 * they discover it from a customer.
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
      results: results.map(result => ({
        content: result.content,
        score: Number(result.score.toFixed(3)),
        sourceId: result.sourceId,
        sourceType: result.sourceType
      }))
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

    const removed = await getVectorStore().deleteSource(companyId, req.params.sourceId);

    if (removed === 0) {
      return res.status(404).json({ error: 'No such source' });
    }

    await audit.record({ req, action: 'knowledge.deleted', details: { sourceId: req.params.sourceId, chunks: removed } });

    res.json({ sourceId: req.params.sourceId, removed });
  } catch (error) {
    logger.error('Could not delete a knowledge source', { error: error.message });
    res.status(500).json({ error: 'Could not delete that source' });
  }
});

module.exports = router;
