/**
 * What one provider call is ASSUMED to cost, in EUR — the single table behind
 * every adapter's `costPerCallEur` and every role-registry step estimate.
 *
 * Why it matters: the cost ledger, the per-lead cap and the run ceiling all use
 * these numbers. Two copies of a price that disagree mean the ledger records
 * less than the plan budgeted, so the ceiling protects less than it appears to
 * (Tavily/Exa were charged 0.005 by their adapters while the plan assumed
 * 0.0074/0.0064). The conservative figure wins.
 *
 * Figures are per call (a search, a scrape, one judgment) converted from vendor
 * USD prices at ≈0.92 €/$. LLM entries are flat per-call estimates; token-based
 * costing from the response `usage` is the intended replacement.
 */
/** @public Read by humans refreshing this table, not by code. */
export const PRICING_VERIFIED_ON = '2026-09-28';

export const CALL_COST_EUR = {
  // SERP
  serper: 0.001,
  tavily: 0.0074,
  exa: 0.0064,
  // page fetch / unblock
  brightdata: 0.00138,
  firecrawl: 0.0046,
  // LLM (flat per-call estimates)
  anthropic: 0.02,
  openrouter: 0.02,
  openai: 0.01,
  deepseek: 0.002,
  zhipu_glm: 0.0003,
  kimi: 0.001,
  perplexity: 0.012,
  // company data / enrichment
  openapi_search: 0.01,
  openapi_advanced: 0.1,
  google_places: 0.06,
  snov: 0.036,
} as const;

/** Hunter bills credits per operation (1 credit ≈ €0.04; verification is half a credit). */
export const HUNTER_OP_COST_EUR = { find: 0.04, domain: 0.04, verify: 0.02 } as const;
