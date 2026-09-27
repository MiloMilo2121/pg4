import { parseArgs, optString } from '../../src/cli/_args';
import { loadState, saveState, runIfMain } from './_shared';

/**
 * ENRICH-3 R0 — seed the state chain from the frozen v2 list (read-only,
 * never copied writable). Assigns a stable `_e3_id` (row index) that lives
 * only in the JSONL chain, for join reporting and row-parity checks.
 *
 *   pnpm tsx tools/enrich3/init_state.ts \
 *     --input ~/pg4-deliverables/veneto_immobiliari_v2_2026-07-20.csv \
 *     --out output/enrich3/state0
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const input = optString(args, 'input') ?? `${process.env.HOME}/pg4-deliverables/veneto_immobiliari_v2_2026-07-20.csv`;
  const out = optString(args, 'out') ?? 'output/enrich3/state0';

  const leads = await loadState(input);
  leads.forEach((lead, i) => {
    lead._e3_id = String(i + 1);
  });
  const { jsonl } = await saveState(leads, out);
  console.log(`init_state: ${leads.length} leads → ${jsonl}`);
}

runIfMain('init_state.ts', main);
