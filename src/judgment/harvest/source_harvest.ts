import type { Lead } from '../../types/lead';
import type { Signal } from '../../types/judgment';
import type { EnrichmentCache } from '../../persistence/enrichment_cache';
import { cacheKey } from '../../persistence/enrichment_cache';
import type { SerpResult } from '../../types/providers';

/**
 * SourceHarvest — the generalization of pg4's website-only free-gold ("fetch
 * once, extract all", deep_pages.ts) into a reusable per-SOURCE abstraction.
 *
 * ONE retrieval of ONE source yields MANY attributes AND MANY A/B signals,
 * cache-first, persisted once, read by all downstream layers. The attribute↔
 * source and signal↔axis routing is DATA (routing.ts), not hardcoded.
 *
 * Offline-first / wired-but-safe: an adapter whose key/flag is off returns
 * `ok:false` and the COLLECTOR marks the affected signals `unknown_not_found`
 * — never `confirmed_absent`. A failed source lowers coverage, never fabricates
 * absence (the firewall against "discovery fallito = B basso").
 */

export type SourceKind = 'website' | 'maps_gbp' | 'registry' | 'social' | 'ad_library';

/**
 * A minimal page fetcher: URL → body text (or undefined on any failure).
 * Optional `init` lets an adapter issue a POST with headers/body — required by the
 * New Google Places API (POST places:searchText + X-Goog-FieldMask). Back-compat:
 * existing GET callers pass no init; impls that ignore init still type-check.
 */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export type PageFetcher = (url: string, init?: FetchInit) => Promise<string | undefined>;

/** Everything an adapter may need. Adapters that need env read getEnv() themselves. */
export interface HarvestContext {
  tenantId: string;
  cache: EnrichmentCache;
  fetcher: PageFetcher;
  /** optional SERP access (social/press discovery); absent → those adapters are unavailable */
  search?: (query: string) => Promise<SerpResult[]>;
  paidEnabled: boolean;
  /** time seam (Date.now is fine in src; injectable for tests) */
  now: () => number;
  ledgerMeta?: Record<string, string | number | boolean>;
}

/** What ONE retrieval of ONE source yields. Superset of BodyExtraction. */
export interface HarvestResult {
  source: SourceKind;
  sourceId: string;
  locator: string;
  fetchedAt: string; // ISO
  /** false ⇒ contributions are `unknown`, NOT absent (could not reach the source). */
  ok: boolean;
  /** attributes that fill Lead fields (email, pec, instagram, vat, address, …) */
  attributes: Record<string, string>;
  /** A and B signals with three-state + evidence (axis stamped at build time) */
  signals: Signal[];
  /** kept for audit / late field-path finalization */
  raw?: unknown;
}

/** Adapter: cache-first retrieval + extraction of one source for one company. */
export interface SourceAdapter {
  readonly kind: SourceKind;
  readonly id: string;
  readonly tier: 0 | 1 | 2;
  readonly costEur: number;
  /** key + flag present (mirrors Provider.available()). */
  available(): boolean;
  /** resolve the source locator (domain, VAT, GBP query, profile URL). undefined → cannot run. */
  locate(lead: Lead, bundle: HarvestBundle): string | undefined;
  /** TTL for cached harvests of this source (days); null = never expires. */
  ttlDays(): number | null;
  /** fetch + extract. MUST be offline-safe: throwing or empty → ok:false. */
  harvest(locator: string, ctx: HarvestContext): Promise<HarvestResult>;
}

/** All harvested sources for one company in one job (the multi-source bundle). */
export interface HarvestBundle {
  byKind: Partial<Record<SourceKind, HarvestResult>>;
}

export function emptyBundle(): HarvestBundle {
  return { byKind: {} };
}

/** Cache key-type per source kind (what the locator is keyed on). */
function keyTypeFor(kind: SourceKind): string {
  switch (kind) {
    case 'website':
      return 'host';
    case 'registry':
      return 'vat';
    case 'maps_gbp':
      return 'place';
    case 'social':
    case 'ad_library':
      return 'brand';
  }
}

export function unreachableResult(adapter: SourceAdapter, locator: string, nowIso: string): HarvestResult {
  return {
    source: adapter.kind,
    sourceId: adapter.id,
    locator,
    fetchedAt: nowIso,
    ok: false,
    attributes: {},
    signals: [],
  };
}

/**
 * The cardinal flow: cache-first → select source → fetch ONCE → extract all →
 * persist (cache) → return. Persisting evidence atoms to `field_evidence` is the
 * collector's job (it owns the company/run ids); the cache here suppresses
 * re-fetch (cost-first). Idempotent: a cache hit returns the same HarvestResult.
 */
export async function harvestSource(adapter: SourceAdapter, lead: Lead, bundle: HarvestBundle, ctx: HarvestContext): Promise<HarvestResult> {
  const nowIso = new Date(ctx.now()).toISOString();
  if (!adapter.available()) return unreachableResult(adapter, '', nowIso);
  const locator = adapter.locate(lead, bundle);
  if (!locator) return unreachableResult(adapter, '', nowIso);

  const key = cacheKey('harvest', keyTypeFor(adapter.kind), locator);
  const cached = await ctx.cache.get(ctx.tenantId, key);
  if (cached && cached.value && typeof cached.value === 'object') {
    const hit = cached.value as HarvestResult;
    bundle.byKind[adapter.kind] = hit;
    return hit;
  }

  let result: HarvestResult;
  try {
    result = await adapter.harvest(locator, ctx);
  } catch {
    result = unreachableResult(adapter, locator, nowIso);
  }

  // Only cache reachable harvests; an `ok:false` (couldn't reach) should be
  // retryable next run rather than frozen as "unknown" for the whole TTL.
  if (result.ok) {
    const ttl = adapter.ttlDays();
    await ctx.cache.set(ctx.tenantId, key, {
      value: result,
      fetchedAt: ctx.now(),
      source: adapter.id,
      ttlDays: ttl === null ? undefined : ttl,
    });
  }
  bundle.byKind[adapter.kind] = result;
  return result;
}
