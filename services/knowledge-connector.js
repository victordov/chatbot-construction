/**
 * Knowledge Connector Services
 * Handles integration with various knowledge sources (Google Sheets, PDF, Vector stores)
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { logger } = require('./logging');

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
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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

      let content = '';
      let filename = '';

      if (url.endsWith('.pdf')) {
        // Handle PDF documents
        content = await this.extractPdfContent(url, tenantId);
        filename = path.basename(url);
      } else {
        // Handle web URLs
        content = await this.extractWebContent(url);
        filename = new URL(url).hostname;
      }

      // Split content into chunks for better vector storage
      const chunks = this.splitIntoChunks(content, 1000);
      
      const documents = chunks.map((chunk, index) => ({
        id: `${tenantId}_url_${Buffer.from(url).toString('base64')}_${index}`,
        content: chunk,
        metadata: {
          source: url.endsWith('.pdf') ? 'pdf' : 'web_url',
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
   * Extract PDF content (placeholder - would use PyPDF or similar)
   */
  async extractPdfContent(url, tenantId) {
    // This is a placeholder. In a real implementation, you'd use:
    // - pdf-parse library for Node.js
    // - or call a Python service with PyPDF2/pdfplumber
    // - or use a cloud service like AWS Textract
    
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      
      // For now, return a placeholder. In production, use proper PDF parsing
      return `PDF content from ${url} - would be extracted using pdf-parse or similar library`;
    } catch (error) {
      throw new Error(`Failed to download PDF: ${error.message}`);
    }
  }

  /**
   * Extract web content
   */
  async extractWebContent(url) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ChatbotKnowledgeBot/1.0)'
        },
        timeout: 30000
      });

      const html = response.data;
      
      // Basic HTML to text conversion (in production, use a proper HTML parser)
      const textContent = html
        .replace(/<script[^>]*>.*?<\/script>/gis, '')
        .replace(/<style[^>]*>.*?<\/style>/gis, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return textContent;
    } catch (error) {
      throw new Error(`Failed to fetch web content: ${error.message}`);
    }
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
  async storeInVectorDB(documents, collectionName = 'knowledge_base') {
    try {
      // This would integrate with Qdrant client
      // For now, return a placeholder
      
      const results = documents.map(doc => ({
        id: doc.id,
        stored: true,
        collection: collectionName,
        vector_id: `vec_${doc.id}`
      }));

      return results;
    } catch (error) {
      console.error('Error storing in vector DB:', error);
      throw new Error(`Failed to store in vector database: ${error.message}`);
    }
  }

  /**
   * Search vector store with tenant filtering
   */
  async searchVectorStore(query, tenantId, collectionName = 'knowledge_base', limit = 5) {
    try {
      // This would integrate with Qdrant client for vector search
      // with tenant filtering
      
      // Placeholder implementation
      return {
        results: [],
        query,
        tenantId,
        collection: collectionName
      };
    } catch (error) {
      console.error('Error searching vector store:', error);
      throw new Error(`Failed to search vector store: ${error.message}`);
    }
  }

  /**
   * Process knowledge source and store in vector DB
   */
  async processKnowledgeSource(sourceConfig, tenantId) {
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

      // Store in vector database
      const collectionName = `tenant_${tenantId}_knowledge`;
      const vectorResults = await this.storeInVectorDB(documents, collectionName);

      return {
        success: true,
        type: sourceConfig.sourceType,
        documentsProcessed: documents.length,
        vectorResults,
        collectionName
      };
    } catch (error) {
      logger.error('Error processing knowledge source', { error: error.message });
      throw error;
    }
  }

  /**
   * Get knowledge for a query (used by workflow execution)
   */
  async getKnowledge(query, knowledgeNodes, tenantId) {
    try {
      const knowledgeResults = [];

      for (const node of knowledgeNodes) {
        // Accept both the raw editor node ({ data: { sourceType, config } })
        // and the compiled source ({ type, config }) the compiler produces.
        const sourceType = node.sourceType || node.type || node.data?.sourceType || node.data?.type;
        const config = node.config || node.data?.config || {};

        if (sourceType === 'vector_store' || sourceType === 'vector-store') {
          // Search vector store
          const results = await this.searchVectorStore(
            query, 
            tenantId, 
            config.collectionName || `tenant_${tenantId}_knowledge`
          );
          knowledgeResults.push(...results.results);
        } else {
          // For other types, we would have already processed them into vector store
          const results = await this.searchVectorStore(
            query, 
            tenantId, 
            `tenant_${tenantId}_knowledge`
          );
          knowledgeResults.push(...results.results);
        }
      }

      return knowledgeResults;
    } catch (error) {
      logger.error('Error getting knowledge', { error: error.message });
      return [];
    }
  }

  /**
   * Query a single knowledge source directly.
   *
   * This is the entry point the workflow editor's "test source" action and the
   * integration tests use: given a source config, fetch matching content
   * without needing the source to have been ingested into the vector store
   * first.
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
        if (!process.env.GOOGLE_CLIENT_EMAIL && !config.credentialsPath) {
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
        if (!process.env.QDRANT_URL && !this.vectorStore) {
          throw new Error('Vector store not configured: set QDRANT_URL');
        }
        const results = await this.searchVectorStore(
          query,
          tenantId,
          config.collection || config.collectionName || `tenant_${tenantId}_knowledge`
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
