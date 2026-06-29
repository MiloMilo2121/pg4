import fs from 'fs';
import path from 'path';
import { parseArgs, reqString, optString, hasHelp } from './_args';
import { readCsvAsLeads } from '../io/csv_reader';
import type { Lead } from '../types/lead';
import { runJudgment } from '../judgment/run_judgment';
import { getActiveJudgmentConfig } from '../judgment/config';
import { computeCategoryProfile } from '../judgment/benchmark';
import { liveFreeHarvestContext, buildJudgeLLM } from '../judgment/runtime_context';
import { InMemoryEnrichmentCache } from '../persistence/enrichment_cache';
import { emptyBundle } from '../judgment/harvest/source_harvest';
import type { JudgmentRecord } from '../types/judgment';

/**
 * `pnpm run judge -- --input output/list.csv --out output/judged.jsonl [--two-pass] [--paid] [--limit N]`
 *
 * Runs the full L2→L5 judgment over a CSV of companies and writes one JSONL line
 * per company (verdict + axis scores + levers + validation + meta). Free-first:
 * website + free SERP at €0; `--paid` enables the LLM judges + paid sources (if
 * keys are set). `--two-pass` (§17) computes the category benchmark from pass-1
 * signals, then re-judges relative to it.
 *
 * NOTE: live network (website fetch + Bing). Verdicts are CANDIDATES to validate
 * against a golden set — not ground truth. The thesis (A-high/B-low recognition)
 * is only validated once a strong A source is ON and the golden set agrees.
 */
function flag(args: ReturnType<typeof parseArgs>, key: string): boolean {
  return args.flags[key] === true;
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    process.stdout.write('usage: pnpm run judge -- --input <csv> --out <jsonl> [--two-pass] [--paid] [--limit N] [--category X]\n');
    return 0;
  }
  const input = reqString(args, 'input', 'path to a CSV of companies');
  const out = reqString(args, 'out', 'path to the JSONL output');
  const paid = flag(args, 'paid');
  const twoPass = flag(args, 'two-pass');
  const limit = Number(optString(args, 'limit') ?? '0') || 0;

  const config = getActiveJudgmentConfig();
  const { llm, modelId } = buildJudgeLLM(paid);
  const cache = new InMemoryEnrichmentCache(); // shared across companies + passes (cost-first)
  const ctx = liveFreeHarvestContext({ tenantId: 'cli', cache, paidEnabled: paid });

  const leads: Lead[] = [];
  for await (const item of readCsvAsLeads(input)) {
    if (!item.ingestError) leads.push(item.lead);
    if (limit && leads.length >= limit) break;
  }
  process.stderr.write(`[judge] ${leads.length} companies · paid=${paid} · twoPass=${twoPass} · llm=${modelId ?? 'deterministic'}\n`);

  // Pass 1 (always) — judge each company. With two-pass we first compute a
  // category profile from the collected signals, then re-judge relative to it.
  const records: JudgmentRecord[] = [];
  for (let i = 0; i < leads.length; i++) {
    const rec = await runJudgment(leads[i], ctx, { config, llm, modelId }, emptyBundle());
    records.push(rec);
    if ((i + 1) % 10 === 0) process.stderr.write(`[judge] pass1 ${i + 1}/${leads.length}\n`);
  }

  let finalRecords = records;
  if (twoPass && leads.length > 1) {
    const category = optString(args, 'category') ?? (leads[0].category as string | undefined) ?? 'unknown';
    const profile = computeCategoryProfile(records.map((r) => ({ segnali_A: r.segnali_A, segnali_B: r.segnali_B })), category, config, new Date().toISOString());
    process.stderr.write(`[judge] category_profile n=${profile.sampleSize} provisional=${profile.provisional}\n`);
    finalRecords = [];
    for (let i = 0; i < leads.length; i++) {
      const rec = await runJudgment(leads[i], ctx, { config, llm, modelId, categoryProfile: profile }, emptyBundle());
      finalRecords.push(rec);
      if ((i + 1) % 10 === 0) process.stderr.write(`[judge] pass2 ${i + 1}/${leads.length}\n`);
    }
  }

  // write JSONL + a console summary
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const lines = finalRecords.map((r, i) => JSON.stringify(summaryRow(leads[i], r)));
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');

  const counts: Record<string, number> = {};
  const quad: Record<string, number> = {};
  for (const r of finalRecords) {
    const t = r.verdetto_gap?.target ?? 'n/a';
    counts[t] = (counts[t] ?? 0) + 1;
    const q = r.verdetto_gap?.quadrant ?? 'n/a';
    quad[q] = (quad[q] ?? 0) + 1;
  }
  process.stderr.write(`[judge] target: ${JSON.stringify(counts)}\n[judge] quadrant: ${JSON.stringify(quad)}\n[judge] → ${out}\n`);
  return 0;
}

function summaryRow(lead: Lead, r: JudgmentRecord) {
  const v = r.verdetto_gap;
  return {
    company_name: lead.company_name,
    category: lead.category,
    official_website: lead.official_website ?? lead.website,
    target: v?.target,
    quadrant: v?.quadrant,
    scoreA: v?.scoreA,
    scoreB: v?.scoreB,
    gap: v?.gap,
    aLevel: r.valutazione_A?.level,
    bLevel: r.valutazione_B?.level,
    cause: v?.cause,
    disqualifiers: v?.disqualifiers,
    levers: (r.leva ?? []).map((l) => l.kind),
    validationScore: r.validazione?.validationScore,
    consistent: r.validazione?.consistent,
    meta: r.meta,
  };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[judge] fatal: ${(err as Error).message}\n`);
    process.exit(2);
  });
