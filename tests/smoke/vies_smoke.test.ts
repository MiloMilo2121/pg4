import { describe, it, expect } from 'vitest';
import { checkVatViaVies } from '../../src/enrichment/financial/vies';

/**
 * LIVE VIES smoke — touches ec.europa.eu. Disabled unless RUN_SMOKE=1.
 * VIES is famously flaky (5xx / timeouts), so the assertions are lenient:
 * we only require a well-formed `ViesResult`, not a specific verdict.
 */
const ENABLED = process.env.RUN_SMOKE === '1' || process.env.RUN_SMOKE === 'true';

describe.runIf(ENABLED)('smoke: VIES live', () => {
  it('returns a structured result for a checksum-valid IT VAT', async () => {
    const r = await checkVatViaVies({ vatNumber: 'IT01654010345' }, { timeoutMs: 15_000 });
    expect(typeof r.isValid).toBe('boolean');
    expect(['vies', 'provisional', 'checksum']).toContain(r.source);
  });

  it('rejects a checksum-invalid VAT WITHOUT a network call', async () => {
    const r = await checkVatViaVies({ vatNumber: 'IT01654010346' });
    expect(r).toMatchObject({ isValid: false, checked: false, source: 'checksum' });
  });
});

describe.skipIf(ENABLED)('smoke: VIES skipped (RUN_SMOKE not set)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
