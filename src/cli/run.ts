import crypto from 'crypto';
import path from 'path';
import { parseArgs, reqString, optString, hasHelp } from './_args';
import { logger, bindRunLogFile } from '../runtime/logger';
import { runLiveMode } from '../discovery/scrape_pipeline';
import { acquireOutputLock } from '../runtime/output_lock';
import { RunRecorder, EXIT, installInterruptHandler, readRunHistory, runsFilePath, assessYield } from '../runtime/run_record';
import { getNotifier } from '../runtime/notifier';
import { PreflightError } from '../discovery/preflight';
import { runEnrichCommand } from './enrich_command';
import { postRunValidate } from './_post_run';
import { SuppressionList } from '../compliance/suppression';
import { enforceRetention, resolveRetentionDays } from '../compliance/retention';

/**
 * `pnpm run run -- --category "X" --province PD --out output/campaign`
 *
 * Phase B.1 — the end-to-end command: scrape → enrich, one shared run id,
 * one run record, one log file. Output layout from `--out <base>`:
 *
 *   <base>_raw.csv / .jsonl          scrape output
 *   <base>_enriched.csv / .jsonl     enrich output
 *   <base>_enriched.cost-ledger.jsonl
 *   <base>.log.jsonl                 combined run log
 *   <dir>/_runs.jsonl                run record (command: "run")
 *
 * Each stage acquires its own output lock (same protection as running the
 * stages by hand). Paid stays opt-in via --enable-paid exactly like enrich.
 *
 * Exit codes: 0 ok · 1 partial (enrich row errors) · 2 fatal ·
 * 3 preflight failed · 130 interrupted.
 */
async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    printUsage();
    return EXIT.OK;
  }
  const category = reqString(args, 'category');
  const outBase = reqString(args, 'out').replace(/\.csv$/i, '');
  const province = optString(args, 'province');
  const comuniCsv = optString(args, 'comuni');
  const region = optString(args, 'region');

  const rawCsv = `${outBase}_raw.csv`;
  const enrichedCsv = `${outBase}_enriched.csv`;

  const logFile = bindRunLogFile(`${outBase}.log.jsonl`);
  const runId = `run-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const abort = new AbortController();
  const recorder = new RunRecorder({ runId, command: 'run', outCsv: enrichedCsv, category, logFile });
  installInterruptHandler({
    onSignal: () => abort.abort(),
    onForceExit: () => {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { error: 'force-exit: graceful drain did not complete' });
    },
  });

  const coverageRaw = optString(args, 'coverage');
  if (coverageRaw !== undefined && coverageRaw !== 'default' && coverageRaw !== 'full') {
    throw new Error(`--coverage must be "default" or "full", got "${coverageRaw}"`);
  }
  const ceilingArg = optString(args, 'cost-ceiling-eur');
  const runCeilingArg = optString(args, 'run-cost-ceiling-eur');

  try {
    // Phase D.2 — retention sweep (only when the operator opted in).
    const retentionDays = resolveRetentionDays(optString(args, 'retention-days'));
    if (retentionDays !== undefined) {
      enforceRetention({ outCsv: enrichedCsv, retentionDays });
    }
    // Phase D.1 — one suppression list for both stages.
    const suppression = SuppressionList.resolve({ flagPath: optString(args, 'suppression-list'), outCsv: enrichedCsv });

    // ---- Stage 1: scrape ----
    logger.info({ runId, category, province, comuniCsv, rawCsv }, '[run] stage 1/2 — scrape');
    const scrapeLock = acquireOutputLock(rawCsv, { command: 'run', stage: 'scrape', category });
    let scrapeSummary;
    try {
      scrapeSummary = await runLiveMode({
        out: rawCsv,
        category,
        province,
        region,
        comuniCsv,
        maxPages: parseIntOrUndefined(optString(args, 'max-pages')),
        runMaps: !!args.flags['maps'],
        mapsCoverage: coverageRaw as 'default' | 'full' | undefined,
        headless: args.flags['headless'] !== 'false',
        fresh: !!args.flags['fresh'],
        allowMissingJsonl: !!args.flags['allow-missing-jsonl'],
        skipPreflight: !!args.flags['skip-preflight'],
        abortSignal: abort.signal,
        suppression,
      });
    } finally {
      scrapeLock.release();
    }

    const history = readRunHistory(runsFilePath(rawCsv));
    const yieldCheck = assessYield(history, { category, comuniYield: scrapeSummary.comuni_yield });
    if (yieldCheck.suspect) {
      logger.warn({ suspect_comuni: yieldCheck.suspectComuni, detail: yieldCheck.detail }, '[run] ⚠ YIELD ANOMALY in scrape stage');
      getNotifier().notify({
        kind: 'yield_anomaly',
        title: 'Scrape yield anomaly',
        body: `Comuni below 30% of historical average: ${yieldCheck.suspectComuni.join(', ')}.`,
        meta: { run_id: runId },
      });
    }
    recorder.update({
      comuni_yield: scrapeSummary.comuni_yield,
      suspect: yieldCheck.suspect || undefined,
      suspect_comuni: yieldCheck.suspect ? yieldCheck.suspectComuni : undefined,
    });
    await postRunValidate({ csvPath: rawCsv, jsonlPath: scrapeSummary.output_jsonl, flavor: 'raw', runId });

    if (scrapeSummary.interrupted) {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { leads_out: scrapeSummary.leads });
      return EXIT.INTERRUPTED;
    }

    // ---- Stage 2: enrich ----
    logger.info({ runId, input: rawCsv, enrichedCsv }, '[run] stage 2/2 — enrich');
    const result = await runEnrichCommand({
      input: rawCsv,
      csvOut: enrichedCsv,
      costCeilingEur: ceilingArg ? Number(ceilingArg) : undefined,
      runCostCeilingEur: runCeilingArg ? Number(runCeilingArg) : undefined,
      enablePaid: !!args.flags['enable-paid'],
      includeClosed: !!args.flags['include-closed'],
      suppression,
      runId,
      abortSignal: abort.signal,
    });

    recorder.update({
      leads_in: scrapeSummary.leads,
      leads_out: result.total - result.suppressed,
      with_website: result.withWebsite,
      row_errors: result.errors,
      suppressed: (scrapeSummary.suppressed + result.suppressed) || undefined,
      total_cost_eur: result.totalCostEur,
    });
    await postRunValidate({
      csvPath: enrichedCsv,
      jsonlPath: result.jsonlOut,
      ledgerPath: result.ledgerPath,
      flavor: 'enriched',
      runId,
    });

    if (result.interrupted) {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { provider_dead: result.providerDead });
      return EXIT.INTERRUPTED;
    }

    const status = result.errors > 0 ? 'partial' : 'ok';
    const code = result.errors > 0 ? EXIT.PARTIAL : EXIT.OK;
    recorder.finish(status, code, { provider_dead: result.providerDead });
    getNotifier().notify({
      kind: 'run_complete',
      title: 'Campaign complete',
      body: `${scrapeSummary.leads} raw leads → ${result.withWebsite} with website (€${result.totalCostEur.toFixed(4)}, ${result.errors} errors).`,
      meta: { run_id: runId, out: path.resolve(enrichedCsv), status },
    });
    logger.info(
      { runId, raw_leads: scrapeSummary.leads, enriched: result.total, with_website: result.withWebsite, cost_eur: result.totalCostEur },
      '[run] campaign done'
    );
    return code;
  } catch (err) {
    if (err instanceof PreflightError) {
      recorder.finish('preflight_failed', EXIT.PREFLIGHT_FAILED, { error: err.message });
      getNotifier().notify({ kind: 'preflight_failed', title: `Preflight failed (${err.source.toUpperCase()})`, body: err.message, meta: { run_id: runId } });
      logger.error({ source: err.source }, `[run] ${err.message}`);
      return EXIT.PREFLIGHT_FAILED;
    }
    recorder.finish('fatal', EXIT.FATAL, { error: (err as Error).message });
    getNotifier().notify({ kind: 'run_failed', title: 'Campaign failed', body: (err as Error).message, meta: { run_id: runId } });
    throw err;
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run run -- --category "<category>" --province PD --out output/campaign
  pnpm run run -- --category "<category>" --comuni "C1,C2" --maps --coverage full --out output/campaign

End-to-end pipeline: scrape -> enrich with one shared run id.
Outputs: <out>_raw.csv/.jsonl, <out>_enriched.csv/.jsonl(+ledger), <out>.log.jsonl.

Flags (superset of scrape + enrich):
  --category <text>             Required business category.
  --province <CC> | --comuni    Geographic scope (one required).
  --maps                        Also scrape Google Maps.
  --coverage default|full       Maps query-variant coverage.
  --fresh                       Clear previous scrape artifacts first.
  --skip-preflight              Skip the selector health check.
  --max-pages <n>               Per-municipality PG page cap.
  --cost-ceiling-eur <n>        Per-lead paid ceiling (enrich stage).
  --run-cost-ceiling-eur <n>    Aggregate paid ceiling (enrich stage).
  --enable-paid                 Opt in to paid providers.
  --out <base>                  Required output base path (no extension).

Exit codes: 0 ok | 1 partial | 2 fatal | 3 preflight failed | 130 interrupted.
`);
}

function parseIntOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, '[run] failed');
    process.exit(EXIT.FATAL);
  });
