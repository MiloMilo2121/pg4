import { logger } from '../runtime/logger';
import { getNotifier } from '../runtime/notifier';
import { validateOutputs } from '../scripts/validate_output';
import type { OutputFlavor } from '../scripts/validate_output';

/**
 * Phase B.2 — automatic output validation at the end of every run.
 *
 * Warn-only by contract: a validation failure is logged + notified but
 * never changes the run's exit code. Rationale: the outputs are already
 * on disk; failing the process at this point would only hide the data
 * from the operator, while the loud warning tells them exactly what to
 * inspect before delivering.
 */
export async function postRunValidate(opts: {
  csvPath: string;
  jsonlPath: string;
  ledgerPath?: string;
  flavor: OutputFlavor;
  runId?: string;
}): Promise<void> {
  try {
    const summary = await validateOutputs({
      csvPath: opts.csvPath,
      jsonlPath: opts.jsonlPath,
      ledgerPath: opts.ledgerPath,
      flavor: opts.flavor,
    });
    if (summary.ok) {
      logger.info(
        { csv_rows: summary.csv_rows, jsonl_rows: summary.jsonl_rows, found_website: summary.found_website },
        '[validate] post-run output validation passed'
      );
      return;
    }
    logger.warn(
      { errors: summary.errors.slice(0, 20), error_count: summary.errors.length },
      '[validate] ⚠ post-run output validation FAILED — inspect before delivering this output'
    );
    getNotifier().notify({
      kind: 'validation_failed',
      title: 'Output validation failed',
      body: `${summary.errors.length} issue(s) in ${opts.csvPath} — first: ${summary.errors[0] ?? 'n/a'}`,
      meta: { run_id: opts.runId, csv: opts.csvPath },
    });
  } catch (err) {
    // The validator itself must never take the run down.
    logger.warn({ err: (err as Error).message }, '[validate] post-run validation errored (non-fatal)');
  }
}
