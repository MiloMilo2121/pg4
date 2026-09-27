import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseFatturatoItaliaPage, parseDipendenti } from '../../src/enrichment/financial/fatturato_italia_parser';

// Local SYNTHETIC fixtures — no live network, no real scraped data.
const fixDir = path.join(__dirname, '../fixtures/financial');
const read = (f: string) => fs.readFileSync(path.join(fixDir, f), 'utf8');

describe('parseFatturatoItaliaPage — chart-var page', () => {
  const r = parseFatturatoItaliaPage(read('fatturato_company_chart.html'), 'https://www.fatturatoitalia.it/esempio-spa-01654010345');

  it('extracts the latest revenue + year from the JS chart series', () => {
    expect(r.revenue_amount).toBe(40_503_424_402);
    expect(r.revenue_year).toBe('2023');
    expect(r.revenue).toBe('€ 40.503.424.402');
  });
  it('extracts utile and full 5-year history', () => {
    expect(r.utile).toBe(1_200_000_000);
    expect(r.history).toHaveLength(5);
    expect(r.history[0]).toMatchObject({ year: 2023, fatturato: 40_503_424_402 });
  });
  it('extracts company name, checksum-valid VAT and employees', () => {
    expect(r.company_name).toBe('ESEMPIO SPA');
    expect(r.vat_code).toBe('01654010345');
    expect(r.employees).toBe('8200');
  });
  it('assigns high confidence when chart data is present', () => {
    expect(r.confidence).toBe(0.9);
    expect(r.source_url).toContain('fatturatoitalia.it');
  });
});

describe('parseFatturatoItaliaPage — grid fallback page', () => {
  const r = parseFatturatoItaliaPage(read('fatturato_company_grid.html'));

  it('picks the most recent fatturato from the label/value grid', () => {
    expect(r.revenue_amount).toBe(1_500_000);
    expect(r.revenue_year).toBe('2022');
  });
  it('reads utile, employees, name and VAT from the grid', () => {
    expect(r.utile).toBe(120_000);
    expect(r.employees).toBe('25');
    expect(r.company_name).toBe('ACME SRL');
    expect(r.vat_code).toBe('00159560366');
  });
  it('assigns medium confidence for grid-only revenue', () => {
    expect(r.confidence).toBe(0.75);
    expect(r.history).toHaveLength(0);
  });
});

describe('parseFatturatoItaliaPage — <th scope="row"> summary table (current 2026-07 format)', () => {
  // O6 regression: the site dropped the chart JS vars + col-xs grid for a
  // `<th scope="row">Fatturato 2024</th><td>…</td>` table. Without this path the
  // fetcher parsed a 404 shell → revenue/employees 0% nationwide.
  const r = parseFatturatoItaliaPage(read('fatturato_company_table.html'));

  it('picks the most recent fatturato year from the table', () => {
    expect(r.revenue_amount).toBe(6_284_626_802);
    expect(r.revenue_year).toBe('2024'); // not 2023
    expect(r.revenue).toBe('€ 6.284.626.802');
  });
  it('reads utile, employee band, name and VAT from the table', () => {
    // "Utile 2023" sits AFTER "Utile 2024" in the fixture: the most recent YEAR
    // must win, never DOM order (the documented wrong-year bug class).
    expect(r.utile).toBe(1_556_213_265);
    expect(r.utile).not.toBe(1_200_000_000);
    expect(r.employees).toBe('1000+'); // "oltre 1000" band, not "1000"
    expect(r.company_name).toBe('TABELLA SPA');
    expect(r.vat_code).toBe('00159560366');
  });
  it('assigns medium confidence (table revenue, no chart history)', () => {
    expect(r.confidence).toBe(0.75);
    expect(r.history).toHaveLength(0);
  });
});

describe('parseFatturatoItaliaPage — company without bilancio', () => {
  const r = parseFatturatoItaliaPage(read('fatturato_no_data.html'));

  it('finds the entity but no revenue', () => {
    expect(r.company_name).toBe('BETA SNC');
    expect(r.vat_code).toBe('00159560366');
    expect(r.revenue_amount).toBeUndefined();
    expect(r.revenue).toBeUndefined();
  });
  it('assigns low confidence (entity only, no financials)', () => {
    expect(r.confidence).toBe(0.4);
  });
});

describe('parseFatturatoItaliaPage — guards', () => {
  it('returns an empty, zero-confidence result for empty/nullish html', () => {
    expect(parseFatturatoItaliaPage('')).toMatchObject({ confidence: 0, history: [] });
    expect(parseFatturatoItaliaPage(undefined)).toMatchObject({ confidence: 0, history: [] });
  });
  it('returns zero confidence for an unrelated page', () => {
    const r = parseFatturatoItaliaPage('<html><body><p>pagina non trovata</p></body></html>');
    expect(r.confidence).toBe(0);
    expect(r.revenue_amount).toBeUndefined();
  });
});

describe('GOLDEN regression — most-recent-year selection (the wrong-year bug)', () => {
  // Real chart vars from fatturatoitalia.it/09999990287, OLDEST-FIRST. The bug:
  // history.find(first positive) returned 2020 (€35.550) for every company.
  // Marco's sample-check caught it (dashboard showed €35.550; the 2024 figure
  // is €51.619). This locks the fix: headline revenue = the MOST RECENT year.
  const r = parseFatturatoItaliaPage(read('fatturato_oldest_first.html'));

  it('returns the MOST RECENT year (2024), not the oldest (2020)', () => {
    expect(r.revenue_year).toBe('2024');
    expect(r.revenue_amount).toBe(51_619);
    expect(r.revenue).toBe('€ 51.619');
    // the specific wrong value must never come back
    expect(r.revenue_amount).not.toBe(35_550);
  });

  it('still preserves the full oldest-first history', () => {
    expect(r.history.map((h) => h.year)).toEqual([2020, 2021, 2022, 2023, 2024]);
    expect(r.history[0]).toMatchObject({ year: 2020, fatturato: 35_550 });
    expect(r.history[4]).toMatchObject({ year: 2024, fatturato: 51_619 });
  });
});

describe('GOLDEN regression — employees BANDS (real strings, the 2nd sample-check bug)', () => {
  // fatturatoitalia publishes "N. dipendenti" as a BAND. The old
  // `.replace(/[^\d-]/g,'')` mangled them ("da 10 a 15" → "1015",
  // "da 3 a 5" → "35", "oltre 1000" → "1000"). These are the REAL strings
  // observed on live pages — the guardrail now lives in the real world.
  it('parses ranges/bounds instead of concatenating digits', () => {
    expect(parseDipendenti('da 10 a 15')).toBe('10-15');
    expect(parseDipendenti('da 3 a 5')).toBe('3-5');
    expect(parseDipendenti('da 6 a 9')).toBe('6-9');
    expect(parseDipendenti('oltre 1000')).toBe('1000+');
    expect(parseDipendenti('fino a 5')).toBe('<5');
    expect(parseDipendenti('1')).toBe('1'); // a real single value stays single
    // the specific mangled outputs must never come back
    expect(parseDipendenti('da 10 a 15')).not.toBe('1015');
    expect(parseDipendenti('oltre 1000')).not.toBe('1000');
  });
  it('returns undefined for empty/garbage', () => {
    expect(parseDipendenti('')).toBeUndefined();
    expect(parseDipendenti(undefined)).toBeUndefined();
    expect(parseDipendenti('n/d')).toBeUndefined();
  });
});
