import type { HttpProvider, LLMProvider, SerpProvider } from '../types/providers';
import { ProviderRouter } from './provider_router';
import type { CostLedger } from '../runtime/cost_ledger';
import { CircuitBreaker } from '../runtime/circuit_breaker';
import { RateLimiter } from '../runtime/rate_limiter';
import { getEnv } from '../config/env';
import { logger } from '../runtime/logger';

import { DirectFetchProvider } from './http/direct_fetch';
import { FirecrawlProvider } from './http/firecrawl';
import { BrightDataUnlockerProvider } from './http/brightdata';
import { DdgLiteProvider } from './serp/ddg_lite';
import { BingHtmlProvider } from './serp/bing_html';
import { SerperProvider } from './serp/serper';
import { TavilyProvider } from './serp/tavily';
import { ExaProvider } from './serp/exa';
import { AnthropicProvider } from './llm/anthropic';
import { OpenRouterProvider } from './llm/openrouter';
import { OpenAIProvider, DeepSeekProvider, ZhipuGlmProvider, KimiProvider, PerplexityLlmProvider } from './llm/openai_family';

/**
 * The provider registry. Adds providers in tier order. Missing API keys are
 * tolerated — the provider is still listed but `available()` returns false
 * and the router skips it.
 *
 * Phase 1: only `direct_fetch` (HTTP tier 0).
 * Phase 3: free SERP providers (ddg_lite, bing_html).
 * Phase 3+: paid providers behind feature flags.
 *
 * Gate-0 — `dns_mx` and `crtsh` were REMOVED. Measured: 0 successes in
 * 12,728 calls each (dns_mx received name-queries it structurally cannot
 * answer; crt.sh blocked this egress IP). They only added latency. The
 * provider-health detector (`runtime/provider_health.ts`) now makes this
 * silent-failure class structurally impossible to reintroduce unnoticed.
 * `ddg_lite` is kept but stays gated off for the real-estate profile
 * (provider_policy.ts) — low yield, not zero.
 */
export function buildProviderCatalog(ledger: CostLedger): ProviderRouter {
  const env = getEnv();

  const serps: SerpProvider[] = [
    new DdgLiteProvider(),
    new BingHtmlProvider(),
    new SerperProvider(), // Phase G — paid tier 2; available() gated by SERPER_ENABLED + SERPER_API_KEY
    new TavilyProvider(), // judgment-layer discovery fallback — paid tier 2, gated
    new ExaProvider(), // judgment-layer discovery fallback — paid tier 2, gated
  ];

  const https: HttpProvider[] = [
    new DirectFetchProvider(), // tier 0, always
    // WEB_FETCH/WEB_UNBLOCK escalation — paid tier 2, default-OFF (available()=false
    // until *_ENABLED + key). Reached only after direct_fetch returns block/empty.
    new FirecrawlProvider(),
    new BrightDataUnlockerProvider(), // distinct id (addendum R2); brightdata_serp deferred
  ];

  const llms: LLMProvider[] = [
    // Judgment layer (L4/L5). All paid tier 2, default-OFF (paid-gate). Claude is
    // the default judge: directly (Anthropic) or via OpenRouter (no new secret).
    new AnthropicProvider(),
    new OpenRouterProvider(),
    // LLM_REASON / LLM_CHEAP cascade (OpenAI-compatible family). Keys recovered into
    // .env (gitignored); each available() only when its *_ENABLED flag is set, so a
    // default run stays €0. Per-role ordering is honoured by the role resolver, not
    // catalog order.
    OpenAIProvider(),
    DeepSeekProvider(),
    ZhipuGlmProvider(),
    KimiProvider(),
    PerplexityLlmProvider(),
  ];

  // Phase F.2 — per-provider breaker tuning. The default global config
  // (5 failures / 60 s / 120 s cooldown) was tripping `direct_fetch`
  // on multi-province free-only runs because:
  //   - direct_fetch is a per-target tool (success rate depends on
  //     each upstream domain, not on direct_fetch itself), so 5
  //     consecutive flapping targets trip the breaker
  //   - once OPEN, ALL future leads in the run lose verify capability
  //     (every stage calls verifyCandidates), starving the rest of
  //     the run
  //   - direct_fetch is FREE — no cost penalty for retrying — so the
  //     breaker is over-protective for this provider
  //
  // p82 / p83 PD runs both ended with `direct_fetch` OPEN
  // (`consecutiveFailures=5`, `lastFailureKind=transport`) despite
  // healthy bing_html / D.3 retry. Loosening the per-key config so
  // direct_fetch tolerates wider bursts of transport flap, with a
  // shorter cooldown so it recovers fast when the network heals.
  // Other providers (paid SERPs, etc.) keep the strict default.
  const breaker = new CircuitBreaker();
  breaker.configure('direct_fetch', {
    failureThreshold: 15,
    windowMs: 60_000,
    cooldownMs: 30_000,
  });

  // Phase F finding — SERP pacing. The Phase F smoke surfaced that the
  // RateLimiter was instantiated but never wired: with no input websites
  // to verify, the enrich stage fired ~3.7 Bing requests/s and Bing
  // soft-blocked the whole run (185/185 empty) — silently. Validated
  // R12 cadence was ~0.27 req/s; 0.5/s keeps a 2x headroom over that
  // while halving worst-case burst exposure. ddg_lite gets the same
  // treatment for when a category profile re-enables it. Unconfigured
  // providers (serper, direct_fetch) stay unlimited — Serper is
  // account-limited upstream and direct_fetch is free/per-target.
  const rate = new RateLimiter();
  rate.configure('bing_html', 0.5, 2);
  rate.configure('ddg_lite', 0.5, 2);

  const router = new ProviderRouter(serps, https, llms, ledger, breaker, rate);

  if (env.NODE_ENV !== 'test') {
    logger.info({ providers: router.describe() }, '[ProviderCatalog] capability surface at boot');
  }

  return router;
}
