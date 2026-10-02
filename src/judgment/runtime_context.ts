import { BingHtmlProvider } from '../providers/serp/bing_html';
import { DdgLiteProvider } from '../providers/serp/ddg_lite';
import { buildPageFetcher } from './harvest/page_fetcher';
import { InMemoryEnrichmentCache } from '../persistence/enrichment_cache';
import type { EnrichmentCache } from '../persistence/enrichment_cache';
import { CostLedger } from '../runtime/cost_ledger';
import { buildProviderCatalog } from '../providers/provider_catalog';
import { getEnv } from '../config/env';
import type { HarvestContext } from './harvest/source_harvest';
import type { JudgeLLM } from './judges/shared';
import type { ProviderRouter } from '../providers/provider_router';

/**
 * Runtime wiring for the judgment pipeline outside the dev server (CLI + eval).
 *
 * The "live free" context uses DirectFetch (website) + Bing HTML, then DDG Lite (free SERP for
 * the A-collector's third-party searches) + an in-memory cache. €0, free-first.
 * The strong A sources (registry/Places) and the LLM judges stay key-gated.
 */
// Tried in order: a blocked, failed or empty page moves on to the next one.
const FREE_SERPS = [new BingHtmlProvider(), new DdgLiteProvider()];

/**
 * One ledger + router for a whole judgment run, shared by the paid source
 * adapters (registry, Places) and the LLM judges so the run's spend is in one
 * place and one run ceiling applies to all of it.
 */
export function judgmentRouter(ledger: CostLedger = new CostLedger()): { ledger: CostLedger; router: ProviderRouter } {
  return { ledger, router: buildProviderCatalog(ledger) };
}

export function liveFreeHarvestContext(opts: { tenantId?: string; cache?: EnrichmentCache; paidEnabled?: boolean; router?: ProviderRouter } = {}): HarvestContext {
  return {
    tenantId: opts.tenantId ?? 'cli',
    cache: opts.cache ?? new InMemoryEnrichmentCache(),
    fetcher: buildPageFetcher(8000),
    search: async (query: string) => {
      for (const serp of FREE_SERPS) {
        const results = await serp.search(query, { limit: 8 }).catch(() => []);
        if (results.length > 0) return results;
      }
      return [];
    },
    paidEnabled: opts.paidEnabled ?? false,
    router: opts.router,
    now: () => Date.now(),
  };
}

/**
 * Build the LLM judge caller (Claude via the provider router). Returns
 * `{ llm: undefined }` when paid is off or no LLM provider is enabled — the
 * judges then run deterministically. The paid-gate + cost ledger still apply.
 */
export function buildJudgeLLM(paidEnabled: boolean, router?: ProviderRouter): { llm?: JudgeLLM; modelId?: string } {
  if (!paidEnabled) return {};
  const env = getEnv();
  const modelId = env.ANTHROPIC_ENABLED ? env.ANTHROPIC_MODEL : env.OPENROUTER_ENABLED ? env.OPENROUTER_MODEL : undefined;
  if (!modelId) return {}; // no LLM enabled → stay deterministic
  router ??= judgmentRouter().router;
  const llm: JudgeLLM = async (req) => {
    const res = await router.complete(req, { paidEnabled: true });
    return res?.content ?? null;
  };
  return { llm, modelId };
}
