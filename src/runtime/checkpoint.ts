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
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = parsed as Record<string, CheckpointEntry>;
      }
    } catch {
      // Missing / corrupt file is not fatal — start fresh.
      this.state = {};
    }
  }

  private flushSync(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}
