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

/**
 * Replace every chunk for a source in one step, so a re-import cannot leave
 * stale chunks from the previous version behind.
 */
KnowledgeChunkSchema.statics.replaceSource = async function(companyId, sourceId, chunks) {
  await this.deleteMany({ company: companyId, sourceId });
  if (!chunks.length) {
    return [];
  }
  return this.insertMany(chunks);
};

const KnowledgeChunk = mongoose.model('KnowledgeChunk', KnowledgeChunkSchema);

module.exports = KnowledgeChunk;
