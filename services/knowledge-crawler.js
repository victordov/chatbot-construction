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
 * Synchronous, by design and by the caps: twenty pages is well inside what an
 * HTTP request can wait for, and a job queue would be one more thing to run.
 */

const safeHttp = require('./safe-http');
const KnowledgeConnectorService = require('./knowledge-connector');
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
 * @returns {Promise<{pages: Array<{url: string, title: string|null, text: string}>,
 *                    skipped: Array<{url: string, reason: string}>}>}
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
  const enqueue = url => {
    if (url && sameOrigin(url) && !queued.has(url) && queued.size < queueLimit) {
      queued.add(url);
      queue.push(url);
    }
  };

  const pages = [];
  const skipped = [];

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
      skipped.push({ url, reason: error.message });
      continue;
    }

    if (!isHtmlResponse(response)) {
      skipped.push({ url, reason: `Not an HTML page (${response.headers?.['content-type'] || 'unknown type'})` });
      continue;
    }

    const html = String(response.body);
    pageLinks(html, url).forEach(enqueue);

    const text = connector.htmlToText(html);
    if (!text) {
      skipped.push({ url, reason: 'No readable text on the page' });
      continue;
    }

    pages.push({ url, title: connector.htmlTitle(html), text });
  }

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

  return { pages, skipped };
}

module.exports = {
  crawl,
  sitemapLocations,
  pageLinks,
  hardMaxPages,
  DEFAULT_MAX_PAGES
};
