/**
 * Site crawls as background jobs: progress while they run, pages a re-crawl
 * drops because the site no longer has them (and pages it keeps because they
 * only failed this time), and the weekly refresh the scheduler drives.
 *
 * The site is a stand-in `fetch`, so each scenario can say exactly what the
 * site looks like on each visit.
 */

const mongoose = require('mongoose');

const Company = require('../models/company');
const KnowledgeChunk = require('../models/knowledge-chunk');
const KnowledgeCrawl = require('../models/knowledge-crawl');
const KnowledgeSource = require('../models/knowledge-source');
const KnowledgeConnectorService = require('../services/knowledge-connector');
const crawler = require('../services/knowledge-crawler');

const ORIGIN = 'https://shop.example';

const page = (title, links = []) =>
  `<html><head><title>${title}</title></head><body><p>The ${title} page.</p>` +
  links.map(href => `<a href="${href}">link</a>`).join(' ') + '</body></html>';

/**
 * A fake site. `pages` maps a path to HTML, or to a number for an HTTP error
 * (thrown the way the real transport throws it). Anything else is a 404.
 */
const site = (pages, { delayMs = 0 } = {}) => jest.fn(async url => {
  const path = new URL(url).pathname;
  if (delayMs) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const entry = pages[path];
  if (entry === undefined || typeof entry === 'number') {
    throw new Error(`That URL answered ${entry || 404}`);
  }
  return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: entry };
});

describe('site crawls as jobs', () => {
  let company;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'WS3 Crawl Jobs Co' });
  });

  afterAll(async () => {
    await Promise.all([
      Company.deleteOne({ _id: company._id }),
      KnowledgeChunk.deleteMany({ company: company._id }),
      KnowledgeCrawl.deleteMany({ company: company._id }),
      KnowledgeSource.deleteMany({ company: company._id })
    ]);
  });

  beforeEach(async () => {
    await KnowledgeChunk.deleteMany({ company: company._id });
    await KnowledgeCrawl.deleteMany({ company: company._id });
    await KnowledgeSource.deleteMany({ company: company._id });
    jest.restoreAllMocks();
  });

  const start = (fetch, extra = {}) => crawler.startCrawl({
    companyId: company._id, url: `${ORIGIN}/`, maxPages: 10, enforceQuota: false, fetch, ...extra
  });

  const sourceIds = async () => (await KnowledgeChunk.distinct('sourceId', { company: company._id })).sort();

  test('the crawler reports its progress page by page', async () => {
    const seen = [];
    const fetch = site({ '/': page('Home', ['/a', '/b']), '/a': page('A'), '/b': page('B') });

    const result = await crawler.crawl(`${ORIGIN}/`, {
      fetch, maxPages: 10, onProgress: progress => seen.push({ ...progress })
    });

    expect(result.pages).toHaveLength(3);
    expect(result.complete).toBe(true);
    expect(seen.map(entry => entry.read)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(seen.every(entry => entry.planned === 10)).toBe(true);
    // The sitemap 404 is not a page attempt, so nothing was skipped.
    expect(seen[seen.length - 1]).toEqual({ read: 3, planned: 10, skipped: 0 });
  });

  test('a crawl cut short by the page cap is not complete', async () => {
    const fetch = site({ '/': page('Home', ['/a', '/b']), '/a': page('A'), '/b': page('B') });
    const result = await crawler.crawl(`${ORIGIN}/`, { fetch, maxPages: 2 });
    expect(result.complete).toBe(false);
  });

  test('starting one returns at once; the job records progress and the result', async () => {
    const fetch = site({ '/': page('Home', ['/a']), '/a': page('A') }, { delayMs: 20 });

    const { job, alreadyRunning, done } = await start(fetch);
    expect(alreadyRunning).toBe(false);
    expect(['queued', 'running']).toContain(job.status);

    // Asking again while it runs follows the same crawl rather than starting
    // a second one.
    const again = await start(fetch);
    expect(again.alreadyRunning).toBe(true);
    expect(String(again.job._id)).toBe(String(job._id));

    const finished = await done;
    expect(finished.status).toBe('done');
    expect(finished.progress).toMatchObject({ read: 2, saved: 2, planned: 10 });
    expect(finished.imported.map(entry => entry.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
    expect(finished.pages.sort()).toEqual([`url:${ORIGIN}/`, `url:${ORIGIN}/a`]);

    const presented = crawler.presentJob(finished);
    expect(presented).toMatchObject({ status: 'done', pages: 2, origin: ORIGIN });
    expect(await sourceIds()).toEqual([`url:${ORIGIN}/`, `url:${ORIGIN}/a`]);
  });

  test('a re-crawl drops pages the site no longer has and keeps ones that only failed', async () => {
    const first = site({
      '/': page('Home', ['/a', '/b', '/c', '/d']),
      '/a': page('A'), '/b': page('B'), '/c': page('C'), '/d': page('D')
    });
    await (await start(first)).done;
    expect(await sourceIds()).toHaveLength(5);

    // Now: /b is down for the moment, /d has been deleted, /c is no longer
    // linked from anywhere.
    const second = site({
      '/': page('Home', ['/a', '/b', '/d']),
      '/a': page('A'), '/b': 503, '/d': 404
    });
    const finished = await (await start(second)).done;

    expect(finished.status).toBe('done');
    expect(finished.removed.sort()).toEqual([`url:${ORIGIN}/c`, `url:${ORIGIN}/d`]);
    expect(await sourceIds()).toEqual([`url:${ORIGIN}/`, `url:${ORIGIN}/a`, `url:${ORIGIN}/b`]);
    // /b is still the site's, so a later crawl can drop it if it stays gone.
    expect(finished.pages).toContain(`url:${ORIGIN}/b`);
    const skippedB = finished.skipped.find(entry => entry.url === `${ORIGIN}/b`);
    expect(skippedB.status).toBe(503);
  });

  test('a crawl cut short removes nothing it did not reach', async () => {
    const first = site({ '/': page('Home', ['/a', '/b']), '/a': page('A'), '/b': page('B') });
    await (await start(first)).done;

    const second = site({ '/': page('Home', ['/a', '/b']), '/a': page('A'), '/b': page('B') });
    const finished = await (await start(second, { maxPages: 1 })).done;

    expect(finished.removed).toEqual([]);
    expect(await sourceIds()).toHaveLength(3);
  });

  test('a job left running by a restart reports itself as failed', async () => {
    const stale = await KnowledgeCrawl.create({
      company: company._id,
      origin: 'https://stale.example',
      startUrl: 'https://stale.example/',
      status: 'running',
      heartbeatAt: new Date(Date.now() - 60 * 60 * 1000)
    });

    const presented = crawler.presentJob(stale);
    expect(presented.status).toBe('failed');
    expect(presented.error).toMatch(/start it again/i);
  });

  describe('the weekly refresh', () => {
    const daysAgo = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    test('re-reads sites and pages a week old, and leaves fresh ones alone', async () => {
      const due = await KnowledgeCrawl.create({
        company: company._id, origin: ORIGIN, startUrl: `${ORIGIN}/`, maxPages: 5,
        status: 'done', refreshWeekly: true, lastRunAt: daysAgo(8)
      });
      const fresh = await KnowledgeCrawl.create({
        company: company._id, origin: 'https://fresh.example', startUrl: 'https://fresh.example/',
        status: 'done', refreshWeekly: true, lastRunAt: daysAgo(1)
      });
      const off = await KnowledgeCrawl.create({
        company: company._id, origin: 'https://off.example', startUrl: 'https://off.example/',
        status: 'done', refreshWeekly: false, lastRunAt: daysAgo(30)
      });

      await KnowledgeSource.create([
        { company: company._id, sourceId: 'url:https://pages.example/due', refreshWeekly: true, lastRefreshedAt: daysAgo(9) },
        { company: company._id, sourceId: 'url:https://pages.example/broken', refreshWeekly: true, lastRefreshedAt: daysAgo(9) },
        { company: company._id, sourceId: 'url:https://pages.example/fresh', refreshWeekly: true, lastRefreshedAt: daysAgo(2) },
        { company: company._id, sourceId: 'text:a-note', refreshWeekly: true, lastRefreshedAt: daysAgo(30) }
      ]);

      const load = jest.spyOn(KnowledgeConnectorService.prototype, 'processKnowledgeSource')
        .mockImplementation(async config => {
          if (config.sourceId.endsWith('/broken')) {
            throw new Error('Failed to load PDF/URL: That URL answered 500');
          }
          return { vectorResults: { stored: 2 } };
        });

      const fetch = site({ '/': page('Home') });
      const summary = await crawler.recrawlDue({ fetch });

      expect(summary).toEqual({ sites: 1, sources: 1, failed: 1 });
      expect(fetch.mock.calls.every(([url]) => url.startsWith(ORIGIN))).toBe(true);

      expect((await KnowledgeCrawl.findById(due._id)).lastRunAt.getTime()).toBeGreaterThan(daysAgo(1).getTime());
      expect((await KnowledgeCrawl.findById(fresh._id)).lastRunAt.getTime()).toBeLessThan(daysAgo(0.5).getTime());
      expect((await KnowledgeCrawl.findById(off._id)).lastRunAt.getTime()).toBeLessThan(daysAgo(29).getTime());

      const refreshed = load.mock.calls.map(([config]) => config.sourceId);
      expect(refreshed.sort()).toEqual(['url:https://pages.example/broken', 'url:https://pages.example/due']);

      const broken = await KnowledgeSource.findOne({ sourceId: 'url:https://pages.example/broken' }).lean();
      expect(broken.lastError).toMatch(/500/);
      // Counted as tried, so it waits a week rather than retrying every tick.
      expect(broken.lastRefreshedAt.getTime()).toBeGreaterThan(daysAgo(1).getTime());

      const done = await KnowledgeSource.findOne({ sourceId: 'url:https://pages.example/due' }).lean();
      expect(done.lastError).toBeNull();
    });

    test('never throws, even when the database does', async () => {
      jest.spyOn(KnowledgeCrawl, 'find').mockImplementation(() => {
        throw new Error('database went away');
      });
      await expect(crawler.recrawlDue()).resolves.toEqual({ sites: 0, sources: 0, failed: 0 });
    });
  });
});
