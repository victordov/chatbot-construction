/**
 * Uploading a file into the knowledge base.
 *
 * The file goes the same way as every other import - chunked, embedded,
 * stored under one source id - so what matters here is the way in: which
 * files are read, which are refused and how, that a CSV is indexed a row at a
 * time with its headers, and that the result is listed like any other source.
 */

// Small, so the size limit can be tested without building a 10 MB buffer.
// Read when the route is first required, which is below.
process.env.KNOWLEDGE_UPLOAD_MAX_BYTES = String(16 * 1024);

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const User = require('../models/user');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const knowledgeFiles = require('../services/knowledge-files');

/** The smallest PDF that says something (same as knowledge-import.test.js). */
function tinyPdf(text) {
  const content = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(offset => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** pdf.js's worker without a dynamic import, which Jest cannot do. */
function installPdfWorkerForJest() {
  if (globalThis.pdfjsWorker) {
    return;
  }
  const workerPath = path.join(path.dirname(require.resolve('pdf-parse')), 'pdf.worker.mjs');
  const source = fs.readFileSync(workerPath, 'utf8')
    .replace(/import\.meta\.url/g, '""')
    .replace(/export\s*\{[^}]*\};?\s*$/, '');
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/knowledge', require('../routes/knowledge'));
  return app;
};

describe('uploading a file into the knowledge base', () => {
  let app;
  let company;
  let adminToken;
  let operatorToken;
  let superToken;

  const login = async username => (await request(app)
    .post('/api/auth/login')
    .send({ username, password: 'TestPassword123!' })).body.token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    installPdfWorkerForJest();
    app = buildApp();
    company = await Company.create({ name: 'Upload Knowledge Co' });

    await User.create([
      {
        username: 'kupload-admin', email: 'admin@kupload.test', password: 'TestPassword123!',
        role: 'company_admin', company: company._id, displayName: 'Admin'
      },
      {
        username: 'kupload-op', email: 'op@kupload.test', password: 'TestPassword123!',
        role: 'operator', company: company._id, displayName: 'Op'
      },
      {
        username: 'kupload-root', email: 'root@kupload.test', password: 'TestPassword123!',
        role: 'superadmin', displayName: 'Root'
      }
    ]);

    adminToken = await login('kupload-admin');
    operatorToken = await login('kupload-op');
    superToken = await login('kupload-root');
  });

  afterAll(async () => {
    await Promise.all([
      User.deleteMany({ email: /@kupload\.test$/ }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: company._id });
  });

  const upload = (buffer, filename, fields = {}, token = adminToken) => {
    const req = request(app).post('/api/knowledge/upload').set('x-auth-token', token);
    Object.entries(fields).forEach(([key, value]) => req.field(key, value));
    return req.attach('file', buffer, filename);
  };

  const contentOf = async () => (await KnowledgeChunk.find({ company: company._id }).sort({ chunkIndex: 1 }))
    .map(chunk => chunk.content).join('\n');

  test('a text file is imported as a file source', async () => {
    const response = await upload(Buffer.from('We open at nine and close at five.'), 'hours.txt');

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      sourceId: 'file:hours.txt',
      sourceType: 'file',
      filename: 'hours.txt',
      title: 'hours.txt',
      format: 'text',
      chunks: 1
    });

    const chunk = await KnowledgeChunk.findOne({ company: company._id });
    expect(chunk.sourceType).toBe('file');
    expect(chunk.content).toContain('We open at nine');
  });

  test('it is listed with its type and file name, and a given title', async () => {
    await upload(Buffer.from('# Returns\n\nThirty days, with a receipt.'), 'returns.md', { title: 'Returns policy' });

    const listing = await request(app).get('/api/knowledge').set('x-auth-token', adminToken);

    expect(listing.status).toBe(200);
    expect(listing.body.sources).toHaveLength(1);
    expect(listing.body.sources[0]).toMatchObject({
      sourceId: 'file:returns.md',
      sourceType: 'file',
      title: 'Returns policy',
      filename: 'returns.md',
      url: null
    });
  });

  test('a PDF is read for its text', async () => {
    const response = await upload(tinyPdf('Refunds take five working days.'), 'refunds.pdf');

    expect(response.status).toBe(201);
    expect(response.body.format).toBe('pdf');
    expect(await contentOf()).toContain('Refunds take five working days.');
    expect(await contentOf()).not.toContain('%PDF');
  });

  test('HTML is stripped of its markup and scripts, and named by its title', async () => {
    const html = '<html><head><title>Delivery &amp; collection</title><script>alert(1)</script></head>' +
      '<body><h1>Delivery</h1><p>We deliver on <b>Tuesdays</b>.</p></body></html>';
    const response = await upload(Buffer.from(html), 'delivery.html');

    expect(response.status).toBe(201);
    expect(response.body.title).toBe('Delivery & collection');
    const content = await contentOf();
    expect(content).toContain('We deliver on Tuesdays');
    expect(content).not.toMatch(/<|alert/);
  });

  test('a CSV becomes Header: value lines, whole rows per chunk', async () => {
    const csv = '﻿Product,Price,Notes\n' +
      'Kettle,£25,"Steel, 1.7 litres"\n' +
      'Toaster,£30,"Four slots; ""wide"" slots"\n' +
      ',,\n' +
      'Mug,£4,\n';
    const response = await upload(Buffer.from(csv), 'prices.csv');

    expect(response.status).toBe(201);
    expect(response.body.format).toBe('csv');

    const content = await contentOf();
    expect(content).toContain('Product: Kettle\nPrice: £25\nNotes: Steel, 1.7 litres');
    expect(content).toContain('Notes: Four slots; "wide" slots');
    // An empty cell is left out rather than written as "Notes: ".
    expect(content).toContain('Product: Mug\nPrice: £4');
    expect(content).not.toMatch(/Notes:\s*$/m);
  });

  test('a long CSV is split between rows, never inside one', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `Item ${i},${'x'.repeat(40)},${i}`);
    const chunks = knowledgeFiles.csvChunks(['Name,Description,Stock', ...rows].join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => {
      // Every row block starts with the first header and has all three.
      chunk.content.split('\n\n').forEach(block => {
        expect(block).toMatch(/^Name: Item \d+\nDescription: x+\nStock: \d+$/);
      });
    });
    expect(chunks[0].rows).toMatch(/^2-\d+$/);
  });

  test('semicolon CSV from a European spreadsheet is read too', () => {
    expect(knowledgeFiles.parseCsv('a;b\n1;2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('uploading the same file name again replaces it', async () => {
    await upload(Buffer.from('Old price: £20.'), 'kettle.txt');
    await upload(Buffer.from('New price: £25.'), 'kettle.txt');

    const chunks = await KnowledgeChunk.find({ company: company._id });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('New price: £25.');
  });

  describe('refusals', () => {
    test('a type we do not read is a 415 that says what we do', async () => {
      const response = await upload(Buffer.from('MZ\u0090\u0000'), 'setup.exe');

      expect(response.status).toBe(415);
      expect(response.body.error).toMatch(/PDF.*text.*Markdown.*CSV.*HTML/);
      expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(0);
    });

    test('a Word document is refused, with what to do instead', async () => {
      const response = await upload(Buffer.from('PK\u0003\u0004 not really a docx'), 'manual.docx');
      expect(response.status).toBe(415);
    });

    test('a file named .pdf that is not a PDF is refused', async () => {
      const response = await upload(Buffer.from('just some text'), 'fake.pdf');

      expect(response.status).toBe(415);
      expect(response.body.error).toMatch(/not one/);
    });

    test('binary data wearing a .txt name is refused', async () => {
      const response = await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]), 'notes.txt');
      expect(response.status).toBe(415);
    });

    test('a file over the size limit is a 413', async () => {
      const response = await upload(Buffer.alloc(20 * 1024, 'a'), 'big.txt');

      expect(response.status).toBe(413);
      expect(response.body.error).toMatch(/under/);
    });

    test('no file is a 400', async () => {
      const response = await request(app)
        .post('/api/knowledge/upload')
        .set('x-auth-token', adminToken)
        .field('title', 'nothing attached');

      expect(response.status).toBe(400);
    });

    test('an empty file is a 400, not an empty source', async () => {
      const response = await upload(Buffer.from('   \n  '), 'empty.txt');

      expect(response.status).toBe(400);
      expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(0);
    });

    test('an operator may not change the knowledge base', async () => {
      const response = await upload(Buffer.from('hello'), 'a.txt', {}, operatorToken);
      expect(response.status).toBe(403);
    });

    test('a superadmin has to say which company', async () => {
      const refused = await upload(Buffer.from('hello'), 'a.txt', {}, superToken);
      expect(refused.status).toBe(400);

      const accepted = await upload(Buffer.from('hello'), 'a.txt', { companyId: String(company._id) }, superToken);
      expect(accepted.status).toBe(201);
      expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(1);
    });
  });

  test('the plan\'s chunk allowance is checked against the real count', async () => {
    const usage = require('../services/usage');
    const check = jest.spyOn(usage, 'check').mockImplementation(async (companyId, meter, requested = 1) =>
      requested <= 1
        ? { allowed: true, limit: 500, used: 499, remaining: 1, planId: 'starter' }
        : { allowed: false, reason: 'Knowledge chunks limit reached.', limit: 500, used: 499, remaining: 1, planId: 'starter' });

    const response = await upload(Buffer.from('A sentence. '.repeat(400)), 'long.txt');

    expect(response.status).toBe(402);
    expect(response.body.code).toBe('PLAN_LIMIT_REACHED');
    check.mockRestore();
  });
});
