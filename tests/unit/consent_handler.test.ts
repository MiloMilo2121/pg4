import { beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { acceptConsent, getConsentCounters, resetConsentCounters } from '../../src/browser/consent_handler';

/**
 * Fake Playwright page: `visible` is the set of selectors that currently
 * match a visible element. Every bounded wait and every click is recorded,
 * so the test can assert what a call costs without a real browser.
 */
function fakePage(visible: string[]) {
  const waits: number[] = [];
  const clicks: string[] = [];
  const makeLocator = (selectors: string[]) => {
    const locator = {
      or: (other: { selectors: string[] }) => makeLocator([...selectors, ...other.selectors]),
      first: () => locator,
      selectors,
      waitFor: async (opts: { state?: string; timeout?: number }) => {
        waits.push(opts.timeout ?? Number.POSITIVE_INFINITY);
        if (!selectors.some((sel) => visible.includes(sel))) {
          throw new Error(`Timeout ${opts.timeout}ms exceeded`);
        }
      },
      isVisible: async () => selectors.some((sel) => visible.includes(sel)),
      click: async (opts: { timeout?: number } = {}) => {
        const sel = selectors.find((candidate) => visible.includes(candidate));
        if (!sel) {
          waits.push(opts.timeout ?? Number.POSITIVE_INFINITY);
          throw new Error(`Timeout ${opts.timeout}ms exceeded`);
        }
        clicks.push(sel);
      },
    };
    return locator;
  };
  const page = {
    locator: (sel: string) => makeLocator([sel]),
    waitForTimeout: async () => {},
  };
  return { page: page as unknown as Page, waits, clicks };
}

beforeEach(() => resetConsentCounters());

describe('acceptConsent', () => {
  it('returns after one bounded wait when no banner is shown', async () => {
    for (const domain of ['pg', 'maps', 'generic'] as const) {
      const { page, waits, clicks } = fakePage([]);

      expect(await acceptConsent(page, domain)).toBe('not_present');

      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeLessThan(2_000);
      expect(clicks).toEqual([]);
    }
    expect(getConsentCounters()).toMatchObject({ 'pg:not_present': 1, 'maps:not_present': 1, 'generic:not_present': 1 });
  });

  it('clicks the highest-priority visible button, not the first in DOM order', async () => {
    const { page, clicks } = fakePage(['button:has-text("Accetta")', '#onetrust-accept-btn-handler']);

    expect(await acceptConsent(page, 'pg')).toBe('accepted');

    expect(clicks).toEqual(['#onetrust-accept-btn-handler']);
    expect(getConsentCounters()['pg:accepted']).toBe(1);
  });

  it('accepts the Google consent page', async () => {
    const { page, clicks } = fakePage(['button:has-text("Accept all")']);

    expect(await acceptConsent(page, 'maps')).toBe('accepted');
    expect(clicks).toEqual(['button:has-text("Accept all")']);
  });
});
