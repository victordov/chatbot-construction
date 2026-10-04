/**
 * Knowledge Connector Services
 * Handles integration with various knowledge sources (Google Sheets, PDF, Vector stores)
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const path = require('path');
const { logger } = require('./logging');
const { getVectorStore } = require('./vector-store');
const safeHttp = require('./safe-http');

// PDFs are downloaded into memory before parsing, so cap the size.
const MAX_PDF_BYTES = parseInt(process.env.MAX_PDF_BYTES, 10) || 25 * 1024 * 1024;

// A web page is text; anything this large is not a knowledge source.
const MAX_PAGE_BYTES = parseInt(process.env.MAX_PAGE_BYTES, 10) || 2 * 1024 * 1024;

/**
 * Whether a URL names a PDF, by its path.
 *
 * Ignores the query string and fragment: `report.pdf?v=3` is a PDF, and the
 * old `endsWith('.pdf')` said it was not while the route said it was, so the
 * source was labelled one thing and loaded as another.
 */
function isPdfUrl(url) {
  try {
    return /\.pdf$/i.test(new URL(String(url)).pathname);
  } catch {
    return /\.pdf(\?|#|$)/i.test(String(url));
  }
}

/** Whether a response says it is a PDF, whatever the URL looked like. */
function isPdfResponse(headers = {}) {
  const type = String(headers['content-type'] || '').toLowerCase();
  return type.startsWith('application/pdf') || type.startsWith('application/x-pdf');
}

class KnowledgeConnectorService {
  constructor() {
    this.vectorStore = null; // Will be initialized with Qdrant client
  }

  /**
   * Google Sheets Loader
   * Uses LangChain's JavaScript loader for cell ingestion
   */
  async loadGoogleSheets(config, tenantId) {
    try {
      const { sheetId, range = 'A:Z', credentialsPath } = config;

      if (!sheetId) {
        throw new Error('Google Sheets ID is required');
      }

      // Initialize the sheet
      const doc = new GoogleSpreadsheet(sheetId);

      // Load credentials (this should be tenant-specific)
      if (credentialsPath) {
        const creds = require(credentialsPath);
        await doc.useServiceAccountAuth(creds);
      } else {
        // Use environment credentials
        await doc.useServiceAccountAuth({
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
        });
      }

      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0]; // Get first sheet

      // Parse range
      const [startCol, endCol] = range.split(':');
      await sheet.loadCells(range);

      const rows = [];
      const headerRow = sheet.getRows({ offset: 0, limit: 1 });
      const headers = [];

      // Get headers
      const maxCol = sheet.columnCount;
      for (let col = 0; col < maxCol; col++) {
        const cell = sheet.getCell(0, col);
        headers.push(cell.value || `Column${col + 1}`);
      }

      // Get data rows
      const allRows = await sheet.getRows();
      const documents = allRows.map((row, index) => {
        const rowData = {};
        headers.forEach((header, colIndex) => {
          rowData[header] = row._rawData[colIndex] || '';
        });

        return {
          id: `${tenantId}_sheets_${sheetId}_${index}`,
          content: Object.values(rowData).join(' ').trim(),
          metadata: {
            source: 'google_sheets',
            sheetId,
            rowIndex: index,
            tenantId,
            ...rowData
          }
        };
      });

      return documents;
    } catch (error) {
      console.error('Error loading Google Sheets:', error);
      throw new Error(`Failed to load Google Sheets: ${error.message}`);
    }
  }

  /**
   * PDF/URL Loader
   * Uses Apache-2 tools for document processing
   */
  async loadPdfUrl(config, tenantId) {
    try {
      const { url } = config;

      if (!url) {
        throw new Error('URL is required');
      }

      // Fetched once, as bytes, and only then decided: a PDF is a PDF when
      // either the path says so or the server does. The one fetch also means
      // the size cap is the larger of the two, which is fine - a page that is
      // 25MB is refused as a knowledge source further down anyway.
      const response = await this.fetchDocument(url);
      const pdf = isPdfUrl(url) || isPdfResponse(response.headers);

      let content = '';
      let filename = '';

      if (pdf) {
        content = await this.parsePdf(response.body, url);
        filename = path.basename(new URL(url).pathname) || 'document.pdf';
      } else {
        if (response.body.length > MAX_PAGE_BYTES) {
          throw new Error(`Failed to fetch web content: page is larger than ${Math.round(MAX_PAGE_BYTES / 1024 / 1024)}MB`);
        }
        content = this.htmlToText(response.body.toString('utf8'));
        filename = new URL(url).hostname;
      }

      // Split content into chunks for better vector storage
      const chunks = this.splitIntoChunks(content, 1000);

      const documents = chunks.map((chunk, index) => ({
        id: `${tenantId}_url_${Buffer.from(url).toString('base64')}_${index}`,
        content: chunk,
        metadata: {
          source: pdf ? 'pdf' : 'web_url',
          url,
          filename,
          chunkIndex: index,
          tenantId
        }
      }));

      return documents;
    } catch (error) {
      logger.error('Error loading PDF/URL', { error: error.message });
      throw new Error(`Failed to load PDF/URL: ${error.message}`);
    }
  }

  /**
   * Download a document through the address-checked transport.
   *
   * Not plain axios. The URL is one a tenant typed, so this is our server
   * fetching on behalf of somebody whose interests are not ours - the same
   * hazard as a workflow action or a webhook, and it gets the same protection:
   * private, loopback and cloud-metadata addresses are refused, on every
   * redirect hop.
   */
  async fetchDocument(url) {
    try {
      return await safeHttp.fetchUrl(url, {
        asBuffer: true,
        maxBytes: MAX_PDF_BYTES,
        timeoutMs: 60000
      });
    } catch (error) {
      throw new Error(`Failed to download: ${error.message}`);
    }
  }

  /**
   * Extract the text of a PDF at a URL.
   */
  async extractPdfContent(url) {
    const response = await this.fetchDocument(url);
    return this.parsePdf(response.body, url);
  }

  /**
   * The text of a PDF.
   *
   * This previously returned the literal string "PDF content from <url> -
   * would be extracted using pdf-parse or similar library", which was then
   * chunked, embedded and served to visitors as knowledge. The next version
   * called `pdfParse(buffer)`, which is the 1.x API; the installed 2.x exports
   * a `PDFParse` class, so every PDF import failed with "pdfParse is not a
   * function".
   */
  async parsePdf(buffer, url = '') {
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(`PDF is larger than the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB limit`);
    }

    let parser = null;

    try {
      // Required lazily: it is only needed on this path, and loading pdf.js
      // costs enough that every other request should not pay for it.
      const { PDFParse } = require('pdf-parse');
      parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();

      const text = String(parsed.text || '')
        // pdf-parse 2.x writes a "-- 3 of 12 --" separator between pages,
        // which is navigation, not knowledge.
        .replace(/^\s*-- \d+ of \d+ --\s*$/gm, '')
        // PDF extraction leaves ragged whitespace and hyphenated line breaks.
        .replace(/-\n\s*/g, '')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!text) {
        throw new Error('No extractable text found. The PDF may be a scan; OCR is not supported.');
      }

      logger.info('Extracted PDF text', { url, pages: parsed.total, characters: text.length });
      return text;
    } catch (error) {
      throw new Error(`Failed to read PDF: ${error.message}`);
    } finally {
      if (parser) {
        // pdf.js holds worker resources until told otherwise.
        await parser.destroy().catch(() => {});
      }
    }
  }

  /**
   * Extract web content
   */
  async extractWebContent(url) {
    try {
      const response = await safeHttp.fetchUrl(url, {
        maxBytes: MAX_PAGE_BYTES,
        timeoutMs: 30000
      });

      return this.htmlToText(response.body);
    } catch (error) {
      throw new Error(`Failed to fetch web content: ${error.message}`);
    }
  }

  /**
   * Basic HTML to text conversion (in production, use a proper HTML parser).
   */
  htmlToText(html) {
    return String(html)
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Split text into chunks
   */
  splitIntoChunks(text, maxChunkSize = 1000, overlap = 200) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxChunkSize;

      if (end >= text.length) {
        chunks.push(text.slice(start));
        break;
      }

      // Try to find a good break point (sentence boundary)
      const breakPoint = text.lastIndexOf('.', end);
      if (breakPoint > start + maxChunkSize * 0.5) {
        end = breakPoint + 1;
      }

      chunks.push(text.slice(start, end));
      start = end - overlap;
    }

    return chunks.filter(chunk => chunk.trim().length > 0);
  }

  /**
   * Vector Store Integration with Qdrant
   * One collection per environment, tenant isolation via payload filtering
   */
  async storeInVectorDB(documents, collectionName = 'knowledge_base', options = {}) {
    // This used to report `{stored: true}` for every document without writing
    // anything anywhere, so ingestion always "succeeded" and retrieval always
    // came back empty.
    const { companyId, sourceId, sourceType } = options;

    return getVectorStore().store(documents, {
      companyId,
      sourceId: sourceId || `source_${collectionName}`,
      sourceType,
      collectionName
    });
  }

  /**
   * Search vector store with tenant filtering
   */
  async searchVectorStore(query, tenantId, collectionName = 'knowledge_base', limit = 5) {
    // Previously returned an empty array unconditionally, which is why every
    // knowledge node in every workflow contributed no context.
    const results = await getVectorStore().search(query, {
      companyId: tenantId,
      collectionName,
      limit
    });

    return { results, query, tenantId, collection: collectionName };
  }

  /**
   * Process knowledge source and store in vector DB.
   *
   * @param {object} [options]
   * @param {function} [options.beforeStore] called with the chunked documents
   *        after loading and before any embedding is paid for. Throwing here
   *        aborts the import with the thrown error: the route uses it to check
   *        the tenant's plan against the real chunk count.
   */
  async processKnowledgeSource(sourceConfig, tenantId, options = {}) {
    try {
      let documents = [];

      switch (sourceConfig.sourceType) {
      case 'google_sheets':
        documents = await this.loadGoogleSheets(sourceConfig.config, tenantId);
        break;
      case 'pdf':
      case 'url':
        documents = await this.loadPdfUrl(sourceConfig.config, tenantId);
        break;
      case 'vector_store':
        // Direct vector store access - no processing needed
        return { success: true, type: 'vector_store', config: sourceConfig.config };
      default:
        throw new Error(`Unsupported source type: ${sourceConfig.sourceType}`);
      }

      // Store in the vector database, scoped to the tenant and to this source
      // so a re-import replaces exactly its own chunks.
      const collectionName = sourceConfig.collectionName || 'knowledge_base';
      const sourceId = sourceConfig.sourceId ||
        `${sourceConfig.sourceType}:${sourceConfig.config?.sheetId || sourceConfig.config?.url || 'default'}`;

      if (typeof options.beforeStore === 'function') {
        await options.beforeStore(documents, { sourceId });
      }

      const vectorResults = await this.storeInVectorDB(documents, collectionName, {
        companyId: tenantId,
        sourceId,
        sourceType: sourceConfig.sourceType === 'google_sheets' ? 'google_sheets'
          : sourceConfig.sourceType === 'vector_store' ? 'manual'
            : sourceConfig.sourceType
      });

      return {
        success: true,
        type: sourceConfig.sourceType,
        documentsProcessed: documents.length,
        vectorResults,
        collectionName,
        sourceId
      };
    } catch (error) {
      logger.error('Error processing knowledge source', { error: error.message });
      throw error;
    }
  }

  /**
   * Get knowledge for a query (used by workflow execution)
   */
  async getKnowledge(query, knowledgeNodes = [], tenantId, options = {}) {
    try {
      if (!tenantId || knowledgeNodes.length === 0) {
        return [];
      }

      // Every node used to trigger its own search against a
      // `tenant_<id>_knowledge` collection that ingestion never wrote to, and
      // identical results were then concatenated once per node. Search each
      // distinct collection once instead, and let the tenant filter do the
      // isolation work.
      const collections = [...new Set(
        knowledgeNodes.map(node => {
          const config = node.config || node.data?.config || {};
          return config.collectionName || config.collection || 'knowledge_base';
        })
      )];

      const limit = options.limit || 5;
      const perCollection = await Promise.all(
        collections.map(collectionName =>
          this.searchVectorStore(query, tenantId, collectionName, limit)
            .then(result => result.results)
            .catch(error => {
              // One bad source must not remove the context from the others.
              logger.warn('Knowledge search failed for a collection', {
                collectionName,
                error: error.message
              });
              return [];
            })
        )
      );

      // Merge, drop duplicates, and keep the best-scoring chunks overall.
      const seen = new Set();
      return perCollection
        .flat()
        .filter(result => {
          const key = result.content;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      logger.error('Error getting knowledge', { error: error.message });
      return [];
    }
  }

  /**
   * Query a single knowledge source directly, without going through the
   * ingest-then-search path.
   *
   * This is what the workflow editor's "test this source" action uses: an
   * author configuring a knowledge node wants to see whether their credentials
   * and IDs are right before committing to a full import.
   *
   * @param {object} config  `{ type, ... }` describing the source
   * @param {string} query   the user's question
   * @param {string} tenantId
   * @returns {Promise<{source: string, results: Array}>}
   */
  async queryKnowledgeSource(config = {}, query = '', tenantId) {
    const type = config.type || config.sourceType;

    switch (type) {
    case 'google-sheets':
    case 'google_sheets': {
      if (!config.spreadsheetId && !config.sheetId) {
        throw new Error('Google Sheets service not configured: spreadsheetId is required');
      }
      if (!process.env.GOOGLE_CLIENT_EMAIL && !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !config.credentialsPath) {
        throw new Error('Google Sheets service not configured: no service account credentials');
      }
      const documents = await this.loadGoogleSheets(
        { ...config, sheetId: config.sheetId || config.spreadsheetId },
        tenantId
      );
      return { source: 'google-sheets', results: this.rankByRelevance(documents, query) };
    }

    case 'pdf-url':
    case 'pdf':
    case 'url': {
      if (!config.url) {
        throw new Error('Failed to fetch content from URL: no url provided');
      }
      try {
        const documents = await this.loadPdfUrl(config, tenantId);
        return { source: type, results: this.rankByRelevance(documents, query) };
      } catch (error) {
        // Surface a consistent message; callers (the editor's "test source"
        // button) show this string directly to the user.
        throw new Error(`Failed to fetch content from URL "${config.url}": ${error.message}`);
      }
    }

    case 'vector-store':
    case 'vector_store': {
      // Only a *dedicated* vector database counts as "configured" here. The
      // in-process MongoDB backend is queried through searchVectorStore, which
      // this method deliberately does not stand in for: a vector-store node
      // points at an external index the author must set up.
      if (!process.env.QDRANT_URL && !process.env.MONGODB_VECTOR_INDEX) {
        throw new Error('Vector store not configured: set QDRANT_URL or MONGODB_VECTOR_INDEX');
      }
      const results = await this.searchVectorStore(
        query,
        tenantId,
        config.collection || config.collectionName || 'knowledge_base'
      );
      return { source: 'vector-store', results: results.results || [] };
    }

    default:
      throw new Error(`Unsupported knowledge source type: ${type}`);
    }
  }

  /**
   * Cheap lexical ranking for sources queried directly (no embeddings).
   * Keeps the most term-overlapping chunks so the prompt stays small.
   */
  rankByRelevance(documents = [], query = '', limit = 5) {
    const terms = String(query)
      .toLowerCase()
      .split(/\W+/)
      .filter(term => term.length > 2);

    if (terms.length === 0) {
      return documents.slice(0, limit);
    }

    return documents
      .map(doc => {
        const content = String(doc.content || doc.pageContent || '').toLowerCase();
        const score = terms.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0);
        return { ...doc, score };
      })
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = KnowledgeConnectorService;
module.exports.isPdfUrl = isPdfUrl;
module.exports.isPdfResponse = isPdfResponse;
