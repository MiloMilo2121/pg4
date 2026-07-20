import { parseArgs, optString } from '../../cli/_args';
import { ApifyMapsStage } from '../../enrichment/stages/apify_maps_stage';
import { normalizeLead } from '../../discovery/input_normalizer';
import { createPerLeadContext } from '../../runtime/run_context';
import { loadState, saveState, buildE3Run, pool, has, closeLedger, runIfMain } from './_shared';

/**
 * ENRICH-3 R2 — Google Places detail via the EXISTING ApifyMapsStage (rating
 * + reviews + website recall + socials), on the subset still missing a
 * rating. A dedicated script (not `pnpm enrich`): the full pipeline would
 * re-run the whole free ladder AND re-arm the paid Serper pass on ~4k
 * SERP_EMPTY leads — hours of wall-clock and unrelated spend.
 *
 * Leads without a verified website come FIRST: if the ceiling cuts the tail,
 * the website-recall value lands before the rating-only value.
 *
 *   APIFY_ENABLED=true APIFY_MAPS_ENABLED=true pnpm tsx src/scripts/enrich3/places.ts \
 *     --state output/enrich3/state2.jsonl --out output/enrich3/state3 \
 *     --per-lead-cap-eur 0.01 --run-cost-ceiling-eur 14 [--limit N]
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state2.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state3';
  const perLeadCap = Number(optString(args, 'per-lead-cap-eur') ?? '0.01');
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? '');
  const limit = Number(optString(args, 'limit') ?? '0');
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  const leads = await loadState(statePath);
  let subset = leads.filter((l) => !has(l.rating) && String(l.permanently_closed) !== 'true');
  subset.sort((a, b) => Number(has(a.official_website)) - Number(has(b.official_website)));
  if (limit > 0) subset = subset.slice(0, limit);

  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/places/ledger.jsonl',
    paidEnabled: true,
    perLeadCapEur: perLeadCap,
    runCostCeilingEur: ceiling,
  });
  const stage = new ApifyMapsStage(router);

  const counts: Record<string, number> = {};
  let processed = 0;
  await pool(subset, 6, async (lead) => {
    const ctx = createPerLeadContext(run);
    try {
      const outcome = await stage.run(ctx, lead, normalizeLead(lead));
      const key = outcome.status === 'not_found' && (outcome.detail ?? '').startsWith('maps_entity_mismatch') ? 'entity_mismatch' : outcome.status;
      counts[key] = (counts[key] ?? 0) + 1;
    } catch {
      counts.error = (counts.error ?? 0) + 1;
    }
    processed += 1;
    if (processed % 500 === 0) {
      console.log(`places: ${processed}/${subset.length} · ledger €${run.ledger.getTotal().toFixed(2)}`);
    }
  });

  const total = closeLedger(run, 'places');
  await saveState(leads, out);
  const filled = leads.filter((l) => has(l.rating)).length;
  console.log(
    `places: subset ${subset.length} → outcomes ${JSON.stringify(counts)}; rating ora su ${filled}/${leads.length}; ledger €${total.toFixed(2)} (cap €${ceiling})`,
  );
}

runIfMain('places.ts', main);
