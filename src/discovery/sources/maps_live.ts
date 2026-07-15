import { setTimeout as wait } from 'timers/promises';
import type { Lead } from '../../types/lead';
import { BrowserFactory } from '../../browser/factory';
import { acceptConsent } from '../../browser/consent_handler';
import { Checkpoint, isVerifiedTerminalQuery } from '../../runtime/checkpoint';
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
  /** Initial Maps render delay; production default remains 2500ms. */
  initialRenderDelayMs?: number;
  checkpoint?: Checkpoint;
  diagnosticsDir?: string;
  /** Cooperative cancellation passed through from the run-level lifecycle. */
  abortSignal?: AbortSignal;
}

export interface MapsLiveResult {
  results: Lead[];
  total_cards: number;
  parsed: number;
  dropped: number;
  cap_likely: boolean;
  scroll_attempts: number;
  /** The process was asked to stop; the current pending query is resumable. */
  interrupted: boolean;
}

export const FEED_SELECTOR = 'div[role="feed"]';
const END_MARKERS = '.m6QErb span.HlvSq, .Q2vNVc';
// A feed container alone proves neither that Maps rendered results nor that a
// zero-card page is legitimate. Only these explicit result-state messages may
// become `empty_verified`; block, consent, and selector-drift pages stay failed.
const MAPS_EMPTY_RESULT_MARKER = /nessun[oa]?\s+risultat[oi]|non\s+(?:abbiamo\s+trovato|sono\s+stati\s+trovati)\s+risultat[oi]|no\s+results?\s+(?:found|for)|couldn'?t\s+find\s+any\s+results?/i;

export function hasVerifiedMapsEmptyResults(html: string): boolean {
  return MAPS_EMPTY_RESULT_MARKER.test(html.replace(/<[^>]*>/g, ' '));
}

function unresolvedMapsPageReason(html: string, fallback: string): string {
  const text = html.replace(/<[^>]*>/g, ' ').toLowerCase();
  if (/consent|cookie|before you continue/.test(text)) return 'consent_wall';
  if (/captcha|unusual traffic|access denied|forbidden|blocked|cloudflare/.test(text)) return 'blocked_or_captcha';
  return fallback;
}

export async function scrapeMapsLocation(
  factory: BrowserFactory,
  opts: MapsLiveOptions
): Promise<MapsLiveResult> {
  const maxAttempts = opts.maxScrollAttempts ?? DEFAULTS.scraper.mapsMaxScrollAttempts;
  const pauseMs = opts.scrollPauseMs ?? DEFAULTS.scraper.mapsScrollPauseMs;
  const initialRenderDelayMs = opts.initialRenderDelayMs ?? 2500;
  const cp = opts.checkpoint;
  const cpKey = Checkpoint.buildKey({ provider: 'maps', category: opts.category, location: opts.location });
  if (isVerifiedTerminalQuery(cp?.get(cpKey))) {
    return emptyMapsResult();
  }
  const url = buildMapsSearchUrl(opts.category, opts.location);
  // See the PG navigator: a durable pending entry is intentionally visible to
  // the coverage manifest if a process disappears mid-navigation.
  cp?.set(cpKey, { status: 'pending', kind: 'query', attempts: 0, reason: 'navigation_in_progress', url });

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
        if (opts.abortSignal?.aborted) return emptyMapsResult({ interrupted: true });
        logger.info({ url, attempt }, '[maps_live] navigating');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (opts.abortSignal?.aborted) return emptyMapsResult({ interrupted: true });
        await acceptConsent(page, 'maps');
        if (await waitForAbortOrTimeout(initialRenderDelayMs, opts.abortSignal)) return emptyMapsResult({ interrupted: true });
        const hasFeed = await page.$(FEED_SELECTOR);
        if (!hasFeed) {
          const pageHtml = await page.content();
          if (hasVerifiedMapsEmptyResults(pageHtml)) {
            cp?.set(cpKey, {
              status: 'done', kind: 'query', url, total_cards: 0, parsed: 0, dropped: 0,
              cap_likely: false, attempts: attempt + 1, empty_verified: true,
            });
            factory.noteNavigation();
            logger.info({ url }, '[maps_live] explicit empty-result state verified without a feed');
            return emptyMapsResult();
          }
          const evidence = await capturePageEvidence(page, opts.diagnosticsDir, cpKey);
          logger.warn({ url }, '[maps_live] no result feed (single place or blocked)');
          cp?.set(cpKey, {
            status: 'failed', kind: 'query', url, reason: unresolvedMapsPageReason(pageHtml, 'no_feed'), attempts: attempt + 1,
            evidence_fingerprint: evidence.fingerprint, page_title: evidence.title, screenshot_path: evidence.screenshot_path,
          });
          factory.noteNavigation();
          return emptyMapsResult();
        }
        const scroll = await scrollFeedToEnd(page, maxAttempts, pauseMs, opts.abortSignal);
        if (scroll.interrupted) {
          factory.noteNavigation();
          return emptyMapsResult({ scroll_attempts: scroll.attempts, interrupted: true });
        }
        if (opts.abortSignal?.aborted) return emptyMapsResult({ scroll_attempts: scroll.attempts, interrupted: true });
        factory.noteNavigation();
        const feedHandle = await page.$(FEED_SELECTOR);
        const pageHtml = await page.content();
        if (!feedHandle) {
          if (hasVerifiedMapsEmptyResults(pageHtml)) {
            cp?.set(cpKey, {
              status: 'done', kind: 'query', url, total_cards: 0, parsed: 0, dropped: 0,
              cap_likely: false, attempts: attempt + 1, empty_verified: true,
            });
            return emptyMapsResult({ scroll_attempts: scroll.attempts });
          }
          const evidence = await capturePageEvidence(page, opts.diagnosticsDir, cpKey);
          cp?.set(cpKey, {
            status: 'failed', kind: 'query', url, reason: unresolvedMapsPageReason(pageHtml, 'feed_missing_after_scroll'), attempts: attempt + 1,
            evidence_fingerprint: evidence.fingerprint, page_title: evidence.title, screenshot_path: evidence.screenshot_path,
          });
          return emptyMapsResult({ scroll_attempts: scroll.attempts });
        }
        const html = await feedHandle.innerHTML();
        // Wrap in role=feed shell so the existing parser finds the container.
        const wrapped = `<html><body><div role="feed">${html}</div></body></html>`;
        const parsed = parseGoogleMapsResults(wrapped, { category: opts.category, cityHint: opts.location });
        if (parsed.total_cards === 0) {
          if (hasVerifiedMapsEmptyResults(pageHtml)) {
            cp?.set(cpKey, {
              status: 'done', kind: 'query', url, total_cards: 0, parsed: 0, dropped: 0,
              cap_likely: false, attempts: attempt + 1, empty_verified: true,
            });
            logger.info({ url }, '[maps_live] explicit empty-result state verified');
            return emptyMapsResult({ scroll_attempts: scroll.attempts });
          }
          const evidence = await capturePageEvidence(page, opts.diagnosticsDir, cpKey);
          cp?.set(cpKey, {
            status: 'failed', kind: 'query', url,
            reason: unresolvedMapsPageReason(pageHtml, 'selector_missing_or_unverified_empty_results'), attempts: attempt + 1,
            evidence_fingerprint: evidence.fingerprint, page_title: evidence.title, screenshot_path: evidence.screenshot_path,
          });
          return emptyMapsResult({ scroll_attempts: scroll.attempts });
        }
        if (parsed.results.length === 0) {
          const evidence = await capturePageEvidence(page, opts.diagnosticsDir, cpKey);
          cp?.set(cpKey, {
            status: 'failed', kind: 'query', url, reason: 'parser_dropped_all_cards', attempts: attempt + 1,
            evidence_fingerprint: evidence.fingerprint, page_title: evidence.title, screenshot_path: evidence.screenshot_path,
          });
          return emptyMapsResult({ scroll_attempts: scroll.attempts });
        }
        if (opts.abortSignal?.aborted) return emptyMapsResult({ scroll_attempts: scroll.attempts, interrupted: true });
        cp?.set(cpKey, {
          status: 'done', kind: 'query', url,
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
            scroll_attempts: scroll.attempts,
          },
          '[maps_live] feed parsed'
        );
        return {
          results: parsed.results,
          total_cards: parsed.total_cards,
          parsed: parsed.results.length,
          dropped: parsed.dropped,
          cap_likely: parsed.cap_likely,
          scroll_attempts: scroll.attempts,
          interrupted: false,
        };
      },
      {
        abortSignal: opts.abortSignal,
        onRetry: ({ attempt, delayMs, err }) =>
          logger.warn({ url, attempt, delayMs, err: (err as Error).message }, '[maps_live] nav retry (network?)'),
      },
    );
  } catch (err) {
    if (opts.abortSignal?.aborted) return emptyMapsResult({ interrupted: true });
    const evidence = await capturePageEvidence(pageForEvidence, opts.diagnosticsDir, cpKey);
    logger.warn({ url, err: (err as Error).message }, '[maps_live] navigation error — comune skipped after retries');
    cp?.set(cpKey, {
      status: 'failed', kind: 'query', url, reason: (err as Error).message, attempts: lastAttempt + 1,
      evidence_fingerprint: evidence.fingerprint, page_title: evidence.title, screenshot_path: evidence.screenshot_path,
    });
    return emptyMapsResult();
  }
}

function emptyMapsResult(overrides: Partial<MapsLiveResult> = {}): MapsLiveResult {
  return {
    results: [], total_cards: 0, parsed: 0, dropped: 0, cap_likely: false, scroll_attempts: 0, interrupted: false,
    ...overrides,
  };
}

async function scrollFeedToEnd(
  page: import('playwright').Page,
  maxAttempts: number,
  pauseMs: number,
  abortSignal?: AbortSignal,
): Promise<{ attempts: number; interrupted: boolean }> {
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
    if (abortSignal?.aborted) return { attempts: attempt, interrupted: true };
    const currentCount = (await page.evaluate(SCROLL_AND_COUNT)) as number;
    const ended = (await page.evaluate(buildEndedExpr(END_MARKERS))) as boolean;
    if (ended) return { attempts: attempt + 1, interrupted: false };
    if (currentCount === previousCount) {
      stallCount += 1;
      if (stallCount >= 3) return { attempts: attempt + 1, interrupted: false };
    } else {
      stallCount = 0;
    }
    previousCount = currentCount;
    if (await waitForAbortOrTimeout(pauseMs, abortSignal)) return { attempts: attempt + 1, interrupted: true };
  }
  return { attempts: maxAttempts, interrupted: false };
}

async function waitForAbortOrTimeout(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) {
    await wait(ms);
    return false;
  }
  if (signal.aborted) return true;
  return new Promise((resolve) => {
    const state: {
      settled: boolean;
      timer: ReturnType<typeof setTimeout> | undefined;
    } = { settled: false, timer: undefined };
    const finish = (aborted: boolean) => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      signal.removeEventListener('abort', onAbort);
      resolve(aborted);
    };
    const onAbort = () => finish(true);
    signal.addEventListener('abort', onAbort, { once: true });
    state.timer = setTimeout(() => finish(false), ms);
    // Cover the tiny interval between the first `aborted` check and listener
    // registration without waiting for a full scroll pause.
    if (signal.aborted) onAbort();
  });
}
