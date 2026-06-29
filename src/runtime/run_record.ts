import fs from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Phase A.2 — run history audit trail.
 *
 * One JSONL record per CLI run, appended to `<outdir>/_runs.jsonl`. The file
 * doubles as:
 *   - operational run history ("what ran last week, what did it cost")
 *   - audit log ("which inputs were processed when" — GDPR Art. 30 support)
 *   - baseline store for yield-anomaly detection (Phase A.4)
 *
 * Records are append-only; the file is never truncated by pg4.
 */

export const EXIT = {
  OK: 0,
  /** Run completed but with degraded results (row errors, failed comuni). */
  PARTIAL: 1,
  FATAL: 2,
  PREFLIGHT_FAILED: 3,
  INTERRUPTED: 130,
} as const;

export type RunStatus = 'ok' | 'partial' | 'fatal' | 'interrupted' | 'preflight_failed';

export interface RunRecord {
  record_version: 1;
  run_id: string;
  command: 'scrape' | 'enrich' | 'run';
  args: string[];
  category?: string;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  status: RunStatus;
  exit_code: number;
  out_csv?: string;
  log_file?: string | null;
  leads_in?: number;
  leads_out?: number;
  with_website?: number;
  row_errors?: number;
  suppressed?: number;
  total_cost_eur?: number;
  /** Per-comune pre-dedupe parsed-lead counts (scrape only). */
  comuni_yield?: Record<string, number>;
  /** Phase A.4 — true when ≥1 comune yielded < 30% of its historical average. */
  suspect?: boolean;
  suspect_comuni?: string[];
  /**
   * Gate-0 — provider ids that made ≥N calls this run and succeeded 0 times
   * (the dns_mx/crtsh silent-failure class). Empty/absent when all healthy.
   */
  provider_dead?: string[];
  error?: string;
}

export const RUNS_FILENAME = '_runs.jsonl';

export function runsFilePath(outCsv: string): string {
  return path.join(path.dirname(path.resolve(outCsv)), RUNS_FILENAME);
}

/**
 * Mutable recorder for a single run. Created at CLI start, finished exactly
 * once — either by the normal completion path or by the signal handler.
 * The latch guarantees one record per run even when both paths race.
 */
export class RunRecorder {
  readonly record: RunRecord;
  private finished = false;
  private readonly runsPath: string;

  constructor(init: {
    runId: string;
    command: RunRecord['command'];
    outCsv: string;
    args?: string[];
    category?: string;
    logFile?: string | null;
  }) {
    this.runsPath = runsFilePath(init.outCsv);
    this.record = {
      record_version: 1,
      run_id: init.runId,
      command: init.command,
      args: init.args ?? process.argv.slice(2),
      category: init.category,
      started_at: new Date().toISOString(),
      status: 'fatal', // pessimistic default; finish() overwrites
      exit_code: EXIT.FATAL,
      out_csv: path.resolve(init.outCsv),
      log_file: init.logFile,
    };
  }

  /** Merge partial fields gathered during the run (counts, cost, yields). */
  update(fields: Partial<RunRecord>): void {
    Object.assign(this.record, fields);
  }

  /**
   * Finalize and append the record. Idempotent — the first call wins.
   * Never throws: a failed audit write must not mask the run outcome.
   */
  finish(status: RunStatus, exitCode: number, fields: Partial<RunRecord> = {}): void {
    if (this.finished) return;
    this.finished = true;
    Object.assign(this.record, fields);
    this.record.status = status;
    this.record.exit_code = exitCode;
    this.record.finished_at = new Date().toISOString();
    this.record.duration_ms = Date.parse(this.record.finished_at) - Date.parse(this.record.started_at);
    try {
      fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });
      fs.appendFileSync(this.runsPath, JSON.stringify(this.record) + '\n', 'utf8');
    } catch (err) {
      logger.warn({ err: (err as Error).message, runsPath: this.runsPath }, '[run-record] failed to append');
    }
  }

  isFinished(): boolean {
    return this.finished;
  }
}

/** Read all parseable run records from a `_runs.jsonl` file. Missing file → []. */
export function readRunHistory(runsPath: string): RunRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(runsPath, 'utf8');
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RunRecord);
    } catch {
      /* skip malformed lines — the audit file may interleave with crashes */
    }
  }
  return out;
}

export interface YieldAssessment {
  suspect: boolean;
  suspectComuni: string[];
  /** comune → { current, historicalAvg } for every flagged comune. */
  detail: Record<string, { current: number; historical_avg: number }>;
}

/**
 * Phase A.4 — yield anomaly detection.
 *
 * Compares this run's per-comune yield against the historical average for the
 * same command+category from prior `ok`/`partial` runs. A comune is suspect
 * when its current yield is below `threshold` (default 30%) of its average.
 * Comuni with no history are skipped (first run on a province is never
 * suspect). The check is advisory — it marks the record, never fails the run.
 */
export function assessYield(
  history: RunRecord[],
  current: { category?: string; comuniYield: Record<string, number> },
  threshold = 0.3
): YieldAssessment {
  const relevant = history.filter(
    (r) =>
      r.comuni_yield &&
      (r.status === 'ok' || r.status === 'partial') &&
      (current.category === undefined || r.category === current.category)
  );
  const suspectComuni: string[] = [];
  const detail: YieldAssessment['detail'] = {};
  for (const [comune, yieldNow] of Object.entries(current.comuniYield)) {
    const past: number[] = [];
    for (const r of relevant) {
      const v = r.comuni_yield![comune];
      if (typeof v === 'number' && v > 0) past.push(v);
    }
    if (past.length === 0) continue;
    const avg = past.reduce((a, b) => a + b, 0) / past.length;
    if (avg > 0 && yieldNow < avg * threshold) {
      suspectComuni.push(comune);
      detail[comune] = { current: yieldNow, historical_avg: avg };
    }
  }
  return { suspect: suspectComuni.length > 0, suspectComuni, detail };
}

/**
 * Phase B.5 — graceful shutdown.
 *
 * First SIGINT/SIGTERM triggers `onSignal` (fast: abort controllers, set
 * flags) and arms a watchdog. The NATURAL completion path is expected to
 * drain in-flight work, flush outputs, write the run record and exit 130
 * by itself — that keeps CSV/JSONL parseable. The watchdog only fires when
 * the drain wedges (Playwright teardown, hung socket): it runs
 * `onForceExit` (sync, last-resort — e.g. fallback run record) and
 * force-exits. A second signal skips the wait entirely.
 */
export function installInterruptHandler(opts: {
  onSignal: () => void;
  onForceExit?: () => void;
  forceExitMs?: number;
}): void {
  const forceExitMs = opts.forceExitMs ?? 45_000;
  let firstSignal = true;
  const forceExit = () => {
    try {
      opts.onForceExit?.();
    } catch {
      /* last resort — never mask the exit */
    }
    process.exit(EXIT.INTERRUPTED);
  };
  const handler = (sig: string) => {
    if (!firstSignal) {
      logger.error('[lifecycle] second interrupt — forcing exit now');
      forceExit();
      return;
    }
    firstSignal = false;
    logger.warn(
      { signal: sig, force_exit_ms: forceExitMs },
      '[lifecycle] interrupt received — draining gracefully (repeat to force exit)'
    );
    try {
      opts.onSignal();
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[lifecycle] onSignal failed');
    }
    const watchdog = setTimeout(() => {
      logger.error('[lifecycle] graceful drain timed out — forcing exit');
      forceExit();
    }, forceExitMs);
    watchdog.unref();
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
