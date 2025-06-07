// Document indexing and search service for CSV and Markdown files
// Uses 'csv-parse' for CSV and basic text search for Markdown

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DOCS_DIR = path.join(__dirname, '../docs');

function indexMarkdownFiles() {
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
  const index = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
    index.push({ file, content });
  }
  return index;
}

function searchMarkdown(query, index) {
  const results = [];
  for (const doc of index) {
    if (doc.content.toLowerCase().includes(query.toLowerCase())) {
      results.push({ file: doc.file, snippet: getSnippet(doc.content, query) });
    }
  }
  return results;
}

function getSnippet(content, query, len = 100) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return '';
  }
  return content.substring(Math.max(0, idx - len/2), idx + len/2);
}

function indexCSVFiles() {
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.csv'));
  const index = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
    const records = parse(content, { columns: true });
    index.push({ file, records });
  }
  return index;
}

function searchCSV(query, index) {
  const results = [];
  for (const doc of index) {
    for (const row of doc.records) {
      for (const value of Object.values(row)) {
        if (String(value).toLowerCase().includes(query.toLowerCase())) {
          results.push({ file: doc.file, row });
          break;
        }
      }
    }
  }
  return results;
}

module.exports = {
  indexMarkdownFiles,
  searchMarkdown,
  indexCSVFiles,
  searchCSV
};

