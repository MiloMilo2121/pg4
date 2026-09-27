import fs from 'fs';
import path from 'path';
import { parseArgs, optString } from '../../src/cli/_args';
import { ApifyDatasetError, ApifyProvider, ApifyRunError, type ApifyActor } from '../../src/providers/apify/apify_provider';
import { buildE3Run, closeLedger, runIfMain } from './_shared';
import { logger } from '../../src/runtime/logger';

/**
 * ENRICH-3 R1a — BULK harvest of the Veneto real-estate portals via Apify
 * actors, one dataset per (actor × unit) under `--raw-dir`. Download only —
 * the offline JOIN lives in `portali_join.ts` (€0).
 *
 * Money safety: every actor call goes through `router.invoke` with a
 * worst-case reservation (`maxItems × unit cost`) so the run ceiling holds
 * atomically, while the ledger records the REAL cost (items the actor pushed
 * × unit — not the items `maxItems` let us download).
 *
 * Resume: a non-empty raw file skips its call — re-running after a crash or
 * ceiling stop only pays for what is missing. A run that SUCCEEDED (already
 * billed) but whose dataset download failed leaves a `<raw>.pending.json`
 * with its dataset id; the next run re-downloads it for free instead of
 * paying for a new run.
 *
 *   # probe (validates actor input/output shapes BEFORE scaling, ~€0.10):
 *   APIFY_ENABLED=true APIFY_PORTAL_IMMOBILIARE_ENABLED=true ... \
 *     pnpm tsx tools/enrich3/portali_harvest.ts --probe --run-cost-ceiling-eur 1
 *   # full harvest:
 *   ... pnpm tsx tools/enrich3/portali_harvest.ts --run-cost-ceiling-eur 45
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
 *   - memo23~immobiliare-scraper: { startUrls: [{url}], maxItems,
 *     includeAgencyDetails } — auto-paginates the directory. Chosen after
 *     azzouzana measured ~5 items/run + a 1-min free-tier rate limit, and
 *     saregaa turned out to be a listings scraper (proxy required).
 *   - stealth_mode~wikicasa-agency-search-scraper: { urls: string[],
 *     max_items_per_url, ignore_url_failures }.
 */
function buildUnits(probe: boolean): HarvestUnit[] {
  const cap = (n: number): number => (probe ? 30 : n);
  const units: HarvestUnit[] = [];
  for (const slug of probe ? PROVINCES.slice(0, 1) : PROVINCES) {
    units.push({
      actor: 'portal_immobiliare',
      slug,
      maxItems: cap(3000),
      input: {
        startUrls: [{ url: `https://www.immobiliare.it/agenzie-immobiliari/${slug}-provincia/` }],
        includeAgencyDetails: true,
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
    const pendingPath = `${rawPath}.pending.json`;
    const recovered = fs.existsSync(pendingPath) ? await recoverPaidDataset(provider, pendingPath, unit.maxItems) : 'none';
    const items = Array.isArray(recovered) ? recovered : recovered === 'retry-later' ? null : await harvestUnit(provider, router, unit, ceiling, pendingPath);
    if (!items) {
      logger.warn({ actor: unit.actor, slug: unit.slug }, '[portali] no items (gated, failed, or empty) — raw not written');
      continue;
    }
    fs.writeFileSync(rawPath, items.map((it) => JSON.stringify(it)).join('\n') + '\n');
    fs.rmSync(pendingPath, { force: true });
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

/** One paid actor run through the router's gates; the ledger gets the run's real cost. */
async function harvestUnit(
  provider: ApifyProvider,
  router: ReturnType<typeof buildE3Run>['router'],
  unit: HarvestUnit,
  ceiling: number,
  pendingPath: string,
): Promise<unknown[] | null> {
  const meta = { ...provider.meta(unit.actor), costPerCallEur: unit.maxItems * provider.meta(unit.actor).costPerCallEur };
  logger.info({ actor: unit.actor, slug: unit.slug, maxItems: unit.maxItems, worstCaseEur: meta.costPerCallEur }, '[portali] harvesting');
  return router.invoke<unknown[]>(
    meta,
    async () => {
      try {
        const run = await provider.runActorAsync(unit.actor, unit.input, { maxItems: unit.maxItems, timeoutMs: 1_800_000 });
        return { ok: run.items.length > 0, value: run.items, cost_eur: run.cost_eur };
      } catch (err) {
        if (err instanceof ApifyRunError && err.succeeded && err.datasetId) {
          fs.writeFileSync(pendingPath, JSON.stringify({ runId: err.runId, datasetId: err.datasetId }) + '\n');
          logger.warn({ pendingPath, runId: err.runId }, '[portali] run paid but download failed — dataset id saved for a free re-download');
        }
        throw err;
      }
    },
    { paidEnabled: true, runCostCeilingEur: ceiling, meta: { stage: 'e3_portali', actor: unit.actor, provincia: unit.slug } },
  );
}

/**
 * Resume path for an already-paid run: download its dataset (a read, no new
 * run). Returns the items; 'retry-later' on a transient failure (pending
 * kept); 'none' when the dataset is gone (404 — past Apify retention), empty
 * or the pending file is unreadable — pending dropped, so the unit is
 * harvested again instead of being stuck forever.
 */
export async function recoverPaidDataset(provider: ApifyProvider, pendingPath: string, maxItems: number): Promise<unknown[] | 'retry-later' | 'none'> {
  const drop = (reason: string, datasetId?: string): 'none' => {
    logger.warn({ datasetId, reason }, '[portali] paid dataset unrecoverable — pending dropped, unit will be harvested again');
    fs.rmSync(pendingPath, { force: true });
    return 'none';
  };
  let datasetId: unknown;
  try {
    datasetId = (JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { datasetId?: unknown }).datasetId;
  } catch (err) {
    return drop(`unreadable pending file: ${(err as Error).message}`);
  }
  if (typeof datasetId !== 'string' || !datasetId) return drop('pending file has no datasetId');
  try {
    const items = await provider.fetchDatasetItems(datasetId, maxItems);
    if (items.length === 0) return drop('dataset is empty', datasetId);
    logger.info({ datasetId, items: items.length }, '[portali] recovered paid dataset (no new run)');
    return items;
  } catch (err) {
    if (err instanceof ApifyDatasetError && err.status === 404) return drop('dataset gone (404, past retention?)', datasetId);
    logger.warn({ datasetId, err: (err as Error).message }, '[portali] dataset re-download failed — pending kept for the next resume');
    return 'retry-later';
  }
}

runIfMain('portali_harvest.ts', main);
