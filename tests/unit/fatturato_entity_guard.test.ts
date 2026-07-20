import { describe, expect, it, vi } from 'vitest';

/**
 * Real-data golden for the FRANCHISE-COLLISION fix (validation audit 2026-06-14).
 * A local "Agenzia Immobiliare Tecnocasa ... Albignasego" cited the FRANCHISOR's
 * VAT (08365160152) in its footer; fatturatoitalia returns that VAT's registered
 * name "TECNOCASA FRANCHISING S.P.A." with €58M revenue. The fatturato step must
 * REFUSE it (the firmographics belong to a different legal entity), regardless of
 * the VAT's 'site' provenance. Names + VAT below are REAL observed strings.
 *
 * Mocked at the fetch boundary (no network) so the entity-verification LOGIC is
 * tested deterministically — the live fetch behaviour is covered by the probes.
 */
vi.mock('../../src/enrichment/financial/fatturato_italia_fetch', () => ({
  fetchFatturatoItalia: vi.fn(async (vat: string) => {
    if (vat === '08365160152') return { company_name: 'TECNOCASA FRANCHISING S.P.A.', revenue: '€ 58.024.680', revenue_year: '2024', employees: '10-15', history: [], confidence: 0.9, vat_queried: vat, source_url: '' };
    if (vat === '09999990287') return { company_name: 'AGENZIA IMMOBILIARE ESEMPIO CASE S.R.L.', revenue: '€ 51.619', revenue_year: '2024', employees: '1', history: [], confidence: 0.9, vat_queried: vat, source_url: '' };
    return undefined;
  }),
}));

import { runFieldCascade } from '../../src/enrichment/fields/run_field_cascade';
import type { Lead } from '../../src/types/lead';

describe('fatturato entity-verification guard (franchise-collision bug, audit 2026-06-14)', () => {
  it('REFUSES a franchisor VAT cited in a local franchisee footer — no €58M on a local agency', async () => {
    const lead = { company_name: 'Agenzia Immobiliare Tecnocasa Impresa Albignasego' } as Lead;
    const out = await runFieldCascade(lead, 'revenue', { extraction: { vat_candidates: ['08365160152'], phones: [] } });
    expect(out.resolved).toBe(false);
    // refused via the entity guard (vat_unverified), NOT a genuine no-data (no_value)
    expect(out.steps[0].reason).toBe('vat_unverified');
  });

  it('REFUSES the franchisor VAT for employees too (same guard, both firmographic fields)', async () => {
    const lead = { company_name: 'Agenzia Immobiliare Tecnocasa Impresa Albignasego' } as Lead;
    const out = await runFieldCascade(lead, 'employees', { extraction: { vat_candidates: ['08365160152'], phones: [] } });
    expect(out.resolved).toBe(false);
    expect(out.steps[0].reason).toBe('vat_unverified');
  });

  it('KEEPS a VAT whose registered name matches the company (no over-rejection)', async () => {
    const lead = { company_name: 'Agenzia Immobiliare Esempio Case' } as Lead;
    const out = await runFieldCascade(lead, 'revenue', { extraction: { vat_candidates: ['09999990287'], phones: [] } });
    expect(out.resolved).toBe(true);
    expect(out.value).toBe('€ 51.619');
  });

  it('ships revenue_year with the revenue via the extras channel (fill-only-empty)', async () => {
    const lead = { company_name: 'Agenzia Immobiliare Esempio Case' } as Lead;
    await runFieldCascade(lead, 'revenue', { extraction: { vat_candidates: ['09999990287'], phones: [] } });
    // Same fetch parsed the bilancio year — the list must be able to say
    // "fatturato 2024", not just "fatturato" (the year was silently dropped).
    expect(lead.revenue).toBe('€ 51.619');
    expect(lead.revenue_year).toBe('2024');
  });

  it('extras never overwrite an existing revenue_year (input wins)', async () => {
    const lead = { company_name: 'Agenzia Immobiliare Esempio Case', revenue_year: '2019' } as Lead;
    await runFieldCascade(lead, 'revenue', { extraction: { vat_candidates: ['09999990287'], phones: [] } });
    expect(lead.revenue_year).toBe('2019');
  });
});
