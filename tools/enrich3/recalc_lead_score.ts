import { parseArgs, optString } from '../../src/cli/_args';
import { computeLeadScore } from '../../src/enrichment/lead_score';
import { loadState, saveState, runIfMain } from './_shared';

/**
 * ENRICH-3 R7 — recompute `lead_score` for every lead in the state (the
 * batch twin of the pipeline-finalize hook) and print the distribution: a
 * degenerate one (p10 == p90) means an upstream pass didn't land.
 *
 *   pnpm tsx tools/enrich3/recalc_lead_score.ts \
 *     --state output/enrich3/state7.jsonl --out output/enrich3/state8
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state7.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state8';

  const leads = await loadState(statePath);
  const scores: number[] = [];
  for (const lead of leads) {
    lead.lead_score = computeLeadScore(lead);
    scores.push(lead.lead_score);
  }
  scores.sort((a, b) => a - b);
  const q = (p: number): number => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))] ?? 0;
  const buckets = new Array(10).fill(0);
  for (const s of scores) buckets[Math.min(9, Math.floor(s * 10))] += 1;

  await saveState(leads, out);
  console.log(`recalc_lead_score: ${leads.length} lead · p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}`);
  console.log(`istogramma (0.0-1.0 per decile): ${buckets.join(' ')}`);
  if (q(0.1) === q(0.9)) {
    console.warn('ATTENZIONE: distribuzione degenere (p10 == p90) — verifica che i pass a monte abbiano riempito i campi.');
  }
}

runIfMain('recalc_lead_score.ts', main);
