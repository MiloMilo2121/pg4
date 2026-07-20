import { parseArgs, optString } from '../../cli/_args';
import { deepExtractFromSite, type PageFetcher } from '../../enrichment/extract/deep_pages';
import { applyBodyExtraction } from '../../enrichment/extract/apply_free_gold';
import { isParked, isUnderConstruction } from '../../discovery/website/content_filter';
import { createPerLeadContext } from '../../runtime/run_context';
import { loadState, saveState, buildE3Run, pool, has, closeLedger, runIfMain } from './_shared';
import { DEFAULTS } from '../../config/defaults';

/**
 * ENRICH-3 R4 — mine the "has a site but no email" leads. Two steps per lead:
 *
 *   1. FREE: direct_fetch homepage; dead/parked sites are discarded HERE
 *      (never pay to render a corpse). Then the free deep-pages extraction
 *      (homepage + ≤2 contact pages, €0).
 *   2. RENDER (only if step 1 yielded no email): the same extraction with a
 *      firecrawl-ONLY fetcher (`paidOnly` + `includeProviderIds`) — a JS/SPA
 *      shell that direct_fetch "successfully" fetched empty gets its real DOM.
 *      ≤2 renders/lead (homepage + 1 contact page) ⇒ ≤ €0.0092 < per-lead cap.
 *
 * Same-domain email precision is preserved by extractFromBody itself; the
 * site was already entity-verified when it became official_website.
 *
 *   FIRECRAWL_ENABLED=true pnpm tsx src/scripts/enrich3/firecrawl_pass.ts \
 *     --state output/enrich3/state4.jsonl --out output/enrich3/state5 \
 *     --per-lead-cap-eur 0.01 --run-cost-ceiling-eur 15 [--limit 25]
 */
async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state4.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state5';
  const perLeadCap = Number(optString(args, 'per-lead-cap-eur') ?? '0.01');
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? '');
  const limit = Number(optString(args, 'limit') ?? '0');
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  const leads = await loadState(statePath);
  let subset = leads.filter((l) => has(l.official_website) && !has(l.email_inferred) && String(l.permanently_closed) !== 'true');
  if (limit > 0) subset = subset.slice(0, limit);

  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/firecrawl/ledger.jsonl',
    paidEnabled: true,
    perLeadCapEur: perLeadCap,
    runCostCeilingEur: ceiling,
  });

  const counts = { dead: 0, parked: 0, free_email: 0, rendered: 0, render_email: 0, still_missing: 0 };
  let processed = 0;
  await pool(subset, 4, async (lead) => {
    const site = String(lead.official_website);
    const ctx = createPerLeadContext(run);
    const meta = { lead_id: ctx.leadId, stage: 'e3_firecrawl' };

    // ---- step 1: free homepage + deep pages ----
    const freeFetcher: PageFetcher = async (url) => {
      try {
        const res = await router.fetch(url, { timeoutMs: DEFAULTS.pipeline.requestTimeoutMs, meta });
        return res.status >= 200 && res.status < 400 ? res.html : undefined;
      } catch {
        return undefined;
      }
    };
    let homepage: string | undefined;
    try {
      const res = await router.fetch(site, { timeoutMs: DEFAULTS.pipeline.requestTimeoutMs, meta });
      homepage = res.status >= 200 && res.status < 400 ? res.html : undefined;
    } catch {
      homepage = undefined;
    }
    if (!homepage) {
      counts.dead += 1;
      return; // dead site — never render a corpse
    }
    const lower = homepage.toLowerCase();
    if (isParked(lower) || isUnderConstruction(lower)) {
      counts.parked += 1;
      return;
    }
    try {
      const deep = await deepExtractFromSite(site, freeFetcher, { maxContactPages: 2, homepageHtml: homepage });
      applyBodyExtraction(lead, deep.extraction);
    } catch {
      /* free extraction must never kill the row */
    }
    if (has(lead.email_inferred)) {
      counts.free_email += 1;
      return;
    }

    // ---- step 2: forced render, firecrawl only, budget-fenced ----
    const fcFetcher: PageFetcher = async (url) => {
      try {
        const res = await router.fetch(url, {
          paidEnabled: true,
          paidOnly: true,
          includeProviderIds: ['firecrawl'],
          remainingLeadBudgetEur: Math.max(0, perLeadCap - run.ledger.costForLead(ctx.leadId)),
          runCostCeilingEur: ceiling,
          timeoutMs: 25_000,
          meta,
        });
        return res.status >= 200 && res.status < 400 ? res.html : undefined;
      } catch {
        return undefined;
      }
    };
    try {
      counts.rendered += 1;
      const deep = await deepExtractFromSite(site, fcFetcher, { maxContactPages: 1 });
      applyBodyExtraction(lead, deep.extraction);
    } catch {
      /* render failure degrades to nothing, never throws the pass */
    }
    if (has(lead.email_inferred)) counts.render_email += 1;
    else counts.still_missing += 1;

    processed += 1;
    if (processed % 200 === 0) {
      console.log(`firecrawl: ${processed}/${subset.length} · ledger €${run.ledger.getTotal().toFixed(2)}`);
    }
  });

  const total = closeLedger(run, 'firecrawl_pass');
  await saveState(leads, out);
  console.log(
    `firecrawl_pass: subset ${subset.length} → ${JSON.stringify(counts)} · email totali ora ${leads.filter((l) => has(l.email_inferred)).length}/${leads.length} · ledger €${total.toFixed(2)} (cap €${ceiling})`,
  );
}

runIfMain('firecrawl_pass.ts', main);
