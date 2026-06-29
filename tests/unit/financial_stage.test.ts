import { describe, it, expect } from 'vitest';
import { FinancialStage } from '../../src/enrichment/stages/financial_stage';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

/**
 * R13 — the financial stage is a disabled-by-default, no-op-safe skeleton.
 * It must NEVER touch the network and NEVER break a lead.
 */

const norm = (lead: Lead): NormalizedLead => ({
  company_name: lead.company_name,
  company_name_variants: [],
  quality_score: 1,
  raw: lead,
});

describe('FinancialStage (disabled by default)', () => {
  it('is a strict no-op when not enabled', async () => {
    const run = createRun();
    const stage = new FinancialStage();
    const lead: Lead = { company_name: 'ACME SRL', vat_code: '01654010345' };
    const out = await stage.run(createPerLeadContext(run), lead, norm(lead));
    expect(out.status).toBe('skipped');
    expect(out.detail).toBe('financial_stage_disabled');
    // never writes anything while disabled
    expect(lead.vat_code_final).toBeUndefined();
  });
});

describe('FinancialStage (enabled — pure path only)', () => {
  it('promotes a checksum-valid input VAT to vat_code_final with provenance', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'ACME SRL', vat_code: 'IT 01654010345' };
    const out = await stage.run(createPerLeadContext(run), lead, norm(lead));
    expect(out.status).toBe('success');
    expect(out.provider).toBe('input');
    expect(lead.vat_code_final).toBe('01654010345');
  });

  it('WRONG-ENTITY GUARD: the CLI stage is PURE — never fetches revenue/employees (audit 2026-06-16)', async () => {
    // Locks the safe skeleton: the franchise-collision class lives ONLY where a VAT
    // drives a firmographic FETCH (the per-field cascade, which is guarded). This stage
    // must stay fetch-free so it can't mis-attribute a franchisor's data. If a future
    // phase adds a fatturatoitalia/VIES lookup here, this test fails → forcing the
    // author to route through the guarded per-field cascade (see deriveFromInput contract).
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'Agenzia Immobiliare Tecnocasa Albignasego', vat_code: '08365160152' };
    const out = await stage.run(createPerLeadContext(run), lead, norm(lead));
    expect(lead.vat_code_final).toBe('08365160152'); // checksum-valid → promoted (pure)
    expect(lead.revenue).toBeUndefined(); // NEVER fetched (no franchisor €58M)
    expect(lead.employees).toBeUndefined();
    expect(out.duration_ms).toBeLessThan(50); // no network round-trip
  });

  it('returns not_found (NOT error) when there is no financial signal', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'NoVat SRL' };
    const out = await stage.run(createPerLeadContext(run), lead, norm(lead));
    expect(out.status).toBe('not_found');
    expect(lead.vat_code_final).toBeUndefined();
  });

  it('ignores a checksum-invalid input VAT', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'Bad SRL', vat_code: '01654010346' };
    const out = await stage.run(createPerLeadContext(run), lead, norm(lead));
    expect(out.status).toBe('not_found');
    expect(lead.vat_code_final).toBeUndefined();
  });
});
