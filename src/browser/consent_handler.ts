import type { Page } from 'playwright';
import { logger } from '../runtime/logger';

/**
 * Best-effort cookie / consent acceptance.
 *
 * Logging a line per attempted button buries the actual signal: with
 * thousands of navigations the log is all consent noise. So the module keeps
 * a single in-process counter per (domain, outcome) and flushes a summary
 * on demand.
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

// Listed in priority order. `button#onetrust-accept-btn-handler` and
// `button:has-text("ACCETTA")` are not repeated: the id already matches the
// button, and `:has-text` is a case-insensitive substring match.
const PG_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button[aria-label="Accetta"]',
  'button[aria-label*="cookie" i]',
  'button:has-text("Accetta")',
  'button:has-text("Accetto")',
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

/**
 * Once consent is stored there is no banner, and that is the common case. A
 * sequential click per selector waited the full timeout for each of them
 * (about 10 s per PG comune), so the handler first waits once for any of the
 * selectors to become visible and returns when none does. Only then does it
 * click, walking the list in priority order rather than DOM order so a
 * generic "cookie" button never wins over the dedicated accept button.
 */
export async function acceptConsent(page: Page, domain: Domain, opts: { timeoutMs?: number } = {}): Promise<Outcome> {
  const selectors =
    domain === 'pg' ? PG_SELECTORS : domain === 'maps' ? MAPS_SELECTORS : GENERIC_SELECTORS;
  const timeout = opts.timeoutMs ?? 1500;
  try {
    const anyBanner = selectors
      .map((sel) => page.locator(sel))
      .reduce((combined, next) => combined.or(next));
    await anyBanner.first().waitFor({ state: 'visible', timeout });
  } catch {
    counters[`${domain}:not_present`] += 1;
    return 'not_present';
  }
  for (const sel of selectors) {
    try {
      const button = page.locator(sel).first();
      if (!(await button.isVisible())) continue;
      await button.click({ timeout });
      counters[`${domain}:accepted`] += 1;
      // Allow the page to settle after consent — usually the consent
      // overlay re-renders content. Short, bounded.
      await page.waitForTimeout(400);
      return 'accepted';
    } catch {
      // detached or not clickable — try the next selector
    }
  }
  // A banner was visible but none of its buttons could be clicked.
  counters[`${domain}:failed`] += 1;
  return 'failed';
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
