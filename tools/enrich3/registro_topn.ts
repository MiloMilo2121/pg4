import { parseArgs, optString } from '../../src/cli/_args';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { isWrongEntity } from '../../src/enrichment/fields/field_registry';
import { validateItalianVatChecksum } from '../../src/enrichment/financial/vat';
import { rankByLeadScore } from '../../src/enrichment/lead_score';
import { loadState, saveState, buildE3Run, fillOnlyEmpty, closeLedger, runIfMain } from './_shared';
import { pool } from '../../src/runtime/pool';
import { has } from '../../src/util/values';

/**
 * ENRICH-3 R6 — decision-maker (amministratore/titolare) for the TOP-N leads
 * by lead_score, via the regdata registro actor (the ONLY source for the DM
 * name; known flaky ~42% → expected ~N×0.58 fills, one transient retry).
 * Bonus fills (fill-only-empty): net_profit / rea / legal_form when returned.
 *
 *   APIFY_ENABLED=true APIFY_REGISTRO_ENABLED=true pnpm tsx tools/enrich3/registro_topn.ts \
 *     --state output/enrich3/state6.jsonl --out output/enrich3/state7 --top 300 --run-cost-ceiling-eur 6
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state6.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state7';
  const top = Number(optString(args, 'top') ?? '300');
  if (!Number.isInteger(top) || top <= 0) throw new Error('--top must be a positive integer (paid pass: never "all" by accident)');
  const probe = args.flags.probe === true;
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? (probe ? '0.2' : ''));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  const leads = await loadState(statePath);
  let subset = leads.filter((l) => {
    const vat = String(l.vat_code_final ?? '').replace(/\D/g, '');
    return vat.length === 11 && validateItalianVatChecksum(vat) && !has(l.decision_maker_name);
  });
  subset = rankByLeadScore(subset, probe ? 3 : top);

  const provider = new ApifyProvider();
  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/registro/ledger.jsonl',
    paidEnabled: true,
    perLeadCapEur: 0.04, // one call + one retry
    runCostCeilingEur: ceiling,
  });

  const counts: Record<string, number> = {};
  await pool(subset, probe ? 1 : 2, async (lead) => {
    const vat = String(lead.vat_code_final).replace(/\D/g, '');
    const meta = provider.meta('registro');
    let attempts = 0;
    let rec: Awaited<ReturnType<typeof provider.registroLookup>> | null = null;
    while (attempts < 2 && !rec) {
      attempts += 1;
      rec = await router.invoke(
        meta,
        async () => {
          const r = await provider.registroLookup(vat, { timeoutMs: 120_000 });
          return r ? { ok: true, value: r } : null;
        },
        {
          paidEnabled: true,
          remainingLeadBudgetEur: Math.max(0, 0.04 - run.ledger.costForLead(String(lead._e3_id ?? vat))),
          runCostCeilingEur: ceiling,
          meta: { lead_id: String(lead._e3_id ?? vat), stage: 'e3_registro_topn', attempt: attempts },
        },
      );
    }
    if (!rec) {
      counts.not_found = (counts.not_found ?? 0) + 1;
      return;
    }
    if (rec.name && isWrongEntity(rec.name, lead.company_name)) {
      counts.entity_mismatch = (counts.entity_mismatch ?? 0) + 1;
      return;
    }
    const filled = fillOnlyEmpty(lead, {
      decision_maker_name: rec.decision_maker_name,
      decision_maker_role: rec.decision_maker_role,
      net_profit: rec.net_profit,
      net_profit_year: rec.net_profit_year,
      rea: rec.rea,
      legal_form: rec.legal_form,
      employees: rec.employees,
      share_capital: rec.share_capital,
      pec: rec.pec,
    });
    counts[filled.includes('decision_maker_name') ? 'dm_filled' : 'no_dm_in_record'] =
      (counts[filled.includes('decision_maker_name') ? 'dm_filled' : 'no_dm_in_record'] ?? 0) + 1;
    if (probe) {
      console.log(`\n===== PROBE registro vat=${vat} =====`);
      console.log(JSON.stringify(rec, null, 2).slice(0, 1500));
    }
  });

  const total = closeLedger(run, 'registro_topn');
  if (probe) {
    console.log(`PROBE: ${JSON.stringify(counts)} · ledger €${total.toFixed(3)}. Stato NON salvato.`);
    return;
  }
  await saveState(leads, out);
  console.log(`registro_topn: subset ${subset.length} → ${JSON.stringify(counts)} · ledger €${total.toFixed(2)} (cap €${ceiling})`);
}

runIfMain('registro_topn.ts', main);
