import { setTimeout as wait } from 'timers/promises';
import type { Lead } from '../../types/lead';
import { BrowserFactory } from '../../browser/factory';
import { acceptConsent } from '../../browser/consent_handler';
import { Checkpoint } from '../../runtime/checkpoint';
import { logger } from '../../runtime/logger';
import { DEFAULTS } from '../../config/defaults';
import { buildPgSearchUrl } from './pg_url';
import { parsePagineGialleResults } from './pagine_gialle_parser';
import { withRetry } from '../../runtime/retry';
import { capturePageEvidence } from '../../runtime/page_evidence';

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
  /**
   * Novelty predicate (true = lead not seen before this run). PG returns
   * province-wide results, so once a comune's pages stop adding anything NEW
   * (all already collected from earlier comuni), further pages are pure waste
   * — post-mortem measured 87% duplicate cards. The pipeline passes a check
   * against its Deduplicator; when 2 consecutive pages add 0 new leads, we stop
   * paginating this comune. Omitted → no early-stop (every parsed lead counts).
   */
  isNew?: (lead: Lead) => boolean;
  diagnosticsDir?: string;
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
// A page without cards is only a verified empty result if PG rendered one of
// its explicit result-state messages. Arbitrary blank/block pages must never
// become an "empty_verified" query in the completion manifest.
const PG_EMPTY_RESULT_MARKER = /nessun[oa]?\s+(?:risultat[oi]|attivit[àa])|non\s+abbiamo\s+trovato/i;

export function hasVerifiedPgEmptyResults(html: string): boolean {
  return PG_EMPTY_RESULT_MARKER.test(html.replace(/<[^>]*>/g, ' '));
}

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
  let consecutiveZeroNew = 0;

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
    // Persist intent before navigating. If the process is killed while a page
    // is in flight, coverage turns this non-terminal checkpoint into a partial
    // run instead of claiming completion from only the pages seen so far.
    cp?.set(cpKey, { status: 'pending', page, attempts: 0, reason: 'navigation_in_progress' });
    const url = buildPgSearchUrl(opts.category, opts.location, page);
    let html: string | undefined;
    let pageForEvidence: import('playwright').Page | undefined;
    let lastAttempt = 0;
    try {
      // Retry the SAME page on transient network drops (post-mortem: 3.6k
      // net::ERR disconnects from the laptop's wifi). getPage() lives INSIDE
      // the retry so a browser-restart blip is retried too, and a fresh page
      // is acquired each attempt.
      html = await withRetry(
        async (attempt) => {
          const pwPage = await factory.getPage();
          pageForEvidence = pwPage;
          lastAttempt = attempt;
          logger.info({ url, page, attempt }, '[pg_live] navigating');
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
          const extracted = container ? await container.innerHTML() : await pwPage.content();
          factory.noteNavigation();
          return extracted;
        },
        {
          abortSignal: opts.abortSignal,
          baseBackoffMs: interDelay,
          onRetry: ({ attempt, delayMs, err }) =>
            logger.warn({ url, page, attempt, delayMs, err: (err as Error).message }, '[pg_live] nav retry (network?)'),
        },
      );
    } catch (err) {
      const evidence = await capturePageEvidence(pageForEvidence, opts.diagnosticsDir, cpKey);
      logger.warn({ url, err: (err as Error).message }, '[pg_live] navigation error — page skipped after retries');
      cp?.set(cpKey, { status: 'failed', page, reason: (err as Error).message, attempts: lastAttempt + 1, evidence_fingerprint: evidence.fingerprint });
      // exhausted retries on this page: try the next page rather than aborting
      await wait(interDelay);
      continue;
    }
    pagesVisited += 1;

    let parsed: ReturnType<typeof parsePagineGialleResults>;
    try {
      parsed = parsePagineGialleResults(html, {
        category: opts.category,
        queryLocation: opts.location,
      });
    } catch (err) {
      const evidence = await capturePageEvidence(pageForEvidence, opts.diagnosticsDir, cpKey);
      cp?.set(cpKey, {
        status: 'failed',
        page,
        reason: `parser_error: ${(err as Error).message}`,
        attempts: lastAttempt + 1,
        evidence_fingerprint: evidence.fingerprint,
      });
      logger.warn({ url, page, err: (err as Error).message }, '[pg_live] parser error — page marked failed');
      break;
    }
    if (parsed.total_cards === 0 && !hasVerifiedPgEmptyResults(html)) {
      const evidence = await capturePageEvidence(pageForEvidence, opts.diagnosticsDir, cpKey);
      cp?.set(cpKey, {
        status: 'failed',
        page,
        reason: 'selector_missing_or_unverified_empty_results',
        attempts: lastAttempt + 1,
        evidence_fingerprint: evidence.fingerprint,
      });
      logger.warn({ url, page }, '[pg_live] no cards and no verified empty-result marker — page marked failed');
      // A selector drift/block page will recur on subsequent pages; preserve
      // partial output and defer to recovery instead of generating a noisy
      // run of identical failed page requests.
      break;
    }
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
      attempts: lastAttempt + 1,
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
      // Early-stop on duplicate exhaustion: PG serves province-wide results, so
      // a comune whose pages add nothing new is re-scraping firms we already
      // have. Two consecutive 0-new pages → stop (saves the 25-page cap waste).
      const newCount = opts.isNew ? parsed.results.filter(opts.isNew).length : parsed.results.length;
      if (newCount === 0) {
        consecutiveZeroNew += 1;
        if (consecutiveZeroNew >= 2) {
          logger.info({ page }, '[pg_live] two pages with 0 new unique leads — province results exhausted, stopping');
          break;
        }
      } else {
        consecutiveZeroNew = 0;
      }
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
