/**
 * Reading a new tenant's website while they finish signing up.
 *
 * Somebody who typed their website into the sign-up form should find a bot
 * that already knows something when they reach Home, rather than an empty
 * knowledge base and a step to discover. This runs the same crawler the
 * Knowledge screen uses (services/knowledge-crawler.js), smaller, in the
 * background, and stores each page as its own `url:` source exactly as a
 * crawl from that screen would - so the tenant can refresh or remove any page
 * later in the usual way.
 *
 * It never blocks or fails the sign-up. Every error is logged and swallowed:
 * an unreachable site is the tenant's to fix from the Knowledge screen, not a
 * reason to refuse them an account.
 */

const usageService = require('./usage');
const { logger } = require('./logging');

/** Enough to give the bot a start without spending the trial's allowance. */
const WELCOME_MAX_PAGES = 10;

/**
 * Crawl a site into a company's knowledge base.
 *
 * @param {string} companyId
 * @param {string} website a URL the caller has already normalised
 * @param {object} [deps] test seams
 * @returns {Promise<{pages: number, skipped: number}>}
 */
async function crawlInto(companyId, website, deps = {}) {
  const crawler = deps.crawler || require('./knowledge-crawler');
  const store = deps.store || require('./vector-store').getVectorStore();
  const KnowledgeConnectorService = require('./knowledge-connector');
  const connector = new KnowledgeConnectorService();

  const { pages, skipped } = await crawler.crawl(website, { maxPages: WELCOME_MAX_PAGES });
  let stored = 0;

  for (const page of pages) {
    const chunks = connector.splitIntoChunks(page.text, 1000);
    if (chunks.length === 0) {
      continue;
    }

    // The trial has a chunk allowance like any plan; stop at it rather than
    // storing past it and leaving the tenant over their limit on day one.
    const room = await usageService.check(companyId, 'knowledgeChunks', chunks.length);
    if (!room.allowed) {
      break;
    }

    await store.store(
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
      { companyId, sourceId: `url:${page.url}`, sourceType: 'url' }
    );
    stored += 1;
  }

  logger.info('Read a new tenant\'s website into their knowledge base', {
    companyId: String(companyId),
    pages: stored,
    skipped: (skipped || []).length
  });

  return { pages: stored, skipped: (skipped || []).length };
}

/**
 * Start the crawl and return at once.
 *
 * @returns {Promise} settles when the crawl does, for tests; callers ignore it
 */
function start(companyId, website, deps = {}) {
  return new Promise(resolve => setImmediate(resolve))
    .then(() => crawlInto(companyId, website, deps))
    .catch(error => {
      logger.warn('Could not read a new tenant\'s website; they can import it from Knowledge', {
        companyId: String(companyId),
        error: error.message
      });
      return { pages: 0, skipped: 0, error: error.message };
    });
}

module.exports = { start, crawlInto, WELCOME_MAX_PAGES };
