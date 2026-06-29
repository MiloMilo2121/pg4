import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify';
import type { Lead } from '../types/lead';
import { ENRICHED_CSV_COLUMNS, RAW_CSV_COLUMNS } from '../types/lead';

export type CsvFlavor = 'raw' | 'enriched';

export class CsvWriter {
  private stream: fs.WriteStream;
  private stringifier: ReturnType<typeof stringify>;
  private columns: readonly string[];
  private rowsWritten = 0;
  private done: Promise<void>;

  constructor(filePath: string, flavor: CsvFlavor, opts: { append?: boolean } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const append = !!opts.append && fs.existsSync(filePath);
    this.columns = flavor === 'raw' ? RAW_CSV_COLUMNS : ENRICHED_CSV_COLUMNS;
    this.stream = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
    this.stringifier = stringify({
      header: !append,
      columns: this.columns as unknown as string[],
      quoted_empty: false,
      cast: {
        boolean: (v) => (v ? 'true' : 'false'),
        object: (v) => JSON.stringify(v),
      },
    });
    this.stringifier.pipe(this.stream);

    this.done = new Promise<void>((resolve, reject) => {
      this.stream.on('finish', () => resolve());
      this.stream.on('error', reject);
      this.stringifier.on('error', reject);
    });
  }

  async write(lead: Lead): Promise<void> {
    const row: Record<string, unknown> = {};
    // CSV serialization rules:
    //   - `sources[]` (Lead union of contributing sources) is rendered as
    //     `PG+MAPS` so the column is human-readable. The JSONL keeps the
    //     structured array. This bridges Phase 3.7 §9 — provenance stays
    //     lossless across the two output formats.
    //   - everything else is rendered as the JS value, with object/array
    //     fallback to JSON.stringify by csv-stringify.
    for (const col of this.columns) {
      let v = (lead as Record<string, unknown>)[col];
      if (col === 'source') {
        const arr = Array.isArray((lead as Lead).sources) ? (lead as Lead).sources! : v ? [String(v)] : [];
        v = arr.length > 0 ? arr.join('+') : v;
      }
      row[col] = v === undefined || v === null ? '' : v;
    }
    if (!this.stringifier.write(row)) {
      await new Promise<void>((resolve) => this.stringifier.once('drain', () => resolve()));
    }
    this.rowsWritten += 1;
  }

  async close(): Promise<void> {
    this.stringifier.end();
    await this.done;
  }

  count(): number {
    return this.rowsWritten;
  }
}
