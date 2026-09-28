import fs from 'fs';
import { parseArgs, reqString, optString, hasHelp, reportFatal } from './_args';
import { readCsvAsLeads } from '../io/csv_reader';
import type { Lead } from '../types/lead';
import { logger } from '../runtime/logger';

/**
 * `pnpm run benchmark -- --input <enriched.csv|.jsonl> [--out report.md]`
 *
 * The MEASURED fill-rate report — the honest "did the engine turn {category,geo}
 * into a rich record?" proof. Computes per-field fill-rate + the discovery-method
 * / financial-source breakdown + total cost over a real enriched output.
 *
 * Honesty policy (README): we report FILL-RATE (a measured fact), never accuracy
 * inferred from a found-count.
 */

const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'phone', label: 'phone' },
  { key: 'official_website', label: 'website' },
  { key: 'email_inferred', label: 'email' },
  { key: 'pec', label: 'pec' },
  { key: 'vat_code_final', label: 'vat' },
  { key: 'revenue', label: 'revenue' },
  { key: 'employees', label: 'employees' },
  { key: 'instagram', label: 'instagram' },
  { key: 'facebook', label: 'facebook' },
  { key: 'linkedin', label: 'linkedin' },
  { key: 'tiktok', label: 'tiktok' },
  { key: 'youtube', label: 'youtube' },
  { key: 'rating', label: 'rating' },
  { key: 'reviews_count', label: 'reviews_count' },
  { key: 'founding_year', label: 'founding_year' },
  { key: 'decision_maker_name', label: 'decision_maker' },
];

function filled(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

async function loadLeads(input: string): Promise<Lead[]> {
  if (!fs.existsSync(input)) throw new Error(`input not found: ${input}`);
  if (input.endsWith('.jsonl')) {
    const out: Lead[] = [];
    for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as Lead);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }
  const out: Lead[] = [];
  for await (const r of readCsvAsLeads(input)) if (!r.ingestError) out.push(r.lead);
  return out;
}

function tally(leads: Lead[], key: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of leads) {
    const v = (l as Record<string, unknown>)[key];
    if (filled(v)) m[String(v)] = (m[String(v)] ?? 0) + 1;
  }
  return m;
}

async function main() {
  const args = parseArgs();
  if (hasHelp(args)) {
    printUsage();
    return;
  }
  const input = reqString(args, 'input');
  const outMd = optString(args, 'out');
  const leads = await loadLeads(input);
  const n = leads.length;
  if (n === 0) {
    logger.warn({ input }, '[benchmark] no leads in input');
    return;
  }

  const fillRows = FIELDS.map((f) => {
    const count = leads.filter((l) => filled((l as Record<string, unknown>)[f.key])).length;
    return { label: f.label, count, pct: Math.round((1000 * count) / n) / 10 };
  });
  const methods = tally(leads, 'website_discovery_method');
  const finSources = tally(leads, 'financial_source');
  const emailTypes = tally(leads, 'email_type');
  const totalCost = leads.reduce((s, l) => s + (Number((l as Record<string, unknown>).cost_eur) || 0), 0);

  // ---- stdout report ----
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: string[] = [];
  lines.push(`pg4 fill-rate benchmark — ${input}`);
  lines.push(`leads: ${n}    total cost: €${totalCost.toFixed(4)}`);
  lines.push('');
  lines.push(`${pad('field', 16)} ${pad('filled', 8)} pct`);
  lines.push('-'.repeat(34));
  for (const r of fillRows) lines.push(`${pad(r.label, 16)} ${pad(String(r.count), 8)} ${r.pct}%`);
  lines.push('');
  lines.push(`website methods: ${JSON.stringify(methods)}`);
  lines.push(`financial sources: ${JSON.stringify(finSources)}`);
  lines.push(`email types: ${JSON.stringify(emailTypes)}`);
  process.stdout.write(lines.join('\n') + '\n');

  // ---- optional markdown ----
  if (outMd) {
    const md: string[] = [];
    md.push(`# pg4 fill-rate benchmark`);
    md.push('');
    md.push(`- Input: \`${input}\``);
    md.push(`- Leads: **${n}**`);
    md.push(`- Total cost: **€${totalCost.toFixed(4)}**`);
    md.push('');
    md.push(`| field | filled | fill-rate |`);
    md.push(`|---|---:|---:|`);
    for (const r of fillRows) md.push(`| ${r.label} | ${r.count} | ${r.pct}% |`);
    md.push('');
    md.push(`**Website discovery methods:** ${JSON.stringify(methods)}`);
    md.push('');
    md.push(`**Financial sources:** ${JSON.stringify(finSources)}`);
    md.push('');
    md.push(`**Email types:** ${JSON.stringify(emailTypes)}`);
    md.push('');
    md.push(`> Fill-rate is a MEASURED fact. Accuracy is NOT inferred from found-counts (README policy).`);
    fs.writeFileSync(outMd, md.join('\n') + '\n');
    logger.info({ out: outMd }, '[benchmark] markdown report written');
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run benchmark -- --input <enriched.csv|.jsonl> [--out report.md]

Computes the MEASURED per-field fill-rate over a real enriched output, plus the
website-discovery-method / financial-source / email-type breakdown and total cost.

Flags:
  --input <path>   Required. An enriched CSV or JSONL produced by \`enrich\`/\`run\`.
  --out <path>     Optional. Also write a markdown report to this path.
`);
}

main().catch((err) => {
  reportFatal('benchmark', err);
  process.exit(1);
});
