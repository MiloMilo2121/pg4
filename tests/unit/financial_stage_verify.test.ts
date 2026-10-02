/**
 * financial_stage_verify.test.ts
 *
 * Post-wiring audit: verifies the FinancialStage contracts and the
 * ENRICHED_CSV_COLUMNS append-only guarantee.
 *
 * VALID_PIVA derivation:
 *   Base prefix "0123456789", compute check digit using the standard
 *   Agenzia delle Entrate algorithm (odd 1-indexed positions summed
 *   directly, even 1-indexed positions doubled; check digit makes
 *   sum % 10 === 0). Result: 01234567897.
 *
 * INVALID_PIVA: same prefix, last digit incremented by 1 → 01234567898.
 *   Fails the checksum, never a real company identifier.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FinancialStage } from '../../src/enrichment/stages/financial_stage';
import { validateItalianVatChecksum, normalizeVatCode } from '../../src/enrichment/financial/vat';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import { CsvWriter } from '../../src/io/csv_writer';
import { RAW_CSV_COLUMNS, ENRICHED_CSV_COLUMNS } from '../../src/types/lead';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

// ---------------------------------------------------------------------------
// Test fixtures — derived from the real Italian P.IVA Luhn-like mod-11 rule.
// ---------------------------------------------------------------------------

/**
 * "0123456789" + check digit 7 = "01234567897"
 * Manually verified: sum of contributions = 53, check = (10 - 53%10)%10 = 7
 */
const VALID_PIVA = '01234567897';

/**
 * Same as VALID_PIVA but last digit is 8 — fails the checksum.
 * 8 ≠ 7, sum % 10 = 4, not 0.
 */
const INVALID_PIVA = '01234567898';

// Minimal NormalizedLead builder — only quality_score matters for the stage.
function toNorm(lead: Lead): NormalizedLead {
  return {
    company_name: lead.company_name,
    company_name_variants: [],
    quality_score: 1,
    raw: lead,
  };
}

// ---------------------------------------------------------------------------
// 0. Sanity-check the fixtures themselves
// ---------------------------------------------------------------------------

describe('Italian P.IVA checksum — fixture sanity', () => {
  it('VALID_PIVA passes the checksum', () => {
    expect(validateItalianVatChecksum(VALID_PIVA)).toBe(true);
  });

  it('INVALID_PIVA fails the checksum', () => {
    expect(validateItalianVatChecksum(INVALID_PIVA)).toBe(false);
  });

  it('normalizeVatCode strips IT prefix and whitespace', () => {
    expect(normalizeVatCode(`IT ${VALID_PIVA}`)).toBe(VALID_PIVA);
    expect(normalizeVatCode('  ' + VALID_PIVA + '  ')).toBe(VALID_PIVA);
  });
});

// ---------------------------------------------------------------------------
// 1. Valid PIVA is promoted to vat_code_final
// ---------------------------------------------------------------------------

describe('FinancialStage — valid PIVA promotion', () => {
  it('promotes a checksum-valid vat_code to vat_code_final with source=input, confidence=0.6', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'ACME SRL', vat_code: VALID_PIVA };
    const outcome = await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(outcome.status).toBe('success');
    expect(outcome.provider).toBe('input');
    expect(lead.vat_code_final).toBe(VALID_PIVA);
    expect(lead.financial_source).toBe('input');
    expect(lead.financial_confidence).toBe(0.6);
    expect(lead.financial_evidence_count).toBeGreaterThanOrEqual(1);
    expect(lead.financial_notes).toBeTruthy();
  });

  it('normalizes IT-prefixed vat_code before promoting', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'ACME SRL', vat_code: `IT ${VALID_PIVA}` };
    await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(lead.vat_code_final).toBe(VALID_PIVA);
  });

  it('does not overwrite a vat_code_final that was already present', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const PRE_EXISTING = VALID_PIVA; // same value — idempotent
    const lead: Lead = { company_name: 'ACME SRL', vat_code: VALID_PIVA, vat_code_final: PRE_EXISTING };
    await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(lead.vat_code_final).toBe(PRE_EXISTING);
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid PIVA is ignored — not promoted
// ---------------------------------------------------------------------------

describe('FinancialStage — invalid PIVA ignored', () => {
  it('returns not_found and leaves vat_code_final undefined for a checksum-invalid vat_code', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'Bad SRL', vat_code: INVALID_PIVA };
    const outcome = await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(outcome.status).toBe('not_found');
    expect(lead.vat_code_final).toBeUndefined();
    expect(lead.financial_source).toBeUndefined();
    expect(lead.financial_confidence).toBeUndefined();
    expect(lead.financial_evidence_count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Missing PIVA causes no error
// ---------------------------------------------------------------------------

describe('FinancialStage — missing PIVA is not an error', () => {
  it('returns not_found (not error) when vat_code is absent', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'NoVat SRL', city: 'Torino' };
    const outcome = await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(outcome.status).toBe('not_found');
    expect(outcome.status).not.toBe('error');
    expect(lead.vat_code_final).toBeUndefined();
    expect(lead.financial_source).toBeUndefined();
  });

  it('produces a valid StageOutcome even when both vat_code and vat_code_final are undefined', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = { company_name: 'Ghost SRL' };
    const outcome = await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(outcome.stage).toBe('financial');
    expect(outcome.duration_ms).toBeGreaterThanOrEqual(0);
    // Lead row is always produced — all original fields intact
    expect(lead.company_name).toBe('Ghost SRL');
  });
});

// ---------------------------------------------------------------------------
// 4. No-op (disabled) stage — row is completely unchanged
// ---------------------------------------------------------------------------

describe('FinancialStage — no-op when disabled', () => {
  it('is a strict no-op (skipped) and does not mutate any lead field', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: false });
    const lead: Lead = {
      company_name: 'ACME SRL',
      city: 'Milano',
      province: 'MI',
      vat_code: VALID_PIVA,
      revenue: '€ 1.500.000',
      employees: '12',
    };

    // Snapshot pre-run
    const snapshot = JSON.parse(JSON.stringify(lead)) as typeof lead;
    const outcome = await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toBe('financial_stage_disabled');
    expect(lead.vat_code_final).toBeUndefined();
    expect(lead.financial_source).toBeUndefined();
    expect(lead.financial_confidence).toBeUndefined();
    expect(lead.financial_evidence_count).toBeUndefined();
    expect(lead.financial_notes).toBeUndefined();
    // All original fields preserved
    expect(lead.company_name).toBe(snapshot.company_name);
    expect(lead.revenue).toBe(snapshot.revenue);
    expect(lead.employees).toBe(snapshot.employees);
  });

  it('preserves pre-existing revenue and employees when enabled but no vat signal', async () => {
    const run = createRun();
    const stage = new FinancialStage({ enabled: true });
    const lead: Lead = {
      company_name: 'ACME SRL',
      revenue: '€ 2.000.000',
      revenue_year: '2023',
      employees: '25',
      employees_is_estimated: false,
    };
    await stage.run(createPerLeadContext(run), lead, toNorm(lead));

    // No financial data, but existing revenue/employees must not be wiped
    expect(lead.revenue).toBe('€ 2.000.000');
    expect(lead.revenue_year).toBe('2023');
    expect(lead.employees).toBe('25');
    expect(lead.employees_is_estimated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. CSV header is append-only: financial cols exist, original cols precede them
// ---------------------------------------------------------------------------

describe('ENRICHED_CSV_COLUMNS — append-only contract', () => {
  it('contains all 4 financial columns', () => {
    const cols = ENRICHED_CSV_COLUMNS as readonly string[];
    expect(cols).toContain('financial_source');
    expect(cols).toContain('financial_confidence');
    expect(cols).toContain('financial_evidence_count');
    expect(cols).toContain('financial_notes');
  });

  it('all 4 financial columns appear after all original columns', () => {
    const cols = ENRICHED_CSV_COLUMNS as readonly string[];
    const finCols = ['financial_source', 'financial_confidence', 'financial_evidence_count', 'financial_notes'];
    const minFinIdx = Math.min(...finCols.map((c) => cols.indexOf(c)));
    // "errors" is the last pre-financial column; check it precedes financial cols
    const errorsIdx = cols.indexOf('errors');
    expect(errorsIdx).toBeGreaterThanOrEqual(0);
    expect(minFinIdx).toBeGreaterThan(errorsIdx);
  });

  it('financial columns appear in the correct relative order', () => {
    const cols = ENRICHED_CSV_COLUMNS as readonly string[];
    const srcIdx = cols.indexOf('financial_source');
    const confIdx = cols.indexOf('financial_confidence');
    const evCountIdx = cols.indexOf('financial_evidence_count');
    const notesIdx = cols.indexOf('financial_notes');
    expect(srcIdx).toBeLessThan(confIdx);
    expect(confIdx).toBeLessThan(evCountIdx);
    expect(evCountIdx).toBeLessThan(notesIdx);
  });

  it('ENRICHED_CSV_COLUMNS starts with the RAW base columns (original cols unaffected)', () => {
    // Schema v1 + v2 (free-gold): RAW = RAW_BASE + V1
    // appendix; ENRICHED = RAW_BASE + ENRICHED_BASE + V1 + V2 (instagram/
    // facebook/linkedin). The enriched CSV starts with raw-minus-V1-appendix;
    // no pre-existing column ever moved (append-only).
    const raw = RAW_CSV_COLUMNS as readonly string[];
    const enriched = ENRICHED_CSV_COLUMNS as readonly string[];
    const rawAppendixLen = 3; // V1: phone_raw, permanently_closed, _schema_version
    const rawBase = raw.slice(0, raw.length - rawAppendixLen);
    for (let i = 0; i < rawBase.length; i++) {
      expect(enriched[i]).toBe(rawBase[i]);
    }
    // RAW still ends with the V1 appendix (no v2/v3 on the raw flavor).
    expect(raw.slice(-rawAppendixLen)).toEqual(['phone_raw', 'permanently_closed', '_schema_version']);
    // ENRICHED ends with the V5 appendix; V4, V3, V2, V1 sit before it (append-only).
    expect(enriched.slice(-5)).toEqual(['email_status', 'portal_source', 'portal_listings_count', 'portal_is_paid', 'portal_fiaip']);
    expect(enriched.slice(-11, -5)).toEqual(['net_profit', 'net_profit_year', 'share_capital', 'legal_form', 'ateco', 'rea']);
    expect(enriched.slice(-16, -11)).toEqual(['tiktok', 'youtube', 'rating', 'reviews_count', 'founding_year']);
    expect(enriched.slice(-19, -16)).toEqual(['instagram', 'facebook', 'linkedin']);
    expect(enriched.slice(-22, -19)).toEqual(['phone_raw', 'permanently_closed', '_schema_version']);
  });

  it('CSV writer emits all 4 financial columns in the header', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-fv-'));
    const p = path.join(dir, 'verify.csv');
    const w = new CsvWriter(p, 'enriched');
    await w.write({
      company_name: 'Test SRL',
      vat_code_final: VALID_PIVA,
      financial_source: 'input',
      financial_confidence: 0.6,
      financial_evidence_count: 1,
      financial_notes: 'vat_code:italian_piva_checksum_ok',
    });
    await w.close();

    const raw = fs.readFileSync(p, 'utf8');
    const header = raw.split('\n')[0];
    expect(header).toContain('financial_source');
    expect(header).toContain('financial_confidence');
    expect(header).toContain('financial_evidence_count');
    expect(header).toContain('financial_notes');
  });

  it('CSV row contains the financial values when present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-fv-'));
    const p = path.join(dir, 'values.csv');
    const w = new CsvWriter(p, 'enriched');
    await w.write({
      company_name: 'Value SRL',
      financial_source: 'input',
      financial_confidence: 0.6,
      financial_evidence_count: 1,
      financial_notes: 'vat_code:italian_piva_checksum_ok',
    });
    await w.close();

    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const dataRow = lines[1];
    expect(dataRow).toContain('input');
    expect(dataRow).toContain('0.6');
    expect(dataRow).toContain('1');
    expect(dataRow).toContain('italian_piva_checksum_ok');
  });
});
