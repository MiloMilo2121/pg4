import fs from 'node:fs';
import readline from 'node:readline';

/**
 * R6.1 — extract the leads that GAINED a website between two enriched
 * JSONL files (baseline → recalibrated). For each, dump:
 *   - input identity (company_name / city / phone / vat_code)
 *   - harvested website + discovery method
 *   - the verify evidence (read from stage_outcomes[*].detail)
 *
 * Usage:
 *   pnpm exec tsx pg4/scripts/extract_gains.ts <baseline.jsonl> <recal.jsonl>
 */

interface Row {
  company_name: string;
  city?: string;
  province?: string;
  phone?: string;
  vat_code?: string;
  email?: string;
  status?: string;
  reason_code?: string;
  official_website?: string;
  website_discovery_method?: string;
  website_confidence?: number;
  stage_outcomes?: Record<string, { stage: string; status: string; detail?: string; reason_code?: string }>;
}

async function readJsonl(path: string): Promise<Row[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(path) });
  const rows: Row[] = [];
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t) as Row); } catch { /* skip */ }
  }
  return rows;
}

async function main() {
  const [basePath, recalPath] = process.argv.slice(2);
  if (!basePath || !recalPath) {
    console.error('usage: extract_gains.ts <baseline.jsonl> <recal.jsonl>');
    process.exit(1);
  }
  const base = await readJsonl(basePath);
  const recal = await readJsonl(recalPath);
  const baseByName = new Map(base.map((r) => [r.company_name, r] as const));

  const gains: Row[] = [];
  for (const r of recal) {
    if (!r.official_website) continue;
    const b = baseByName.get(r.company_name);
    if (b?.official_website) continue; // already had a site
    gains.push(r);
  }

  console.log(`# Gains audit — ${gains.length} new websites`);
  console.log('');
  console.log('| # | company | city | phone | vat | website | method | evidence | confidence |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  let i = 1;
  for (const g of gains) {
    const pgDetail = g.stage_outcomes?.pg_detail?.detail ?? '';
    const ev = pgDetail.replace(/\s+/g, ' ').replace(/\|/g, '/');
    console.log(
      `| ${i++} | ${esc(g.company_name)} | ${esc(g.city)} | ${esc(g.phone)} | ${esc(g.vat_code)} | ${esc(g.official_website)} | ${esc(g.website_discovery_method)} | ${ev} | ${g.website_confidence ?? ''} |`,
    );
  }
}

function esc(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return '';
  return String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
