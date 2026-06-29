import { describe, it, expect } from 'vitest';
import { DdgLiteProvider } from '../../src/providers/serp/ddg_lite';
import { BingHtmlProvider } from '../../src/providers/serp/bing_html';

// Gate-0: dns_mx + crtsh were deleted (0 successes in 12,728 calls each).
// Their smoke cases were removed with them.
const ENABLED = process.env.RUN_SMOKE === '1' || process.env.RUN_SMOKE === 'true';

describe.runIf(ENABLED)('smoke: SERP providers (live)', () => {
  it('DdgLiteProvider returns results for a generic query (best effort)', async () => {
    const r = await new DdgLiteProvider().search('"example.com"', { limit: 5 });
    // DDG occasionally serves blocks — we only assert the call did not throw.
    expect(Array.isArray(r)).toBe(true);
  }, 20000);

  it('BingHtmlProvider returns results for a generic query (best effort)', async () => {
    const r = await new BingHtmlProvider().search('"example.com"', { limit: 5 });
    expect(Array.isArray(r)).toBe(true);
  }, 20000);
});

describe.skipIf(ENABLED)('smoke: SERP providers (skipped, RUN_SMOKE not set)', () => {
  it('placeholder', () => expect(true).toBe(true));
});
