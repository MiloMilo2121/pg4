import { parseArgs, optString } from '../../cli/_args';
import { ApifyBilanciStage } from '../../enrichment/stages/apify_bilanci_stage';
import { normalizeLead } from '../../discovery/input_normalizer';
import { createPerLeadContext } from '../../runtime/run_context';
import { validateItalianVatChecksum } from '../../enrichment/financial/vat';
import { rankByLeadScore } from '../../enrichment/lead_score';
import { loadState, saveState, buildE3Run, pool, has, closeLedger, runIfMain } from './_shared';

/**
 * ENRICH-3 R5 — balance-sheet firmographics (real fatturato + PEC +
 * dipendenti + capitale) for the VAT-holders, via the EXISTING
 * ApifyBilanciStage (invoke + VAT/entity guards + fill-only-empty).
 *
 * `--top N` degrades the pass to the N best leads by lead_score when the
 * cumulated budget calls for it (the plan's valve: top-4k if ledger > €65).
 *
 *   # probe 5 VAT (validates the actor's input/output shapes):
 *   APIFY_ENABLED=true APIFY_BILANCI_ENABLED=true pnpm tsx src/scripts/enrich3/bilanci.ts \
 *     --state output/enrich3/state5.jsonl --probe
 *   # full (~5.8k):
 *   ... pnpm tsx src/scripts/enrich3/bilanci.ts --state output/enrich3/state5.jsonl \
 *     --out output/enrich3/state6 --run-cost-ceiling-eur 48 [--top 4000]
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state5.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state6';
  const probe = args.flags.probe === true;
  const top = Number(optString(args, 'top') ?? '0');
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? (probe ? '0.2' : ''));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  const leads = await loadState(statePath);
  let subset = leads.filter((l) => {
    const vat = String(l.vat_code_final ?? '').replace(/\D/g, '');
    if (vat.length !== 11 || !validateItalianVatChecksum(vat)) return false;
    return !(has(l.revenue) && has(l.employees) && has(l.pec));
  });
  if (top > 0) {
    subset = rankByLeadScore(subset, top);
  }
  if (probe) subset = subset.slice(0, 5);

  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/bilanci/ledger.jsonl',
    paidEnabled: true,
    perLeadCapEur: 0.02,
    runCostCeilingEur: ceiling,
  });
  const stage = new ApifyBilanciStage(router);

  const counts: Record<string, number> = {};
  let processed = 0;
  await pool(subset, probe ? 1 : 3, async (lead) => {
    const ctx = createPerLeadContext(run);
    try {
      const outcome = await stage.run(ctx, lead, normalizeLead(lead));
      const key = (outcome.detail ?? '').startsWith('bilanci_entity_mismatch') || (outcome.detail ?? '').startsWith('bilanci_vat_mismatch') ? 'entity_mismatch' : outcome.status;
      counts[key] = (counts[key] ?? 0) + 1;
      if (probe) {
        console.log(`\n===== PROBE bilanci vat=${lead.vat_code_final} → ${outcome.status} (${outcome.detail}) =====`);
        console.log(JSON.stringify({ revenue: lead.revenue, revenue_year: lead.revenue_year, employees: lead.employees, pec: lead.pec, share_capital: lead.share_capital, legal_form: lead.legal_form }, null, 2));
      }
    } catch (err) {
      counts.error = (counts.error ?? 0) + 1;
      if (probe) console.log(`PROBE bilanci error: ${(err as Error).message}`);
    }
    processed += 1;
    if (!probe && processed % 500 === 0) {
      console.log(`bilanci: ${processed}/${subset.length} · ledger €${run.ledger.getTotal().toFixed(2)}`);
    }
  });

  const total = closeLedger(run, 'bilanci');
  if (probe) {
    console.log(`PROBE: outcomes ${JSON.stringify(counts)} · ledger €${total.toFixed(3)}. Stato NON salvato.`);
    return;
  }
  await saveState(leads, out);
  const withRevenue = leads.filter((l) => has(l.revenue)).length;
  console.log(
    `bilanci: subset ${subset.length} → ${JSON.stringify(counts)} · revenue ora su ${withRevenue}/${leads.length} · ledger €${total.toFixed(2)} (cap €${ceiling})`,
  );
}

runIfMain('bilanci.ts', main);
