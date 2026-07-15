import fs from 'fs';
import path from 'path';

/**
 * File-backed checkpoint store. One JSON file per run; keys are
 * "<provider>:<category>:<location>:<page>" (caller chooses the schema).
 *
 * The store is durable across CLI invocations: a re-run picks up where
 * the previous left off. Useful when PG/Maps navigation is interrupted
 * by a captcha mid-batch.
 */

export interface CheckpointEntry {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  /** A preflight probe is operational state, not a scrape query. */
  kind?: 'query' | 'preflight';
  page?: number;
  total_cards?: number;
  parsed?: number;
  dropped?: number;
  overflow?: boolean;
  cap_likely?: boolean;
  ts: number;
  reason?: string;
  /** Navigation attempts consumed before this terminal checkpoint state. */
  attempts?: number;
  /** Hash of a redacted DOM/title diagnostic, never raw page content. */
  evidence_fingerprint?: string;
  /** Request URL for the query. Stored without page content or credentials. */
  url?: string;
  /** Bounded diagnostics for unresolved browser states. */
  page_title?: string;
  screenshot_path?: string;
  /** Explicit proof that a zero-card query rendered a real empty-result state. */
  empty_verified?: boolean;
}

/**
 * A `done` checkpoint alone is not sufficient to skip a query on resume.
 * Legacy checkpoints could mark a parser/blocked page as `done, parsed: 0`.
 * Only extracted records or an explicit source-level empty proof are terminal.
 */
export function isVerifiedTerminalQuery(entry: CheckpointEntry | undefined): boolean {
  return entry?.status === 'done' &&
    (entry.empty_verified === true || (entry.parsed ?? 0) > 0);
}

/**
 * A broken checkpoint is a data-integrity incident, not an empty checkpoint.
 * Treating it as fresh can overwrite the prior JSONL with only the later
 * partial work, so callers must stop or explicitly use `--fresh`.
 */
export class CheckpointIntegrityError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail: string) {
    super(`Checkpoint integrity error at "${filePath}": ${detail}. Preserve the existing artifacts and re-run with --fresh only after review.`);
    this.name = 'CheckpointIntegrityError';
    this.filePath = filePath;
  }
}

export class Checkpoint {
  private state: Record<string, CheckpointEntry> = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  has(key: string): boolean {
    return key in this.state;
  }

  isDone(key: string): boolean {
    return this.state[key]?.status === 'done';
  }

  get(key: string): CheckpointEntry | undefined {
    return this.state[key];
  }

  /** Immutable snapshot for coverage manifests and recovery tooling. */
  entries(): Array<[string, CheckpointEntry]> {
    return Object.entries(this.state).map(([key, entry]) => [key, { ...entry }]);
  }

  /** Persist a new entry and flush to disk. Synchronous on purpose: a
   *  scraper run is interrupt-tolerant only if the file is up-to-date. */
  set(key: string, entry: Omit<CheckpointEntry, 'ts'> & { ts?: number }): void {
    this.state[key] = { ts: Date.now(), ...entry };
    this.flushSync();
  }

  /** Number of keys with status === 'done'. */
  countDone(): number {
    let n = 0;
    for (const v of Object.values(this.state)) if (v.status === 'done') n += 1;
    return n;
  }

  /** Reset (used by tests + when the operator wants to re-run from zero). */
  clear(): void {
    this.state = {};
    this.flushSync();
  }

  /**
   * Build a stable composite key from the parts a typical scrape uses.
   * Caller can pass any key directly to set/get/has.
   */
  static buildKey(parts: { provider: 'pg' | 'maps'; category: string; location: string; page?: number }): string {
    const pieces = [parts.provider, parts.category.toLowerCase(), parts.location.toLowerCase()];
    if (parts.page !== undefined) pieces.push(`p${parts.page}`);
    return pieces.join(':');
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new CheckpointIntegrityError(this.filePath, `cannot read checkpoint: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CheckpointIntegrityError(this.filePath, `invalid JSON: ${(err as Error).message}`);
    }
    if (!isCheckpointState(parsed)) {
      throw new CheckpointIntegrityError(this.filePath, 'invalid checkpoint shape');
    }
    this.state = parsed;
  }

  private flushSync(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function isCheckpointState(value: unknown): value is Record<string, CheckpointEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowedStatuses = new Set<CheckpointEntry['status']>(['pending', 'done', 'failed', 'skipped']);
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Partial<CheckpointEntry>;
    const nonNegativeInteger = (value: unknown): boolean =>
      value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
    const emptyProofIsCoherent = candidate.empty_verified === undefined ||
      (candidate.empty_verified === true && candidate.status === 'done' && (candidate.parsed ?? 0) === 0);
    return allowedStatuses.has(candidate.status as CheckpointEntry['status']) &&
      typeof candidate.ts === 'number' && Number.isFinite(candidate.ts) &&
      (candidate.kind === undefined || candidate.kind === 'query' || candidate.kind === 'preflight') &&
      nonNegativeInteger(candidate.page) &&
      nonNegativeInteger(candidate.total_cards) &&
      nonNegativeInteger(candidate.parsed) &&
      nonNegativeInteger(candidate.dropped) &&
      nonNegativeInteger(candidate.attempts) &&
      (candidate.overflow === undefined || typeof candidate.overflow === 'boolean') &&
      (candidate.cap_likely === undefined || typeof candidate.cap_likely === 'boolean') &&
      optionalString(candidate.reason) &&
      optionalString(candidate.evidence_fingerprint) &&
      optionalString(candidate.url) &&
      optionalString(candidate.page_title) &&
      optionalString(candidate.screenshot_path) &&
      emptyProofIsCoherent;
  });
}
