import { BingHtmlProvider } from '../providers/serp/bing_html';
import { buildPageFetcher } from './harvest/page_fetcher';
import { InMemoryEnrichmentCache } from '../persistence/enrichment_cache';
import type { EnrichmentCache } from '../persistence/enrichment_cache';
import { CostLedger } from '../runtime/cost_ledger';
import { buildProviderCatalog } from '../providers/provider_catalog';
import { getEnv } from '../config/env';
import type { HarvestContext } from './harvest/source_harvest';
import type { JudgeLLM } from './judges/shared';

/**
 * Runtime wiring for the judgment pipeline outside the dev server (CLI + eval).
 *
 * The "live free" context uses DirectFetch (website) + Bing HTML (free SERP for
 * the A-collector's third-party searches) + an in-memory cache. €0, free-first.
 * The strong A sources (registry/Places) and the LLM judges stay key-gated.
 */
const SERP = new BingHtmlProvider();

export function liveFreeHarvestContext(opts: { tenantId?: string; cache?: EnrichmentCache; paidEnabled?: boolean } = {}): HarvestContext {
  return {
    tenantId: opts.tenantId ?? 'cli',
    cache: opts.cache ?? new InMemoryEnrichmentCache(),
    fetcher: buildPageFetcher(8000),
    search: async (query: string) => {
      try {
        return await SERP.search(query, { limit: 8 });
      } catch {
        return [];
      }
    },
    paidEnabled: opts.paidEnabled ?? false,
    now: () => Date.now(),
  };
}

/**
 * Build the LLM judge caller (Claude via the provider router). Returns
 * `{ llm: undefined }` when paid is off or no LLM provider is enabled — the
 * judges then run deterministically. The paid-gate + cost ledger still apply.
 */
export function buildJudgeLLM(paidEnabled: boolean): { llm?: JudgeLLM; modelId?: string } {
  if (!paidEnabled) return {};
  const env = getEnv();
  const modelId = env.ANTHROPIC_ENABLED ? env.ANTHROPIC_MODEL : env.OPENROUTER_ENABLED ? env.OPENROUTER_MODEL : undefined;
  if (!modelId) return {}; // no LLM enabled → stay deterministic
  const router = buildProviderCatalog(new CostLedger());
  const llm: JudgeLLM = async (req) => {
    const res = await router.complete(req, { paidEnabled: true });
    return res?.content ?? null;
  };
  return { llm, modelId };
}
