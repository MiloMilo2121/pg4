import { setTimeout as wait } from 'timers/promises';
import type { Lead } from '../../types/lead';
import { BrowserFactory } from '../../browser/factory';
import { acceptConsent } from '../../browser/consent_handler';
import { Checkpoint } from '../../runtime/checkpoint';
import { logger } from '../../runtime/logger';
import { DEFAULTS } from '../../config/defaults';
import { buildPgSearchUrl } from './pg_url';
import { parsePagineGialleResults } from './pagine_gialle_parser';

/**
 * Live PG navigator. Pure side-effects: navigation + DOM extraction.
 *
 * Parsing logic stays in `pagine_gialle_parser.ts` — this file only
 * orchestrates the browser session. If a page fails to render or the
 * card container is missing, we record the outcome on the checkpoint
 * and move on rather than throwing.
 *
 * Iteration model:
 *   for each pageNum from 1..maxPages:
 *     navigate, wait selector, extract container, parse, dedupe-emit
 *     stop if 0 cards on a fully-rendered page (end of results)
 *     stop if checkpoint says (kw, location, page) is already done
 */

export interface PgLiveOptions {
  category: string;
  location: string;
  /** PG's per-page count is ~20; orchestrator decides total page budget. */
  maxPages?: number;
  /** Skip pages already marked done in the checkpoint. */
  checkpoint?: Checkpoint;
  /** Inter-page delay override; defaults to scraper.interPageDelayMs. */
  interPageDelayMs?: number;
  /**
   * Phase F — page-granular cooperative abort. The comune-level check in
   * the pipeline is too coarse for graceful shutdown: a dense comune
   * (Padova ≈ 15 pages) outlives the 45s drain watchdog and forces a
   * hard exit. Checking between pages bounds the drain to one page.
   */
  abortSignal?: AbortSignal;
}

export interface PgLiveResult {
  results: Lead[];
  total_cards: number;
  parsed: number;
  dropped: number;
  pages_visited: number;
  /**
   * True if PG showed the ">200 risultati" banner on page 1 — orchestrator
   * should split this query into smaller comuni and re-run.
   */
  overflow: boolean;
}

export const PG_RESULTS_SELECTOR = '.search-itm';
const PG_CONTAINER_SELECTORS = ['.search-results', '.search-itm-list', 'main'];

export async function scrapePgLocation(
  factory: BrowserFactory,
  opts: PgLiveOptions
): Promise<PgLiveResult> {
  const maxPages = opts.maxPages ?? DEFAULTS.scraper.pgMaxPages;
  const interDelay = opts.interPageDelayMs ?? DEFAULTS.scraper.interPageDelayMs;
  const cp = opts.checkpoint;

  const out: Lead[] = [];
  let totalCards = 0;
  let dropped = 0;
  let pagesVisited = 0;
  let overflow = false;
  let consecutiveEmpty = 0;

  for (let page = 1; page <= maxPages; page++) {
    if (opts.abortSignal?.aborted) {
      logger.info({ location: opts.location, page }, '[pg_live] abort signal — stopping before next page');
      break;
    }
    const cpKey = Checkpoint.buildKey({ provider: 'pg', category: opts.category, location: opts.location, page });
    if (cp?.isDone(cpKey)) {
      pagesVisited += 1;
      continue;
    }
    const url = buildPgSearchUrl(opts.category, opts.location, page);
    const pwPage = await factory.getPage();
    let html: string | undefined;
    try {
      logger.info({ url, page }, '[pg_live] navigating');
      await pwPage.goto(url, { waitUntil: 'domcontentloaded' });
      // Best-effort consent (no-op after first time once storage state persists).
      if (page === 1) await acceptConsent(pwPage, 'pg');
      // Wait for either result cards or a definitive "no results" marker.
      try {
        await pwPage.waitForSelector(PG_RESULTS_SELECTOR, { timeout: 8000 });
      } catch {
        /* might be empty-results page; container HTML still extractable */
      }
      const container = await firstMatchingHandle(pwPage, PG_CONTAINER_SELECTORS);
      html = container ? await container.innerHTML() : await pwPage.content();
      factory.noteNavigation();
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, '[pg_live] navigation error');
      cp?.set(cpKey, { status: 'failed', page, reason: (err as Error).message });
      // network glitch on this page: try the next page rather than aborting
      await wait(interDelay);
      continue;
    }
    pagesVisited += 1;

    const parsed = parsePagineGialleResults(html, {
      category: opts.category,
      queryLocation: opts.location,
    });
    totalCards += parsed.total_cards;
    dropped += parsed.dropped;
    out.push(...parsed.results);
    if (page === 1 && parsed.overflow) overflow = true;

    cp?.set(cpKey, {
      status: 'done',
      page,
      total_cards: parsed.total_cards,
      parsed: parsed.results.length,
      dropped: parsed.dropped,
      overflow: parsed.overflow,
    });
    logger.info(
      {
        page,
        total: parsed.total_cards,
        parsed: parsed.results.length,
        dropped: parsed.dropped,
        overflow: parsed.overflow,
      },
      '[pg_live] page parsed'
    );

    if (parsed.results.length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2) {
        logger.info({ page }, '[pg_live] two empty pages in a row — stopping');
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }
    if (page < maxPages) await wait(interDelay);
  }

  return { results: out, total_cards: totalCards, parsed: out.length, dropped, pages_visited: pagesVisited, overflow };
}

// ---- helpers ----

async function firstMatchingHandle(page: import('playwright').Page, selectors: string[]) {
  for (const sel of selectors) {
    const handle = await page.$(sel);
    if (handle) return handle;
  }
  return null;
}
