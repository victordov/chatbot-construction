/**
 * Crawling a tenant's site into the knowledge base.
 *
 * A small site is served on localhost: a sitemap, pages that link to each
 * other, a link off-site, an image and a PDF. What must hold is that the crawl
 * stays on the site, reads HTML only, stops at its caps, keys each page as its
 * own `url:` source (so refresh works and a second crawl replaces), and goes
 * through the address-checked transport.
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const dns = require('dns');

const User = require('../models/user');
const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const safeHttp = require('../services/safe-http');
const crawler = require('../services/knowledge-crawler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/knowledge', require('../routes/knowledge'));
  return app;
};

const page = (title, body, links = []) =>
  `<html><head><title>${title}</title></head><body><p>${body}</p>` +
  links.map(href => `<a href="${href}">link</a>`).join(' ') +
  '</body></html>';

describe('crawling a site', () => {
  let app;
  let company;
  let adminToken;
  let server;
  let base;
  let withSitemap = true;
  let version = 1;
  const requested = [];

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }

    app = buildApp();
    company = await Company.create({ name: 'Crawl Test Co' });
    await User.create({
      username: 'crawl-admin', email: 'admin@crawl.test', password: 'TestPassword123!',
      role: 'company_admin', company: company._id, displayName: 'Admin'
    });
    adminToken = (await request(app).post('/api/auth/login')
      .send({ username: 'crawl-admin', password: 'TestPassword123!' })).body.token;

    // The transport refuses loopback by design; this suite's site is on it.
    process.env.ACTIONS_ALLOW_HTTP = 'true';
    safeHttp.__setLookupForTests((hostname, options, callback) => dns.lookup(hostname, options, callback));

    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        requested.push(req.url);
        const html = body => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(body);
        };

        switch (req.url) {
        case '/sitemap.xml':
          if (!withSitemap) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(`<?xml version="1.0"?><urlset>
            <url><loc>${base}/pricing</loc></url>
            <url><loc>https://elsewhere.example/page</loc></url>
          </urlset>`);
        case '/':
          return html(page('Home', `Welcome, version ${version}.`,
            ['/about', '/about#team', '/logo.png', '/guide.pdf', 'https://other.example/x', 'mailto:a@b.c', '/feed']));
        case '/about':
          return html(page('About us', 'We are a small shop in Leeds.', ['/contact']));
        case '/pricing':
          return html(page('Pricing', 'Kettles cost £25.'));
        case '/contact':
          return html(page('Contact', 'Call us on 0113 000 0000.'));
        case '/feed':
          // No extension to give it away; only the content type does.
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"items":[]}');
        default:
          res.writeHead(404);
          return res.end();
        }
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
      User.deleteMany({ email: /@crawl\.test$/ }),
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: company._id });
    requested.length = 0;
    withSitemap = true;
    version = 1;
  });

  const crawl = body => request(app)
    .post('/api/knowledge/crawl')
    .set('x-auth-token', adminToken)
    .send(body);

  test('reads the sitemap and the links, on this site only, HTML only', async () => {
    const response = await crawl({ url: `${base}/` });

    expect(response.status).toBe(200);
    const urls = response.body.imported.map(entry => entry.url);
    expect(urls).toEqual(expect.arrayContaining([`${base}/`, `${base}/pricing`, `${base}/about`, `${base}/contact`]));
    expect(urls).toHaveLength(4);
    // The fragment is the same page, not a second one.
    expect(requested.filter(url => url === '/about')).toHaveLength(1);
    // Nothing off-site was even asked for, and the image and PDF were skipped
    // without a fetch.
    expect(requested).not.toContain('/logo.png');
    expect(requested).not.toContain('/guide.pdf');

    const skipped = Object.fromEntries(response.body.skipped.map(entry => [entry.url, entry.reason]));
    expect(skipped[`${base}/logo.png`]).toMatch(/Not an HTML page/);
    expect(skipped[`${base}/feed`]).toMatch(/application\/json/);
    expect(Object.keys(skipped).some(url => url.includes('other.example') || url.includes('elsewhere'))).toBe(false);

    const home = response.body.imported.find(entry => entry.url === `${base}/`);
    expect(home).toMatchObject({ sourceId: `url:${base}/`, title: 'Home', chunks: 1 });
  });

  test('each page is its own url source, listed with its title', async () => {
    await crawl({ url: `${base}/` });

    const listing = await request(app).get('/api/knowledge').set('x-auth-token', adminToken);
    const pricing = listing.body.sources.find(source => source.sourceId === `url:${base}/pricing`);

    expect(pricing).toMatchObject({ sourceType: 'url', title: 'Pricing', url: `${base}/pricing` });
  });

  test('a crawled page can be refreshed like any imported URL', async () => {
    await crawl({ url: `${base}/` });

    const response = await request(app)
      .post(`/api/knowledge/sources/${encodeURIComponent(`url:${base}/`)}/refresh`)
      .set('x-auth-token', adminToken);

    expect(response.status).toBe(200);
    expect(response.body.chunks).toBe(1);
  });

  test('a second crawl replaces the pages rather than doubling them', async () => {
    await crawl({ url: `${base}/` });
    const before = await KnowledgeChunk.countDocuments({ company: company._id });

    version = 2;
    await crawl({ url: `${base}/` });

    expect(await KnowledgeChunk.countDocuments({ company: company._id })).toBe(before);
    const home = await KnowledgeChunk.findOne({ company: company._id, sourceId: `url:${base}/` });
    expect(home.content).toContain('version 2');
  });

  test('without a sitemap, the links alone are followed', async () => {
    withSitemap = false;

    const response = await crawl({ url: `${base}/` });

    const urls = response.body.imported.map(entry => entry.url);
    expect(urls).toEqual([`${base}/`, `${base}/about`, `${base}/contact`]);
  });

  test('stops at maxPages', async () => {
    const response = await crawl({ url: `${base}/`, maxPages: 2 });

    expect(response.body.imported).toHaveLength(2);
    expect(response.body.imported[0].url).toBe(`${base}/`);
  });

  test('maxPages is capped by KNOWLEDGE_CRAWL_MAX_PAGES', async () => {
    process.env.KNOWLEDGE_CRAWL_MAX_PAGES = '1';
    try {
      const response = await crawl({ url: `${base}/`, maxPages: 500 });
      expect(response.body.imported).toHaveLength(1);
    } finally {
      delete process.env.KNOWLEDGE_CRAWL_MAX_PAGES;
    }
  });

  test('a private address is refused before anything is fetched', async () => {
    const response = await crawl({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/private or reserved/);
  });

  test('a URL that is not one is a 400', async () => {
    expect((await crawl({ url: 'not a url' })).status).toBe(400);
    expect((await crawl({})).status).toBe(400);
  });

  test('every fetch goes through the address-checked transport', async () => {
    const fetchUrl = jest.spyOn(safeHttp, 'fetchUrl');
    // The crawler holds a reference to the module, not the function, so the
    // spy sees its calls.
    await crawl({ url: `${base}/`, maxPages: 2 });

    expect(fetchUrl).toHaveBeenCalled();
    expect(fetchUrl.mock.calls.map(call => call[0])).toContain(`${base}/sitemap.xml`);
    fetchUrl.mockRestore();
  });
});

describe('the crawler on its own', () => {
  test('a time budget that runs out stops the crawl and says what was left', async () => {
    const pages = {
      'https://shop.example/': page('Home', 'Home page.', ['/a', '/b', '/c'])
    };
    const fetch = jest.fn(async url => {
      if (url.endsWith('/sitemap.xml')) {
        throw new Error('That URL answered 404');
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: pages[url] || page('Page', `Text of ${url}.`)
      };
    });

    const result = await crawler.crawl('https://shop.example/', { fetch, timeBudgetMs: 100, maxPages: 10 });

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages.length).toBeLessThan(4);
    expect(result.skipped.some(entry => /Time budget/.test(entry.reason))).toBe(true);
  });

  test('a sitemap index is followed to its sitemaps', async () => {
    const responses = {
      'https://shop.example/sitemap.xml':
        '<sitemapindex><sitemap><loc>https://shop.example/sitemap-pages.xml</loc></sitemap></sitemapindex>',
      'https://shop.example/sitemap-pages.xml':
        '<urlset><url><loc>https://shop.example/faq</loc></url></urlset>'
    };
    const fetch = jest.fn(async url => ({
      statusCode: 200,
      headers: { 'content-type': url.endsWith('.xml') ? 'application/xml' : 'text/html' },
      body: responses[url] || page('Page', `Text of ${url}.`)
    }));

    const result = await crawler.crawl('https://shop.example/', { fetch });

    expect(result.pages.map(entry => entry.url)).toEqual(['https://shop.example/', 'https://shop.example/faq']);
  });

  test('links are resolved against the page and stripped of fragments', () => {
    expect(crawler.pageLinks(
      '<a href="b">x</a><a class="y" href=\'/c#top\'>y</a><a href=/d?q=1&amp;r=2>z</a><a href="tel:1">t</a>',
      'https://shop.example/a/'
    )).toEqual(['https://shop.example/a/b', 'https://shop.example/c', 'https://shop.example/d?q=1&r=2']);
  });
});
