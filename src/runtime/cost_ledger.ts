import fs from 'fs';
import path from 'path';
import { logger } from './logger';

interface LedgerEntry {
  provider: string;
  family: string;
  cost_eur: number;
  ts: number;
  success: boolean;
  /** Optional informational tag — typed by callers when they classify a failure. */
  kind?: 'success' | 'empty' | 'blocked' | 'rate_limit' | 'transport' | 'timeout' | 'other';
  /** Optional caller-provided context (lead id, run id, query, …). Non-PII strings only. */
  meta?: Record<string, string | number | boolean>;
}

export interface CostLedgerOptions {
  /**
   * If set, every `record()` is appended as one JSONL line to this file.
   * Used for durable mid-run cost observability + post-mortem analysis.
   * In-memory aggregation continues to work either way.
   */
  jsonlPath?: string;
  /** Stable run identifier — written on every line + the final summary. */
  runId?: string;
  /**
   * Phase D.5.1 — when `jsonlPath` is set and this is `false` (default),
   * the file is **truncated** at construction so the resulting JSONL
   * contains only THIS run's entries + summary. CSV / JSONL outputs
   * already truncate; the ledger now matches. Pass `true` to retain
   * the legacy append behaviour.
   *
   * Background: rerunning `enrich` against the same output path used
   * to leave stacked summary lines + duplicated per-call entries in
   * the ledger. The CSV / JSONL got overwritten cleanly but the
   * ledger inflated — direct_fetch counts read from the ledger were
   * the sum of every prior run. Verified during the p66 audit.
   */
  appendToExistingFile?: boolean;
}

/**
 * Cost ledger.
 *
 * pg3's CostLedger persisted to disk (Phase 3.7 audit found 16K+ entries
 * per batch). pg4 keeps an in-memory aggregator AND, when `jsonlPath` is
 * configured, mirrors every record to disk as JSONL — one entry per
 * provider call. The final summary is appended as one extra line with
 * `kind: 'summary'` so post-mortem readers can find it deterministically.
 */
export class CostLedger {
  private entries: LedgerEntry[] = [];
  private readonly jsonlPath?: string;
  private readonly runId: string;
  private summaryFlushed = false;

  constructor(opts: CostLedgerOptions = {}) {
    this.jsonlPath = opts.jsonlPath;
    this.runId = opts.runId ?? `run-${Date.now()}`;
    if (this.jsonlPath) {
      fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true });
      if (!opts.appendToExistingFile) {
        // Truncate the file so this run's ledger does not get appended
        // to a previous run's entries. Matches CSV / JSONL behaviour.
        try {
          fs.writeFileSync(this.jsonlPath, '', 'utf8');
        } catch (err) {
          logger.warn({ err: (err as Error).message, jsonlPath: this.jsonlPath }, '[CostLedger] failed to truncate');
        }
      }
    }
  }

  record(
    provider: string,
    family: string,
    costEur: number,
    success: boolean,
    extra: { kind?: LedgerEntry['kind']; meta?: LedgerEntry['meta'] } = {}
  ): void {
    const entry: LedgerEntry = {
      provider,
      family,
      cost_eur: costEur,
      ts: Date.now(),
      success,
      kind: extra.kind ?? (success ? 'success' : 'other'),
      meta: extra.meta,
    };
    this.entries.push(entry);
    this.appendJsonl({ ...entry, run_id: this.runId });
  }

  getTotal(): number {
    let sum = 0;
    for (const e of this.entries) sum += e.cost_eur;
    return sum;
  }

  getByProvider(): Record<string, { calls: number; cost_eur: number; success_rate: number; by_kind: Record<string, number> }> {
    const acc: Record<string, { calls: number; cost_eur: number; ok: number; by_kind: Record<string, number> }> = {};
    for (const e of this.entries) {
      const a = (acc[e.provider] ??= { calls: 0, cost_eur: 0, ok: 0, by_kind: {} });
      a.calls += 1;
      a.cost_eur += e.cost_eur;
      if (e.success) a.ok += 1;
      const k = e.kind ?? 'other';
      a.by_kind[k] = (a.by_kind[k] ?? 0) + 1;
    }
    const out: Record<string, { calls: number; cost_eur: number; success_rate: number; by_kind: Record<string, number> }> = {};
    for (const [k, v] of Object.entries(acc)) {
      out[k] = {
        calls: v.calls,
        cost_eur: v.cost_eur,
        success_rate: v.calls === 0 ? 0 : v.ok / v.calls,
        by_kind: v.by_kind,
      };
    }
    return out;
  }

  getSummary(): {
    run_id: string;
    total_calls: number;
    total_cost_eur: number;
    success_rate: number;
    by_provider: Record<string, { calls: number; cost_eur: number; success_rate: number; by_kind: Record<string, number> }>;
  } {
    if (this.entries.length === 0) {
      return { run_id: this.runId, total_calls: 0, total_cost_eur: 0, success_rate: 0, by_provider: {} };
    }
    let cost = 0;
    let ok = 0;
    for (const e of this.entries) {
      cost += e.cost_eur;
      if (e.success) ok += 1;
    }
    return {
      run_id: this.runId,
      total_calls: this.entries.length,
      total_cost_eur: cost,
      success_rate: ok / this.entries.length,
      by_provider: this.getByProvider(),
    };
  }

  /** Compute cost so far, optionally filtered by `meta.lead_id`. */
  costForLead(leadId: string): number {
    let s = 0;
    for (const e of this.entries) {
      if (e.meta && e.meta.lead_id === leadId) s += e.cost_eur;
    }
    return s;
  }

  /**
   * Emit a single structured log line + (when `jsonlPath` is set) append
   * a final `kind:'summary'` JSONL row. Idempotent.
   */
  flushSummary(extra: Record<string, unknown> = {}): void {
    if (this.summaryFlushed) return;
    this.summaryFlushed = true;
    const summary = { ...this.getSummary(), ...extra };
    logger.info(summary, '[CostLedger] run summary');
    this.appendJsonl({ ...summary, kind: 'summary', ts: Date.now() });
  }

  /** Diagnostic. */
  getRunId(): string {
    return this.runId;
  }

  // Back-compat shim for older call sites that didn't track kinds.
  logSummary(): void {
    this.flushSummary();
  }

  private appendJsonl(obj: unknown): void {
    if (!this.jsonlPath) return;
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(obj) + '\n', 'utf8');
    } catch (err) {
      // Don't crash the pipeline because the disk hiccupped — log once.
      logger.warn({ err: (err as Error).message, jsonlPath: this.jsonlPath }, '[CostLedger] failed to append');
    }
  }
}
