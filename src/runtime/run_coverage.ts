import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Checkpoint, CheckpointEntry } from './checkpoint';

/** Durable contract for a scrape target. A CSV alone is never a completion signal. */
export type CoverageStatus = 'success' | 'empty_verified' | 'failed';
export const RECOVERY_ERROR_CLASSES = [
  'network_exhausted',
  'maps_no_feed',
  'selector_drift',
  'consent_wall',
  'blocked_or_captcha',
  'checkpoint_integrity',
  'unknown',
] as const;
export type RecoveryErrorClass = (typeof RECOVERY_ERROR_CLASSES)[number];

export function isRecoveryErrorClass(value: unknown): value is RecoveryErrorClass {
  return typeof value === 'string' && (RECOVERY_ERROR_CLASSES as readonly string[]).includes(value);
}

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
  url?: string;
  page_title?: string;
  /** Relative to the output directory; never a host-specific absolute path. */
  screenshot_path?: string;
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
  /** Number of failed queries in the full local coverage manifest. */
  total_failed_query_count?: number;
  /** The dispatch payload is diagnostic-only; full failures stay local. */
  failures_truncated?: boolean;
  failures: Array<Pick<CoverageQuery,
    'key' | 'provider' | 'category' | 'location' | 'page' | 'error_class' | 'reason' |
    'evidence_fingerprint' | 'url' | 'page_title' | 'screenshot_path'
  >>;
}

// A repository_dispatch payload and its GitHub Actions environment must remain
// small. The local coverage manifest is the source of truth; this envelope is
// only a bounded diagnostic sample that lets the recovery agent identify a
// common browser/parser failure without receiving lead data or whole logs.
export const MAX_RECOVERY_ENVELOPE_FAILURES = 20;
const MAX_RECOVERY_REASON_CHARS = 800;
const MAX_RECOVERY_KEY_CHARS = 512;
const MAX_RECOVERY_TARGET_CHARS = 256;
const MAX_RECOVERY_URL_CHARS = 2_048;
const MAX_RECOVERY_SCREENSHOT_CHARS = 512;

/** A completion contract breach is fatal: a partial output must never acquire a complete marker. */
export class CoverageContractError extends Error {
  constructor(detail: string) {
    super(`Coverage completion contract error: ${detail}`);
    this.name = 'CoverageContractError';
  }
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

export function jsonlOutputPath(outCsv: string): string {
  return outCsv.replace(/\.csv$/i, '') + '.jsonl';
}

export function classifyRecoveryError(reason: string | undefined): RecoveryErrorClass {
  const value = (reason ?? '').toLowerCase();
  if (/net::err_|err_network|err_name_not_resolved|err_connection|err_timed_out|err_internet_disconnected|timeout.*exceeded|navigation timeout|econnreset|etimedout|eai_again|socket hang up/.test(value)) {
    return 'network_exhausted';
  }
  if (/consent|cookie/.test(value)) return 'consent_wall';
  if (/captcha|unusual traffic|access denied|forbidden|blocked|cloudflare/.test(value)) return 'blocked_or_captcha';
  if (value === 'no_feed' || value.includes('no_feed') || value.includes('no result feed')) return 'maps_no_feed';
  if (/selector|markup|matched 0 elements|unverified_empty|dropped_all_cards|feed_missing_after_scroll/.test(value)) return 'selector_drift';
  if (/checkpoint|missingpriorjsonl|prior jsonl|navigation_in_progress/.test(value)) return 'checkpoint_integrity';
  return 'unknown';
}

function parseCheckpointKey(key: string): { provider: 'pg' | 'maps'; category: string; location: string; page?: number } | undefined {
  const pieces = key.split(':');
  if ((pieces[0] !== 'pg' && pieces[0] !== 'maps') ||
    (pieces.length !== 3 && pieces.length !== 4) || !pieces[1] || !pieces[2]) return undefined;
  const pageToken = pieces[3];
  if (pageToken !== undefined && !/^p[1-9]\d*$/.test(pageToken)) return undefined;
  const page = pageToken === undefined ? undefined : Number(pageToken.slice(1));
  if (page !== undefined && !Number.isSafeInteger(page)) return undefined;
  return {
    provider: pieces[0],
    category: pieces[1],
    location: pieces[2],
    page,
  };
}

/**
 * Keep completion semantics in this non-agent-editable module. Recovery
 * patches may improve checkpoint persistence, but they cannot relax the
 * independent proof required to write a completion manifest.
 */
function hasVerifiedTerminalOutcome(entry: CheckpointEntry): boolean {
  return entry.status === 'done' &&
    (entry.empty_verified === true || (entry.parsed ?? 0) > 0);
}

function toDiagnosticReference(outCsv: string, screenshotPath: string | undefined): string | undefined {
  if (!screenshotPath) return undefined;
  const outDir = path.dirname(path.resolve(outCsv));
  const relative = path.relative(outDir, path.resolve(screenshotPath));
  // A recovery envelope crosses machine boundaries. Do not leak arbitrary host
  // paths; ordinary diagnostics live next to the output and remain referencable.
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' ? relative : undefined;
}

function bounded(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

function compactRecoveryFailure(query: CoverageQuery): RecoveryEnvelope['failures'][number] {
  if (!query.error_class) {
    throw new CoverageContractError(`failed query is missing an error class: ${query.key}`);
  }
  return {
    key: query.key.slice(0, MAX_RECOVERY_KEY_CHARS),
    provider: query.provider,
    category: query.category.slice(0, MAX_RECOVERY_TARGET_CHARS),
    location: query.location.slice(0, MAX_RECOVERY_TARGET_CHARS),
    page: query.page,
    error_class: query.error_class,
    reason: bounded(query.reason, MAX_RECOVERY_REASON_CHARS),
    evidence_fingerprint: query.evidence_fingerprint,
    url: bounded(query.url, MAX_RECOVERY_URL_CHARS),
    page_title: bounded(query.page_title, 500),
    screenshot_path: bounded(query.screenshot_path, MAX_RECOVERY_SCREENSHOT_CHARS),
  };
}

function toCoverageQuery(outCsv: string, key: string, entry: CheckpointEntry): CoverageQuery | undefined {
  // Successful preflight probes are health checks, not source queries. Failed
  // probes remain visible because they make the planned Maps stage incomplete.
  if (entry.kind === 'preflight' && entry.status === 'done') return undefined;
  const parsed = parseCheckpointKey(key);
  if (!parsed) return undefined;
  // A checkpoint may be durable but not terminal when the process is stopped
  // between setting `pending` and writing its final result. It must remain
  // visible as a failed query: omitting it would let a partial run create a
  // false completion marker.
  const terminalStateMissing = entry.status === 'pending' || entry.status === 'skipped';
  const verifiedTerminal = hasVerifiedTerminalOutcome(entry);
  const unverifiedDone = entry.status === 'done' && !verifiedTerminal;
  const status: CoverageStatus = entry.status === 'failed' || terminalStateMissing || unverifiedDone
    ? 'failed'
    : entry.empty_verified === true ? 'empty_verified' : 'success';
  const reason = terminalStateMissing
    ? entry.reason ?? `checkpoint_${entry.status}_without_terminal_result`
    : unverifiedDone
      ? entry.reason ?? 'unverified_empty_result'
      : entry.reason;
  return {
    key,
    ...parsed,
    status,
    attempts: entry.attempts ?? (terminalStateMissing ? 0 : 1),
    error_class: status === 'failed' ? classifyRecoveryError(reason) : undefined,
    reason,
    evidence_fingerprint: entry.evidence_fingerprint,
    url: entry.url,
    page_title: entry.page_title,
    screenshot_path: toDiagnosticReference(outCsv, entry.screenshot_path),
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
  const queries: CoverageQuery[] = [];
  for (const [key, entry] of input.checkpoint.entries()) {
    if (!parseCheckpointKey(key)) {
      throw new CoverageContractError(`unparseable checkpoint key: ${key}`);
    }
    const query = toCoverageQuery(input.outCsv, key, entry);
    if (query) {
      queries.push(query);
      continue;
    }
    // The only omitted record is a successful preflight health check. All
    // source queries must remain represented in the manifest.
    if (!(entry.kind === 'preflight' && entry.status === 'done')) {
      throw new CoverageContractError(`checkpoint entry was unexpectedly omitted: ${key}`);
    }
  }
  queries.sort((a, b) => a.key.localeCompare(b.key));
  const failures = queries.filter((query) => query.status === 'failed');
  const interrupted = input.forcePartial === true;
  const candidateComplete = failures.length === 0 && !interrupted;
  if (candidateComplete && queries.length === 0) {
    throw new CoverageContractError('a run with no terminal source queries cannot be marked complete');
  }
  if (candidateComplete && !hasCompletionArtifacts(input.outCsv)) {
    throw new CoverageContractError(`missing CSV or JSONL artifact for ${path.resolve(input.outCsv)}`);
  }
  const manifest: CoverageManifest = {
    version: 1,
    run_id: input.runId,
    generated_at: new Date().toISOString(),
    output_csv: path.resolve(input.outCsv),
    status: candidateComplete ? 'complete' : 'partial',
    ...(interrupted ? { incomplete_reason: 'interrupted' as const } : {}),
    queries,
    failed_query_count: failures.length,
  };
  writeJsonAtomically(coverageManifestPath(input.outCsv), manifest);
  if (manifest.status === 'complete') {
    writeJsonAtomically(completionMarkerPath(input.outCsv), manifest);
    try { fs.unlinkSync(recoveryEnvelopePath(input.outCsv)); } catch { /* absent is fine */ }
  } else if (failures.length > 0 && !interrupted) {
    try { fs.unlinkSync(completionMarkerPath(input.outCsv)); } catch { /* absent is fine */ }
    const incidentSeed = `${manifest.output_csv}:${failures.map((failure) => `${failure.key}:${failure.error_class}:${failure.evidence_fingerprint ?? ''}`).join('|')}`;
    const envelope: RecoveryEnvelope = {
      version: 1,
      incident_id: crypto.createHash('sha256').update(incidentSeed).digest('hex').slice(0, 24),
      run_id: input.runId,
      output_csv: manifest.output_csv,
      generated_at: manifest.generated_at,
      total_failed_query_count: failures.length,
      failures_truncated: failures.length > MAX_RECOVERY_ENVELOPE_FAILURES,
      failures: failures.slice(0, MAX_RECOVERY_ENVELOPE_FAILURES).map(compactRecoveryFailure),
    };
    writeJsonAtomically(recoveryEnvelopePath(input.outCsv), envelope);
  } else {
    // An interrupt is resumable by the campaign/watchdog; it is not a parser
    // incident that the code-recovery agent can remedy. Even if earlier pages
    // had a real failure, defer dispatch until a non-interrupted resume gives
    // a stable diagnosis rather than mixing shutdown state into an incident.
    try { fs.unlinkSync(completionMarkerPath(input.outCsv)); } catch { /* absent is fine */ }
    try { fs.unlinkSync(recoveryEnvelopePath(input.outCsv)); } catch { /* absent is fine */ }
  }
  return manifest;
}

/** Completion must be proved by the marker, not inferred from a non-empty CSV. */
export function isCompletedOutput(outCsv: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(completionMarkerPath(outCsv), 'utf8'));
    return isValidCompletionManifest(marker, outCsv) &&
      hasMatchingCoverageManifest(marker, outCsv) &&
      hasCompletionArtifacts(outCsv);
  } catch {
    return false;
  }
}

function hasMatchingCoverageManifest(marker: CoverageManifest, outCsv: string): boolean {
  try {
    const coverage = JSON.parse(fs.readFileSync(coverageManifestPath(outCsv), 'utf8'));
    // The two artifacts are intentionally written from the same immutable
    // object. Requiring byte-equivalent semantic JSON prevents a stale marker
    // from surviving a later partial coverage write after a crash.
    return isValidCompletionManifest(coverage, outCsv) && JSON.stringify(coverage) === JSON.stringify(marker);
  } catch {
    return false;
  }
}

function hasCompletionArtifacts(outCsv: string): boolean {
  try {
    const csv = fs.statSync(outCsv);
    const jsonl = fs.statSync(jsonlOutputPath(outCsv));
    // Empty verified runs have an empty JSONL by design, but a CSV writer must
    // always have emitted its header. Both paths must be ordinary files.
    return csv.isFile() && csv.size > 0 && jsonl.isFile();
  } catch {
    return false;
  }
}

function isValidCompletionManifest(value: unknown, outCsv: string): value is CoverageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Partial<CoverageManifest>;
  if (marker.version !== 1 || marker.output_csv !== path.resolve(outCsv) || marker.status !== 'complete' ||
    marker.incomplete_reason !== undefined || marker.failed_query_count !== 0 || !Array.isArray(marker.queries) ||
    marker.queries.length === 0) return false;
  return marker.queries.every((query) => {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
    const candidate = query as Partial<CoverageQuery>;
    return typeof candidate.key === 'string' && candidate.key.length > 0 &&
      (candidate.provider === 'pg' || candidate.provider === 'maps') &&
      typeof candidate.category === 'string' && candidate.category.length > 0 &&
      typeof candidate.location === 'string' && candidate.location.length > 0 &&
      (candidate.page === undefined || (Number.isSafeInteger(candidate.page) && candidate.page > 0)) &&
      (candidate.status === 'success' || candidate.status === 'empty_verified') &&
      typeof candidate.attempts === 'number' && Number.isSafeInteger(candidate.attempts) && candidate.attempts >= 1 &&
      candidate.error_class === undefined;
  });
}
