import { describe, expect, it } from 'vitest';
import { runScrapePreflight, PreflightError, PREFLIGHT_CANARY } from '../../src/discovery/preflight';
import { EXIT } from '../../src/runtime/run_record';
import type { BrowserFactory } from '../../src/browser/factory';

/**
 * Gate-0 — the preflight is the guard against a silent markup change: a
 * selector that suddenly matches 0 cards must ABORT with exit 3 and an
 * actionable message, never "complete" with an empty output. Here we FORCE
 * that failure on a scratch (fake) browser and assert the contract.
 */

// Minimal duck-typed Playwright Page. acceptConsent only calls
// locator().first().click() (in try/catch); the preflight calls goto /
// waitForSelector / $$eval. `cardCount` drives the failure.
function fakeFactory(cardCount: number): BrowserFactory {
  const page = {
    goto: async () => {},
    waitForSelector: async () => {
      if (cardCount === 0) throw new Error('selector timeout (0 matches)');
    },
    $$eval: async () => cardCount,
    $: async () => null,
    locator: () => ({ first: () => ({ click: async () => { throw new Error('no consent button'); } }) }),
    waitForTimeout: async () => {},
  };
  return {
    getPage: async () => page,
    noteNavigation: () => {},
  } as unknown as BrowserFactory;
}

describe('Gate-0 — forced preflight failure', () => {
  it('throws PreflightError when the PG selector matches 0 cards (broken selector)', async () => {
    await expect(runScrapePreflight(fakeFactory(0), { checkMaps: false })).rejects.toBeInstanceOf(PreflightError);
  });

  it('the failure message is actionable (canary, cause, remedy)', async () => {
    let caught: PreflightError | undefined;
    try {
      await runScrapePreflight(fakeFactory(0), { checkMaps: false });
    } catch (e) {
      caught = e as PreflightError;
    }
    expect(caught).toBeInstanceOf(PreflightError);
    expect(caught!.source).toBe('pg');
    expect(caught!.message).toContain(PREFLIGHT_CANARY.location); // "Padova"
    expect(caught!.message).toContain('--skip-preflight'); // remedy
    expect(caught!.message).toContain('markup changed'); // likely cause
  });

  it('passes (control) when the selector matches cards', async () => {
    const r = await runScrapePreflight(fakeFactory(42), { checkMaps: false });
    expect(r.pg_cards).toBe(42);
  });

  it('PreflightError maps to the dedicated exit code 3 (scheduler signal)', () => {
    // src/cli/scrape.ts: `if (err instanceof PreflightError) → finish(preflight_failed, EXIT.PREFLIGHT_FAILED)`
    expect(EXIT.PREFLIGHT_FAILED).toBe(3);
  });
});
