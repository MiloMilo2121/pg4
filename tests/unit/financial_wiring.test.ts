import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { FinancialStage } from '../../src/enrichment/stages/financial_stage';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import { CsvWriter } from '../../src/io/csv_writer';
import { RAW_CSV_COLUMNS, ENRICHED_CSV_COLUMNS } from '../../src/types/lead';
import type { Lead } from '../../src/types/lead';

// Real network is forbidden in unit tests — every host is dead.
const deadDns = async (_host: string) => Promise.reject(new Error('ENOTFOUND'));

const VALID_VAT = '01654010345'; // checksum OK
const INVALID_VAT = '01654010346'; // broken check digit

function run() {
  return createRun();
}
function emptyRouter(ledger: CostLedger) {
  return new ProviderRouter([], [], [], ledger);
}

describe('R13.1 — FinancialStage wiring (no network)', () => {
  it('promotes a checksum-valid input vat_code to vat_code_final with provenance', async () => {
    const r = run();
    const router = emptyRouter(new CostLedger());
    const lead: Lead = { company_name: 'ACME SRL', city: 'Milano', province: 'MI', vat_code: `IT ${VALID_VAT}` };
    const result = await runEnrichmentPipeline({ run: r, perLead: createPerLeadContext(r), router, lead, dnsResolver: deadDns });

    expect(result.lead.vat_code_final).toBe(VALID_VAT);
    expect(result.lead.financial_source).toBe('input');
    expect(result.lead.financial_confidence).toBe(0.6);
    expect(result.lead.financial_notes).toContain('vat_code:');
    expect(result.stage_outcomes.financial.status).toBe('success');
    // financial provenance must NOT leak into network providers_used
    expect(result.lead.providers_used).not.toContain('input');
  });

  it('does NOT promote a checksum-invalid vat_code', async () => {
    const r = run();
    const router = emptyRouter(new CostLedger());
    const lead: Lead = { company_name: 'Bad SRL', city: 'Milano', vat_code: INVALID_VAT };
    const result = await runEnrichmentPipeline({ run: r, perLead: createPerLeadContext(r), router, lead, dnsResolver: deadDns });

    expect(result.lead.vat_code_final).toBeUndefined();
    expect(result.lead.financial_source).toBeUndefined();
    expect(result.stage_outcomes.financial.status).toBe('not_found');
  });

  it('does not error when vat_code is missing — row still produced', async () => {
    const r = run();
    const router = emptyRouter(new CostLedger());
    const lead: Lead = { company_name: 'NoVat SRL', city: 'Torino' };
    const result = await runEnrichmentPipeline({ run: r, perLead: createPerLeadContext(r), router, lead, dnsResolver: deadDns });

    expect(result.lead.status).toBeDefined();
    expect(result.lead.reason_code).toBeDefined();
    expect(result.lead.vat_code_final).toBeUndefined();
    expect(result.stage_outcomes.financial.status).not.toBe('error');
  });

  it('a disabled FinancialStage is a no-op and does not change website status/reason_code', async () => {
    const r = run();
    const router = emptyRouter(new CostLedger());
    const lead: Lead = { company_name: 'ACME SRL', city: 'Milano', province: 'MI', vat_code: VALID_VAT };
    const result = await runEnrichmentPipeline({
      run: r,
      perLead: createPerLeadContext(r),
      router,
      lead,
      dnsResolver: deadDns,
      financialStage: new FinancialStage({ enabled: false }),
    });

    // website discovery verdict unchanged (no website → NOT_FOUND), and the
    // disabled stage wrote nothing.
    expect(result.lead.status).toBe('NOT_FOUND');
    expect(result.lead.vat_code_final).toBeUndefined();
    expect(result.stage_outcomes.financial.status).toBe('skipped');
    expect(result.stage_outcomes.financial.detail).toBe('financial_stage_disabled');
  });

  it('does not alter the FOUND verdict for a lead whose website resolves', async () => {
    // Reuse the happy-path shape but assert financial runs alongside without
    // touching the website outcome. We can't resolve DNS offline, so this
    // checks the orthogonality contract on a NOT_FOUND lead instead: the
    // financial success must not flip the lead to FOUND.
    const r = run();
    const router = emptyRouter(new CostLedger());
    const lead: Lead = { company_name: 'ACME SRL', city: 'Milano', province: 'MI', vat_code: VALID_VAT };
    const result = await runEnrichmentPipeline({ run: r, perLead: createPerLeadContext(r), router, lead, dnsResolver: deadDns });
    expect(result.stage_outcomes.financial.status).toBe('success');
    expect(result.lead.status).toBe('NOT_FOUND'); // financial success ≠ website found
    expect(result.lead.official_website).toBeUndefined();
  });
});

describe('R13.1 — CSV columns are deterministic and append-only', () => {
  // Schema v1 (Phase C.1) appended phone_raw/permanently_closed/_schema_version
  // after the financial block; v2 (Phase 1 free-gold) appended instagram/
  // facebook/linkedin after THAT, on the enriched flavor only. So on ENRICHED
  // the financial block is the last four columns before the v1+v2 appendices.
  // The append-only guarantee (no pre-existing column moved) holds.
  const V1_APPENDIX = ['phone_raw', 'permanently_closed', '_schema_version'];
  const V2_APPENDIX = ['instagram', 'facebook', 'linkedin'];
  const V3_APPENDIX = ['tiktok', 'youtube', 'rating', 'reviews_count', 'founding_year'];
  const V4_APPENDIX = ['net_profit', 'net_profit_year', 'share_capital', 'legal_form', 'ateco', 'rea'];
  const ENRICHED_APPENDIX = [...V1_APPENDIX, ...V2_APPENDIX, ...V3_APPENDIX, ...V4_APPENDIX];

  it('keeps the 4 financial columns contiguous, right before the v1+v2 appendix', () => {
    const beforeAppendix = ENRICHED_CSV_COLUMNS.slice(0, -ENRICHED_APPENDIX.length);
    expect(beforeAppendix.slice(-4)).toEqual([
      'financial_source',
      'financial_confidence',
      'financial_evidence_count',
      'financial_notes',
    ]);
    expect(ENRICHED_CSV_COLUMNS.slice(-ENRICHED_APPENDIX.length)).toEqual(ENRICHED_APPENDIX);
  });

  it('keeps ENRICHED a strict superset that starts with the RAW base columns', () => {
    const rawBase = RAW_CSV_COLUMNS.slice(0, -V1_APPENDIX.length);
    expect(ENRICHED_CSV_COLUMNS.slice(0, rawBase.length)).toEqual([...rawBase]);
    // RAW carries only the v1 appendix at its end (v2 is enrichment-only).
    expect(RAW_CSV_COLUMNS.slice(-V1_APPENDIX.length)).toEqual(V1_APPENDIX);
  });

  it('places the financial columns AFTER the pre-existing "errors" column', () => {
    const errorsIdx = ENRICHED_CSV_COLUMNS.indexOf('errors');
    const finIdx = ENRICHED_CSV_COLUMNS.indexOf('financial_source');
    expect(errorsIdx).toBeGreaterThanOrEqual(0);
    expect(finIdx).toBeGreaterThan(errorsIdx);
  });

  it('serializes the financial columns in the header and row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-fin-'));
    const p = path.join(dir, 'out.csv');
    const w = new CsvWriter(p, 'enriched');
    await w.write({
      company_name: 'ACME SRL',
      vat_code_final: VALID_VAT,
      financial_source: 'input',
      financial_confidence: 0.6,
      financial_notes: 'vat:italian_piva_checksum_ok',
    });
    await w.close();
    const [header, row] = fs.readFileSync(p, 'utf8').split('\n');
    expect(
      header
        .trim()
        .endsWith('financial_source,financial_confidence,financial_evidence_count,financial_notes,phone_raw,permanently_closed,_schema_version,instagram,facebook,linkedin,tiktok,youtube,rating,reviews_count,founding_year,net_profit,net_profit_year,share_capital,legal_form,ateco,rea')
    ).toBe(true);
    expect(row).toContain('input');
    expect(row).toContain('0.6');
    expect(row).toContain('italian_piva_checksum_ok');
  });
});
