/**
 * Text written straight into the knowledge base.
 *
 * Three ways in, one way of storing it: pasted on the Knowledge screen, edited
 * there afterwards, and written as the answer when an admin teaches the bot a
 * question it could not answer. They used to be (or would have become) three
 * copies of "split, check the plan, embed, store", and the copies drift: one
 * forgets the quota, another titles its chunks differently, and a taught answer
 * stops looking like the note it is.
 *
 * The source id is random rather than derived from the title, so two notes
 * both called "Opening hours" (one per branch, say) do not replace each other.
 * Storing under an existing id replaces that source atomically: the vector
 * store writes the new chunks before removing the old, so a search in between
 * finds one version or the other, never nothing.
 */

const crypto = require('crypto');
const KnowledgeConnectorService = require('./knowledge-connector');
const KnowledgeChunk = require('../models/knowledge-chunk');
const KnowledgeSource = require('../models/knowledge-source');
const { getVectorStore } = require('./vector-store');
const usageService = require('./usage');

const connector = new KnowledgeConnectorService();

/** Characters per chunk, the same as a fetched page. */
const CHUNK_SIZE = 1000;

/** How far consecutive chunks overlap (knowledge-connector's default). */
const CHUNK_OVERLAP = 200;

/** A fresh id for a new note. */
function newSourceId() {
  return `text:${crypto.randomUUID()}`;
}

/** Whether a source id is one of these notes, and so may be edited as text. */
function isTextSource(sourceId) {
  return /^text:/.test(String(sourceId || ''));
}

/**
 * Refuse a write that would take the tenant over their chunk allowance.
 *
 * Chunks the same source already has are being replaced, so they do not count
 * against it: editing a note never needs more room than the edit adds.
 *
 * @throws {Error} with `status: 402` and the meter, limit and usage attached,
 *         the shape routes/knowledge.js answers a quota refusal with
 */
async function assertRoom(companyId, sourceId, chunkCount) {
  const replacing = await KnowledgeChunk.countDocuments({ company: companyId, sourceId });
  const requested = Math.max(0, chunkCount - replacing);
  const result = await usageService.check(companyId, 'knowledgeChunks', requested);

  if (!result.allowed) {
    await usageService.recordLimitHit(companyId);
    const error = new Error(
      `${result.reason || 'Knowledge limit reached.'} This would add ${requested} chunk${requested === 1 ? '' : 's'}.`
    );
    error.status = 402;
    error.code = 'PLAN_LIMIT_REACHED';
    error.meter = 'knowledgeChunks';
    error.limit = result.limit;
    error.used = result.used;
    throw error;
  }
}

/**
 * Chunk, embed and store a piece of text as one source.
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {string} options.text
 * @param {string} [options.title='Note'] the name the dashboard shows
 * @param {string} [options.sourceId] an existing note's id to replace it;
 *        a new id otherwise
 * @param {object} [options.metadata] extra string fields for every chunk,
 *        e.g. `{ taughtFrom: sessionId }`
 * @param {boolean} [options.enforceQuota=true] false for a superadmin, who is
 *        not subject to a tenant's plan
 * @param {string} [options.by] the user writing it, recorded with the text
 * @returns {Promise<{sourceId: string, chunks: number, title: string}>}
 */
async function storeText({ companyId, text, title, sourceId, metadata = {}, enforceQuota = true, by }) {
  if (!companyId) {
    throw new Error('A company is required to store knowledge');
  }

  const body = String(text || '').trim();
  if (!body) {
    const error = new Error('There is no text to save');
    error.status = 400;
    throw error;
  }

  const id = sourceId || newSourceId();
  const name = String(title || '').trim().slice(0, 200) || 'Note';
  const chunks = connector.splitIntoChunks(body, CHUNK_SIZE);

  if (enforceQuota) {
    await assertRoom(companyId, id, chunks.length);
  }

  const stored = await getVectorStore().store(
    chunks.map((content, index) => ({
      content,
      chunkIndex: index,
      metadata: { ...stringValues(metadata), title: name, source: 'manual' }
    })),
    { companyId, sourceId: id, sourceType: 'manual' }
  );

  // The note as typed, so editing it later starts from exactly this rather
  // than from overlapping chunks glued back together. After the chunks, so a
  // failed import never leaves text describing chunks that are not there.
  await KnowledgeSource.updateOne(
    { company: companyId, sourceId: id },
    {
      $set: { title: name, text: body, updatedAt: new Date(), ...(by ? { updatedBy: by } : {}) },
      $setOnInsert: { company: companyId, sourceId: id }
    },
    { upsert: true }
  );

  return { sourceId: id, chunks: stored.stored, title: name };
}

/**
 * A note's title and text, for editing.
 *
 * Notes written since the text was kept come back exactly as typed. Older ones
 * only exist as chunks, which overlap; the overlap is removed where the next
 * chunk starts with the end of the previous one, which is how they were cut.
 *
 * @returns {Promise<{sourceId: string, title: string, text: string}|null>}
 *          null when the source does not exist for this company
 */
async function readText(companyId, sourceId) {
  const saved = await KnowledgeSource.findOne({ company: companyId, sourceId })
    .select('title text').lean();

  if (saved && typeof saved.text === 'string' && saved.text) {
    return { sourceId, title: saved.title || 'Note', text: saved.text };
  }

  const chunks = await KnowledgeChunk.find({ company: companyId, sourceId })
    .select('content chunkIndex metadata')
    .sort({ chunkIndex: 1 })
    .lean();

  if (chunks.length === 0) {
    return null;
  }

  const metadata = chunks[0].metadata || {};
  return {
    sourceId,
    title: (saved && saved.title) || metadata.title || 'Note',
    text: joinChunks(chunks.map(chunk => String(chunk.content || '')))
  };
}

/**
 * Glue overlapping chunks back into one text.
 *
 * Each chunk after the first starts with up to CHUNK_OVERLAP characters of the
 * one before. The longest such overlap is dropped; chunks that do not overlap
 * (a note from some other producer) are joined with a blank line.
 */
function joinChunks(chunks) {
  return chunks.reduce((text, chunk, index) => {
    if (index === 0) {
      return chunk;
    }
    const limit = Math.min(CHUNK_OVERLAP, text.length, chunk.length);
    for (let size = limit; size > 0; size -= 1) {
      if (text.endsWith(chunk.slice(0, size))) {
        return text + chunk.slice(size);
      }
    }
    return `${text}\n\n${chunk}`;
  }, '');
}

/** Forget what was kept about a source once its chunks are gone. */
async function forget(companyId, sourceId) {
  await KnowledgeSource.deleteOne({ company: companyId, sourceId });
}

/** Chunk metadata is a map of strings; anything else would be cast or lost. */
function stringValues(object) {
  return Object.fromEntries(
    Object.entries(object || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

module.exports = {
  storeText,
  readText,
  joinChunks,
  forget,
  assertRoom,
  newSourceId,
  isTextSource,
  CHUNK_SIZE
};
