import fs from 'fs';
import { logger } from '../runtime/logger';
import { Checkpoint } from '../runtime/checkpoint';
import { Deduplicator } from './deduper';
import { readJsonlAsLeads } from '../io/jsonl_writer';
import type { Lead } from '../types/lead';

export interface RehydrateInput {
  jsonlPath: string;
  /**
   * The run's output CSV path. Used to distinguish a recoverable partial
   * (CSV present, JSONL missing → hard error) from an ORPHANED checkpoint
   * (both CSV and JSONL absent → nothing to lose → auto-reset + cold start).
   */
  csvPath?: string;
  checkpoint: Checkpoint;
  dedup: Deduplicator;
  sink: Lead[];
  /**
   * When the checkpoint shows done entries but the JSONL is missing, the
   * resulting CSV would silently miss every lead from those pages. We
   * treat that as a HARD ERROR by default. Operator must pass
   * `--allow-missing-jsonl` (or `--fresh` upstream) to proceed.
   */
  allowMissingJsonl?: boolean;
}

export class MissingPriorJsonlError extends Error {
  readonly jsonlPath: string;
  readonly checkpointDone: number;
  constructor(jsonlPath: string, checkpointDone: number) {
    super(
      `[scrape] resume aborted: checkpoint reports ${checkpointDone} done page(s) but the prior JSONL "${jsonlPath}" is missing. ` +
      `Without it the resulting CSV would silently lose every lead from those pages. ` +
      `Re-run with --fresh to start clean, or pass --allow-missing-jsonl to acknowledge the data loss and proceed.`
    );
    this.name = 'MissingPriorJsonlError';
    this.jsonlPath = jsonlPath;
    this.checkpointDone = checkpointDone;
  }
}

/**
 * Re-hydrate `dedup` and `sink` from a prior run's JSONL so that
 * checkpointed-as-done pages can be safely skipped without losing the
 * leads they contributed. Returns the number of NEW unique leads loaded
 * (0 if the checkpoint is empty — i.e. cold start).
 *
 * Throws `MissingPriorJsonlError` when the checkpoint has done entries
 * but the JSONL is missing, unless `allowMissingJsonl: true`. Hard-stop
 * is the contract — see `docs/legacy_failure_taxonomy.md`
 * for why a silent partial CSV is worse than a stop.
 */
export async function rehydrateFromPriorRun(args: RehydrateInput): Promise<number> {
  const { jsonlPath, csvPath, checkpoint, dedup, sink, allowMissingJsonl } = args;
  if (checkpoint.countDone() === 0) return 0;
  if (!fs.existsSync(jsonlPath)) {
    // ORPHANED checkpoint: done entries but NEITHER the JSONL nor the CSV exist
    // (e.g. a run killed before it ever emitted, or a stale cross-province
    // checkpoint). There is demonstrably nothing to preserve → reset and cold
    // start instead of aborting. Post-mortem: this trap cost an rc=2 every time
    // a run was force-killed mid-cell.
    if (csvPath && !fs.existsSync(csvPath)) {
      logger.warn(
        { jsonl: jsonlPath, csv: csvPath, checkpoint_done: checkpoint.countDone() },
        '[scrape] orphaned checkpoint (done entries but no CSV/JSONL to recover) — resetting checkpoint and starting cold'
      );
      checkpoint.clear();
      return 0;
    }
    // CSV present but JSONL missing: the CSV holds leads that resume cannot
    // rehydrate into the deduper, so skipping done pages WOULD drop them.
    if (!allowMissingJsonl) {
      throw new MissingPriorJsonlError(jsonlPath, checkpoint.countDone());
    }
    logger.error(
      { jsonl: jsonlPath, checkpoint_done: checkpoint.countDone() },
      '[scrape] --allow-missing-jsonl: checkpoint will skip pages whose leads cannot be recovered. Output will be incomplete by operator request.'
    );
    return 0;
  }
  const prior = await readJsonlAsLeads(jsonlPath);
  let loaded = 0;
  for (const lead of prior) {
    if (!lead.company_name) continue;
    const existing = dedup.find(lead);
    if (existing) {
      dedup.merge(existing, lead);
    } else {
      dedup.add(lead);
      sink.push(lead);
      loaded += 1;
    }
  }
  logger.info(
    { jsonl: jsonlPath, prior_records: prior.length, loaded_unique: loaded, checkpoint_done: checkpoint.countDone() },
    '[scrape] resumed from prior JSONL — checkpointed pages will be skipped, but their leads are already in the working set'
  );
  return loaded;
}
