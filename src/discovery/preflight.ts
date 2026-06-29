import { setTimeout as wait } from 'timers/promises';
import type { BrowserFactory } from '../browser/factory';
import { acceptConsent } from '../browser/consent_handler';
import { logger } from '../runtime/logger';
import { buildPgSearchUrl } from './sources/pg_url';
import { buildMapsSearchUrl } from './sources/maps_url';
import { PG_RESULTS_SELECTOR } from './sources/pg_live';
import { FEED_SELECTOR } from './sources/maps_live';

/**
 * Phase A.3 — selector health check, run before any live scrape.
 *
 * Today a PagineGialle / Maps markup change produces an empty run with no
 * alarm: every comune parses 0 cards, the run "completes", and the operator
 * discovers the loss hours later. The preflight fetches ONE known-good query
 * per source and asserts the critical selector matches at least one element.
 * Failure aborts the run with an actionable error and a dedicated exit code
 * (3) so schedulers can distinguish "site changed" from "pipeline bug".
 *
 * The known-good query is fixed (densest validated comune): "agenzie
 * immobiliari" in Padova returns 200+ PG cards and a full Maps feed on every
 * validated run since R6. If THAT query yields zero matches, the markup
 * changed or the IP is blocked — either way the run must not proceed
 * silently.
 *
 * Skippable with `--skip-preflight` (e.g. when scraping a category/geo where
 * the canary itself is the target and double-fetching wastes a navigation).
 */

export const PREFLIGHT_CANARY = { category: 'agenzie immobiliari', location: 'Padova' } as const;

export class PreflightError extends Error {
  readonly source: 'pg' | 'maps';
  readonly selector: string;

  constructor(source: 'pg' | 'maps', selector: string, detail: string) {
    super(
      `Preflight failed for ${source.toUpperCase()}: selector "${selector}" matched 0 elements on the known-good query ` +
        `("${PREFLIGHT_CANARY.category}", ${PREFLIGHT_CANARY.location}). ${detail} ` +
        `Likely causes: site markup changed, consent wall regression, or IP block. ` +
        `Inspect the page manually, update the selector, or re-run with --skip-preflight if you accept the risk.`
    );
    this.name = 'PreflightError';
    this.source = source;
    this.selector = selector;
  }
}

export interface PreflightResult {
  pg_cards: number;
  /** undefined when Maps was not checked (run without --maps). */
  maps_feed_present?: boolean;
  duration_ms: number;
}

export async function runScrapePreflight(
  factory: BrowserFactory,
  opts: { checkMaps: boolean }
): Promise<PreflightResult> {
  const started = Date.now();

  // --- PG canary ---
  const pgUrl = buildPgSearchUrl(PREFLIGHT_CANARY.category, PREFLIGHT_CANARY.location, 1);
  const page = await factory.getPage();
  logger.info({ url: pgUrl }, '[preflight] PG canary');
  let pgCards = 0;
  try {
    await page.goto(pgUrl, { waitUntil: 'domcontentloaded' });
    await acceptConsent(page, 'pg');
    try {
      await page.waitForSelector(PG_RESULTS_SELECTOR, { timeout: 10_000 });
    } catch {
      /* counted below — 0 matches is the failure signal */
    }
    pgCards = await page.$$eval(PG_RESULTS_SELECTOR, (els) => els.length);
    factory.noteNavigation();
  } catch (err) {
    throw new PreflightError('pg', PG_RESULTS_SELECTOR, `Navigation error: ${(err as Error).message}.`);
  }
  if (pgCards === 0) {
    throw new PreflightError('pg', PG_RESULTS_SELECTOR, 'The page loaded but contained no result cards.');
  }

  // --- Maps canary (only when the run will use Maps) ---
  let mapsFeed: boolean | undefined;
  if (opts.checkMaps) {
    const mapsUrl = buildMapsSearchUrl(PREFLIGHT_CANARY.category, PREFLIGHT_CANARY.location);
    logger.info({ url: mapsUrl }, '[preflight] Maps canary');
    try {
      const mp = await factory.getPage();
      await mp.goto(mapsUrl, { waitUntil: 'domcontentloaded' });
      await acceptConsent(mp, 'maps');
      await wait(2500); // initial feed render
      mapsFeed = (await mp.$(FEED_SELECTOR)) !== null;
      factory.noteNavigation();
    } catch (err) {
      throw new PreflightError('maps', FEED_SELECTOR, `Navigation error: ${(err as Error).message}.`);
    }
    if (!mapsFeed) {
      throw new PreflightError('maps', FEED_SELECTOR, 'The page loaded but the result feed container is missing.');
    }
  }

  const result: PreflightResult = { pg_cards: pgCards, maps_feed_present: mapsFeed, duration_ms: Date.now() - started };
  logger.info(result, '[preflight] passed');
  return result;
}
