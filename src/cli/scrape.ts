import crypto from 'crypto';
import { parseArgs, reqString, optString, hasHelp } from './_args';
import { logger, bindRunLogFile } from '../runtime/logger';
import { runFixtureMode, runLiveMode } from '../discovery/scrape_pipeline';
import { acquireOutputLock } from '../runtime/output_lock';
import { RunRecorder, EXIT, installInterruptHandler, readRunHistory, runsFilePath, assessYield } from '../runtime/run_record';
import { getNotifier } from '../runtime/notifier';
import { PreflightError } from '../discovery/preflight';
import { postRunValidate } from './_post_run';
import { SuppressionList } from '../compliance/suppression';
import { enforceRetention, resolveRetentionDays } from '../compliance/retention';

/**
 * scrape — Phase 4 CLI (thin wrapper).
 *
 * Argument parsing + flag validation + lifecycle (run record, signals,
 * exit codes) + dispatch. All orchestration (fixture mode + live mode +
 * comuni resolution + dedupe + output) lives in
 * `src/discovery/scrape_pipeline.ts` so it can be exercised by tests
 * without touching the CLI.
 *
 * Two coexisting modes:
 *   1) FIXTURE (offline, deterministic):
 *        pnpm run scrape -- --fixture pg=path1.html,maps=path2.html \
 *           --category "agenzie immobiliari" --out output/raw.csv
 *
 *   2) LIVE (Playwright):
 *        pnpm run scrape -- --category "..." --province BL --out output/raw.csv
 *        pnpm run scrape -- --category "..." --comuni "C1,C2,C3" --out output/raw.csv
 *
 * Live mode skips Maps unless `--maps` is passed (PG-only by default,
 * because Maps' Cloudflare/consent surface needs more hardening).
 *
 * Exit codes (Phase B.3): 0 ok · 2 fatal · 3 preflight failed ·
 * 130 interrupted. Never prompts — safe for cron/launchd as-is.
 */

async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    printUsage();
    return EXIT.OK;
  }
  const out = reqString(args, 'out', 'e.g. output/raw.csv');
  const category = optString(args, 'category');
  const fixtureFlag = optString(args, 'fixture');

  // Phase A.1 — per-run log file alongside outputs (LOG_FILE env overrides).
  const logFile = bindRunLogFile(out.replace(/\.csv$/i, '') + '.log.jsonl');

  if (fixtureFlag) {
    const outputLock = acquireOutputLock(out, { command: 'scrape', mode: 'fixture', fixture: fixtureFlag });
    try {
      await runFixtureMode({
        out,
        category,
        fixture: fixtureFlag,
        sourceFlag: optString(args, 'source'),
      });
      return EXIT.OK;
    } finally {
      outputLock.release();
    }
  }

  if (!category) {
    throw new Error('Live mode requires --category. Pass --fixture <path> for offline mode.');
  }
  // R5 — `--coverage` flag. Accept 'default' (single query) or 'full'
  // (sector-keyword variants per comune). Anything else is rejected
  // so a typo doesn't silently fall back to default and surprise
  // the operator with under-coverage.
  const coverageRaw = optString(args, 'coverage');
  let mapsCoverage: 'default' | 'full' | undefined;
  if (coverageRaw !== undefined) {
    if (coverageRaw !== 'default' && coverageRaw !== 'full') {
      throw new Error(`--coverage must be "default" or "full", got "${coverageRaw}"`);
    }
    mapsCoverage = coverageRaw;
  }

  const runId = optString(args, 'run-id') ?? `run-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const abort = new AbortController();
  const recorder = new RunRecorder({ runId, command: 'scrape', outCsv: out, category, logFile });
  installInterruptHandler({
    // The live loop checks the signal between comuni; checkpoint is synced
    // after every page so the natural drain emits partial outputs and the
    // next run resumes cleanly.
    onSignal: () => abort.abort(),
    onForceExit: () => {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { error: 'force-exit: graceful drain did not complete' });
    },
  });

  // Phase D.2 — retention sweep (only when the operator opted in).
  const retentionDays = resolveRetentionDays(optString(args, 'retention-days'));
  if (retentionDays !== undefined) {
    enforceRetention({ outCsv: out, retentionDays });
  }
  // Phase D.1 — suppression list (flag > env > auto-discovered suppression.csv).
  const suppression = SuppressionList.resolve({ flagPath: optString(args, 'suppression-list'), outCsv: out });

  const outputLock = acquireOutputLock(out, { command: 'scrape', mode: 'live', category });
  try {
    const summary = await runLiveMode({
      out,
      category,
      province: optString(args, 'province'),
      region: optString(args, 'region'),
      comuniCsv: optString(args, 'comuni'),
      maxPages: parseIntOrUndefined(optString(args, 'max-pages')),
      interDelayMs: parseIntOrUndefined(optString(args, 'inter-delay-ms')),
      runMaps: !!args.flags['maps'],
      mapsCoverage,
      headless: args.flags['headless'] !== 'false',
      checkpointPath: optString(args, 'checkpoint'),
      restartEvery: parseIntOrUndefined(optString(args, 'restart-every')),
      fresh: !!args.flags['fresh'],
      allowMissingJsonl: !!args.flags['allow-missing-jsonl'],
      skipPreflight: !!args.flags['skip-preflight'],
      abortSignal: abort.signal,
      suppression,
    });

    // Phase A.4 — yield anomaly check against run history (advisory only).
    // History is read BEFORE this run's record is appended, so the baseline
    // never includes the run being assessed.
    const history = readRunHistory(runsFilePath(out));
    const yieldCheck = assessYield(history, { category, comuniYield: summary.comuni_yield });
    if (yieldCheck.suspect) {
      logger.warn(
        { suspect_comuni: yieldCheck.suspectComuni, detail: yieldCheck.detail },
        '[scrape] ⚠ YIELD ANOMALY — one or more comuni yielded <30% of their historical average. ' +
          'Possible markup drift, consent regression, or IP throttling. Inspect before trusting this output.'
      );
      getNotifier().notify({
        kind: 'yield_anomaly',
        title: 'Scrape yield anomaly',
        body: `Comuni below 30% of historical average: ${yieldCheck.suspectComuni.join(', ')}.`,
        meta: { run_id: runId, out_csv: out },
      });
    }

    recorder.update({
      leads_out: summary.leads,
      suppressed: summary.suppressed || undefined,
      comuni_yield: summary.comuni_yield,
      suspect: yieldCheck.suspect || undefined,
      suspect_comuni: yieldCheck.suspect ? yieldCheck.suspectComuni : undefined,
    });

    // Phase B.2 — automatic output validation (warn-only).
    await postRunValidate({
      csvPath: out,
      jsonlPath: summary.output_jsonl,
      flavor: 'raw',
      runId,
    });

    if (summary.interrupted) {
      recorder.finish('interrupted', EXIT.INTERRUPTED);
      getNotifier().notify({
        kind: 'run_interrupted',
        title: 'Scrape interrupted',
        body: `Partial outputs on disk (${summary.leads} leads); checkpoint is resume-ready.`,
        meta: { run_id: runId },
      });
      return EXIT.INTERRUPTED;
    }

    recorder.finish('ok', EXIT.OK);
    getNotifier().notify({
      kind: 'run_complete',
      title: 'Scrape complete',
      body: `${summary.leads} unique leads from ${summary.total_cards} cards (${summary.comuni_count} comuni)${yieldCheck.suspect ? ' — YIELD SUSPECT' : ''}.`,
      meta: { run_id: runId, out_csv: out },
    });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof PreflightError) {
      recorder.finish('preflight_failed', EXIT.PREFLIGHT_FAILED, { error: err.message });
      getNotifier().notify({
        kind: 'preflight_failed',
        title: `Preflight failed (${err.source.toUpperCase()})`,
        body: err.message,
        meta: { run_id: runId },
      });
      logger.error({ source: err.source, selector: err.selector }, `[scrape] ${err.message}`);
      return EXIT.PREFLIGHT_FAILED;
    }
    recorder.finish('fatal', EXIT.FATAL, { error: (err as Error).message });
    getNotifier().notify({ kind: 'run_failed', title: 'Scrape failed', body: (err as Error).message, meta: { run_id: runId } });
    throw err;
  } finally {
    outputLock.release();
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run scrape -- --fixture pg=<pg.html>,maps=<maps.html> --category "<category>" --out output/raw.csv
  pnpm run scrape -- --category "<category>" --province BL --out output/raw.csv

Modes:
  --fixture <spec>          Offline parser mode. Use pg=path,maps=path or a single path plus --source.
  --source <pg|maps>        Source type when --fixture is a single path.
  --category <text>         Business category to scrape.
  --province <CC>           Live mode province code.
  --comuni "A,B,C"          Live mode explicit municipality list.
  --maps                    Also scrape Google Maps in live mode.
  --max-pages <n>           Per-municipality PG page cap.
  --checkpoint <path>       Resume checkpoint path.
  --fresh                   Clear previous output/checkpoint for this target.
  --headless false          Show browser in live mode.
  --skip-preflight          Skip the selector health check (Phase A.3).
  --run-id <id>             Externally supplied run id (used by the run command).
  --suppression-list <csv>  Do-not-contact list (phone,vat,reason,date). Also: SUPPRESSION_LIST env
                            or auto-discovered suppression.csv next to the output.
  --retention-days <n>      Delete output artifacts older than n days at run start (default: off).
  --out <path>              Required raw CSV output path.

Observability (Phase A):
  LOG_FILE env              Per-run JSONL log. Default: <out>.log.jsonl. LOG_FILE=off disables.
  NOTIFY env                local (default) | off. Completion/anomaly events.
  Run history               One record per run appended to <outdir>/_runs.jsonl.

Exit codes: 0 ok | 2 fatal | 3 preflight failed | 130 interrupted.
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
    logger.error({ err: err.message, stack: err.stack }, '[scrape] failed');
    process.exit(EXIT.FATAL);
  });
