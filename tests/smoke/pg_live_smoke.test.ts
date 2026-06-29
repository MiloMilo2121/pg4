import { describe, it, expect, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Live smoke test for Phase 4 PG navigation.
 *
 * Skipped unless `RUN_SMOKE=1` is set. Performs a single PG navigation
 * to the smallest Belluno result page and asserts the live navigator +
 * pure parser agree on a non-zero card count.
 *
 * Network is required, headless Chromium is required. Test makes ONE
 * navigation; no scraping of dense provinces here.
 */

const ENABLED = process.env.RUN_SMOKE === '1' || process.env.RUN_SMOKE === 'true';

const tmpStateDir = path.join(os.tmpdir(), `pg4-smoke-${Date.now()}`);

afterAll(() => {
  // Best-effort cleanup of the smoke state dir.
  try {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.runIf(ENABLED)('smoke: PG live navigation (Belluno page 1)', () => {
  it('returns at least 5 parsed cards for "agenzie immobiliari" in Belluno', async () => {
    const { BrowserFactory } = await import('../../src/browser/factory');
    const { scrapePgLocation } = await import('../../src/discovery/sources/pg_live');
    const factory = new BrowserFactory({ id: 'smoke', stateDir: tmpStateDir, headless: true, restartEvery: 100 });
    try {
      const r = await scrapePgLocation(factory, {
        category: 'agenzie immobiliari',
        location: 'Belluno',
        maxPages: 1,
      });
      expect(r.results.length).toBeGreaterThanOrEqual(5);
      expect(r.results.every((l) => !!l.company_name)).toBe(true);
      expect(r.results.every((l) => l.source === 'PG')).toBe(true);
      expect(r.results.every((l) => l.query_location === 'Belluno')).toBe(true);
    } finally {
      await factory.close();
    }
  }, 60_000);
});

describe.skipIf(ENABLED)('smoke: PG live (skipped, RUN_SMOKE not set)', () => {
  it('placeholder', () => expect(true).toBe(true));
});
