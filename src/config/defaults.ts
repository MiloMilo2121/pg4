/**
 * Hard-coded defaults. Anything tunable in production goes through env →
 * `config/env.ts` → here. No magic numbers in modules.
 */

import { CHROME_MAJOR } from './browser_versions';
import { DEFAULT_MODELS } from './models';

export const DEFAULTS = {
  pipeline: {
    concurrency: 4,
    costCeilingEurPerLead: 0.10,
    requestTimeoutMs: 8000,
    /**
     * Deadline for one enrichment stage. On expiry the stage's signal aborts
     * its I/O, the stage is recorded as `ERROR_TIMEOUT_FETCH` and the ladder
     * moves on. Paid stages whose provider legitimately takes longer declare
     * their own `Stage.timeoutMs` instead.
     */
    perStageTimeoutMs: 12000,
    /**
     * Shorter timeout for HYPER-GUESSER candidate fetches. A guessed domain that
     * resolves but takes >5s to answer is almost never the real site (the log
     * analysis showed ~2.8k guess fetches wasting the full 8s timeout). Real SMB
     * sites answer fast; this caps the wasted wall-time without losing recall.
     */
    guessTimeoutMs: 5000,
    /**
     * Transport-class retry schedule for `verifyCandidates`.
     * `verifyRetryDelaysMs.length` is the number of EXTRA attempts after
     * the first fetch. Delays carry ±20% jitter at runtime.
     *
     * Triggers (per attempt): `transport` / `timeout` failure kinds, or
     * upstream 502 / 503 / 504. Anything else (4xx, 429, semantic
     * reject, parked, common-stem) skips retry immediately.
     *
     * `verifyRetryBudgetMs` caps the total *delay* time spent retrying
     * any single candidate. The fetch attempts themselves can take up
     * to `requestTimeoutMs` each, so the worst-case per-candidate
     * total is roughly `verifyRetryBudgetMs + (1 + retries) *
     * requestTimeoutMs`.
     *
     * The schedule is deliberately tight (`[300, 1500]` = 1.8 s of
     * waiting + 3 fetch attempts at most) because `perStageTimeoutMs`
     * is 12 s and a stage typically iterates 3-6 candidates. p63 TV
     * proved a `[300, 1000, 3000]` schedule starves the per-stage
     * budget: one flapping candidate eats up to ~36 s, so the stage
     * times out before reaching the legit one.
     */
    verifyRetryDelaysMs: [300, 1500] as readonly number[],
    verifyRetryBudgetMs: 2500,
  },
  scraper: {
    pgMaxPages: 30,
    browserRefreshEvery: 5,
    interPageDelayMs: 3000,
    overflowThreshold: 200, // PG returns banner >200 results
    mapsMaxScrollAttempts: 40,
    mapsScrollPauseMs: 1500,
  },
  cache: {
    l1MaxMemoryMB: 50,
  },
  http: {
    // Realistic desktop-Chrome UA (was a declared bot `pg4/0.1 (github…)`, which
    // some sites block or serve stripped). direct_fetch overrides this per-host
    // via runtime/fingerprint.ts; this default covers the other undici clients
    // (bing_html SERP, the fatturatoitalia search POST). Keep in sync with
    // fingerprint.ts pool head (DEFAULT_USER_AGENT).
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    maxRetries: 2,
    retryBaseMs: 500,
  },
  llm: {
    defaultModel: DEFAULT_MODELS.openai,
    // Judgment-layer default judge (Anthropic).
    anthropicModel: DEFAULT_MODELS.anthropic,
    // Claude reachable via OpenRouter without a dedicated Anthropic key.
    openrouterModel: DEFAULT_MODELS.openrouter,
    maxTokens: 1024,
    temperature: 0,
    /** Judgment judges need a larger budget for structured multi-dimension output. */
    judgeMaxTokens: 2000,
  },
  scoring: {
    pivaMatchConfidence: 0.95,
    semanticMatchConfidence: 0.80,
    llmOracleSemanticConfidence: 0.75,
    rdapBingoConfidence: 0.90,
    // Input website accepted on domain↔name match only (no live-body confirm):
    // below semantic — strong ownership signal, but the site was not verified live.
    nameMatchConfidence: 0.55,
  },
} as const;
