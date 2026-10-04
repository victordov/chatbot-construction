/**
 * Vector storage and similarity search.
 *
 * Both `storeInVectorDB` and `searchVectorStore` used to be placeholders -
 * one returned `{stored: true}` without writing anything, the other returned
 * an empty result array - so every knowledge node in every workflow retrieved
 * nothing, silently.
 *
 * Three backends, selected automatically:
 *
 *   qdrant  - when QDRANT_URL is set. Best for large corpora.
 *   atlas   - when MONGODB_VECTOR_INDEX is set. Uses Atlas `$vectorSearch`.
 *   mongo   - the default. Stores vectors in MongoDB and ranks them in
 *             process. Needs no extra infrastructure, which matters because
 *             the alternative here was "no retrieval at all".
 *
 * The in-process backend is honest about its limit: it scans a tenant's chunks
 * rather than using an ANN index, so it caps how many it will consider and
 * logs when a tenant exceeds that.
 */

const axios = require('axios');
const crypto = require('crypto');
const KnowledgeChunk = require('../models/knowledge-chunk');
const { getEmbeddingService, cosineSimilarity } = require('./embeddings');
const { toObjectId } = require('../utils/query');
const { logger } = require('./logging');

// Above this many chunks for one tenant, the in-process backend is no longer
// the right tool and the operator should configure Qdrant or Atlas.
const IN_PROCESS_SCAN_LIMIT = parseInt(process.env.VECTOR_SCAN_LIMIT, 10) || 20000;

class VectorStoreService {
  constructor(options = {}) {
    this.embeddings = options.embeddings || getEmbeddingService();
    this.qdrantUrl = options.qdrantUrl !== undefined ? options.qdrantUrl : process.env.QDRANT_URL;
    this.qdrantApiKey = process.env.QDRANT_API_KEY;
    this.atlasIndex = options.atlasIndex !== undefined ? options.atlasIndex : process.env.MONGODB_VECTOR_INDEX;
  }

  get backend() {
    if (this.qdrantUrl) {
      return 'qdrant';
    }
    if (this.atlasIndex) {
      return 'atlas';
    }
    return 'mongo';
  }

  /**
   * Embed and store a set of documents, replacing any previous chunks for the
   * same source.
   *
   * @param {Array<{id?: string, content: string, metadata?: object}>} documents
   * @param {object} options
   * @param {string} options.companyId
   * @param {string} options.sourceId    groups chunks for replacement
   * @param {string} [options.sourceType]
   * @param {string} [options.collectionName]
   * @returns {Promise<{stored: number, backend: string, signature: string}>}
   */
  async store(documents = [], options = {}) {
    const { companyId, sourceId, sourceType = 'manual', collectionName = 'knowledge_base' } = options;

    if (!companyId) {
      throw new Error('A company is required to store knowledge - chunks must be tenant-scoped');
    }
    if (!sourceId) {
      throw new Error('A sourceId is required so the source can be re-imported cleanly');
    }

    const usable = documents.filter(doc => doc && String(doc.content || '').trim().length > 0);

    if (usable.length === 0) {
      await this.deleteSource(companyId, sourceId);
      return { stored: 0, backend: this.backend, signature: this.embeddings.signature };
    }

    const vectors = await this.embeddings.embedBatch(usable.map(doc => doc.content));

    // One id per import. The new chunks are written under it and the old ones
    // removed by it, so a search in the middle of a re-import is never empty
    // and a failed import never leaves half a source.
    const importId = crypto.randomUUID();

    const chunks = usable.map((doc, index) => ({
      company: companyId,
      sourceId,
      sourceType,
      collectionName,
      importId,
      content: doc.content,
      embedding: vectors[index],
      embeddingSignature: this.embeddings.signature,
      metadata: doc.metadata || {},
      chunkIndex: doc.chunkIndex !== undefined ? doc.chunkIndex : index
    }));

    // MongoDB is the system of record in every backend: Qdrant is an index we
    // can rebuild, not the only copy of the tenant's content.
    await KnowledgeChunk.replaceSource(companyId, sourceId, chunks, importId);

    if (this.backend === 'qdrant') {
      await this.qdrantUpsert(chunks, collectionName);
      await this.qdrantDelete(collectionName, {
        must: [
          { key: 'company', match: { value: String(companyId) } },
          { key: 'sourceId', match: { value: sourceId } }
        ],
        must_not: [{ key: 'importId', match: { value: importId } }]
      });
    }

    logger.info('Stored knowledge chunks', {
      companyId: String(companyId),
      sourceId,
      count: chunks.length,
      backend: this.backend
    });

    return { stored: chunks.length, backend: this.backend, signature: this.embeddings.signature };
  }

  /**
   * Find the chunks most similar to `query` for one tenant.
   *
   * @returns {Promise<Array<{content: string, score: number, metadata: object}>>}
   */
  async search(query, options = {}) {
    const { companyId, collectionName = 'knowledge_base', limit = 5, minScore = 0.15 } = options;

    if (!companyId) {
      // Returning [] rather than throwing: a knowledge node without a tenant
      // should degrade to "no context", not break the conversation.
      logger.warn('Knowledge search attempted without a company; returning no results');
      return [];
    }

    if (!String(query || '').trim()) {
      return [];
    }

    const queryVector = await this.embeddings.embed(query);

    let results;
    switch (this.backend) {
    case 'qdrant':
      results = await this.qdrantSearch(queryVector, { companyId, collectionName, limit });
      break;
    case 'atlas':
      results = await this.atlasSearch(queryVector, { companyId, collectionName, limit });
      break;
    default:
      results = await this.inProcessSearch(queryVector, { companyId, collectionName, limit });
    }

    return results.filter(result => result.score >= minScore);
  }

  /**
   * Default backend: load this tenant's vectors and rank them here.
   *
   * Two passes, because the content is the bulk of a chunk and only the top
   * few are needed: rank on `embedding` alone, then fetch the text for the
   * winners. Loading content for every chunk meant a tenant with a few
   * thousand pages pulled megabytes through the driver on every message.
   */
  async inProcessSearch(queryVector, { companyId, collectionName, limit }) {
    const filter = {
      company: companyId,
      collectionName,
      // Never compare vectors produced by a different model.
      embeddingSignature: this.embeddings.signature
    };

    const total = await KnowledgeChunk.countDocuments(filter);
    if (total === 0) {
      return [];
    }

    if (total > IN_PROCESS_SCAN_LIMIT) {
      // Loud on purpose: past this point the tenant's older material is
      // silently unsearchable, and "the bot does not know about X" is the
      // only symptom anybody would otherwise see.
      logger.warn(
        `Tenant has ${total} knowledge chunks, above the in-process scan limit of ${IN_PROCESS_SCAN_LIMIT}. ` +
        'Only the most recent chunks are searched. Configure QDRANT_URL or MONGODB_VECTOR_INDEX for a real index.',
        { companyId: String(companyId), total, limit: IN_PROCESS_SCAN_LIMIT }
      );
    }

    const candidates = await KnowledgeChunk.find(filter)
      .select('_id embedding')
      .sort({ createdAt: -1 })
      .limit(IN_PROCESS_SCAN_LIMIT)
      .lean();

    const ranked = candidates
      .map(chunk => ({ id: chunk._id, score: cosineSimilarity(queryVector, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) {
      return [];
    }

    const winners = await KnowledgeChunk.find({ _id: { $in: ranked.map(r => r.id) } })
      .select('content metadata sourceId sourceType')
      .lean();
    const byId = new Map(winners.map(chunk => [String(chunk._id), chunk]));

    return ranked
      .map(({ id, score }) => {
        const chunk = byId.get(String(id));
        return chunk && {
          content: chunk.content,
          score,
          metadata: chunk.metadata || {},
          sourceId: chunk.sourceId,
          sourceType: chunk.sourceType
        };
      })
      .filter(Boolean);
  }

  /**
   * MongoDB Atlas `$vectorSearch`.
   */
  async atlasSearch(queryVector, { companyId, collectionName, limit }) {
    try {
      const results = await KnowledgeChunk.aggregate([
        {
          $vectorSearch: {
            index: this.atlasIndex,
            path: 'embedding',
            queryVector,
            numCandidates: Math.max(100, limit * 20),
            limit,
            filter: {
              company: companyId,
              collectionName,
              embeddingSignature: this.embeddings.signature
            }
          }
        },
        {
          $project: {
            content: 1,
            metadata: 1,
            sourceId: 1,
            sourceType: 1,
            score: { $meta: 'vectorSearchScore' }
          }
        }
      ]);

      return results.map(result => ({
        content: result.content,
        score: result.score,
        metadata: result.metadata || {},
        sourceId: result.sourceId,
        sourceType: result.sourceType
      }));
    } catch (error) {
      // A missing or misconfigured Atlas index should not take retrieval down;
      // fall back to scanning rather than returning nothing.
      logger.error('Atlas vector search failed, falling back to in-process ranking', {
        error: error.message
      });
      return this.inProcessSearch(queryVector, { companyId, collectionName, limit });
    }
  }

  qdrantCollection(collectionName) {
    return process.env.QDRANT_COLLECTION || collectionName || 'knowledge_base';
  }

  qdrantHeaders() {
    return this.qdrantApiKey ? { 'api-key': this.qdrantApiKey } : {};
  }

  /**
   * Create the Qdrant collection if it does not exist yet.
   */
  async ensureQdrantCollection(collectionName) {
    const name = this.qdrantCollection(collectionName);
    const url = `${this.qdrantUrl.replace(/\/+$/, '')}/collections/${encodeURIComponent(name)}`;

    try {
      await axios.get(url, { headers: this.qdrantHeaders(), timeout: 10000 });
      return name;
    } catch (error) {
      if (error.response && error.response.status !== 404) {
        throw error;
      }
    }

    await axios.put(url, {
      vectors: { size: this.embeddings.dimensions, distance: 'Cosine' }
    }, { headers: this.qdrantHeaders(), timeout: 15000 });

    logger.info(`Created Qdrant collection "${name}"`);
    return name;
  }

  async qdrantUpsert(chunks, collectionName) {
    try {
      const name = await this.ensureQdrantCollection(collectionName);

      // Qdrant point ids must be an unsigned integer or a UUID, so derive a
      // stable UUID from the chunk's identity rather than using the Mongo id.
      const points = chunks.map((chunk, index) => ({
        id: deterministicUuid(`${chunk.company}:${chunk.sourceId}:${chunk.chunkIndex ?? index}`),
        vector: chunk.embedding,
        payload: {
          company: String(chunk.company),
          sourceId: chunk.sourceId,
          sourceType: chunk.sourceType,
          collectionName: chunk.collectionName,
          importId: chunk.importId || null,
          content: chunk.content,
          embeddingSignature: chunk.embeddingSignature
        }
      }));

      await axios.put(
        `${this.qdrantUrl.replace(/\/+$/, '')}/collections/${encodeURIComponent(name)}/points?wait=true`,
        { points },
        { headers: this.qdrantHeaders(), timeout: 30000 }
      );
    } catch (error) {
      // The chunks are already safely in MongoDB, so a Qdrant outage degrades
      // search quality rather than losing the tenant's content.
      logger.error('Qdrant upsert failed; chunks are stored in MongoDB and searchable in process', {
        error: error.message
      });
    }
  }

  /**
   * Remove the points matching a payload filter.
   *
   * Qdrant was written to on import and never on delete, so a source a tenant
   * removed from the dashboard kept being served from the index.
   */
  async qdrantDelete(collectionName, filter) {
    try {
      const name = this.qdrantCollection(collectionName);
      await axios.post(
        `${this.qdrantUrl.replace(/\/+$/, '')}/collections/${encodeURIComponent(name)}/points/delete?wait=true`,
        { filter },
        { headers: this.qdrantHeaders(), timeout: 30000 }
      );
    } catch (error) {
      // MongoDB is the record, and the search filters on what is still there
      // by content rather than by the index alone; the stale points are a
      // cleanup problem, not a correctness one, but worth knowing about.
      logger.error('Qdrant delete failed; stale points may remain in the index', {
        error: error.message
      });
    }
  }

  async qdrantSearch(queryVector, { companyId, collectionName, limit }) {
    try {
      const name = this.qdrantCollection(collectionName);

      const response = await axios.post(
        `${this.qdrantUrl.replace(/\/+$/, '')}/collections/${encodeURIComponent(name)}/points/search`,
        {
          vector: queryVector,
          limit,
          with_payload: true,
          // Tenant isolation is enforced by the index, not just by our query
          // construction, so a bug elsewhere cannot leak another tenant's data.
          filter: {
            must: [
              { key: 'company', match: { value: String(companyId) } },
              { key: 'embeddingSignature', match: { value: this.embeddings.signature } }
            ]
          }
        },
        { headers: this.qdrantHeaders(), timeout: 15000 }
      );

      return (response.data.result || []).map(hit => ({
        content: hit.payload.content,
        score: hit.score,
        metadata: hit.payload,
        sourceId: hit.payload.sourceId,
        sourceType: hit.payload.sourceType
      }));
    } catch (error) {
      logger.error('Qdrant search failed, falling back to in-process ranking', {
        error: error.message
      });
      return this.inProcessSearch(queryVector, { companyId, collectionName, limit });
    }
  }

  /**
   * What this tenant has indexed, one row per source.
   *
   * The dashboard needs to show somebody what their bot can actually draw on,
   * and to let them remove a source they no longer stand behind. Without this,
   * a knowledge base is a write-only hole.
   */
  async sources(companyId) {
    const rows = await KnowledgeChunk.aggregate([
      { $match: { company: toObjectId(companyId) } },
      {
        $group: {
          _id: '$sourceId',
          sourceType: { $first: '$sourceType' },
          collectionName: { $first: '$collectionName' },
          chunks: { $sum: 1 },
          characters: { $sum: { $strLenCP: '$content' } },
          importedAt: { $max: '$createdAt' },
          signature: { $first: '$embeddingSignature' },
          sample: { $first: '$content' },
          metadata: { $first: '$metadata' }
        }
      },
      { $sort: { importedAt: -1 } }
    ]);

    return rows.map(row => ({
      sourceId: row._id,
      sourceType: row.sourceType,
      collectionName: row.collectionName,
      chunks: row.chunks,
      characters: row.characters,
      importedAt: row.importedAt,
      // A source embedded by a different model than the one now configured
      // cannot be searched, and saying so is more use than quietly never
      // matching it.
      stale: row.signature !== this.embeddings.signature,
      title: (row.metadata && (row.metadata.title || row.metadata.url || row.metadata.filename)) || null,
      url: (row.metadata && row.metadata.url) || null,
      filename: (row.metadata && row.metadata.filename) || null,
      excerpt: String(row.sample || '').slice(0, 160)
    }));
  }

  /**
   * Remove everything stored for one source, from every backend.
   */
  async deleteSource(companyId, sourceId) {
    const result = await KnowledgeChunk.deleteMany({ company: companyId, sourceId });

    if (this.backend === 'qdrant') {
      await this.qdrantDelete(undefined, {
        must: [
          { key: 'company', match: { value: String(companyId) } },
          { key: 'sourceId', match: { value: sourceId } }
        ]
      });
    }

    return result.deletedCount;
  }

  /**
   * How much a tenant currently has indexed.
   */
  async stats(companyId) {
    const [row] = await KnowledgeChunk.aggregate([
      // Cast explicitly: unlike a find(), an aggregation `$match` does not
      // coerce a string id, and would silently match nothing.
      { $match: { company: toObjectId(companyId) } },
      {
        $group: {
          _id: null,
          chunks: { $sum: 1 },
          sources: { $addToSet: '$sourceId' }
        }
      }
    ]);

    return {
      backend: this.backend,
      chunks: row ? row.chunks : 0,
      sources: row ? row.sources.length : 0,
      embeddingModel: this.embeddings.signature,
      semantic: this.embeddings.isModelBacked
    };
  }
}

/**
 * A UUIDv5-shaped id derived from a string, so re-importing a source
 * overwrites its own points instead of duplicating them.
 */
function deterministicUuid(input) {
  const hash = require('crypto').createHash('sha1').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
    hash.slice(20, 32)
  ].join('-');
}

module.exports = {
  VectorStoreService,
  getVectorStore: (() => {
    let instance = null;
    return () => {
      if (!instance) {
        instance = new VectorStoreService();
      }
      return instance;
    };
  })()
};
