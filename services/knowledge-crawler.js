/**
 * Reading a tenant's website into the knowledge base, a page at a time.
 *
 * Importing one URL at a time is fine for a returns policy and hopeless for a
 * site: nobody pastes forty addresses. "Crawl my site" is the first thing every
 * competing product offers during setup, so this is the same, kept small:
 *
 *   - same origin only. The tenant vouches for their own site, not for every
 *     page it links to, and a crawl that wandered onto a news site would fill
 *     their bot with somebody else's material
 *   - the sitemap first, because it is the site's own list of what matters,
 *     then the links on the pages themselves, breadth first so the pages
 *     closest to the start are read before the deep ones
 *   - a page cap and a time budget, so one request cannot run for ever or
 *     spend a month's embedding allowance
 *   - every fetch through services/safe-http.js. The URL is one a tenant
 *     typed, and every link we follow is one a web page wrote, so each is a
 *     request our server makes on a stranger's behalf and gets the same
 *     address checks as an import, a webhook or a workflow action
 *
 * `crawl()` itself only reads. `startCrawl()` runs it in the background and
 * stores what it found, writing progress to a KnowledgeCrawl record the
 * dashboard polls: twenty pages plus their embeddings is longer than a person
 * should stare at a spinner, and longer than some proxies hold a request open.
 * It runs in this process rather than a queue, which would be one more thing
 * to operate; a crawl a restart interrupts is reported as failed and can be
 * started again.
 *
 * `recrawlDue()` is the weekly refresh, for the scheduler to call.
 */

const safeHttp = require('./safe-http');
const KnowledgeConnectorService = require('./knowledge-connector');
const KnowledgeCrawl = require('../models/knowledge-crawl');
const KnowledgeSource = require('../models/knowledge-source');
const { getVectorStore } = require('./vector-store');
const knowledgeText = require('./knowledge-text');
const audit = require('./audit');
const { logger } = require('./logging');

const connector = new KnowledgeConnectorService();

/** Pages a crawl reads when the caller does not say. */
const DEFAULT_MAX_PAGES = 20;

/** The most any one crawl may read, whatever the caller asks for. */
function hardMaxPages() {
  return parseInt(process.env.KNOWLEDGE_CRAWL_MAX_PAGES, 10) || 50;
}

/** How long one crawl may take altogether, in milliseconds. */
function timeBudgetMs() {
  return parseInt(process.env.KNOWLEDGE_CRAWL_TIME_BUDGET_MS, 10) || 60000;
}

/** Same allowance as a single-page import. */
const MAX_PAGE_BYTES = parseInt(process.env.MAX_PAGE_BYTES, 10) || 2 * 1024 * 1024;

/** A sitemap can list thousands of pages; we only need their addresses. */
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;

/** No single page may eat the whole budget. */
const PAGE_TIMEOUT_MS = 15000;

/**
 * Paths that are plainly not web pages. Skipped without a fetch: the answer
 * is already known, and each fetch spends the time budget.
 */
const NOT_HTML = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|tar|rar|7z|mp3|mp4|m4a|wav|ogg|webm|avi|mov|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|csv|txt|exe|dmg|apk)$/i;

/** The address without its fragment: `#pricing` is the same page. */
function normalise(raw, base) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Every `<loc>` in a sitemap or sitemap index. */
function sitemapLocations(xml) {
  const locations = [];
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match;

  while ((match = pattern.exec(String(xml))) !== null) {
    locations.push(connector.decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()));
  }

  return locations;
}

/** The href of every anchor on a page, resolved against the page. */
function pageLinks(html, base) {
  const links = [];
  const pattern = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = pattern.exec(String(html))) !== null) {
    const href = connector.decodeEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) {
      continue;
    }
    const url = normalise(href, base);
    if (url) {
      links.push(url);
    }
  }

  return links;
}

/**
 * The HTTP status a failed fetch reported, when it reported one.
 *
 * The transport says "That URL answered 404" rather than attaching the code,
 * so it is read back from the message. Only used to tell a page that is gone
 * (404, 410) from one that was merely unreachable this time.
 */
function statusOf(error) {
  const match = /answered (\d{3})/.exec(String(error && error.message));
  return match ? Number(match[1]) : undefined;
}

/** Whether a response is a web page, by its declared type, or by its bytes. */
function isHtmlResponse(response) {
  const type = String(response.headers?.['content-type'] || '').toLowerCase();

  if (type) {
    return type.includes('text/html') || type.includes('application/xhtml');
  }
  return !String(response.body).slice(0, 2048).includes('\u0000');
}

/**
 * Read a site.
 *
 * @param {string} startUrl
 * @param {object} [options]
 * @param {number} [options.maxPages] capped at KNOWLEDGE_CRAWL_MAX_PAGES
 * @param {number} [options.timeBudgetMs]
 * @param {function} [options.fetch] test seam; defaults to safeHttp.fetchUrl
 * @param {function} [options.onProgress] called with `{read, planned, skipped}`
 *        after every page; its failures are ignored
 * @returns {Promise<{pages: Array<{url: string, title: string|null, text: string}>,
 *                    skipped: Array<{url: string, reason: string, status?: number}>,
 *                    complete: boolean}>}
 *          `complete` is true when every page the crawl found was tried: the
 *          queue ran dry rather than the page cap, the attempt cap, the queue
 *          cap or the time budget stopping it. Only then is a page it never
 *          reached known not to be linked from the site any more.
 * @throws {Error} with `status: 400` when the start URL is not one we may fetch
 */
async function crawl(startUrl, options = {}) {
  const check = safeHttp.validateUrl(startUrl);
  if (!check.valid) {
    const error = new Error(check.error);
    error.status = 400;
    throw error;
  }

  const fetch = options.fetch || safeHttp.fetchUrl;
  const requested = parseInt(options.maxPages, 10) || DEFAULT_MAX_PAGES;
  const maxPages = Math.max(1, Math.min(requested, hardMaxPages()));
  const deadline = Date.now() + (options.timeBudgetMs || timeBudgetMs());
  const remaining = () => deadline - Date.now();

  const start = normalise(check.url.toString());
  const origin = new URL(start).origin;
  const sameOrigin = url => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  const queue = [start];
  const queued = new Set(queue);
  // The queue is bounded too: a site with a link to every product would
  // otherwise hold thousands of addresses we will never reach.
  const queueLimit = maxPages * 10;
  let overflowed = false;
  const enqueue = url => {
    if (url && sameOrigin(url) && !queued.has(url)) {
      if (queued.size >= queueLimit) {
        overflowed = true;
        return;
      }
      queued.add(url);
      queue.push(url);
    }
  };

  const pages = [];
  const skipped = [];
  const report = async () => {
    if (typeof options.onProgress !== 'function') {
      return;
    }
    try {
      await options.onProgress({ read: pages.length, planned: maxPages, skipped: skipped.length });
    } catch (error) {
      logger.info('Crawl progress could not be reported', { error: error.message });
    }
  };

  // The sitemap is optional and so are its failures: most small sites have
  // none, and the links on the start page are enough.
  try {
    const sitemap = await fetch(`${origin}/sitemap.xml`, {
      maxBytes: MAX_SITEMAP_BYTES,
      timeoutMs: Math.min(PAGE_TIMEOUT_MS, Math.max(1000, remaining()))
    });
    let locations = sitemapLocations(sitemap.body);

    // A sitemap index lists further sitemaps. A few are read; a site big
    // enough to need more has far more pages than one crawl takes anyway.
    if (/<sitemapindex/i.test(String(sitemap.body))) {
      const children = locations.filter(sameOrigin).slice(0, 3);
      locations = [];
      for (const child of children) {
        if (remaining() <= 0) {
          break;
        }
        try {
          const response = await fetch(child, {
            maxBytes: MAX_SITEMAP_BYTES,
            timeoutMs: Math.min(PAGE_TIMEOUT_MS, Math.max(1000, remaining()))
          });
          locations.push(...sitemapLocations(response.body));
        } catch (error) {
          logger.info('Could not read a child sitemap', { url: child, error: error.message });
        }
      }
    }

    locations.forEach(location => enqueue(normalise(location)));
  } catch (error) {
    logger.info('No usable sitemap; crawling from links', { origin, error: error.message });
  }

  // Failures count against the attempts as well as successes against the
  // pages, so a site of broken links cannot keep the loop going.
  let attempts = 0;
  const maxAttempts = maxPages * 3;

  while (queue.length && pages.length < maxPages && attempts < maxAttempts) {
    if (remaining() <= 0) {
      break;
    }

    const url = queue.shift();
    let pathname = '';
    try {
      pathname = new URL(url).pathname;
    } catch {
      // normalise() already parsed it; unreachable in practice.
    }

    if (NOT_HTML.test(pathname)) {
      skipped.push({ url, reason: 'Not an HTML page' });
      continue;
    }

    attempts += 1;

    let response;
    try {
      response = await fetch(url, {
        maxBytes: MAX_PAGE_BYTES,
        timeoutMs: Math.min(PAGE_TIMEOUT_MS, Math.max(1000, remaining()))
      });
    } catch (error) {
      const status = statusOf(error);
      skipped.push({ url, reason: error.message, ...(status ? { status } : {}) });
      await report();
      continue;
    }

    if (!isHtmlResponse(response)) {
      skipped.push({ url, reason: `Not an HTML page (${response.headers?.['content-type'] || 'unknown type'})` });
      await report();
      continue;
    }

    const html = String(response.body);
    pageLinks(html, url).forEach(enqueue);

    const text = connector.htmlToText(html);
    if (!text) {
      skipped.push({ url, reason: 'No readable text on the page' });
      await report();
      continue;
    }

    pages.push({ url, title: connector.htmlTitle(html), text });
    await report();
  }

  const complete = queue.length === 0 && !overflowed && remaining() > 0;

  if (remaining() <= 0 && pages.length < maxPages) {
    // Said rather than left out, so "why is my pricing page missing" has an
    // answer on the screen.
    queue.slice(0, maxPages - pages.length).forEach(url => {
      skipped.push({ url, reason: 'Time budget for this crawl ran out' });
    });
  }

  logger.info('Crawled a site for knowledge', {
    origin,
    pages: pages.length,
    skipped: skipped.length,
    tookMs: Date.now() - (deadline - (options.timeBudgetMs || timeBudgetMs()))
  });

  return { pages, skipped, complete };
}

// ------------------------------------------------------------ storing a site

/** How long a running crawl may go without progress before it counts as dead. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** How often progress is written while a crawl runs. */
const PROGRESS_INTERVAL_MS = 500;

/** A week, for "refresh weekly". */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a job says it is running but has stopped making progress. */
function isStale(job, now = Date.now()) {
  const beat = job.heartbeatAt || job.startedAt || job.createdAt;
  return ['queued', 'running'].includes(job.status) &&
    (!beat || now - new Date(beat).getTime() > STALE_AFTER_MS);
}

/** A job as the dashboard reads it. */
function presentJob(job) {
  const stale = isStale(job);
  const progress = job.progress || {};
  return {
    jobId: String(job._id),
    origin: job.origin,
    startUrl: job.startUrl,
    maxPages: job.maxPages,
    status: stale ? 'failed' : job.status,
    progress: {
      phase: progress.phase || 'reading',
      read: progress.read || 0,
      planned: progress.planned || job.maxPages || 0,
      saved: progress.saved || 0,
      skipped: progress.skipped || 0
    },
    imported: job.imported || [],
    skipped: job.skipped || [],
    removed: job.removed || [],
    pages: (job.pages || []).length,
    error: stale ? 'The crawl stopped before it finished. Start it again.' : (job.error || null),
    errorCode: job.errorCode || null,
    refreshWeekly: Boolean(job.refreshWeekly),
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    lastRunAt: job.lastRunAt || null
  };
}

/**
 * Start reading a site in the background.
 *
 * Validates the address first, so a private or malformed URL is refused to the
 * caller rather than becoming a failed job. A second request for a site that
 * is already being read returns that crawl rather than starting another.
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {string} options.url
 * @param {number} [options.maxPages]
 * @param {boolean} [options.refreshWeekly] leave undefined to keep the site's setting
 * @param {boolean} [options.enforceQuota=true]
 * @param {object} [options.actor] who asked, for the audit entry
 * @param {string} [options.createdBy]
 * @param {function} [options.fetch] test seam
 * @returns {Promise<{job: object, alreadyRunning: boolean, done: Promise<object>}>}
 *          `done` settles when the background run does; it never rejects
 * @throws {Error} with `status: 400` for an address that may not be fetched
 */
async function startCrawl(options = {}) {
  const { companyId, url, refreshWeekly, createdBy } = options;
  const check = safeHttp.validateUrl(url);
  if (!check.valid) {
    const error = new Error(check.error);
    error.status = 400;
    throw error;
  }

  const startUrl = normalise(check.url.toString());
  const origin = new URL(startUrl).origin;
  const requested = parseInt(options.maxPages, 10) || DEFAULT_MAX_PAGES;
  const maxPages = Math.max(1, Math.min(requested, hardMaxPages()));

  const existing = await KnowledgeCrawl.findOne({ company: companyId, origin });
  if (existing && ['queued', 'running'].includes(existing.status) && !isStale(existing)) {
    return { job: existing, alreadyRunning: true, done: Promise.resolve(existing) };
  }

  const now = new Date();
  const job = await KnowledgeCrawl.findOneAndUpdate(
    { company: companyId, origin },
    {
      $set: {
        startUrl,
        maxPages,
        status: 'queued',
        progress: { phase: 'reading', read: 0, planned: maxPages, saved: 0, skipped: 0 },
        imported: [],
        skipped: [],
        removed: [],
        error: null,
        errorCode: null,
        startedAt: now,
        finishedAt: null,
        heartbeatAt: now,
        ...(refreshWeekly !== undefined ? { refreshWeekly: Boolean(refreshWeekly) } : {}),
        ...(createdBy ? { createdBy } : {})
      },
      $setOnInsert: { company: companyId, origin, createdAt: now }
    },
    { upsert: true, new: true }
  );

  // Not awaited by the route: the request returns the job id at once and the
  // dashboard polls. `runCrawl` records its own failures and never rejects.
  const done = runCrawl(job._id, options);
  return { job, alreadyRunning: false, done };
}

/**
 * Read a site and store its pages, recording progress on the job.
 *
 * A re-crawl drops the pages the site no longer has: a page this site owned
 * that answered 404 or 410, or - when the crawl tried everything it found - a
 * page it never came across. A page that merely failed to load this time, or
 * that a cut-short crawl never got to, is kept: a timeout is not a deletion.
 *
 * @returns {Promise<object|null>} the finished job; never rejects
 */
async function runCrawl(jobId, options = {}) {
  const { enforceQuota = true, actor, fetch } = options;
  let job = null;

  try {
    job = await KnowledgeCrawl.findByIdAndUpdate(
      jobId,
      { $set: { status: 'running', heartbeatAt: new Date() } },
      { new: true }
    );
    if (!job) {
      return null;
    }

    const companyId = job.company;
    const previous = new Set(job.pages || []);

    let lastWrite = 0;
    const onProgress = async progress => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_INTERVAL_MS) {
        return;
      }
      lastWrite = now;
      await KnowledgeCrawl.updateOne({ _id: job._id }, {
        $set: {
          'progress.read': progress.read,
          'progress.planned': progress.planned,
          'progress.skipped': progress.skipped,
          heartbeatAt: new Date()
        }
      });
    };

    const result = await crawl(job.startUrl, { maxPages: job.maxPages, fetch, onProgress });
    const { pages, complete } = result;
    const skipped = [...result.skipped];

    await KnowledgeCrawl.updateOne({ _id: job._id }, {
      $set: {
        progress: { phase: 'saving', read: pages.length, planned: job.maxPages, saved: 0, skipped: skipped.length },
        heartbeatAt: new Date()
      }
    });

    const store = getVectorStore();
    const imported = [];
    let quotaError = null;

    for (const page of pages) {
      const sourceId = `url:${page.url}`;
      if (quotaError) {
        skipped.push({ url: page.url, reason: quotaError.message });
        continue;
      }

      const chunks = connector.splitIntoChunks(page.text, 1000);
      try {
        if (enforceQuota) {
          await knowledgeText.assertRoom(companyId, sourceId, chunks.length);
        }

        const stored = await store.store(
          chunks.map((content, index) => ({
            content,
            chunkIndex: index,
            metadata: {
              source: 'web_url',
              url: page.url,
              filename: new URL(page.url).hostname,
              ...(page.title ? { title: page.title } : {})
            }
          })),
          { companyId, sourceId, sourceType: 'url' }
        );

        imported.push({ sourceId, title: page.title || page.url, url: page.url, chunks: stored.stored });
      } catch (error) {
        if (error.status === 402) {
          // Everything after this would be refused too; say so for each.
          quotaError = error;
        }
        skipped.push({ url: page.url, reason: error.message });
      }

      await KnowledgeCrawl.updateOne({ _id: job._id }, {
        $set: { 'progress.saved': imported.length, 'progress.skipped': skipped.length, heartbeatAt: new Date() }
      });
    }

    // Which of the pages this site owned are gone.
    const importedIds = new Set(imported.map(entry => entry.sourceId));
    const skippedByUrl = new Map(skipped.map(entry => [entry.url, entry]));
    const removed = [];
    const kept = [];

    for (const sourceId of previous) {
      if (importedIds.has(sourceId)) {
        continue;
      }
      const miss = skippedByUrl.get(sourceId.replace(/^url:/, ''));
      const gone = miss ? [404, 410].includes(miss.status) : complete;
      if (gone) {
        removed.push(sourceId);
      } else {
        kept.push(sourceId);
      }
    }

    for (const sourceId of removed) {
      await store.deleteSource(companyId, sourceId);
      await knowledgeText.forget(companyId, sourceId);
    }

    const failedOnQuota = imported.length === 0 && quotaError;
    const finished = new Date();

    job = await KnowledgeCrawl.findByIdAndUpdate(job._id, {
      $set: {
        status: failedOnQuota ? 'failed' : 'done',
        error: failedOnQuota ? quotaError.message : null,
        errorCode: failedOnQuota ? quotaError.code : null,
        progress: {
          phase: 'saving',
          read: pages.length,
          planned: job.maxPages,
          saved: imported.length,
          skipped: skipped.length
        },
        imported: imported.slice(0, 200),
        skipped: skipped.slice(0, KnowledgeCrawl.SKIPPED_LIMIT),
        removed,
        pages: [...importedIds, ...kept],
        finishedAt: finished,
        lastRunAt: finished,
        heartbeatAt: finished
      }
    }, { new: true });

    await audit.record({
      company: companyId,
      actor: actor || { displayName: 'Knowledge crawler', role: 'system' },
      action: 'knowledge.imported',
      details: { crawl: job.startUrl, pages: imported.length, skipped: skipped.length, removed: removed.length }
    });

    return job;
  } catch (error) {
    logger.error('A site crawl failed', { jobId: String(jobId), error: error.message });
    try {
      return await KnowledgeCrawl.findByIdAndUpdate(jobId, {
        $set: {
          status: 'failed',
          error: error.message,
          errorCode: error.code || null,
          finishedAt: new Date(),
          lastRunAt: new Date(),
          heartbeatAt: new Date()
        }
      }, { new: true });
    } catch {
      return job;
    }
  }
}

// ----------------------------------------------------------- a single page

/**
 * Import one web page or PDF, or fetch it again in place.
 *
 * The source id is derived from the URL, so a second import replaces the
 * first rather than doubling it. Records when it was last fetched (and why it
 * failed, when it did), which is what the weekly refresh reads.
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {string} [options.url] for a new import
 * @param {string} [options.sourceId] for a refresh: `url:` or `pdf:` and the address
 * @param {boolean} [options.enforceQuota=true]
 * @returns {Promise<{sourceId: string, sourceType: string, chunks: number}>}
 * @throws the loader's error, or a 402 from the plan check
 */
async function fetchSource({ companyId, url, sourceId, enforceQuota = true }) {
  const [prefix, ...rest] = String(sourceId || '').split(':');
  const target = sourceId ? rest.join(':') : url;
  const sourceType = sourceId
    ? (prefix === 'pdf' ? 'pdf' : 'url')
    : (KnowledgeConnectorService.isPdfUrl(url) ? 'pdf' : 'url');
  const id = sourceId || `${sourceType}:${url}`;

  try {
    const result = await connector.processKnowledgeSource(
      { sourceType, config: { url: target }, sourceId: id },
      companyId,
      {
        beforeStore: documents => (enforceQuota
          ? knowledgeText.assertRoom(companyId, id, documents.length)
          : undefined)
      }
    );

    await KnowledgeSource.updateOne(
      { company: companyId, sourceId: id },
      {
        $set: { lastRefreshedAt: new Date(), lastError: null },
        $setOnInsert: { company: companyId, sourceId: id }
      },
      { upsert: true }
    );

    return { sourceId: id, sourceType, chunks: result.vectorResults ? result.vectorResults.stored : 0 };
  } catch (error) {
    await KnowledgeSource.updateOne(
      { company: companyId, sourceId: id },
      { $set: { lastError: String(error.message).slice(0, 300) } }
    ).catch(() => {});
    throw error;
  }
}

// ----------------------------------------------------------- weekly refresh

/**
 * Re-read everything set to refresh weekly that has not been read for a week.
 *
 * For the scheduler. Works through a bounded batch per call, oldest first, one
 * at a time - an embedding bill and somebody else's web server are both worth
 * being gentle with - and records each failure against its source rather than
 * stopping. Never throws.
 *
 * @param {object} [options]
 * @param {number} [options.limit=5] sites and pages, each, per call
 * @param {Date} [options.now]
 * @param {function} [options.fetch] test seam for site crawls
 * @returns {Promise<{sites: number, sources: number, failed: number}>}
 */
async function recrawlDue(options = {}) {
  const limit = options.limit || 5;
  const now = options.now ? new Date(options.now) : new Date();
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const summary = { sites: 0, sources: 0, failed: 0 };

  try {
    const sites = await KnowledgeCrawl.find({
      refreshWeekly: true,
      $or: [{ lastRunAt: { $lt: weekAgo } }, { lastRunAt: null }]
    }).sort({ lastRunAt: 1 }).limit(limit);

    for (const site of sites) {
      if (['queued', 'running'].includes(site.status) && !isStale(site, now.getTime())) {
        continue;
      }
      try {
        const { done } = await startCrawl({
          companyId: site.company,
          url: site.startUrl,
          maxPages: site.maxPages,
          fetch: options.fetch
        });
        const finished = await done;
        summary.sites += 1;
        if (!finished || finished.status === 'failed') {
          summary.failed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        await KnowledgeCrawl.updateOne({ _id: site._id }, {
          $set: { status: 'failed', error: error.message, lastRunAt: now }
        }).catch(() => {});
      }
    }

    const sources = await KnowledgeSource.find({
      refreshWeekly: true,
      sourceId: /^(url|pdf):/,
      $or: [{ lastRefreshedAt: { $lt: weekAgo } }, { lastRefreshedAt: null }]
    }).sort({ lastRefreshedAt: 1 }).limit(limit).lean();

    for (const source of sources) {
      try {
        await fetchSource({ companyId: source.company, sourceId: source.sourceId });
        summary.sources += 1;
      } catch (error) {
        summary.failed += 1;
        // Counted as tried, so one dead page is retried next week rather than
        // on every scheduler tick.
        await KnowledgeSource.updateOne({ _id: source._id }, {
          $set: { lastRefreshedAt: now, lastError: String(error.message).slice(0, 300) }
        }).catch(() => {});
      }
    }
  } catch (error) {
    logger.error('Weekly knowledge refresh failed', { error: error.message });
  }

  if (summary.sites || summary.sources || summary.failed) {
    logger.info('Weekly knowledge refresh', summary);
  }
  return summary;
}

module.exports = {
  crawl,
  startCrawl,
  runCrawl,
  fetchSource,
  recrawlDue,
  presentJob,
  isStale,
  sitemapLocations,
  pageLinks,
  hardMaxPages,
  DEFAULT_MAX_PAGES,
  WEEK_MS
};
