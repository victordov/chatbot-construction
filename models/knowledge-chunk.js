const mongoose = require('mongoose');

/**
 * One embedded slice of a knowledge source.
 *
 * Chunks are the unit of retrieval: a workflow's knowledge node embeds the
 * visitor's question and finds the nearest chunks belonging to that tenant.
 */
const KnowledgeChunkSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  /**
   * Groups chunks that came from the same source, so re-ingesting a document
   * can replace exactly its own chunks and nothing else.
   */
  sourceId: {
    type: String,
    required: true
  },
  sourceType: {
    type: String,
    enum: ['google_sheets', 'pdf', 'url', 'upload', 'manual'],
    default: 'manual'
  },
  /**
   * Which import wrote this chunk. A re-import writes its chunks under a new
   * id and then removes the ones under the old, so a search during the import
   * always finds something and a failed import leaves the previous version in
   * place rather than nothing.
   */
  importId: {
    type: String,
    default: null
  },
  collectionName: {
    type: String,
    default: 'knowledge_base'
  },
  content: {
    type: String,
    required: true
  },
  embedding: {
    type: [Number],
    required: true
  },
  /**
   * Which model produced `embedding`. Vectors from different models are not
   * comparable, so retrieval filters on this rather than silently ranking by
   * meaningless similarities after a model change.
   */
  embeddingSignature: {
    type: String,
    required: true,
    index: true
  },
  metadata: {
    type: Map,
    of: String
  },
  chunkIndex: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Retrieval always filters by company + collection + signature, so lead with
// those; re-ingestion deletes by company + sourceId.
KnowledgeChunkSchema.index({ company: 1, collectionName: 1, embeddingSignature: 1 });
KnowledgeChunkSchema.index({ company: 1, sourceId: 1 });
// The in-process search scans a tenant's newest chunks first; without this
// the sort was a full collection scan per message.
KnowledgeChunkSchema.index({ company: 1, createdAt: -1 });

/**
 * Replace every chunk for a source: write the new ones, then remove whatever
 * an earlier import left.
 *
 * Insert-then-delete rather than delete-then-insert, on purpose. A search
 * that lands between the two steps finds the old chunks or the new, never
 * nothing; and an insert that fails halfway leaves the previous import intact,
 * because its chunks are only removed once the new ones are all in.
 *
 * @param {string} importId identifies this import; every chunk must carry it
 */
KnowledgeChunkSchema.statics.replaceSource = async function(companyId, sourceId, chunks, importId) {
  if (!importId) {
    throw new Error('replaceSource needs an importId to tell the new chunks from the old');
  }

  let inserted = [];
  if (chunks.length) {
    inserted = await this.insertMany(chunks.map(chunk => ({ ...chunk, importId })));
  }

  await this.deleteMany({ company: companyId, sourceId, importId: { $ne: importId } });
  return inserted;
};

const KnowledgeChunk = mongoose.model('KnowledgeChunk', KnowledgeChunkSchema);

module.exports = KnowledgeChunk;
