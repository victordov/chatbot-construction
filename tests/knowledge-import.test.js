/**
 * Importing knowledge: PDFs actually parse, notes do not collide, re-imports
 * never leave a gap.
 *
 * The PDF path had never worked in production: the installed pdf-parse 2.x
 * exports a class, and the loader called it as a function. And a pasted note
 * took its id from its title, so two "Opening hours" notes overwrote each
 * other.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const User = require('../models/user');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const safeHttp = require('../services/safe-http');
const { getVectorStore } = require('../services/vector-store');
const KnowledgeConnectorService = require('../services/knowledge-connector');
const { isPdfUrl } = require('../services/knowledge-connector');

/**
 * The smallest PDF that says something: one page, one Helvetica line.
 * Offsets in the xref table have to be right or pdf.js rejects the file.
 */
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

/**
 * Hand pdf.js its worker without a dynamic import.
 *
 * In Node the library loads its worker with `import()`, which Jest's module
 * sandbox cannot do ("A dynamic import callback was invoked without
 * --experimental-vm-modules"). pdf.js checks `globalThis.pdfjsWorker` first,
 * and the worker script sets exactly that when evaluated, so it is evaluated
 * here as a plain script. Test-only: the product runs the real import.
 */
function installPdfWorkerForJest() {
  if (globalThis.pdfjsWorker) {
    return;
  }
  const workerPath = path.join(
    path.dirname(require.resolve('pdf-parse')), 'pdf.worker.mjs'
  );
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

describe('importing knowledge', () => {
  let app;
  let company;
  let adminToken;
  let server;
  let base;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    installPdfWorkerForJest();
    app = buildApp();
    company = await Company.create({ name: 'Import Test Co', description: 'test tenant' });

    await User.create({
      username: 'import-admin',
      displayName: 'Import Admin',
      email: 'admin@import.test',
      password: 'TestPassword123!',
      role: 'company_admin',
      company: company._id
    });

    adminToken = (await request(app)
      .post('/api/auth/login')
      .send({ username: 'import-admin', password: 'TestPassword123!' })).body.token;

    // The transport refuses loopback addresses by design; the test server is
    // on one, so name resolution is handed back to the OS for this suite.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) =>
      dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        if (req.url.startsWith('/policy.pdf')) {
          res.writeHead(200, { 'content-type': 'application/pdf' });
          return res.end(tinyPdf('Refunds are available within 30 days of purchase.'));
        }
        if (req.url.startsWith('/download')) {
          // A PDF with nothing in the URL to say so: only the header does.
          res.writeHead(200, { 'content-type': 'application/pdf' });
          return res.end(tinyPdf('Delivery takes three working days.'));
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><p>We open at nine.</p></body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        base = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    safeHttp.__setLookupForTests(null);
    delete process.env.ACTIONS_ALLOW_HTTP;
    await new Promise(resolve => server.close(resolve));
    await Promise.all([
      User.deleteMany({ company: company._id }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: company._id });
  });

  const post = body => request(app)
    .post('/api/knowledge/sources')
    .set('x-auth-token', adminToken)
    .send(body);

  describe('PDFs', () => {
    test('a PDF is read with the pdf-parse 2.x API, not called as a function', async () => {
      const connector = new KnowledgeConnectorService();
      const text = await connector.parsePdf(tinyPdf('Hello from a PDF.'));

      expect(text).toContain('Hello from a PDF.');
      // Page separators are navigation, not knowledge.
      expect(text).not.toMatch(/-- \d+ of \d+ --/);
    });

    test('a PDF at a URL with a query string is imported as a PDF', async () => {
      const response = await post({ url: `${base}/policy.pdf?v=2` });

      expect(response.status).toBe(201);
      expect(response.body.sourceType).toBe('pdf');
      expect(response.body.chunks).toBeGreaterThan(0);

      const chunks = await KnowledgeChunk.find({ company: company._id });
      expect(chunks.map(chunk => chunk.content).join(' ')).toContain('Refunds are available within 30 days');
      expect(chunks[0].sourceType).toBe('pdf');
    });

    test('a PDF served without .pdf in the path is still read as one', async () => {
      const response = await post({ url: `${base}/download?id=7` });

      expect(response.status).toBe(201);

      const chunks = await KnowledgeChunk.find({ company: company._id });
      expect(chunks.map(chunk => chunk.content).join(' ')).toContain('Delivery takes three working days');
      // Not the raw bytes of the file mistaken for a web page.
      expect(chunks.map(chunk => chunk.content).join(' ')).not.toContain('%PDF');
    });

    test('the route and the loader agree on what a PDF is', () => {
      expect(isPdfUrl('https://example.com/a.pdf')).toBe(true);
      expect(isPdfUrl('https://example.com/a.pdf?download=1')).toBe(true);
      expect(isPdfUrl('https://example.com/a.PDF#page=2')).toBe(true);
      expect(isPdfUrl('https://example.com/a.html?file=x.pdf')).toBe(false);
    });
  });

  describe('pasted notes', () => {
    test('two notes with the same title are two notes', async () => {
      const first = await post({ title: 'Opening hours', text: 'The Leeds shop opens at nine.' });
      const second = await post({ title: 'Opening hours', text: 'The York shop opens at ten.' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.sourceId).not.toBe(second.body.sourceId);

      const listing = await request(app).get('/api/knowledge').set('x-auth-token', adminToken);
      expect(listing.body.sources).toHaveLength(2);
      expect(listing.body.sources.map(source => source.title)).toEqual(['Opening hours', 'Opening hours']);

      const content = (await KnowledgeChunk.find({ company: company._id }))
        .map(chunk => chunk.content).join(' ');
      expect(content).toContain('Leeds');
      expect(content).toContain('York');
    });

    test('a note can be removed by the id it was given', async () => {
      const created = await post({ title: 'Temporary', text: 'Gone soon.' });

      const removed = await request(app)
        .delete(`/api/knowledge/sources/${encodeURIComponent(created.body.sourceId)}`)
        .set('x-auth-token', adminToken);

      expect(removed.status).toBe(200);
      expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(0);
    });
  });

  describe('re-importing a source', () => {
    test('writes the new chunks before removing the old, under a new import id', async () => {
      const store = getVectorStore();
      const options = { companyId: company._id, sourceId: 'url:https://example.com/policy', sourceType: 'url' };

      await store.store([{ content: 'The old policy said fourteen days.' }], options);
      const before = await KnowledgeChunk.findOne({ company: company._id });
      expect(before.importId).toEqual(expect.any(String));

      // The old chunks must still be there while the new ones are written:
      // insert first, then delete by import id.
      const insertMany = jest.spyOn(KnowledgeChunk, 'insertMany');
      const deleteMany = jest.spyOn(KnowledgeChunk, 'deleteMany');

      await store.store([{ content: 'The new policy says thirty days.' }], options);

      expect(insertMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
      expect(deleteMany.mock.calls[0][0]).toMatchObject({ importId: { $ne: expect.any(String) } });
      insertMany.mockRestore();
      deleteMany.mockRestore();

      const after = await KnowledgeChunk.find({ company: company._id });
      expect(after).toHaveLength(1);
      expect(after[0].content).toContain('thirty days');
      expect(after[0].importId).not.toBe(before.importId);
    });

    test('a failed import leaves the previous version in place', async () => {
      const store = getVectorStore();
      const options = { companyId: company._id, sourceId: 'url:https://example.com/faq', sourceType: 'url' };

      await store.store([{ content: 'Still here.' }], options);

      const failing = jest.spyOn(KnowledgeChunk, 'insertMany')
        .mockRejectedValueOnce(new Error('database went away'));

      await expect(store.store([{ content: 'Never landed.' }], options)).rejects.toThrow('database went away');
      failing.mockRestore();

      const chunks = await KnowledgeChunk.find({ company: company._id });
      expect(chunks.map(chunk => chunk.content)).toEqual(['Still here.']);
    });
  });

  describe('the plan', () => {
    test('an import bigger than the remaining allowance is refused before embedding', async () => {
      const usage = require('../services/usage');
      // Two chunks left. The middleware's "room for one more" check passes;
      // the check with the real count must be the one that refuses.
      const check = jest.spyOn(usage, 'check').mockImplementation(async (companyId, meter, requested = 1) =>
        requested <= 2
          ? { allowed: true, limit: 500, used: 498, remaining: 2, planId: 'starter' }
          : {
            allowed: false, reason: 'Knowledge chunks limit reached (498/500) on the Starter plan.',
            limit: 500, used: 498, remaining: 2, planId: 'starter'
          });
      const embed = jest.spyOn(getVectorStore().embeddings, 'embedBatch');

      const response = await post({ title: 'Big', text: 'x '.repeat(3000) });

      expect(response.status).toBe(402);
      expect(response.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(check.mock.calls.some(call => call[2] > 2)).toBe(true);
      expect(embed).not.toHaveBeenCalled();

      check.mockRestore();
      embed.mockRestore();
    });
  });
});
