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
    return allowedStatuses.has(candidate.status as CheckpointEntry['status']) &&
      typeof candidate.ts === 'number' && Number.isFinite(candidate.ts);
  });
}
