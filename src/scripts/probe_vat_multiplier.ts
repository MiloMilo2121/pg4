/**
 * B.2 probe — the VAT-as-master-key MULTIPLIER, measured against the source.
 *
 * One VAT key unlocks revenue + employees from fatturatoitalia.it for FREE. This
 * quantifies the multiplier AND classifies every lookup honestly, because a bare
 * "no value" conflates three very different things:
 *   - BLOCKED  : status-0 / empty body (rate-limited — a measurement artifact)
 *   - NO_DATA  : page exists but has no chart (ditta individuale / no bilancio filed)
 *   - HAS_DATA : revenue/employees parsed
 * The honest hit-rate is HAS_DATA / (HAS_DATA + NO_DATA) — i.e. among REACHABLE
 * pages, ignoring blocks. Spacing is ~4s (MEASURED reliable) to avoid blocks. €0.
 *
 *   pnpm exec tsx src/scripts/probe_vat_multiplier.ts --n 30 [--step 18]
 *   → docs/precision_evidence/probe_vat_multiplier_output.json
 */
import fs from 'fs';
import path from 'path';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { parseFatturatoItaliaPage } from '../enrichment/financial/fatturato_italia_parser';
import { normalizeVatCode, validateItalianVatChecksum } from '../enrichment/financial/vat';

const SEED = 'output/r12_maps_pd_province_full_enriched_free.jsonl';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

async function main(): Promise<void> {
  const n = arg('--n', 30);
  const step = arg('--step', 18);
  const fetcher = new DirectFetchProvider();
  const rows = fs
    .readFileSync(SEED, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s))
    .filter((r) => {
      const v = normalizeVatCode(r.vat_code);
      return /^\d{11}$/.test(v) && validateItalianVatChecksum(v);
    });

  let probed = 0;
  let blocked = 0;
  let noData = 0;
  let hasRevenue = 0;
  let hasEmployees = 0;
  const samples: Array<{ company: string; vat: string; klass: string; revenue?: string; employees?: string }> = [];

  for (let i = 0; i < rows.length && probed < n; i += step) {
    const r = rows[i];
    const vat = normalizeVatCode(r.vat_code);
    let html = '';
    try {
      html = (await fetcher.fetch(`https://www.fatturatoitalia.it/${vat}`, { timeoutMs: 15000 })).html ?? '';
    } catch {
      /* status 0 */
    }
    probed += 1;
    let klass: string;
    if (html.length < 50_000) {
      blocked += 1;
      klass = 'BLOCKED';
    } else {
      const p = parseFatturatoItaliaPage(html);
      if (p.confidence >= 0.5 && p.revenue !== undefined) {
        hasRevenue += 1;
        if (p.employees !== undefined && p.employees !== '') hasEmployees += 1;
        klass = 'HAS_DATA';
      } else {
        noData += 1;
        klass = 'NO_DATA';
      }
      if (samples.length < 15) samples.push({ company: String(r.company_name ?? '').slice(0, 32), vat, klass, revenue: p.revenue, employees: p.employees as string });
    }
    await sleep(4000); // MEASURED reliable spacing (2.5s still blocked)
  }

  const reachable = probed - blocked;
  const pct = (x: number, d: number): string => (d ? `${((100 * x) / d).toFixed(1)}%` : 'n/a');
  const out = {
    vat_keys_probed: probed,
    reachability: { blocked, reachable, blocked_pct: pct(blocked, probed) },
    among_reachable: {
      has_revenue: { count: hasRevenue, pct: pct(hasRevenue, reachable) },
      has_employees: { count: hasEmployees, pct: pct(hasEmployees, reachable) },
      no_data: { count: noData, pct: pct(noData, reachable) },
    },
    multiplier_note: `1 reachable VAT key → ${pct(hasRevenue, reachable)} revenue + ${pct(hasEmployees, reachable)} employees, free. NO_DATA = ditta individuale / no bilancio filed.`,
    spacing: '~4s/req (rate-limited; bulk free scraping is reliable only when throttled)',
    samples,
  };
  const dest = path.resolve('docs/precision_evidence/probe_vat_multiplier_output.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error(`\nwrote ${dest}`);
}

void main();
