import { setTimeout as wait } from 'timers/promises';
import type { Lead } from '../../types/lead';
import { BrowserFactory } from '../../browser/factory';
import { acceptConsent } from '../../browser/consent_handler';
import { Checkpoint } from '../../runtime/checkpoint';
import { logger } from '../../runtime/logger';
import { DEFAULTS } from '../../config/defaults';
import { buildMapsSearchUrl } from './maps_url';
import { parseGoogleMapsResults } from './google_maps_parser';
import { withRetry } from '../../runtime/retry';
import { capturePageEvidence } from '../../runtime/page_evidence';

/**
 * Live Google Maps navigator. Scrolls `div[role="feed"]` until the count
 * stabilises, an end marker appears, or `maxAttempts` is reached. Then
 * extracts the feed inner-HTML and hands it to the pure parser.
 *
 * Parsing stays in `google_maps_parser.ts`. This file's only job is the
 * scroll loop + container extraction.
 */

export interface MapsLiveOptions {
  category: string;
  location: string;
  /** Max scroll attempts before giving up. */
  maxScrollAttempts?: number;
  scrollPauseMs?: number;
  checkpoint?: Checkpoint;
  diagnosticsDir?: string;
}

export interface MapsLiveResult {
  results: Lead[];
  total_cards: number;
  parsed: number;
  dropped: number;
  cap_likely: boolean;
  scroll_attempts: number;
}

export const FEED_SELECTOR = 'div[role="feed"]';
const END_MARKERS = '.m6QErb span.HlvSq, .Q2vNVc';

export async function scrapeMapsLocation(
  factory: BrowserFactory,
  opts: MapsLiveOptions
): Promise<MapsLiveResult> {
  const maxAttempts = opts.maxScrollAttempts ?? DEFAULTS.scraper.mapsMaxScrollAttempts;
  const pauseMs = opts.scrollPauseMs ?? DEFAULTS.scraper.mapsScrollPauseMs;
  const cp = opts.checkpoint;
  const cpKey = Checkpoint.buildKey({ provider: 'maps', category: opts.category, location: opts.location });
  if (cp?.isDone(cpKey)) {
    return { results: [], total_cards: 0, parsed: 0, dropped: 0, cap_likely: false, scroll_attempts: 0 };
  }

  const url = buildMapsSearchUrl(opts.category, opts.location);
  let pageForEvidence: import('playwright').Page | undefined;
  let lastAttempt = 0;
  try {
    // Retry the whole comune session on transient network drops (post-mortem:
    // wifi flap / macOS sleep). getPage() lives inside so a fresh page is used
    // on each attempt. The "no feed" case returns a result (not a throw) → no
    // wasted retry; only real network errors are retried.
    return await withRetry(
      async (attempt) => {
        const page = await factory.getPage();
        pageForEvidence = page;
        lastAttempt = attempt;
        logger.info({ url, attempt }, '[maps_live] navigating');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await acceptConsent(page, 'maps');
        await wait(2500); // initial render
        const hasFeed = await page.$(FEED_SELECTOR);
        if (!hasFeed) {
          const evidence = await capturePageEvidence(page, opts.diagnosticsDir, cpKey);
          logger.warn({ url }, '[maps_live] no result feed (single place or blocked)');
          cp?.set(cpKey, { status: 'failed', reason: 'no_feed', attempts: attempt + 1, evidence_fingerprint: evidence.fingerprint });
          factory.noteNavigation();
          return { results: [], total_cards: 0, parsed: 0, dropped: 0, cap_likely: false, scroll_attempts: 0 };
        }
        const scrollAttempts = await scrollFeedToEnd(page, maxAttempts, pauseMs);
        factory.noteNavigation();
        const feedHandle = await page.$(FEED_SELECTOR);
        const html = feedHandle ? await feedHandle.innerHTML() : '';
        // Wrap in role=feed shell so the existing parser finds the container.
        const wrapped = `<html><body><div role="feed">${html}</div></body></html>`;
        const parsed = parseGoogleMapsResults(wrapped, { category: opts.category, cityHint: opts.location });
        cp?.set(cpKey, {
          status: 'done',
          total_cards: parsed.total_cards,
          parsed: parsed.results.length,
          dropped: parsed.dropped,
          cap_likely: parsed.cap_likely,
          attempts: attempt + 1,
        });
        logger.info(
          {
            total: parsed.total_cards,
            parsed: parsed.results.length,
            dropped: parsed.dropped,
            cap_likely: parsed.cap_likely,
            scroll_attempts: scrollAttempts,
          },
          '[maps_live] feed parsed'
        );
        return {
          results: parsed.results,
          total_cards: parsed.total_cards,
          parsed: parsed.results.length,
          dropped: parsed.dropped,
          cap_likely: parsed.cap_likely,
          scroll_attempts: scrollAttempts,
        };
      },
      {
        onRetry: ({ attempt, delayMs, err }) =>
          logger.warn({ url, attempt, delayMs, err: (err as Error).message }, '[maps_live] nav retry (network?)'),
      },
    );
  } catch (err) {
    const evidence = await capturePageEvidence(pageForEvidence, opts.diagnosticsDir, cpKey);
    logger.warn({ url, err: (err as Error).message }, '[maps_live] navigation error — comune skipped after retries');
    cp?.set(cpKey, { status: 'failed', reason: (err as Error).message, attempts: lastAttempt + 1, evidence_fingerprint: evidence.fingerprint });
    return { results: [], total_cards: 0, parsed: 0, dropped: 0, cap_likely: false, scroll_attempts: 0 };
  }
}

async function scrollFeedToEnd(page: import('playwright').Page, maxAttempts: number, pauseMs: number): Promise<number> {
  let previousCount = 0;
  let stallCount = 0;
  // The two evaluator strings run inside the page (browser) context where
  // `document` exists. We pass them as strings rather than callbacks so the
  // node-side TypeScript compiler doesn't need DOM types.
  const SCROLL_AND_COUNT = `(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return 0;
    feed.scrollTop = feed.scrollHeight;
    return feed.querySelectorAll('div.Nv2PK').length;
  })()`;
  const buildEndedExpr = (sel: string) =>
    `(() => !!document.querySelector(${JSON.stringify(sel)}))()`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentCount = (await page.evaluate(SCROLL_AND_COUNT)) as number;
    const ended = (await page.evaluate(buildEndedExpr(END_MARKERS))) as boolean;
    if (ended) return attempt + 1;
    if (currentCount === previousCount) {
      stallCount += 1;
      if (stallCount >= 3) return attempt + 1;
    } else {
      stallCount = 0;
    }
    previousCount = currentCount;
    await wait(pauseMs);
  }
  return maxAttempts;
}
