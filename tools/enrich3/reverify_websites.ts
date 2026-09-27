import { parseArgs, optString } from '../../src/cli/_args';
import { InputWebsiteStage } from '../../src/enrichment/stages/input_website_stage';
import { normalizeLead } from '../../src/discovery/input_normalizer';
import { createPerLeadContext } from '../../src/runtime/run_context';
import { loadState, saveState, buildE3Run, closeLedger, runIfMain } from './_shared';
import { pool } from '../../src/runtime/pool';
import { has } from '../../src/util/values';

/**
 * ENRICH-3 R1c — FREE re-verify of declared-but-unverified websites (portal
 * join fills `website`; this pass promotes it to `official_website` through
 * the EXISTING gate: PreVerifyGate piva/phone/semantic+RDAP, plus the
 * flag-gated domain-name-match recovery). Run with:
 *
 *   INPUT_WEBSITE_NAME_MATCH_ENABLED=1 pnpm tsx tools/enrich3/reverify_websites.ts \
 *     --state output/enrich3/state1.jsonl --out output/enrich3/state2
 *
 * €0: paid gate off, direct_fetch only.
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state1.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state2';
  const limit = Number(optString(args, 'limit') ?? '0');

  const leads = await loadState(statePath);
  let subset = leads.filter((l) => has(l.website) && !has(l.official_website) && String(l.permanently_closed) !== 'true');
  if (limit > 0) subset = subset.slice(0, limit);

  const { run, router } = buildE3Run({ ledgerPath: 'output/enrich3/reverify/ledger.jsonl', paidEnabled: false });
  const stage = new InputWebsiteStage(router);

  let promoted = 0;
  let byNameMatch = 0;
  let failed = 0;
  await pool(subset, 6, async (lead) => {
    const ctx = createPerLeadContext(run);
    try {
      const outcome = await stage.run(ctx, lead, normalizeLead(lead));
      if (outcome.status === 'success' && has(lead.official_website)) {
        promoted += 1;
        if ((outcome.detail ?? '').startsWith('domain_name_match')) byNameMatch += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  });

  const total = closeLedger(run, 'reverify_websites');
  await saveState(leads, out);
  console.log(
    `reverify_websites: ${subset.length} candidati → promossi ${promoted} (di cui name-match ${byNameMatch}), respinti ${failed}; ledger €${total.toFixed(4)} (atteso 0)`,
  );
}

runIfMain('reverify_websites.ts', main);
