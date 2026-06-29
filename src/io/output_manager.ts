import { CsvWriter } from './csv_writer';
import { JsonlWriter } from './jsonl_writer';
import type { Lead } from '../types/lead';
import { SCHEMA_VERSION } from '../types/lead';
import { logger } from '../runtime/logger';

/**
 * Pairs a CSV writer (deterministic columns) with a JSONL writer (full debug)
 * so callers can stream results to both with one call.
 */
export class OutputManager {
  private csv: CsvWriter;
  private jsonl: JsonlWriter;

  constructor(csvPath: string, jsonlPath: string, flavor: 'raw' | 'enriched', opts: { append?: boolean } = {}) {
    this.csv = new CsvWriter(csvPath, flavor, opts);
    this.jsonl = new JsonlWriter(jsonlPath, opts);
    logger.info({ csvPath, jsonlPath, flavor }, '[OutputManager] writing');
  }

  async write(lead: Lead, debug?: Record<string, unknown>): Promise<void> {
    // Phase C.1 — stamp the schema version on every row (CSV column +
    // JSONL field) so downstream consumers detect capability programmatically.
    lead._schema_version ??= SCHEMA_VERSION;
    await Promise.all([this.csv.write(lead), this.jsonl.write({ ...lead, _debug: debug })]);
  }

  async close(): Promise<void> {
    await Promise.all([this.csv.close(), this.jsonl.close()]);
    logger.info({ csv_rows: this.csv.count(), jsonl_rows: this.jsonl.count() }, '[OutputManager] closed');
  }
}
