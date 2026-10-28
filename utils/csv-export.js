/**
 * CSV for exports somebody opens in a spreadsheet.
 *
 * Quoting alone is not enough. A cell that begins with `=`, `+`, `-` or `@` is
 * a formula to Excel, LibreOffice and Google Sheets, and every value in these
 * exports - a visitor's name, a message, a tag - was typed by a stranger. A
 * visitor who calls themselves `=HYPERLINK("https://evil.example", "Click")`
 * would otherwise put a live link, or worse, in front of whoever opens the
 * file. Prefixing a quote makes the spreadsheet show the text as text.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted, with a formula neutralised. */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * A whole file: header row first, CRLF line endings, and a byte-order mark so
 * Excel reads it as UTF-8 rather than mangling every accented name.
 *
 * @param {string[]} header
 * @param {Array<Array<*>>} rows
 */
function toCsv(header, rows) {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { csvCell, toCsv };
