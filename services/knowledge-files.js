/**
 * Turning an uploaded file into knowledge.
 *
 * Until this existed the only ways in were a URL or pasted text, so a tenant
 * whose price list lived in a spreadsheet export, or whose policy was a PDF on
 * their laptop, had to put it on a public web server first. Every competing
 * product accepts a file; this is that.
 *
 * The type is decided from the bytes as well as the name. A browser's declared
 * content type is whatever the operating system guessed, and a file called
 * `prices.csv` that is really a zip archive would otherwise be embedded as
 * several hundred chunks of binary noise and served to visitors.
 */

const path = require('path');
const KnowledgeConnectorService = require('./knowledge-connector');

const connector = new KnowledgeConnectorService();

/** Roughly what the other importers aim for, so retrieval behaves the same. */
const CHUNK_SIZE = 1000;

/** The formats we read, by extension. */
const EXTENSIONS = {
  '.pdf': 'pdf',
  '.txt': 'text',
  '.text': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.csv': 'csv',
  '.html': 'html',
  '.htm': 'html'
};

/** The same formats, by declared content type, for a file with no extension. */
const MIME_TYPES = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/html': 'html'
};

/** What the 415 says we accept, in words a person reads. */
const ACCEPTED_DESCRIPTION = 'PDF, plain text (.txt), Markdown (.md), CSV (.csv) or HTML (.html)';

/** Thrown for a file we will not read; the route answers 415 with the message. */
class UnsupportedFileError extends Error {
  constructor(message) {
    super(message);
    this.status = 415;
    this.code = 'UNSUPPORTED_FILE_TYPE';
  }
}

/**
 * Whether bytes look like text rather than a binary format wearing a text
 * extension. A NUL byte never appears in UTF-8 text; the magic numbers catch
 * the binaries people most often rename by accident (zip, which is also every
 * .docx and .xlsx, and PDF).
 */
function looksLikeText(buffer) {
  const head = buffer.subarray(0, 8192);

  if (head.includes(0)) {
    return false;
  }
  const signature = head.subarray(0, 5).toString('latin1');
  return !signature.startsWith('PK\u0003\u0004') && !signature.startsWith('%PDF-');
}

/**
 * Which of our formats a file is, or an UnsupportedFileError.
 *
 * @param {{originalname: string, mimetype?: string, buffer: Buffer}} file
 * @returns {'pdf'|'text'|'markdown'|'csv'|'html'}
 */
function detectFormat(file) {
  const name = String(file.originalname || '');
  const extension = path.extname(name).toLowerCase();
  const declared = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  const format = EXTENSIONS[extension] || (!extension ? MIME_TYPES[declared] : null);

  if (!format) {
    throw new UnsupportedFileError(
      `${name || 'That file'} is not a type we can read. Upload a ${ACCEPTED_DESCRIPTION} file.`
    );
  }

  const buffer = file.buffer || Buffer.alloc(0);

  if (format === 'pdf') {
    // The header may be preceded by a little junk, which readers tolerate.
    if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
      throw new UnsupportedFileError(`${name} is named like a PDF but is not one.`);
    }
    return format;
  }

  if (!looksLikeText(buffer)) {
    throw new UnsupportedFileError(
      `${name} is named like a text file but contains binary data. ` +
      'A Word or Excel file has to be saved as PDF or CSV first.'
    );
  }

  return format;
}

/** UTF-8, without the byte-order mark spreadsheet exports like to add. */
function decode(buffer) {
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV, quotes and all.
 *
 * Small and strict on purpose rather than a dependency: RFC 4180 is quoted
 * fields, doubled quotes inside them, and newlines allowed within quotes. The
 * delimiter is whichever of comma, semicolon or tab the header row uses most,
 * because a spreadsheet saved in a European locale writes semicolons.
 *
 * @returns {string[][]}
 */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t']
    .map(candidate => [candidate, firstLine.split(candidate).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

/**
 * A CSV as chunks of whole rows.
 *
 * Each row is written as `Header: value` lines, so a chunk retrieved on its
 * own still says which number is the price and which the stock count. Rows are
 * packed into chunks of about the usual size and never split between two,
 * because half a row is a wrong answer waiting to happen. This is how the
 * Google Sheets recommendation in docs/PRODUCT.md says tabular data should be
 * indexed, and how the products it surveys do it.
 *
 * @returns {Array<{content: string, rows: string}>}
 */
function csvChunks(text) {
  const rows = parseCsv(text);

  if (rows.length < 2) {
    throw new Error('The CSV needs a header row and at least one row of data');
  }

  const headers = rows[0].map((header, index) => header.trim() || `Column ${index + 1}`);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let firstRow = 2;

  const flush = lastRow => {
    if (current.length) {
      chunks.push({ content: current.join('\n\n'), rows: `${firstRow}-${lastRow}` });
    }
    current = [];
    currentLength = 0;
  };

  rows.slice(1).forEach((cells, index) => {
    // Spreadsheet row numbers, counting the header as row 1, so a tenant can
    // find the row a chunk came from.
    const rowNumber = index + 2;
    const block = headers
      .map((header, column) => [header, String(cells[column] || '').trim()])
      .filter(([, value]) => value !== '')
      .map(([header, value]) => `${header}: ${value}`)
      .join('\n');

    if (!block) {
      return;
    }

    if (currentLength && currentLength + block.length > CHUNK_SIZE) {
      flush(rowNumber - 1);
      firstRow = rowNumber;
    }
    if (!current.length) {
      firstRow = rowNumber;
    }

    current.push(block);
    currentLength += block.length + 2;
  });

  flush(rows.length);
  return chunks;
}

/** The text inside an HTML document's <title>, if it has one. */
function htmlTitle(html) {
  return connector.htmlTitle(html);
}

/**
 * Read an uploaded file into chunks ready for the vector store.
 *
 * @param {{originalname: string, mimetype?: string, buffer: Buffer}} file
 * @returns {Promise<{format: string, title: string|null,
 *                    chunks: Array<{content: string, metadata?: object}>}>}
 *          `title` is one the document gave itself (an HTML <title>), or null
 * @throws {UnsupportedFileError} for a type we do not read (415)
 * @throws {Error} for a readable type with nothing usable in it (400)
 */
async function parseFile(file) {
  const format = detectFormat(file);
  let title = null;
  let chunks;

  if (format === 'csv') {
    chunks = csvChunks(decode(file.buffer)).map(chunk => ({
      content: chunk.content,
      metadata: { rows: chunk.rows }
    }));
  } else {
    let text;

    if (format === 'pdf') {
      text = await connector.parsePdf(file.buffer, file.originalname);
    } else if (format === 'html') {
      const html = decode(file.buffer);
      title = htmlTitle(html);
      text = connector.htmlToText(html);
    } else {
      // Markdown is read as it is written. Its markup is light enough that
      // the model reads it fine, and headings keep a chunk's context.
      text = decode(file.buffer).replace(/\r\n/g, '\n').trim();
    }

    chunks = connector.splitIntoChunks(text, CHUNK_SIZE).map(content => ({ content }));
  }

  if (!chunks.length) {
    throw new Error('That file has no text in it to learn from');
  }

  return { format, title, chunks };
}

module.exports = {
  parseFile,
  detectFormat,
  parseCsv,
  csvChunks,
  htmlTitle,
  UnsupportedFileError,
  ACCEPTED_DESCRIPTION
};
