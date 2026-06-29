import fs from 'fs';
import { parseArgs, reqString, hasHelp } from '../cli/_args';
import type { Lead } from '../types/lead';
import { runJudgment } from '../judgment/run_judgment';
import { getActiveJudgmentConfig } from '../judgment/config';
import { evaluateByCategory, type GoldenItem, type EvalReport } from '../judgment/eval';
import { computeCategoryProfile, type SignalSetItem } from '../judgment/benchmark';
import { liveFreeHarvestContext, buildJudgeLLM } from '../judgment/runtime_context';
import { InMemoryEnrichmentCache } from '../persistence/enrichment_cache';
import { emptyBundle } from '../judgment/harvest/source_harvest';
import type { JudgmentRecord } from '../types/judgment';

/**
 * §15 golden-set eval runner — HETEROGENEOUS, PER-BLOCK (§1.4 + §17).
 * `pnpm run judge:eval -- --golden tests/fixtures/judgment_golden.json [--paid]`
 *
 * The golden file is heterogeneous BY DESIGN: N categories × ~6-8 companies, each
 * block stratified on the 4 quadrants. The runner groups by `categoria` and, for
 * EACH block, runs the §17 TWO-PASS:
 *   pass-1 (deterministic, cheap) harvests + collects the block's signals;
 *   computeCategoryProfile builds the per-block baseline (the metro of THAT model);
 *   pass-2 judges each company AGAINST its block profile (with the LLM if --paid).
 * Metrics are reported PER BLOCK — never pooled into one number (a mean between
 * restaurants and dentists is meaningless). A thin block (< benchmarkMinSample) is
 * flagged provisional. This is what makes the eval test GENERALIZATION across models,
 * and what exercises the per-category benchmark the production judge actually uses.
 *
 * File shape: { "items": [ { "id", "categoria", "lead": {...}, "expectedTarget",
 *   "expectedQuadrant"?, "expectedALevel"?, "expectedBLevel"?, "expectedModel"? } ] }
 * `categoria` is the block label; absent → falls back to lead.category.
 */
interface GoldenFileItem extends GoldenItem {
  lead: Lead;
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    process.stdout.write('usage: pnpm run judge:eval -- --golden <golden.json> [--paid]\n');
    return 0;
  }
  const goldenPath = reqString(args, 'golden', 'path to the golden-set JSON');
  const paid = args.flags.paid === true;

  const raw = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as { items?: GoldenFileItem[] };
  const items = (raw.items ?? []).filter((it) => it.lead && it.id);
  if (items.length === 0) {
    process.stderr.write('[eval] golden set is empty — fill tests/fixtures/judgment_golden.json (see the .example).\n');
    return 1;
  }

  const config = getActiveJudgmentConfig();
  const { llm, modelId } = buildJudgeLLM(paid);
  const cache = new InMemoryEnrichmentCache();
  const ctx = liveFreeHarvestContext({ tenantId: 'eval', cache, paidEnabled: paid });
  const nowIso = new Date(ctx.now()).toISOString();
  const minSample = config.thresholds.benchmarkMinSample;

  // Resolve each item's BLOCK label (explicit categoria, else the firm's category) and
  // group. Heterogeneous between blocks, homogeneous within — the §17 cohort is the block.
  for (const it of items) it.categoria = (it.categoria && it.categoria.trim()) || it.lead.category || 'uncategorized';
  const blocks = new Map<string, GoldenFileItem[]>();
  for (const it of items) {
    const arr = blocks.get(it.categoria!) ?? [];
    arr.push(it);
    blocks.set(it.categoria!, arr);
  }
  process.stderr.write(`[eval] ${items.length} companies in ${blocks.size} block(s) · llm=${modelId ?? 'deterministic'}\n`);

  const predictions = new Map<string, JudgmentRecord>();
  for (const [cat, blockItems] of blocks) {
    process.stderr.write(`\n[eval] block "${cat}" (${blockItems.length})${blockItems.length < minSample ? ` ⚠ thin (< ${minSample}) → benchmark provisional` : ''}\n`);
    // PASS-1 (deterministic, no LLM): harvest + collect the block's signals. The harvest
    // is cached, so pass-2 re-reads it cheaply; the deterministic verdict is discarded —
    // we only need segnali_A/B to build the §17 baseline.
    const signalSet: SignalSetItem[] = [];
    for (const it of blockItems) {
      const rec = await runJudgment(it.lead, ctx, { config }, emptyBundle());
      signalSet.push({ segnali_A: rec.segnali_A, segnali_B: rec.segnali_B });
    }
    const profile = computeCategoryProfile(signalSet, cat, config, nowIso);
    // PASS-2: judge each company AGAINST the block profile (the metro of this model).
    for (let i = 0; i < blockItems.length; i++) {
      const it = blockItems[i];
      const rec = await runJudgment(it.lead, ctx, { config, llm, modelId, categoryProfile: profile }, emptyBundle());
      predictions.set(it.id, rec);
      process.stderr.write(`[eval]   ${i + 1}/${blockItems.length} ${it.id} → target=${rec.verdetto_gap?.target} ${rec.verdetto_gap?.quadrant}\n`);
    }
  }

  const { blocks: reports, categories } = evaluateByCategory(items, predictions);
  process.stdout.write('\n=== GOLDEN-SET REPORT (PER BLOCK — never pooled) ===\n');
  for (const cat of categories) {
    const r: EvalReport = reports[cat];
    const thin = r.n < minSample ? `  ⚠ thin (< ${minSample}, provisional)` : '';
    process.stdout.write(`\n## ${cat}  (n=${r.n})${thin}\n`);
    process.stdout.write(`target  precision=${r.target.precision}  recall=${r.target.recall}  f1=${r.target.f1}  (tp=${r.target.tp} fp=${r.target.fp} fn=${r.target.fn} tn=${r.target.tn})\n`);
    if (r.aAgreement !== undefined) process.stdout.write(`A agreement = ${r.aAgreement}   (which judge errs: A vs B, separately)\n`);
    if (r.bAgreement !== undefined) process.stdout.write(`B agreement = ${r.bAgreement}\n`);
    if (r.modelAgreement !== undefined) process.stdout.write(`business-model agreement = ${r.modelAgreement}\n`);
    process.stdout.write(`quadrant confusion (expected → predicted): ${JSON.stringify(r.quadrantConfusion)}\n`);
  }
  process.stdout.write('\nNO global number by design (§1.4): a mean across blocks mixes incomparable metros.\n');
  process.stdout.write('Reminder: with a strong A source OFF, A reads "unknown" → quadrants land on A?/fuffa and the thesis cannot be validated. Turn ON one A source per vertical first.\n');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    process.stderr.write(`[eval] fatal: ${(err as Error).message}\n`);
    process.exit(2);
  });
