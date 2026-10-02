import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../runtime/logger';
import { CsvWriter } from '../io/csv_writer';
import { JsonlWriter } from '../io/jsonl_writer';
import { parsePagineGialleResults } from './sources/pagine_gialle_parser';
import { parseGoogleMapsResults } from './sources/google_maps_parser';
import { dedupeLeads, Deduplicator } from './deduper';
import { rehydrateFromPriorRun } from './resume_prior_run';
import type { Lead } from '../types/lead';
import { SCHEMA_VERSION } from '../types/lead';
import { normalizeLeadPhone } from './phone';
import { provinceForComune } from '../geo/comune_lookup';
import {
  completionMarkerPath,
  coverageManifestPath,
  recoveryEnvelopePath,
  type CoverageManifest,
  writeCoverageArtifacts,
} from './scrape_completion';
import { stripDiacritics } from '../util/text';

/**
 * Scrape pipeline: all orchestration logic lives here,
 * `cli/scrape.ts` is a thin wrapper that parses args and calls these
 * functions. Two coexisting modes:
 *
 *   - FIXTURE  — read saved HTML, run pure parsers, dedupe, write
 *                CSV+JSONL. Deterministic, offline, used in CI.
 *   - LIVE     — Playwright-driven; lazy-imports the navigators so
 *                fixture mode never spins up Chromium.
 */

// ============================================================
// FIXTURE MODE
// ============================================================

interface FixtureSource {
  path: string;
  source: 'pg' | 'maps';
}

export interface FixtureModeInput {
  out: string;
  category?: string;
  fixture: string;
  sourceFlag?: string;
  /** Do-not-contact list, applied before emit exactly as in live mode. */
  suppression?: import('../compliance/suppression').SuppressionList;
}

export async function runFixtureMode(input: FixtureModeInput): Promise<void> {
  const sources = resolveFixtureSources(input.fixture, input.sourceFlag);
  if (sources.length === 0) throw new Error('No fixtures resolved from --fixture flag');
  const all: Lead[] = [];
  let totalCards = 0;
  let dropped = 0;
  let overflowDetected = false;
  let capLikelyDetected = false;
  for (const fx of sources) {
    if (!fs.existsSync(fx.path)) {
      logger.warn({ path: fx.path }, '[scrape] fixture not found, skipping');
      continue;
    }
    const html = fs.readFileSync(fx.path, 'utf8');
    if (fx.source === 'pg') {
      const r = parsePagineGialleResults(html, { category: input.category });
      totalCards += r.total_cards;
      dropped += r.dropped;
      overflowDetected = overflowDetected || r.overflow;
      logger.info(
        { fixture: fx.path, cards: r.total_cards, parsed: r.results.length, dropped: r.dropped, overflow: r.overflow },
        '[scrape] PG fixture parsed'
      );
      all.push(...r.results);
    } else {
      const r = parseGoogleMapsResults(html, { category: input.category });
      totalCards += r.total_cards;
      dropped += r.dropped;
      capLikelyDetected = capLikelyDetected || r.cap_likely;
      logger.info(
        { fixture: fx.path, cards: r.total_cards, parsed: r.results.length, dropped: r.dropped, cap_likely: r.cap_likely },
        '[scrape] Maps fixture parsed'
      );
      all.push(...r.results);
    }
  }
  // Same normalization the live path applies in ingestBatch.
  for (const lead of all) {
    normalizeLeadPhone(lead);
    fillProvinceFromComune(lead);
  }
  const { kept, suppressed } = input.suppression ? input.suppression.apply(dedupeLeads(all)) : { kept: dedupeLeads(all), suppressed: 0 };
  await emitCsvJsonl(input.out, kept, {
    fixtures: sources.length,
    total_cards: totalCards,
    dropped_at_parse: dropped,
    raw_pre_dedupe: all.length,
    overflow: overflowDetected,
    cap_likely: capLikelyDetected,
    suppressed,
    mode: 'fixture',
  });
}

function resolveFixtureSources(fixtureFlag: string, sourceFlag?: string): FixtureSource[] {
  if (fixtureFlag.includes('=')) {
    return fixtureFlag.split(',').map((piece) => {
      const [src, p] = piece.split('=', 2);
      if ((src !== 'pg' && src !== 'maps') || !p) throw new Error(`Invalid fixture spec "${piece}"`);
      return { source: src, path: p } satisfies FixtureSource;
    });
  }
  if (sourceFlag !== 'pg' && sourceFlag !== 'maps') {
    throw new Error('When --fixture is a single path, --source must be "pg" or "maps".');
  }
  return [{ source: sourceFlag, path: fixtureFlag }];
}

// ============================================================
// LIVE MODE
// ============================================================

export interface LiveModeInput {
  runId: string;
  out: string;
  category: string;
  province?: string;
  region?: string;
  comuniCsv?: string;
  maxPages?: number;
  interDelayMs?: number;
  runMaps?: boolean;
  /**
   * Maps coverage mode. `'default'` runs ONE query per comune
   * (today's behaviour); `'full'` expands to a curated list of
   * sector-keyword variants per category and fires each as a separate
   * Maps scroll session. The Deduplicator collapses cross-query
   * overlap. Unknown categories silently fall back to default.
   * Defaults to `'default'`.
   */
  mapsCoverage?: import('./sources/maps_coverage').CoverageMode;
  headless?: boolean;
  checkpointPath?: string;
  restartEvery?: number;
  /**
   * When true, delete the previous CSV/JSONL/checkpoint at `out` and
   * start a fresh run. Without it, an existing JSONL alongside the
   * checkpoint is reloaded so resume produces a complete CSV.
   */
  fresh?: boolean;
  /**
   * An existing checkpoint that says pages are `done`
   * combined with a missing JSONL is a HARD ERROR by default. Operator
   * passes `--allow-missing-jsonl` to acknowledge the data loss.
   */
  allowMissingJsonl?: boolean;
  /**
   * Skip the selector health check. Default: preflight runs
   * before any live scraping and aborts loudly when PG/Maps markup no
   * longer matches the known-good canary query.
   */
  skipPreflight?: boolean;
  /**
   * Cooperative cancellation. When the signal aborts, the
   * comuni loop stops at the next iteration boundary, partial outputs
   * are still emitted, and the summary reports `interrupted: true`.
   * The checkpoint is already synced after every page/comune, so a
   * subsequent run resumes cleanly.
   */
  abortSignal?: AbortSignal;
  /**
   * Do-not-contact suppression. Matching leads are dropped
   * from the outputs entirely (counted in the summary).
   */
  suppression?: import('../compliance/suppression').SuppressionList;
}

export interface LiveModeSummary {
  leads: number;
  raw_pre_dedupe: number;
  total_cards: number;
  dropped_at_parse: number;
  pg_overflow_count: number;
  maps_cap_likely_count: number;
  comuni_count: number;
  /** Per-comune pre-dedupe parsed-lead counts (PG + Maps combined). */
  comuni_yield: Record<string, number>;
  /** Leads dropped by the suppression list. */
  suppressed: number;
  interrupted: boolean;
  output_csv: string;
  output_jsonl: string;
  coverage: CoverageManifest;
}

export async function runLiveMode(a: LiveModeInput): Promise<LiveModeSummary> {
  // Lazy-load the live navigator + browser modules so fixture mode +
  // typecheck never have to spin up Playwright. Under `module: node16` a
  // dynamic import() stays a real ESM import, so the specifier carries the
  // `.js` it resolves to at runtime (tsx and vitest map it back to `.ts`).
  const { BrowserFactory } = await import('../browser/factory.js');
  const { scrapePgLocation } = await import('./sources/pagine_gialle_live.js');
  const { scrapeMapsLocation } = await import('./sources/maps_live.js');
  const { Checkpoint } = await import('../runtime/checkpoint.js');
  const { logConsentSummary } = await import('../browser/consent_handler.js');
  const { getComuniForProvince, parseComuniList } = await import('../geo/italy_geo.js');

  if (a.maxPages !== undefined && (!Number.isInteger(a.maxPages) || a.maxPages < 1)) {
    throw new Error('--max-pages must be a positive integer.');
  }
  const comuni = resolveComuniList(a, getComuniForProvince, parseComuniList);
  if (comuni.length === 0) {
    throw new Error('Live mode needs --province (curated list) or --comuni "C1,C2,...".');
  }

  // Default checkpoint co-located with the output (1:1 with the target): two
  // provinces of the same category never share a checkpoint file. The old
  // category-only path (`.scrape-checkpoint-<slug>.json`) was shared across
  // provinces and poisoned resume → MissingPriorJsonlError (post-mortem: 31
  // occurrences, 30 Veneto cells zeroed). Drivers no longer need --checkpoint.
  const checkpointPath = a.checkpointPath ?? defaultCheckpointPath(a.out);
  const jsonlOut = a.out.replace(/\.csv$/i, '') + '.jsonl';
  const diagnosticsDir = a.out.replace(/\.csv$/i, '') + '.diagnostics';

  // --fresh: wipe the prior run's artifacts so the next run is clean.
  if (a.fresh) {
    for (const f of [a.out, jsonlOut, checkpointPath, coverageManifestPath(a.out), completionMarkerPath(a.out), recoveryEnvelopePath(a.out)]) {
      try { fs.unlinkSync(f); } catch { /* ignore missing */ }
    }
    logger.info({ out: a.out, jsonl: jsonlOut, checkpoint: checkpointPath }, '[scrape] --fresh: wiped prior run artifacts');
  }

  const checkpoint = new Checkpoint(checkpointPath);
  const factory = new BrowserFactory({
    // Session state belongs to an output target, not to a category. Campaign
    // cells for the same category run concurrently (e.g. PD + VR): a
    // category-only id made both processes overwrite the same cookie/storage
    // JSON and leak consent/WAF state across cells. The output lock is already
    // scoped to this target, so this id gives the browser state the same owner.
    id: browserSessionId(a.out, a.category),
    headless: a.headless,
    restartEvery: a.restartEvery,
  });

  const dedup = new Deduplicator();
  const allLeads: Lead[] = [];

  // RESUME: rehydrate deduper + lead set from prior JSONL when
  // checkpoint shows done entries. Hard-stop if JSONL missing unless
  // operator passes --allow-missing-jsonl.
  const resumed = await rehydrateFromPriorRun({
    jsonlPath: jsonlOut,
    csvPath: a.out,
    checkpoint,
    dedup,
    sink: allLeads,
    allowMissingJsonl: !!a.allowMissingJsonl,
  });

  let totalCards = 0;
  let dropped = 0;
  let comuniWithOverflow = 0;
  let comuniWithCapLikely = 0;
  let interrupted = false;
  // Set when the Maps preflight degrades (Maps down but PG healthy) → the Maps
  // stage is skipped and the run proceeds PG-only instead of aborting.
  let mapsDegraded = false;
  // Per-comune pre-dedupe yields. Feeds the run record so the
  // yield-anomaly check can compare against historical averages.
  const comuniYield: Record<string, number> = {};
  // Count parsed leads BEFORE the deduper so the run summary reports
  // `collapsed_by_dedupe` honestly — sourcing it from `allLeads.length`
  // (already deduped) makes the metric always read 0. The 3-comuni canary
  // on BL shows why that matters: 209 parsed cards collapsed to 116 unique
  // leads while the log still reported `collapsed_by_dedupe: 0`. Output
  // files were always correct; only the metric was wrong.
  let parsedLeadsBeforeDedupe = resumed;
  const aborted = () => a.abortSignal?.aborted === true;

  try {
    // Selector health check before any real scraping. A
    // PreflightError propagates out of runLiveMode (the finally below
    // still closes the browser) and maps to exit code 3 in the CLI.
    if (!a.skipPreflight) {
      const { runScrapePreflight } = await import('./preflight.js');
      const pf = await runScrapePreflight(factory, { checkMaps: !!a.runMaps });
      // PG failure still throws inside the preflight (real markup safety net).
      // Maps failure is non-fatal: degrade to PG-only for this run.
      if (a.runMaps && pf.maps_feed_present === false) {
        mapsDegraded = true;
        checkpoint.set(
          Checkpoint.buildKey({ provider: 'maps', category: a.category, location: '__preflight__' }),
          { status: 'failed', kind: 'preflight', reason: 'maps_preflight_no_feed', attempts: 1 },
        );
        logger.warn('[scrape] Maps degraded at preflight — running PG-only this run (Maps stage skipped)');
      } else if (a.runMaps && pf.maps_feed_present === true) {
        // A prior degraded run left an explicit failed preflight checkpoint.
        // Once the canary succeeds, replace that failure so a resumed Maps
        // scrape can genuinely reach completion after its failed queries pass.
        checkpoint.set(
          Checkpoint.buildKey({ provider: 'maps', category: a.category, location: '__preflight__' }),
          { status: 'done', kind: 'preflight', parsed: 0, attempts: 1 },
        );
      }
    } else {
      logger.warn('[scrape] preflight skipped by operator (--skip-preflight)');
    }

    // Stage 1: PG run for each comune in the curated list.
    for (const comune of comuni) {
      if (aborted()) {
        interrupted = true;
        break;
      }
      // Per-comune isolation: a comune that throws (e.g. a browser-restart
      // failure surfacing past the in-navigator retries) is logged and skipped
      // so the run continues instead of dying on one bad comune.
      try {
        const r = await scrapePgLocation(factory, {
          category: a.category,
          location: comune,
          maxPages: a.maxPages,
          checkpoint,
          diagnosticsDir,
          interPageDelayMs: a.interDelayMs,
          abortSignal: a.abortSignal,
          // PG serves province-wide results, so a comune adding 0 new leads
          // is re-scraping firms we already have → early-stop paginating it.
          isNew: pgNoveltyCheck(dedup),
        });
        if (r.interrupted) {
          interrupted = true;
          break;
        }
        totalCards += r.total_cards;
        dropped += r.dropped;
        if (r.overflow) comuniWithOverflow += 1;
        parsedLeadsBeforeDedupe += r.results.length;
        comuniYield[comune] = (comuniYield[comune] ?? 0) + r.results.length;
        ingestBatch(allLeads, dedup, r.results);
        // Save state after each comune so an interrupted run resumes cleanly.
        await factory.saveSessionState();
      } catch (err) {
        if (aborted()) {
          interrupted = true;
          break;
        }
        logger.error({ comune, err: (err as Error).message }, '[scrape] PG comune failed — skipping to next (run continues)');
      }
    }
    // Stage 2 (optional): Maps per comune.
    // When `mapsCoverage='full'`, expand the category to multiple
    // sector-keyword variants and run each as its own scroll session.
    // The Deduplicator collapses cross-variant overlap.
    if (a.runMaps && !interrupted && !mapsDegraded) {
      const { expandMapsQueryVariants, hasFullCoverageVariants } = await import('./sources/maps_coverage.js');
      const coverage = a.mapsCoverage ?? 'default';
      const queryVariants = expandMapsQueryVariants(a.category, coverage);
      if (coverage === 'full' && !hasFullCoverageVariants(a.category)) {
        logger.warn(
          { category: a.category, coverage },
          '[scrape] --coverage=full requested but no variants curated for this category; falling back to default single query',
        );
      }
      outer: for (const comune of comuni) {
        for (const queryCategory of queryVariants) {
          if (aborted()) {
            interrupted = true;
            break outer;
          }
          try {
            const r = await scrapeMapsLocation(factory, {
              category: queryCategory,
              location: comune,
              checkpoint,
              diagnosticsDir,
              abortSignal: a.abortSignal,
            });
            if (r.interrupted) {
              interrupted = true;
              break outer;
            }
            totalCards += r.total_cards;
            dropped += r.dropped;
            if (r.cap_likely) comuniWithCapLikely += 1;
            parsedLeadsBeforeDedupe += r.results.length;
            comuniYield[comune] = (comuniYield[comune] ?? 0) + r.results.length;
            ingestBatch(allLeads, dedup, r.results);
            await factory.saveSessionState();
          } catch (err) {
            if (aborted()) {
              interrupted = true;
              break outer;
            }
            logger.error({ comune, queryCategory, err: (err as Error).message }, '[scrape] Maps comune failed — skipping to next (run continues)');
          }
        }
      }
    }
    // An abort can arrive immediately after the final terminal checkpoint.
    // Never let that race turn a graceful shutdown into a completion marker.
    if (aborted()) interrupted = true;
    if (interrupted) {
      logger.warn(
        { comuni_done: Object.keys(comuniYield).length, comuni_total: comuni.length },
        '[scrape] aborted by signal — emitting partial outputs (checkpoint is resume-ready)'
      );
    }
  } finally {
    logConsentSummary();
    await factory.close();
  }

  // Suppression at output time. Matching leads are dropped
  // entirely (a do-not-contact subject must not appear in delivered files) and
  // suppressed addresses are stripped from the rest.
  let emitLeads = allLeads;
  let suppressed = 0;
  if (a.suppression?.active) {
    ({ kept: emitLeads, suppressed } = a.suppression.apply(allLeads));
    if (suppressed > 0) {
      logger.warn({ suppressed, list: a.suppression.sourcePath }, '[scrape] leads dropped by suppression list');
    }
  }

  await emitCsvJsonl(a.out, emitLeads, {
    mode: 'live',
    province: a.province,
    region: a.region,
    comuni_count: comuni.length,
    pg_overflow_count: comuniWithOverflow,
    maps_cap_likely_count: comuniWithCapLikely,
    total_cards: totalCards,
    dropped_at_parse: dropped,
    raw_pre_dedupe: parsedLeadsBeforeDedupe,
    suppressed,
    checkpoint_done: checkpoint.countDone(),
    resumed_from_prior_jsonl: resumed,
    interrupted,
    maps_degraded: mapsDegraded,
    factory: factory.describe(),
  });

  const coverage = writeCoverageArtifacts({ outCsv: a.out, runId: a.runId, checkpoint, forcePartial: interrupted });
  if (coverage.status === 'partial') {
    if (coverage.incomplete_reason === 'interrupted') {
      logger.warn(
        { failed_query_count: coverage.failed_query_count },
        '[scrape] coverage interrupted — output is NOT complete; resume pending queries before recovery dispatch',
      );
    } else {
      logger.warn(
        { failed_query_count: coverage.failed_query_count, recovery: recoveryEnvelopePath(a.out) },
        '[scrape] coverage partial — output is NOT complete and recovery is required',
      );
    }
  } else {
    logger.info({ completion_marker: completionMarkerPath(a.out) }, '[scrape] coverage complete');
  }

  // Near-duplicate candidates for operator review (never
  // auto-merged). Written only when the run produced any.
  const reviewCandidates = dedup.getReviewCandidates();
  if (reviewCandidates.length > 0) {
    const reviewPath = a.out.replace(/\.csv$/i, '') + '.dedup-review.jsonl';
    fs.writeFileSync(reviewPath, reviewCandidates.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
    logger.warn(
      { candidates: reviewCandidates.length, reviewPath },
      '[scrape] near-duplicate candidates flagged for manual review (NOT merged)'
    );
  }

  return {
    leads: emitLeads.length,
    raw_pre_dedupe: parsedLeadsBeforeDedupe,
    total_cards: totalCards,
    dropped_at_parse: dropped,
    pg_overflow_count: comuniWithOverflow,
    maps_cap_likely_count: comuniWithCapLikely,
    comuni_count: comuni.length,
    comuni_yield: comuniYield,
    suppressed,
    interrupted,
    output_csv: path.resolve(a.out),
    output_jsonl: path.resolve(jsonlOut),
    coverage,
  };
}

function resolveComuniList(
  a: Pick<LiveModeInput, 'comuniCsv' | 'province'>,
  getComuniForProvince: (code: string) => string[],
  parseComuniList: (csv: string) => string[]
): string[] {
  if (a.comuniCsv && a.comuniCsv.trim()) return parseComuniList(a.comuniCsv);
  if (a.province && a.province.trim()) {
    const c = getComuniForProvince(a.province);
    if (c.length > 0) return c;
    return [a.province.trim().toUpperCase()];
  }
  return [];
}

/**
 * Fill `province` (2-letter sigla) from the comune name when the parser left it
 * empty — chiefly the Google Maps path, whose card address rarely carries the
 * "(PD)" sigla. Never overwrites an address-parsed province; leaves it empty on
 * omonimie (provinceForComune returns undefined → no guessing).
 */
export function fillProvinceFromComune(lead: Lead): void {
  if (lead.province) return;
  const prov =
    provinceForComune(typeof lead.business_city === 'string' ? lead.business_city : undefined) ??
    provinceForComune(typeof lead.city === 'string' ? lead.city : undefined) ??
    provinceForComune(typeof lead.query_location === 'string' ? lead.query_location : undefined);
  if (prov) lead.province = prov;
}

/**
 * Novelty predicate for one PG comune. `runDedup` holds only the comuni
 * already ingested: the current comune is ingested after all its pages are
 * scraped, so a repeat of its own page 1 would still look new. A per-comune
 * Deduplicator (same keys as the run's) records what this comune has shown
 * so far. It only answers the question; ingest is unchanged.
 */
export function pgNoveltyCheck(runDedup: Deduplicator): (lead: Lead) => boolean {
  const seenInComune = new Deduplicator();
  return (lead) => {
    if (runDedup.find(lead) || seenInComune.find(lead)) return false;
    seenInComune.add(lead);
    return true;
  };
}

function ingestBatch(allLeads: Lead[], dedup: Deduplicator, batch: Lead[]): void {
  for (const lead of batch) {
    // Normalize phones to E.164 BEFORE dedupe so the output is
    // consistent regardless of which source format arrived first. The
    // deduper's own phone key is format-tolerant either way.
    normalizeLeadPhone(lead);
    fillProvinceFromComune(lead);
    const existing = dedup.find(lead);
    if (existing) {
      dedup.merge(existing, lead);
    } else {
      dedup.add(lead);
      allLeads.push(lead);
    }
  }
}

// ============================================================
// SHARED — output emission
// ============================================================

async function emitCsvJsonl(
  outCsv: string,
  leads: Lead[],
  summary: Record<string, unknown>
): Promise<void> {
  const jsonlOut = outCsv.replace(/\.csv$/i, '') + '.jsonl';
  const csv = new CsvWriter(outCsv, 'raw');
  const jsonl = new JsonlWriter(jsonlOut);
  for (const lead of leads) {
    // Stamp the schema version on every emitted row.
    lead._schema_version ??= SCHEMA_VERSION;
    await csv.write(lead);
    await jsonl.write(lead);
  }
  await csv.close();
  await jsonl.close();
  logger.info(
    {
      ...summary,
      raw_post_dedupe: leads.length,
      collapsed_by_dedupe: typeof summary.raw_pre_dedupe === 'number' ? (summary.raw_pre_dedupe as number) - leads.length : 0,
      output_csv: path.resolve(outCsv),
      output_jsonl: path.resolve(jsonlOut),
    },
    '[scrape] complete'
  );
}

/**
 * Default checkpoint path — co-located with the output CSV so it is 1:1 with
 * the run target. Two provinces of the same category produce different output
 * files → different checkpoints → no cross-province poisoning.
 */
export function defaultCheckpointPath(outCsv: string): string {
  return outCsv.replace(/\.csv$/i, '') + '.checkpoint.json';
}

/**
 * Stable, target-scoped browser-storage id. The readable category prefix helps
 * operators inspect `.browser-state`; the resolved output hash makes the id
 * collision-resistant without exposing the full local filesystem path.
 */
export function browserSessionId(outCsv: string, category: string): string {
  const targetHash = crypto.createHash('sha256').update(path.resolve(outCsv)).digest('hex').slice(0, 12);
  return `scrape-${slug(category) || 'target'}-${targetHash}`;
}

function slug(s: string): string {
  return stripDiacritics(s.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
