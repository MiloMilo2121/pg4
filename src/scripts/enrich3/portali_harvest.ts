import fs from 'fs';
import path from 'path';
import { parseArgs, optString } from '../../cli/_args';
import { ApifyProvider, type ApifyActor } from '../../providers/apify/apify_provider';
import { buildE3Run, closeLedger, runIfMain } from './_shared';
import { logger } from '../../runtime/logger';

/**
 * ENRICH-3 R1a — BULK harvest of the Veneto real-estate portals via Apify
 * actors, one dataset per (actor × unit) under `--raw-dir`. Download only —
 * the offline JOIN lives in `portali_join.ts` (€0).
 *
 * Money safety: every actor call goes through `router.invoke` with a
 * worst-case reservation (`maxItems × unit cost`) so the run ceiling holds
 * atomically, while the ledger records the REAL cost (items × unit).
 *
 * Resume: a non-empty raw file skips its call — re-running after a crash or
 * ceiling stop only pays for what is missing.
 *
 *   # probe (validates actor input/output shapes BEFORE scaling, ~€0.10):
 *   APIFY_ENABLED=true APIFY_PORTAL_IMMOBILIARE_ENABLED=true ... \
 *     pnpm tsx src/scripts/enrich3/portali_harvest.ts --probe --run-cost-ceiling-eur 1
 *   # full harvest:
 *   ... pnpm tsx src/scripts/enrich3/portali_harvest.ts --run-cost-ceiling-eur 45
 */

const PROVINCES = ['padova', 'verona', 'vicenza', 'treviso', 'venezia', 'rovigo', 'belluno'] as const;

interface HarvestUnit {
  actor: ApifyActor;
  slug: string; // province slug or 'veneto' for region-wide actors
  input: Record<string, unknown>;
  maxItems: number;
}

/**
 * Single place encoding each actor's input shape — validated against the
 * REAL input schemas fetched from the actors' default builds (probe R1):
 *   - azzouzana~immobiliare-agencies-scraper: { startUrl: string, maxItems,
 *     extractSocials } — `startUrl` is SINGULAR; an array is silently ignored
 *     and the actor runs its Milano default (measured in the first probe).
 *   - stealth_mode~wikicasa-agency-search-scraper: { urls: string[],
 *     max_items_per_url, ignore_url_failures }.
 *   - saregaa~immobiliareit-scraper was DROPPED: its schema is a listings
 *     scraper (startUrls + required proxyConfiguration; scrapeAllAgencies is
 *     all-Italy only), and azzouzana already returns isPaid + realEstateAds —
 *     the only unique loss is `fiaip`.
 */
function buildUnits(probe: boolean): HarvestUnit[] {
  const cap = (n: number): number => (probe ? 15 : n);
  const units: HarvestUnit[] = [];
  for (const slug of probe ? PROVINCES.slice(0, 1) : PROVINCES) {
    units.push({
      actor: 'portal_immobiliare',
      slug,
      maxItems: cap(3000),
      input: {
        startUrl: `https://www.immobiliare.it/agenzie-immobiliari/${slug}-provincia/`,
        extractSocials: true,
        maxItems: cap(3000),
      },
    });
  }
  units.push({
    actor: 'portal_wikicasa',
    slug: 'veneto',
    maxItems: cap(6000),
    input: {
      urls: ['https://www.wikicasa.it/agenzie-immobiliari/regione-veneto/'],
      max_items_per_url: cap(6000),
      ignore_url_failures: true,
    },
  });
  return units;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const probe = args.flags.probe === true;
  const rawDir = optString(args, 'raw-dir') ?? 'output/enrich3/portali/raw';
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? (probe ? '1' : ''));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  fs.mkdirSync(rawDir, { recursive: true });
  const provider = new ApifyProvider();
  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/portali/ledger.jsonl',
    paidEnabled: true,
    runCostCeilingEur: ceiling,
  });

  const units = buildUnits(probe).filter((u) => {
    if (!provider.actorAvailable(u.actor)) {
      logger.warn({ actor: u.actor }, '[portali] actor disabled (flag off) — skipped');
      return false;
    }
    return true;
  });
  if (units.length === 0) throw new Error('no portal actor enabled — set APIFY_ENABLED + APIFY_PORTAL_*_ENABLED inline');

  let done = 0;
  for (const unit of units) {
    const rawPath = path.join(rawDir, `${unit.actor}_${unit.slug}${probe ? '_probe' : ''}.jsonl`);
    if (fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0) {
      logger.info({ rawPath }, '[portali] raw exists — skip (resume)');
      continue;
    }
    const meta = { ...provider.meta(unit.actor), costPerCallEur: unit.maxItems * provider.meta(unit.actor).costPerCallEur };
    const unitCost = provider.meta(unit.actor).costPerCallEur;
    logger.info({ actor: unit.actor, slug: unit.slug, maxItems: unit.maxItems, worstCaseEur: meta.costPerCallEur }, '[portali] harvesting');
    const items = await router.invoke<unknown[]>(
      meta,
      async () => {
        const got = await provider.runActorAsync(unit.actor, unit.input, { maxItems: unit.maxItems, timeoutMs: 1_800_000 });
        return { ok: got.length > 0, value: got, cost_eur: got.length * unitCost };
      },
      { paidEnabled: true, runCostCeilingEur: ceiling, meta: { stage: 'e3_portali', actor: unit.actor, provincia: unit.slug } },
    );
    if (!items) {
      logger.warn({ actor: unit.actor, slug: unit.slug }, '[portali] no items (gated, failed, or empty) — raw not written');
      continue;
    }
    fs.writeFileSync(rawPath, items.map((it) => JSON.stringify(it)).join('\n') + '\n');
    done += 1;
    logger.info({ rawPath, items: items.length, ledgerEur: run.ledger.getTotal().toFixed(3) }, '[portali] unit done');
    if (probe) {
      console.log(`\n===== PROBE ${unit.actor} (${unit.slug}) — first raw item =====`);
      console.log(JSON.stringify(items[0], null, 2).slice(0, 4000));
    }
  }

  closeLedger(run, 'portali_harvest');
  console.log(`portali_harvest: ${done} unit scaricate (probe=${probe}); raw in ${rawDir}`);
}

runIfMain('portali_harvest.ts', main);
