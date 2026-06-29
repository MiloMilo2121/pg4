/**
 * Cross-run enrichment cache (a blueprint cost principle).
 *
 * The engine's existing `MemoryCache` is per-process and 30-min TTL — it does
 * NOT survive a run. This is the durable, tenant-scoped, cross-run cache: a
 * field already resolved for a company (keyed by a stable identity like the
 * P.IVA) is never re-fetched. Since P.IVA→PEC and P.IVA→firmographics never
 * change, caching them forever collapses repeat-run cost toward €0 — the single
 * biggest cost lever at scale.
 *
 * Implements the same shape the per-field waterfall reads through, so wiring it
 * is a backend swap, not a call-site change. The in-memory implementation is
 * the dev/test double; `SupabaseEnrichmentCache` (documented, unwired this
 * pass) backs it with the `enrichment_cache` table from migration 0001.
 */

export interface CachedField {
  value: unknown;
  confidence?: number;
  source?: string;
  fetchedAt: number;
  /** null/undefined = never expires (registry facts). */
  ttlDays?: number;
}

export interface EnrichmentCache {
  get(tenantId: string, cacheKey: string): Promise<CachedField | undefined>;
  set(tenantId: string, cacheKey: string, value: CachedField): Promise<void>;
}

/** Build the canonical cache key. e.g. cacheKey('pec','vat','01234567897'). */
export function cacheKey(field: string, keyType: string, keyVal: string): string {
  return `${field}:${keyType}:${keyVal}`;
}

/**
 * In-memory, tenant-scoped cross-run cache. Used for local/dev runs and tests.
 * Honors TTL; a null ttlDays means the entry never expires.
 */
export class InMemoryEnrichmentCache implements EnrichmentCache {
  private store = new Map<string, CachedField>();

  private k(tenantId: string, cacheKey: string): string {
    return `${tenantId}::${cacheKey}`;
  }

  async get(tenantId: string, key: string): Promise<CachedField | undefined> {
    const hit = this.store.get(this.k(tenantId, key));
    if (!hit) return undefined;
    if (hit.ttlDays != null && hit.ttlDays >= 0) {
      const ageDays = (this.now() - hit.fetchedAt) / 86_400_000;
      if (ageDays > hit.ttlDays) {
        this.store.delete(this.k(tenantId, key));
        return undefined;
      }
    }
    return hit;
  }

  async set(tenantId: string, key: string, value: CachedField): Promise<void> {
    this.store.set(this.k(tenantId, key), value);
  }

  // Seam so tests can inject time (Date.now is unavailable in some sandboxes).
  protected now(): number {
    return Date.now();
  }
}
