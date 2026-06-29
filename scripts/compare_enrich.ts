import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Compare two enriched JSONL outputs (same input CSV, different
 * enrichment configs). Produces:
 *   - per-status counts for both runs
 *   - per-reason_code counts for both runs
 *   - found_website count + delta
 *   - per-discovery_method counts
 *   - cost totals + delta
 *   - per-lead diff: leads that GAINED a website + leads that LOST one
 *
 * Run:
 *   pnpm exec tsx pg4/scripts/compare_enrich.ts \
 *     <baseline.jsonl> <recalibrated.jsonl>
 *
 * Both inputs must have one JSON object per line with at least
 * `company_name`, `status`, `reason_code`, `official_website`,
 * `cost_eur`, and `website_discovery_method`.
 *
 * NOTE — pg4 emits one CSV row + one JSONL row per input lead, so
 * we expect identical row counts between the two outputs (matched
 * by `company_name`). When counts diverge we still emit both
 * tables but call out the asymmetry up front.
 */

interface Row {
  company_name: string;
  status?: string;
  reason_code?: string;
  official_website?: string;
  website_discovery_method?: string;
  cost_eur?: number;
}

async function readJsonl(path: string): Promise<Row[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(path) });
  const rows: Row[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as Row);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

function tally<T>(rows: Row[], key: (r: Row) => T | undefined): Map<T, number> {
  const m = new Map<T, number>();
  for (const r of rows) {
    const k = key(r);
    if (k === undefined) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function printTable(
  label: string,
  baseline: Map<unknown, number>,
  recal: Map<unknown, number>,
): void {
  console.log(`\n## ${label}`);
  const keys = new Set<unknown>([...baseline.keys(), ...recal.keys()]);
  const sorted = Array.from(keys).sort((a, b) => String(a).localeCompare(String(b)));
  console.log('| key | baseline | recalibrated | Δ |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const k of sorted) {
    const b = baseline.get(k) ?? 0;
    const r = recal.get(k) ?? 0;
    const delta = r - b;
    const sign = delta > 0 ? '+' : '';
    console.log(`| ${String(k)} | ${b} | ${r} | ${sign}${delta} |`);
  }
}

async function main() {
  const [baselinePath, recalPath] = process.argv.slice(2);
  if (!baselinePath || !recalPath) {
    console.error('usage: compare_enrich.ts <baseline.jsonl> <recalibrated.jsonl>');
    process.exit(1);
  }

  const baseline = await readJsonl(baselinePath);
  const recal = await readJsonl(recalPath);

  console.log(`# Enrichment comparison`);
  console.log(`- baseline:     ${baselinePath} (${baseline.length} rows)`);
  console.log(`- recalibrated: ${recalPath} (${recal.length} rows)`);
  if (baseline.length !== recal.length) {
    console.log(`\n> WARNING: row count mismatch — comparisons by company_name only.`);
  }

  // ---- summary numbers ---------------------------------------------------
  const baselineFound = baseline.filter((r) => !!r.official_website).length;
  const recalFound = recal.filter((r) => !!r.official_website).length;
  const baselineCost = baseline.reduce((acc, r) => acc + (r.cost_eur ?? 0), 0);
  const recalCost = recal.reduce((acc, r) => acc + (r.cost_eur ?? 0), 0);

  console.log(`\n## Headline`);
  console.log(`| metric | baseline | recalibrated | Δ |`);
  console.log(`| --- | ---: | ---: | ---: |`);
  console.log(`| total rows | ${baseline.length} | ${recal.length} | ${recal.length - baseline.length} |`);
  console.log(`| found_website | ${baselineFound} | ${recalFound} | ${recalFound - baselineFound} |`);
  console.log(`| cost_eur (sum) | ${baselineCost.toFixed(4)} | ${recalCost.toFixed(4)} | ${(recalCost - baselineCost).toFixed(4)} |`);

  // ---- distributions -----------------------------------------------------
  printTable(
    'status',
    tally(baseline, (r) => r.status ?? '<unset>'),
    tally(recal, (r) => r.status ?? '<unset>'),
  );
  printTable(
    'reason_code',
    tally(baseline, (r) => r.reason_code ?? '<unset>'),
    tally(recal, (r) => r.reason_code ?? '<unset>'),
  );
  printTable(
    'website_discovery_method',
    tally(baseline.filter((r) => !!r.official_website), (r) => r.website_discovery_method ?? '<unset>'),
    tally(recal.filter((r) => !!r.official_website), (r) => r.website_discovery_method ?? '<unset>'),
  );

  // ---- per-lead diff -----------------------------------------------------
  const baselineByName = new Map(baseline.map((r) => [r.company_name, r] as const));
  const recalByName = new Map(recal.map((r) => [r.company_name, r] as const));

  const gained: { name: string; site: string; method?: string }[] = [];
  const lost: { name: string; site: string }[] = [];

  for (const [name, r] of recalByName) {
    const b = baselineByName.get(name);
    const recalSite = r.official_website;
    const baseSite = b?.official_website;
    if (recalSite && !baseSite) gained.push({ name, site: recalSite, method: r.website_discovery_method });
    else if (!recalSite && baseSite) lost.push({ name, site: baseSite });
  }

  console.log(`\n## Per-lead website delta`);
  console.log(`- gained: ${gained.length}`);
  console.log(`- lost:   ${lost.length}`);

  if (gained.length > 0) {
    console.log(`\n### Gained (top 30)`);
    for (const g of gained.slice(0, 30)) {
      console.log(`- ${g.name} → ${g.site} (${g.method ?? '-'})`);
    }
    if (gained.length > 30) console.log(`- … and ${gained.length - 30} more`);
  }
  if (lost.length > 0) {
    console.log(`\n### Lost (top 30)`);
    for (const l of lost.slice(0, 30)) {
      console.log(`- ${l.name} → was ${l.site}`);
    }
    if (lost.length > 30) console.log(`- … and ${lost.length - 30} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
