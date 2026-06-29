/**
 * Phase 3 (official-data) — measurement probe. READ-ONLY, FREE.
 *
 * Measures the full moat pipeline on real seed companies that have a website:
 *   site → free-gold VAT (footer) → fatturatoitalia.it by VAT → revenue/employees.
 * Reports, honestly, how often each link resolves. The numbers that justify the
 * moat — reported exactly as produced.
 *
 * Usage: pnpm exec tsx src/scripts/probe_official_data.ts [--input <jsonl>] [--n 60]
 */
import fs from 'fs';
import path from 'path';
import { parseArgs, optString } from '../cli/_args';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { extractFromBody } from '../enrichment/extract/extract_from_body';
import { fetchFatturatoItalia } from '../enrichment/financial/fatturato_italia_fetch';

interface Row { official_website?: string; vat_code?: string }

async function main(): Promise<void> {
  const args = parseArgs();
  const input = optString(args, 'input') ?? 'output/r12_maps_pd_province_full_enriched_free.jsonl';
  const n = Number(optString(args, 'n') ?? '60');
  if (!fs.existsSync(path.resolve(input))) {
    process.stderr.write(`[probe] input not found: ${input}\n`);
    process.exit(2);
  }
  const rows: Row[] = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row)
    .filter((r) => r.official_website && /^https?:\/\//.test(r.official_website));
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = rows.filter((_r, i) => i % step === 0).slice(0, n);

  const fetcher = new DirectFetchProvider();
  let sitesFetched = 0, withVat = 0, fatturatoHit = 0, withRevenue = 0, withEmployees = 0;
  process.stderr.write(`[probe] ${sample.length} sites (of ${rows.length} with website) from ${input}\n`);

  for (const r of sample) {
    let html: string | undefined;
    try { html = (await fetcher.fetch(r.official_website!, { timeoutMs: 8000 })).html; } catch { /* skip */ }
    if (!html) continue;
    sitesFetched += 1;
    const vat = extractFromBody(html, { official_website: r.official_website }).vat_candidates[0] ?? r.vat_code;
    if (!vat) continue;
    withVat += 1;
    const fi = await fetchFatturatoItalia(vat);
    if (fi) fatturatoHit += 1;
    if (fi?.revenue) withRevenue += 1;
    if (fi?.employees) withEmployees += 1;
  }

  const pc = (x: number, d: number): string => (d > 0 ? `${((100 * x) / d).toFixed(1)}%` : 'n/a');
  process.stdout.write(JSON.stringify({
    input, sampled: sample.length, sites_fetched: sitesFetched,
    vat_from_site: `${withVat} (${pc(withVat, sitesFetched)} of fetched)`,
    fatturatoitalia_page: `${fatturatoHit} (${pc(fatturatoHit, withVat)} of VAT)`,
    revenue: `${withRevenue} (${pc(withRevenue, withVat)} of VAT, ${pc(withRevenue, sitesFetched)} of fetched)`,
    employees: `${withEmployees} (${pc(withEmployees, withVat)} of VAT)`,
    cost_eur: 0,
  }, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(`[probe] ${(e as Error).message}\n`); process.exit(1); });
