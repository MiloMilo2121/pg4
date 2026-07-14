import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Checkpoint, CheckpointEntry } from './checkpoint';

/** Durable contract for a scrape target. A CSV alone is never a completion signal. */
export type CoverageStatus = 'success' | 'empty_verified' | 'failed';
export type RecoveryErrorClass =
  | 'network_exhausted'
  | 'maps_no_feed'
  | 'selector_drift'
  | 'consent_wall'
  | 'blocked_or_captcha'
  | 'checkpoint_integrity'
  | 'unknown';

export interface CoverageQuery {
  key: string;
  provider: 'pg' | 'maps';
  category: string;
  location: string;
  page?: number;
  status: CoverageStatus;
  attempts: number;
  error_class?: RecoveryErrorClass;
  reason?: string;
  evidence_fingerprint?: string;
}

export interface CoverageManifest {
  version: 1;
  run_id: string;
  generated_at: string;
  output_csv: string;
  status: 'complete' | 'partial';
  /** Present when the run ended before every planned query could terminate. */
  incomplete_reason?: 'interrupted';
  queries: CoverageQuery[];
  failed_query_count: number;
}

export interface RecoveryEnvelope {
  version: 1;
  incident_id: string;
  run_id: string;
  output_csv: string;
  generated_at: string;
  failures: Array<Pick<CoverageQuery, 'key' | 'provider' | 'category' | 'location' | 'page' | 'error_class' | 'reason' | 'evidence_fingerprint'>>;
}

export function coverageManifestPath(outCsv: string): string {
  return outCsv.replace(/\.csv$/i, '') + '.coverage.json';
}

export function completionMarkerPath(outCsv: string): string {
  return outCsv.replace(/\.csv$/i, '') + '.complete.json';
}

export function recoveryEnvelopePath(outCsv: string): string {
  return outCsv.replace(/\.csv$/i, '') + '.recovery.json';
}

export function classifyRecoveryError(reason: string | undefined): RecoveryErrorClass {
  const value = (reason ?? '').toLowerCase();
  if (value === 'no_feed' || value.includes('no_feed') || value.includes('no result feed')) return 'maps_no_feed';
  if (/net::err_|err_network|err_name_not_resolved|err_connection|err_timed_out|err_internet_disconnected|timeout.*exceeded|navigation timeout|econnreset|etimedout|eai_again|socket hang up/.test(value)) {
    return 'network_exhausted';
  }
  if (/consent|cookie/.test(value)) return 'consent_wall';
  if (/captcha|unusual traffic|access denied|forbidden|blocked|cloudflare/.test(value)) return 'blocked_or_captcha';
  if (/selector|markup|matched 0 elements/.test(value)) return 'selector_drift';
  if (/checkpoint|missingpriorjsonl|prior jsonl|navigation_in_progress/.test(value)) return 'checkpoint_integrity';
  return 'unknown';
}

function parseCheckpointKey(key: string): { provider: 'pg' | 'maps'; category: string; location: string; page?: number } | undefined {
  const pieces = key.split(':');
  if ((pieces[0] !== 'pg' && pieces[0] !== 'maps') || pieces.length < 3) return undefined;
  const pageToken = pieces[3];
  return {
    provider: pieces[0],
    category: pieces[1],
    location: pieces[2],
    page: pageToken?.startsWith('p') ? Number(pageToken.slice(1)) : undefined,
  };
}

function toCoverageQuery(key: string, entry: CheckpointEntry): CoverageQuery | undefined {
  const parsed = parseCheckpointKey(key);
  if (!parsed) return undefined;
  // A checkpoint may be durable but not terminal when the process is stopped
  // between setting `pending` and writing its final result. It must remain
  // visible as a failed query: omitting it would let a partial run create a
  // false completion marker.
  const terminalStateMissing = entry.status === 'pending' || entry.status === 'skipped';
  const status: CoverageStatus = entry.status === 'failed' || terminalStateMissing
    ? 'failed'
    : (entry.parsed ?? 0) === 0 ? 'empty_verified' : 'success';
  const reason = terminalStateMissing
    ? entry.reason ?? `checkpoint_${entry.status}_without_terminal_result`
    : entry.reason;
  return {
    key,
    ...parsed,
    status,
    attempts: entry.attempts ?? (terminalStateMissing ? 0 : 1),
    error_class: status === 'failed' ? classifyRecoveryError(reason) : undefined,
    reason,
    evidence_fingerprint: entry.evidence_fingerprint,
  };
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export function writeCoverageArtifacts(input: {
  outCsv: string;
  runId: string;
  checkpoint: Checkpoint;
  /** A graceful interrupt leaves unstarted queries outside the checkpoint. */
  forcePartial?: boolean;
}): CoverageManifest {
  const queries = input.checkpoint.entries()
    .map(([key, entry]) => toCoverageQuery(key, entry))
    .filter((query): query is CoverageQuery => query !== undefined)
    .sort((a, b) => a.key.localeCompare(b.key));
  const failures = queries.filter((query) => query.status === 'failed');
  const interrupted = input.forcePartial === true;
  const manifest: CoverageManifest = {
    version: 1,
    run_id: input.runId,
    generated_at: new Date().toISOString(),
    output_csv: path.resolve(input.outCsv),
    status: failures.length === 0 && !interrupted ? 'complete' : 'partial',
    ...(interrupted ? { incomplete_reason: 'interrupted' as const } : {}),
    queries,
    failed_query_count: failures.length,
  };
  writeJsonAtomically(coverageManifestPath(input.outCsv), manifest);
  if (manifest.status === 'complete') {
    writeJsonAtomically(completionMarkerPath(input.outCsv), manifest);
    try { fs.unlinkSync(recoveryEnvelopePath(input.outCsv)); } catch { /* absent is fine */ }
  } else if (failures.length > 0) {
    try { fs.unlinkSync(completionMarkerPath(input.outCsv)); } catch { /* absent is fine */ }
    const incidentSeed = `${manifest.output_csv}:${failures.map((failure) => `${failure.key}:${failure.error_class}:${failure.evidence_fingerprint ?? ''}`).join('|')}`;
    const envelope: RecoveryEnvelope = {
      version: 1,
      incident_id: crypto.createHash('sha256').update(incidentSeed).digest('hex').slice(0, 24),
      run_id: input.runId,
      output_csv: manifest.output_csv,
      generated_at: manifest.generated_at,
      failures: failures.map(({ key, provider, category, location, page, error_class, reason, evidence_fingerprint }) => ({
        key, provider, category, location, page, error_class, reason, evidence_fingerprint,
      })),
    };
    writeJsonAtomically(recoveryEnvelopePath(input.outCsv), envelope);
  } else {
    // An interrupt is resumable by the campaign/watchdog; it is not a parser
    // incident that the code-recovery agent can remedy. Do not dispatch an
    // empty recovery envelope for it.
    try { fs.unlinkSync(completionMarkerPath(input.outCsv)); } catch { /* absent is fine */ }
    try { fs.unlinkSync(recoveryEnvelopePath(input.outCsv)); } catch { /* absent is fine */ }
  }
  return manifest;
}

/** Completion must be proved by the marker, not inferred from a non-empty CSV. */
export function isCompletedOutput(outCsv: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(completionMarkerPath(outCsv), 'utf8')) as CoverageManifest;
    const queries = Array.isArray(marker.queries) ? marker.queries : [];
    const failed = queries.filter((query) => query?.status === 'failed').length;
    return marker.version === 1 &&
      marker.output_csv === path.resolve(outCsv) &&
      marker.status === 'complete' &&
      queries.length > 0 &&
      marker.failed_query_count === 0 &&
      failed === 0;
  } catch {
    return false;
  }
}
