import type { Lead } from '../types/lead';

/**
 * The output-sink seam. The engine's scrape/enrich loop writes each finished
 * lead to a `LeadSink`. Today that is the CSV/JSONL writer; the SaaS adds a
 * Postgres sink WITHOUT removing CSV — both implement this interface, so the
 * same engine can target either (or a tee of both) by construction.
 *
 * REUSE vs ADD: the interface is new; the CSV implementation wraps the
 * existing OutputManager unchanged (see csv_jsonl_sink.ts).
 */
export interface LeadWriteOutcome {
  /** Stable id of the persisted record (db id, or the dedup key for CSV). */
  id: string;
  /** True when this write merged into an existing record (dedup hit). */
  merged: boolean;
}

export interface LeadSink {
  write(lead: Lead): Promise<LeadWriteOutcome>;
  /** Flush any buffered writes (no-op for unbuffered sinks). */
  flush?(): Promise<void>;
  close(): Promise<void>;
}
