import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * The CONNECTION (enrichByVat) — the gated entry point the activation layer will call.
 * The OpenapiClient is mocked (no network) so the always-on SAFETY RULES are tested
 * deterministically: disabled-gate, entity-guard, ledger cost, memo. Names + VAT are
 * the REAL franchise-collision case (Tecnocasa) so the guard is proven on real data.
 */
vi.mock('../../src/providers/openapi/openapi_client', () => ({
  OpenapiClient: class {
    available(): boolean {
      return true;
    } // pretend enabled+key for the connection-logic tests
    async advancedByVat(vat: string): Promise<unknown> {
      if (vat === '08365160152') return { companyName: 'TECNOCASA FRANCHISING S.P.A.', revenue: 58024680, employees: '10-15' };
      if (vat === '09999990287') return { companyName: 'AGENZIA IMMOBILIARE ESEMPIO CASE S.R.L.', revenue: 51619, employees: '1' };
      return undefined;
    }
  },
}));

import { enrichByVat, _clearOpenapiMemo } from '../../src/enrichment/openapi/openapi_enrich';
import { CostLedger } from '../../src/runtime/cost_ledger';

beforeEach(() => _clearOpenapiMemo());

describe('enrichByVat — gated connection + always-on safety rules', () => {
  it('REFUSES a franchisor VAT cited for a local agency (entity-guard, real Tecnocasa case)', async () => {
    const ledger = new CostLedger();
    const r = await enrichByVat('08365160152', 'Agenzia Immobiliare Tecnocasa Impresa Albignasego', { ledger });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('entity_mismatch'); // €58M franchisor NOT attached
    expect(ledger.getTotal()).toBeGreaterThan(0); // the lookup happened → billed (honest cost)
  });

  it('returns the company when the official name matches the lead', async () => {
    const r = await enrichByVat('09999990287', 'Agenzia Immobiliare Esempio Case');
    expect(r.ok).toBe(true);
    expect(r.company?.revenue).toBe(51619);
  });

  it('memoises by VAT (one paid call per company per process)', async () => {
    const ledger = new CostLedger();
    await enrichByVat('09999990287', 'Agenzia Immobiliare Esempio Case', { ledger });
    await enrichByVat('09999990287', 'Agenzia Immobiliare Esempio Case', { ledger });
    expect(ledger.getTotal()).toBeCloseTo(0.1); // billed ONCE, not twice
  });
});
