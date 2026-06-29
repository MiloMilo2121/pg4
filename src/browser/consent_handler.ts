import type { Page } from 'playwright';
import { logger } from '../runtime/logger';

/**
 * Best-effort cookie / consent acceptance.
 *
 * pg3 logged a line per attempted button; with thousands of navigations
 * that buried the actual signal. pg4 keeps a single in-process counter
 * per (domain, outcome) and flushes a summary on demand.
 *
 * The handler is safe to call before/after navigation. A "miss" (no
 * known button) is fine — many navigations land directly on the result
 * page once the storage state has accepted the consent once.
 */

type Domain = 'pg' | 'maps' | 'generic';
type Outcome = 'accepted' | 'not_present' | 'failed';

const counters: Record<`${Domain}:${Outcome}`, number> = {
  'pg:accepted': 0,
  'pg:not_present': 0,
  'pg:failed': 0,
  'maps:accepted': 0,
  'maps:not_present': 0,
  'maps:failed': 0,
  'generic:accepted': 0,
  'generic:not_present': 0,
  'generic:failed': 0,
};

const PG_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button#onetrust-accept-btn-handler',
  'button[aria-label="Accetta"]',
  'button[aria-label*="cookie" i]',
  'button:has-text("Accetta")',
  'button:has-text("Accetto")',
  'button:has-text("ACCETTA")',
];

const MAPS_SELECTORS = [
  'button[aria-label*="Accetta tutto" i]',
  'button[aria-label*="Accept all" i]',
  'button:has-text("Accetta tutto")',
  'button:has-text("Accept all")',
  'form[action*="consent"] button:has-text("Accetta")',
  'form[action*="consent"] button:has-text("Accept")',
];

const GENERIC_SELECTORS = [
  'button:has-text("Accetta tutti")',
  'button:has-text("Accetta")',
  'button:has-text("Accept all")',
  'button:has-text("I agree")',
  'button:has-text("OK")',
];

export async function acceptConsent(page: Page, domain: Domain, opts: { perButtonTimeoutMs?: number } = {}): Promise<Outcome> {
  const selectors =
    domain === 'pg' ? PG_SELECTORS : domain === 'maps' ? MAPS_SELECTORS : GENERIC_SELECTORS;
  const timeout = opts.perButtonTimeoutMs ?? 1500;
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      await locator.click({ timeout });
      counters[`${domain}:accepted`] += 1;
      // Allow the page to settle after consent — usually the consent
      // overlay re-renders content. Short, bounded.
      await page.waitForTimeout(400);
      return 'accepted';
    } catch {
      // selector not present / not clickable / timed out — try next
    }
  }
  counters[`${domain}:not_present`] += 1;
  return 'not_present';
}

/** Flush accumulated counters as a single structured log line. */
export function logConsentSummary(): void {
  logger.info({ ...counters }, '[consent_handler] summary');
}

/** Reset counters between runs / tests. */
export function resetConsentCounters(): void {
  for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k] = 0;
}

export function getConsentCounters(): Readonly<typeof counters> {
  return counters;
}
