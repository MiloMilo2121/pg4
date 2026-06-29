import type { Lead } from './lead';
import type { NormalizedLead } from './discovery';
import type { StageOutcome } from './output';
import type { HttpFetchResult } from './providers';

/**
 * Run-scoped context passed to every stage in the enrichment pipeline.
 * Contains shared infrastructure and per-lead accumulators.
 */
export interface RunContext {
  runId: string;
  startedAt: number;
  costCeilingEur: number;
  abort: AbortSignal;
  /**
   * Phase G — paid providers gate. Default false. Set true via the
   * `--enable-paid` CLI flag / `PAID_PROVIDERS_ENABLED=true` env. When
   * false, no provider with `costPerCallEur > 0` is ever called,
   * regardless of tier or budget.
   */
  paidEnabled?: boolean;
  /**
   * Phase G — run-level cost ceiling (EUR). Aggregate cap across the
   * whole run; once reached, paid providers stop. `undefined` means
   * no run-level cap.
   */
  runCostCeilingEur?: number;
}

export interface PerLeadContext {
  runId: string;
  leadId: string;
  startedAt: number;
  costEur: number;
  providersUsed: Set<string>;
  layersAttempted: string[];
  abort: AbortSignal;
  /**
   * Per-lead cost ceiling in EUR. Threaded from `RunContext.costCeilingEur`
   * for fast access inside stages. When `costEur >= costCeilingEur`,
   * stages must downgrade to free-tier providers (`maxTier: 0`) for the
   * remainder of this lead's processing.
   */
  costCeilingEur: number;
  /** Set to true the first time the budget is exhausted for this lead. */
  budgetExhausted?: boolean;
  /**
   * Phase G — when true, stages may run paid-tier providers within
   * the per-lead budget. Default false. Threaded from `RunContext`
   * which gets it from the CLI flag / env. The router still enforces
   * per-call cost gates as a defence-in-depth.
   */
  paidEnabled?: boolean;
  /**
   * Phase G hotfix — run-level cost ceiling threaded from
   * `RunContext`. SerpStage forwards it to the router so the paid
   * call is filtered out if `ledger.getTotal() + cost` would exceed
   * the cap.
   */
  runCostCeilingEur?: number;
  /**
   * R6.1 — per-lead HTTP fetch memoization. `verifyCandidates` (and
   * any other caller that wants to opt in) reads/writes this map
   * keyed by canonical URL so the same URL is fetched at most once
   * per lead across stages. The R1 PG-detail stage and HyperGuesser
   * routinely produce the SAME candidate URL; without this cache
   * both stages timed out independently on flaky hosts (Liviana p_recal
   * audit). The cache stores SUCCESSES AND FAILURES — a host that
   * blew up in PgDetailStage will short-circuit in HyperGuesser
   * instead of consuming another retry budget on the same flap.
   *
   * Lifetime: one Map per `PerLeadContext`, GC'd at lead end.
   * Memory bounded by candidates-per-lead × leads-in-flight.
   */
  httpFetchCache: Map<string, HttpFetchResult>;
  /**
   * Phase 1 (free-gold) — the HTML body of the firm's OWN website, captured
   * the moment a stage accepts a strong (piva/phone) website match. Set by
   * the website-discovery stages from `VerifyVerdict.body`; consumed once by
   * `applyFreeGoldExtraction` after the ladder to mine email/PEC/social/VAT
   * at zero marginal HTTP cost. Undefined when no strong match occurred.
   */
  verifiedBody?: string;
}

/**
 * The Stage contract. Every step in the enrichment pipeline implements this.
 * Pure: takes context + lead, returns an outcome (and optionally mutates the lead).
 */
export interface Stage {
  readonly name: string;
  run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome>;
}

/**
 * The product of running the enrichment pipeline on a single lead.
 */
export interface EnrichmentResult {
  lead: Lead;
  outcome: 'success' | 'partial' | 'not_found' | 'error';
  stage_outcomes: Record<string, StageOutcome>;
  duration_ms: number;
  cost_eur: number;
}
