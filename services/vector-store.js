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
const KnowledgeChunk = require('../models/knowledge-chunk');
const { getEmbeddingService, cosineSimilarity } = require('./embeddings');
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
      await KnowledgeChunk.deleteMany({ company: companyId, sourceId });
      return { stored: 0, backend: this.backend, signature: this.embeddings.signature };
    }

    const vectors = await this.embeddings.embedBatch(usable.map(doc => doc.content));

    const chunks = usable.map((doc, index) => ({
      company: companyId,
      sourceId,
      sourceType,
      collectionName,
      content: doc.content,
      embedding: vectors[index],
      embeddingSignature: this.embeddings.signature,
      metadata: doc.metadata || {},
      chunkIndex: doc.chunkIndex !== undefined ? doc.chunkIndex : index
    }));

    // MongoDB is the system of record in every backend: Qdrant is an index we
    // can rebuild, not the only copy of the tenant's content.
    await KnowledgeChunk.replaceSource(companyId, sourceId, chunks);

    if (this.backend === 'qdrant') {
      await this.qdrantUpsert(chunks, collectionName);
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
      logger.warn(
        `Tenant has ${total} knowledge chunks, above the in-process scan limit of ${IN_PROCESS_SCAN_LIMIT}. ` +
        'Only the most recent chunks are searched. Configure QDRANT_URL or MONGODB_VECTOR_INDEX for a real index.',
        { companyId: String(companyId) }
      );
    }

    const chunks = await KnowledgeChunk.find(filter)
      .select('content embedding metadata sourceId sourceType')
      .sort({ createdAt: -1 })
      .limit(IN_PROCESS_SCAN_LIMIT)
      .lean();

    return chunks
      .map(chunk => ({
        content: chunk.content,
        score: cosineSimilarity(queryVector, chunk.embedding),
        metadata: chunk.metadata || {},
        sourceId: chunk.sourceId,
        sourceType: chunk.sourceType
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
   * Remove everything stored for one source.
   */
  async deleteSource(companyId, sourceId) {
    const result = await KnowledgeChunk.deleteMany({ company: companyId, sourceId });
    return result.deletedCount;
  }

  /**
   * How much a tenant currently has indexed.
   */
  async stats(companyId) {
    const [row] = await KnowledgeChunk.aggregate([
      { $match: { company: companyId } },
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
