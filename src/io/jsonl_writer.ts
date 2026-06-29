import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { Lead } from '../types/lead';

/**
 * Read every line of a JSONL file and return parsed objects. Malformed
 * lines are skipped silently (callers can compare `out.length` against
 * the file's line count if they need a strict check).
 *
 * Phase 4.1: used by the live scraper to rebuild the deduper state on
 * resume — checkpoint counters alone are not enough to reconstruct the
 * lead set, but the JSONL is the lossless record of what was emitted.
 */
export async function readJsonlObjects<T = unknown>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];
  const out: T[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Convenience wrapper: type-pinned to Lead. */
export async function readJsonlAsLeads(filePath: string): Promise<Lead[]> {
  return readJsonlObjects<Lead>(filePath);
}

/**
 * Append-only JSONL writer for full debug payloads (one JSON object per line).
 */
export class JsonlWriter {
  private stream: fs.WriteStream;
  private rowsWritten = 0;

  constructor(filePath: string, opts: { append?: boolean } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const append = !!opts.append && fs.existsSync(filePath);
    this.stream = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
  }

  async write(obj: unknown): Promise<void> {
    const line = JSON.stringify(obj) + '\n';
    if (!this.stream.write(line)) {
      await new Promise<void>((resolve) => this.stream.once('drain', () => resolve()));
    }
    this.rowsWritten += 1;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  count(): number {
    return this.rowsWritten;
  }
}
