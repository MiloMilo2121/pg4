import fs from 'fs';
import path from 'path';
import { logger } from '../runtime/logger';

/**
 * Phase D.2 — data retention enforcement.
 *
 * When `--retention-days N` (or env `RETENTION_DAYS`) is set, output
 * artifacts older than N days are deleted at run start. Default: UNSET —
 * nothing is ever deleted (conservative; the operator must opt in, and
 * the chosen period is a GDPR decision documented in gdpr_posture.md).
 *
 * Scope: data artifacts only (*.csv, *.jsonl, *.log.jsonl, *.checkpoint*)
 * in the OUTPUT DIRECTORY of the current run. Never touched:
 *   - `_runs.jsonl`        (audit trail — legal record of processing)
 *   - `suppression.csv`    (do-not-contact list must outlive the data)
 *   - `*.lock`             (concurrency control)
 *   - anything outside the output directory
 */

const PROTECTED_FILES = new Set(['_runs.jsonl', 'suppression.csv']);
const PRUNABLE_EXT = /\.(csv|jsonl|json)$/i;

export interface RetentionResult {
  deleted: string[];
  scanned: number;
}

export function enforceRetention(opts: { outCsv: string; retentionDays: number; now?: number }): RetentionResult {
  const dir = path.dirname(path.resolve(opts.outCsv));
  const now = opts.now ?? Date.now();
  const cutoffMs = now - opts.retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  let scanned = 0;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { deleted, scanned };
  }

  for (const name of names) {
    if (PROTECTED_FILES.has(name)) continue;
    if (name.endsWith('.lock')) continue;
    if (!PRUNABLE_EXT.test(name)) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    scanned += 1;
    if (st.mtimeMs < cutoffMs) {
      try {
        fs.unlinkSync(full);
        deleted.push(name);
        logger.info({ file: name, age_days: Math.round((now - st.mtimeMs) / 86_400_000) }, '[retention] deleted expired output');
      } catch (err) {
        logger.warn({ file: name, err: (err as Error).message }, '[retention] failed to delete');
      }
    }
  }
  if (deleted.length > 0) {
    logger.info({ deleted: deleted.length, retention_days: opts.retentionDays, dir }, '[retention] sweep complete');
  }
  return { deleted, scanned };
}

/** Parse the retention period from flag/env. Undefined = retention off. */
export function resolveRetentionDays(flagValue: string | undefined): number | undefined {
  const raw = flagValue ?? process.env.RETENTION_DAYS;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--retention-days must be a positive number of days, got "${raw}"`);
  }
  return n;
}
