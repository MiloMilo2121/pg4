import crypto from 'crypto';
import { CostLedger } from './cost_ledger';
import { getConfig } from '../config/env';
import type { ResolvedConfig } from '../config/env';
import type { PerLeadContext, RunContext } from '../types/enrichment';

export interface RunOptions {
  /** Persist CostLedger entries as JSONL at this path (one record per call). */
  ledgerJsonlPath?: string;
  /** Override the per-lead cost ceiling from config/env. */
  costCeilingEur?: number;
  /**
   * When true, stages may run paid providers within the
   * per-lead and per-run budgets. Default false. Default-deny is
   * the load-bearing safety: a misconfigured ceiling cannot
   * accidentally enable paid calls.
   */
  paidEnabled?: boolean;
  /** Run-level cost cap. `undefined` = no aggregate cap. */
  runCostCeilingEur?: number;
  /**
   * Externally supplied run id. The `run` command generates
   * one id and threads it through scrape + enrich so the run record,
   * ledger, and log file all correlate. Default: generated.
   */
  runId?: string;
  /**
   * Externally supplied abort signal (SIGINT/SIGTERM →
   * graceful drain). Default: a never-aborting signal.
   */
  abortSignal?: AbortSignal;
}

/**
 * Container for the shared infrastructure used across a whole run
 * (one CLI invocation processes one CSV).
 */
export interface Run {
  ctx: RunContext;
  cfg: ResolvedConfig;
  ledger: CostLedger;
}

export function createRun(opts: RunOptions = {}): Run {
  const cfg = getConfig();
  const runId = opts.runId ?? `run-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const ledger = new CostLedger({ jsonlPath: opts.ledgerJsonlPath, runId });
  const ctx: RunContext = {
    runId,
    startedAt: Date.now(),
    costCeilingEur: opts.costCeilingEur ?? cfg.pipeline.costCeilingEurPerLead,
    abort: opts.abortSignal ?? new AbortController().signal,
    paidEnabled: opts.paidEnabled === true,
    runCostCeilingEur: opts.runCostCeilingEur,
  };
  return { ctx, cfg, ledger };
}

export function createPerLeadContext(run: Run): PerLeadContext {
  return {
    runId: run.ctx.runId,
    leadId: crypto.randomUUID(),
    startedAt: Date.now(),
    costEur: 0,
    providersUsed: new Set(),
    layersAttempted: [],
    abort: run.ctx.abort,
    costCeilingEur: run.ctx.costCeilingEur,
    paidEnabled: run.ctx.paidEnabled === true,
    runCostCeilingEur: run.ctx.runCostCeilingEur,
    httpFetchCache: new Map(),
  };
}

/**
 * Budget gate helper used by enrichment stages. Returns the maximum tier
 * the stage is allowed to use given the lead's remaining budget. Tiers
 * 0–1 are always allowed (free deterministic + free-or-cheap SERP);
 * higher tiers are blocked once the ceiling is hit.
 */
export function tierCapForLead(perLead: PerLeadContext, defaultMax = 4): number {
  if (perLead.costEur >= perLead.costCeilingEur) {
    perLead.budgetExhausted = true;
    return 1;
  }
  return defaultMax;
}
