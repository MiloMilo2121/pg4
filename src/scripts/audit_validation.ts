/**
 * FINAL VALIDATION AUDIT harness — runs the REAL pipeline (the same modules the
 * dev server uses) on an independent sample, captures per-field fill + the
 * evidence for the 6 bug-checks, and samples against the live source. Read/measure
 * only; touches no extraction logic.
 *
 *   pnpm exec tsx src/scripts/audit_validation.ts --label S1 --comuni "Padova" --n 15
 *   → docs/precision_evidence/audit_<label>.json
 *
 * The 6 bugs re-checked on fresh data:
 *  #1 fatturato = max-year (revenue_year == max history year w/ fatturato)
 *  #2 dipendenti = real range, never concatenated digits ("1015")
 *  #3 VAT confidence honest (vies_confirmed→0.95, footer_unconfirmed→0.6, foreign refused)
 *  #4 rate-limit holds: an empty fatturato is a TRUE no-data page, not a silent drop
 *     (re-fetch empties → classify blocked vs no-data by raw page size)
 *  #6 no dead/redundant tier firing (inspect cascade step traces)
 *  prov: source+confidence tag per cell matches reality
 */
import fs from 'fs';
import path from 'path';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { deepExtractFromSite } from '../enrichment/extract/deep_pages';
import { runFieldCascade } from '../enrichment/fields/run_field_cascade';
import { resolveVat } from '../enrichment/fields/field_registry';
import { fetchFatturatoItalia } from '../enrichment/financial/fatturato_italia_fetch';
import { parseFatturatoItaliaPage } from '../enrichment/financial/fatturato_italia_parser';
import type { Lead } from '../types/lead';

const SEED = 'output/r12_maps_pd_province_full_enriched_free.jsonl';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENRICH_FIELDS = ['email', 'instagram', 'facebook', 'linkedin', 'vat', 'pec', 'revenue', 'employees'] as const;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const label = arg('--label', 'S');
  const comuni = arg('--comuni', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const n = Number(arg('--n', '15'));
  const fetcher = new DirectFetchProvider();
  const fetch = async (url: string): Promise<string | undefined> => {
    try { return (await fetcher.fetch(url, { timeoutMs: 8000 })).html; } catch { return undefined; }
  };

  const rows = fs.readFileSync(SEED, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
    .filter((r) => r.official_website)
    .filter((r) => comuni.length === 0 || comuni.includes(String(r.business_city || r.city || r.query_location || '').trim().toLowerCase()));

  const companies: any[] = [];
  for (let i = 0; i < rows.length && companies.length < n; i++) {
    const r = rows[i];
    const lead = { ...r } as Lead;
    const deep = await deepExtractFromSite(String(r.official_website), fetch);
    const extraction = deep.extraction;
    const cells: Record<string, any> = {};
    for (const f of ENRICH_FIELDS) {
      const out = await runFieldCascade({ ...lead }, f as any, { extraction });
      cells[f] = { value: out.resolved ? out.value : undefined, source: out.source, confidence: out.confidence, steps: out.steps.map((s) => ({ id: s.id, ran: s.ran, reason: s.reason })) };
    }
    // bug #1/#2 evidence: the fatturatoitalia parse the pipeline used (memo hit, free)
    const rv = resolveVat({ lead, extraction, paidEnabled: false });
    let fatturato: any = undefined;
    if (rv) {
      const fi = await fetchFatturatoItalia(rv.vat); // memoised from the cascade above
      if (fi) fatturato = { vat: rv.vat, revenue: fi.revenue, revenue_year: fi.revenue_year, employees: fi.employees, history: fi.history, name: fi.company_name };
    }
    companies.push({
      company_name: r.company_name, comune: r.business_city || r.city, website: r.official_website,
      input_vat: r.vat_code, pages_fetched: deep.pagesFetched.length, cells, fatturato,
    });
  }

  // bug #4 check: re-fetch fatturatoitalia RAW for companies with a VAT but NO revenue →
  // classify blocked (silent drop) vs genuine no-data, distinguishing the two.
  let blocked = 0, genuineNoData = 0;
  for (const c of companies) {
    const vat = c.fatturato?.vat ?? (c.input_vat ?? '').replace(/\D/g, '');
    const hasRevenue = !!c.fatturato?.revenue;
    if (hasRevenue || !/^\d{11}$/.test(vat)) continue;
    await sleep(4500); // good-citizen spacing for the raw re-check
    const html = (await fetch(`https://www.fatturatoitalia.it/${vat}`)) ?? '';
    if (html.length < 50_000) { blocked++; c.rate_limit_class = 'BLOCKED(len<50k)'; }
    else { const p = parseFatturatoItaliaPage(html); c.rate_limit_class = p.confidence >= 0.5 && p.revenue ? 'DATA-ON-RECHECK(drop!)' : 'GENUINE-NO-DATA'; if (c.rate_limit_class === 'GENUINE-NO-DATA') genuineNoData++; else blocked++; }
  }

  // ---- aggregate + bug-checks ----
  const fill: Record<string, number> = {};
  for (const f of ENRICH_FIELDS) fill[f] = companies.filter((c) => c.cells[f].value).length;
  const withFatt = companies.filter((c) => c.fatturato?.revenue);
  const bug1 = withFatt.map((c) => {
    const years = (c.fatturato.history || []).filter((h: any) => h.fatturato !== undefined).map((h: any) => h.year);
    const maxY = years.length ? Math.max(...years) : undefined;
    return { co: c.company_name, picked: c.fatturato.revenue_year, maxYear: maxY, ok: String(maxY) === String(c.fatturato.revenue_year) };
  });
  const bug2 = companies.filter((c) => c.cells.employees.value).map((c) => ({ co: c.company_name, emp: c.cells.employees.value, ok: /^(<?\d+|\d+\-\d+|\d+\+|oltre|fino)/i.test(String(c.cells.employees.value)) && !/^\d{4,}$/.test(String(c.cells.employees.value).replace(/[^\d]/g, '')) }));
  const bug3 = companies.filter((c) => c.cells.vat.value || c.cells.vat.source?.includes('foreign')).map((c) => ({ co: c.company_name, src: c.cells.vat.source, conf: c.cells.vat.confidence }));
  const vatConfHonest = bug3.every((b) => (b.src === 'vat:vies_confirmed' && b.conf === 0.95) || (b.src === 'vat:footer_unconfirmed' && b.conf === 0.6) || (b.src?.includes('foreign')));

  const out = {
    label, comuni, sample_size: companies.length,
    fill_rate: Object.fromEntries(ENRICH_FIELDS.map((f) => [f, `${fill[f]}/${companies.length} (${((100 * fill[f]) / companies.length).toFixed(0)}%)`])),
    bug1_maxyear: { checked: bug1.length, pass: bug1.filter((b) => b.ok).length, fails: bug1.filter((b) => !b.ok) },
    bug2_ranges: { checked: bug2.length, pass: bug2.filter((b) => b.ok).length, fails: bug2.filter((b) => !b.ok), samples: bug2.slice(0, 8) },
    bug3_vat_honest: { confidence_all_honest: vatConfHonest, breakdown: bug3 },
    bug4_ratelimit: { rechecked_empties: blocked + genuineNoData, silent_drops: blocked, genuine_no_data: genuineNoData },
    structural_ceiling: { with_fatturato: withFatt.length, no_fatturato_genuine: genuineNoData, note: 'no-fatturato should be ditte individuali / non-filers = honest empties' },
    companies,
  };
  const dest = path.resolve(`docs/precision_evidence/audit_${label}.json`);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`=== AUDIT ${label} (${comuni.join('+')}) n=${companies.length} ===`);
  console.log('fill:', JSON.stringify(out.fill_rate));
  console.log(`bug#1 max-year: ${out.bug1_maxyear.pass}/${out.bug1_maxyear.checked} pass`, out.bug1_maxyear.fails.length ? JSON.stringify(out.bug1_maxyear.fails) : '');
  console.log(`bug#2 ranges:   ${out.bug2_ranges.pass}/${out.bug2_ranges.checked} pass`, out.bug2_ranges.fails.length ? JSON.stringify(out.bug2_ranges.fails) : '');
  console.log(`bug#3 vat honest: ${vatConfHonest}`, JSON.stringify(bug3.slice(0, 6)));
  console.log(`bug#4 ratelimit: silent_drops=${blocked} genuine_no_data=${genuineNoData}`);
  console.log(`ceiling: ${withFatt.length}/${companies.length} have fatturato (rest = non-filers)`);
  console.error(`wrote ${dest}`);
}

void main();
