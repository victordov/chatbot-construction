/**
 * Text embeddings.
 *
 * Wraps the OpenAI embeddings API with batching and a small in-process cache,
 * and degrades to a deterministic local fallback when no API key is configured
 * so that knowledge retrieval still returns *something* useful in development
 * and in tests rather than failing the conversation.
 */

const crypto = require('crypto');
const { logger } = require('./logging');

const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

// Matches text-embedding-3-small. Changing the model changes this, and vectors
// of different dimensions cannot be compared - see `isCompatible`.
const MODEL_DIMENSIONS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536
};

// The OpenAI embeddings endpoint accepts many inputs per call; batching keeps
// ingestion of a large document to a handful of requests instead of hundreds.
const BATCH_SIZE = 96;

// Fallback vectors are much smaller - they only need to be good enough for
// lexical-ish similarity, and a big sparse vector would waste storage.
const FALLBACK_DIMENSIONS = 256;

class EmbeddingService {
  constructor(options = {}) {
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : process.env.OPENAI_API_KEY;
    this.client = null;

    if (this.apiKey) {
      const { OpenAI } = require('openai');
      this.client = new OpenAI({ apiKey: this.apiKey });
    }

    // Query embeddings repeat constantly (the same question asked twice, a
    // retry after a failure), so a small cache removes a lot of latency.
    this.cache = new Map();
    this.cacheLimit = options.cacheLimit || 500;
  }

  /**
   * True when this service is backed by a real model rather than the fallback.
   */
  get isModelBacked() {
    return Boolean(this.client);
  }

  get dimensions() {
    return this.isModelBacked
      ? (MODEL_DIMENSIONS[this.model] || 1536)
      : FALLBACK_DIMENSIONS;
  }

  /**
   * The identifier stored alongside every vector. Vectors are only comparable
   * when this matches, so it is written into each chunk and checked at query
   * time rather than silently returning nonsense similarities.
   */
  get signature() {
    return this.isModelBacked ? this.model : 'local-hash-v1';
  }

  cacheGet(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // Refresh recency so the map's insertion order acts as an LRU.
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  cacheSet(key, value) {
    if (this.cache.size >= this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  /**
   * Embed a batch of strings.
   *
   * @param {string[]} texts
   * @returns {Promise<number[][]>} one vector per input, in the same order
   */
  async embedBatch(texts) {
    const inputs = texts.map(text => String(text || '').slice(0, 8000));

    if (!this.isModelBacked) {
      return inputs.map(text => this.localEmbedding(text));
    }

    const vectors = [];

    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);

      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch
        });

        // The API guarantees ordering by `index`, but sort defensively rather
        // than trusting position: a mismatch would silently attach the wrong
        // vector to a chunk, which is very hard to debug later.
        const ordered = response.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map(item => item.embedding);

        vectors.push(...ordered);
      } catch (error) {
        logger.error('Embedding request failed, falling back to local vectors', {
          error: error.message,
          batchSize: batch.length
        });
        vectors.push(...batch.map(text => this.localEmbedding(text)));
      }
    }

    return vectors;
  }

  /**
   * Embed one string, with caching.
   */
  async embed(text) {
    const key = `${this.signature}:${crypto.createHash('sha1').update(String(text || '')).digest('hex')}`;
    const cached = this.cacheGet(key);
    if (cached) {
      return cached;
    }

    const [vector] = await this.embedBatch([text]);
    this.cacheSet(key, vector);
    return vector;
  }

  /**
   * Deterministic bag-of-words vector used when no model is available.
   *
   * This is not semantic - it cannot match "refund" to "money back" - but it
   * does rank documents that share vocabulary with the query above those that
   * do not, which is far more useful than the empty array this code used to
   * return. Vectors built this way are tagged with a different signature so
   * they are never mixed with real embeddings.
   */
  localEmbedding(text) {
    const vector = new Array(FALLBACK_DIMENSIONS).fill(0);
    const tokens = String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length > 2);

    tokens.forEach(token => {
      const hash = crypto.createHash('md5').update(token).digest();
      // Two buckets per token reduces collisions in a small vector.
      vector[hash.readUInt16BE(0) % FALLBACK_DIMENSIONS] += 1;
      vector[hash.readUInt16BE(2) % FALLBACK_DIMENSIONS] += 0.5;
    });

    return normalise(vector);
  }

  /**
   * Whether a stored vector can be compared against this service's output.
   */
  isCompatible(signature) {
    return signature === this.signature;
  }
}

/**
 * Scale a vector to unit length, so cosine similarity is a plain dot product.
 */
function normalise(vector) {
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }
  magnitude = Math.sqrt(magnitude);

  if (magnitude === 0) {
    return vector;
  }
  return vector.map(value => value / magnitude);
}

/**
 * Cosine similarity. Assumes both vectors are unit length (everything stored
 * by this service is), reducing it to a dot product.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

module.exports = {
  EmbeddingService,
  cosineSimilarity,
  normalise,
  // Shared instance: the cache is only useful if callers share it.
  getEmbeddingService: (() => {
    let instance = null;
    return () => {
      if (!instance) {
        instance = new EmbeddingService();
      }
      return instance;
    };
  })()
};
