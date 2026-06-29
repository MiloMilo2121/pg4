import crypto from 'crypto';
import path from 'path';
import { parseArgs, reqString, optString, hasHelp } from './_args';
import { logger, bindRunLogFile } from '../runtime/logger';
import { RunRecorder, EXIT, installInterruptHandler } from '../runtime/run_record';
import { getNotifier } from '../runtime/notifier';
import { runEnrichCommand } from './enrich_command';
import { postRunValidate } from './_post_run';
import { SuppressionList } from '../compliance/suppression';
import { enforceRetention, resolveRetentionDays } from '../compliance/retention';

/**
 * `pnpm run enrich -- --input output/raw.csv --out output/enriched.csv`
 *
 * Thin wrapper: arg parsing + run-record lifecycle + signal handling +
 * exit codes. The pipeline itself lives in `enrich_command.ts` so the
 * `run` command and tests can reuse it.
 *
 * Exit codes (Phase B.3): 0 ok · 1 partial (row errors) · 2 fatal ·
 * 130 interrupted. Never prompts — safe for cron/launchd as-is.
 */
async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    printUsage();
    return EXIT.OK;
  }
  const input = reqString(args, 'input', 'path to raw CSV');
  const csvOut = reqString(args, 'out', 'path to enriched CSV');

  // Phase A.1 — per-run log file alongside outputs (LOG_FILE env overrides).
  const logFile = bindRunLogFile(csvOut.replace(/\.csv$/i, '') + '.log.jsonl');

  const ceilingArg = optString(args, 'cost-ceiling-eur');
  const runCeilingArg = optString(args, 'run-cost-ceiling-eur');

  const runId = optString(args, 'run-id') ?? `run-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const abort = new AbortController();
  const recorder = new RunRecorder({ runId, command: 'enrich', outCsv: csvOut, logFile });
  installInterruptHandler({
    // Fast path: signal the drain. The command notices the abort between
    // rows, finishes in-flight leads, flushes outputs + ledger summary,
    // releases the lock — then main() returns interrupted and exits 130.
    onSignal: () => abort.abort(),
    // Last resort (drain wedged / second Ctrl-C): persist what we know.
    onForceExit: () => {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { error: 'force-exit: graceful drain did not complete' });
    },
  });

  try {
    // Phase D.2 — retention sweep (only when the operator opted in).
    const retentionDays = resolveRetentionDays(optString(args, 'retention-days'));
    if (retentionDays !== undefined) {
      enforceRetention({ outCsv: csvOut, retentionDays });
    }
    // Phase D.1 — suppression list (flag > env > auto-discovered suppression.csv).
    const suppression = SuppressionList.resolve({ flagPath: optString(args, 'suppression-list'), outCsv: csvOut });

    const result = await runEnrichCommand({
      input,
      csvOut,
      mockHttpPath: optString(args, 'mock-http'),
      ledgerPath: optString(args, 'ledger-path'),
      costCeilingEur: ceilingArg ? Number(ceilingArg) : undefined,
      runCostCeilingEur: runCeilingArg ? Number(runCeilingArg) : undefined,
      enablePaid: !!args.flags['enable-paid'],
      includeClosed: !!args.flags['include-closed'],
      suppression,
      runId,
      abortSignal: abort.signal,
    });

    recorder.update({
      leads_in: result.total,
      leads_out: result.total - result.suppressed,
      with_website: result.withWebsite,
      row_errors: result.errors,
      suppressed: result.suppressed || undefined,
      total_cost_eur: result.totalCostEur,
    });

    // Phase B.2 — automatic output validation (warn-only).
    await postRunValidate({
      csvPath: csvOut,
      jsonlPath: result.jsonlOut,
      ledgerPath: result.ledgerPath,
      flavor: 'enriched',
      runId,
    });

    logger.info(
      {
        total: result.total,
        with_website: result.withWebsite,
        errors: result.errors,
        budget_exhausted_leads: result.budgetExhaustedLeads,
        output_csv: path.resolve(csvOut),
        output_jsonl: path.resolve(result.jsonlOut),
        ledger_jsonl: path.resolve(result.ledgerPath),
      },
      '[enrich] done'
    );

    if (result.interrupted) {
      recorder.finish('interrupted', EXIT.INTERRUPTED, { provider_dead: result.providerDead });
      getNotifier().notify({
        kind: 'run_interrupted',
        title: 'Enrich interrupted',
        body: `Run on ${path.basename(csvOut)} interrupted; ${result.total} leads processed before stop, outputs are consistent.`,
        meta: { run_id: result.runId },
      });
      return EXIT.INTERRUPTED;
    }
    const status = result.errors > 0 ? 'partial' : 'ok';
    const code = result.errors > 0 ? EXIT.PARTIAL : EXIT.OK;
    recorder.finish(status, code, { provider_dead: result.providerDead });
    getNotifier().notify({
      kind: 'run_complete',
      title: 'Enrich complete',
      body: `${result.total} leads, ${result.withWebsite} with website, ${result.errors} errors, €${result.totalCostEur.toFixed(4)}.`,
      meta: { run_id: result.runId, status },
    });
    return code;
  } catch (err) {
    recorder.finish('fatal', EXIT.FATAL, { error: (err as Error).message });
    getNotifier().notify({
      kind: 'run_failed',
      title: 'Enrich failed',
      body: (err as Error).message,
    });
    throw err;
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run enrich -- --input output/raw.csv --out output/enriched.csv
  pnpm run enrich -- --input examples/input_companies.csv --out output/examples/enriched.csv --mock-http examples/mock_http_pages.json

Flags:
  --input <path>                Required raw CSV input.
  --out <path>                  Required enriched CSV output.
  --mock-http <json>            Offline URL->HTML fixture. No real HTTP, PG detail fetch, SERP, DNS, or API keys.
  --cost-ceiling-eur <n>        Per-lead paid provider ceiling. Paid remains off unless --enable-paid is set.
  --run-cost-ceiling-eur <n>    Aggregate run ceiling for paid providers.
  --ledger-path <path>          Cost ledger JSONL path. Default: <out>.cost-ledger.jsonl.
  --enable-paid                 Opt in to paid providers already enabled by env and API key.
  --run-id <id>                 Externally supplied run id (used by the run command).
  --include-closed              Also enrich leads Maps marked "Chiuso definitivamente" (default: skipped).
  --suppression-list <csv>      Do-not-contact list (phone,vat,reason,date). Also: SUPPRESSION_LIST env
                                or auto-discovered suppression.csv next to the output.
  --retention-days <n>          Delete output artifacts older than n days at run start (default: off).

Observability (Phase A):
  LOG_FILE env                  Per-run JSONL log. Default: <out>.log.jsonl. LOG_FILE=off disables.
  NOTIFY env                    local (default) | off. Cost/completion events.
  Run history                   One record per run appended to <outdir>/_runs.jsonl.

Exit codes: 0 ok | 1 partial (row errors) | 2 fatal | 130 interrupted.
`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, '[enrich] fatal');
    process.exit(EXIT.FATAL);
  });
