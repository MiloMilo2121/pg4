/**
 * Default model ids per provider — the single registry (env vars override each).
 *
 * `MODELS_VERIFIED_ON` is when every id below was last checked against the
 * vendor's own docs. Models get retired: a default that vanishes turns every
 * call into an error, so refresh this table — and the prices in
 * `providers/pricing.ts` — together.
 */
/** @public Read by humans refreshing this table, not by code. */
export const MODELS_VERIFIED_ON = '2026-09-28';

export const DEFAULT_MODELS = {
  /** Cheap general model (LLM_CHEAP / LLM_REASON fallback). Still active. */
  openai: 'gpt-4o-mini',
  /**
   * Default judge. Valid today. `claude-opus-5-5` is newer and cheaper per token
   * but always thinks (extra output tokens): switch only after re-running the
   * judgment eval (`pnpm judge:eval`) on it.
   */
  anthropic: 'claude-opus-4-8',
  /** Claude through OpenRouter (no dedicated Anthropic key). */
  openrouter: 'anthropic/claude-opus-4-8',
  /** `deepseek-chat` was scheduled for retirement on 2026-07-24; `deepseek-flash` is the current fast model. */
  deepseek: 'deepseek-flash',
  /** `glm-4-flash` is no longer listed; `glm-4.7-flash` is the current free fast tier. */
  zhipu: 'glm-4.7-flash',
  /** `moonshot-v1-8k` is no longer listed; `kimi-k2.6` is the current mid-price model. */
  kimi: 'kimi-k2.6',
  perplexity: 'sonar',
} as const;
