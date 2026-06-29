import type { Lead } from '../types/lead';
import type { CompanyRow, TenantDb, UpsertResult } from './tenant_db';
import { leadToCompanyRow, computeDedupAliases } from './tenant_db';

/**
 * In-memory TenantDb — the dev/test double and the local-run backend (the
 * "migrations + sink, no live DB" mode chosen for this pass). It enforces
 * tenant isolation STRUCTURALLY: storage is a Map keyed by tenant id, and
 * every read/write reaches only the requested tenant's bucket. There is no
 * code path that can return another tenant's rows — which is exactly what the
 * isolation tests assert, and what Postgres RLS will enforce in production.
 *
 * Merge policy matches the scraper's Deduplicator (fill-only-missing): a second
 * write with the same dedup key fills only the columns the existing row is
 * missing; existing values win. `sources` would be unioned by the engine before
 * it reaches the sink, so the row-level merge stays simple.
 */
export class InMemoryTenantDb implements TenantDb {
  // tenant_id → (dedup_key → { id, row })
  private store = new Map<string, Map<string, { id: string; row: CompanyRow }>>();
  private seq = 0;

  private bucket(tenantId: string): Map<string, { id: string; row: CompanyRow }> {
    let b = this.store.get(tenantId);
    if (!b) {
      b = new Map();
      this.store.set(tenantId, b);
    }
    return b;
  }

  async upsertCompany(tenantId: string, lead: Lead): Promise<UpsertResult> {
    if (!tenantId) throw new Error('upsertCompany: tenantId required');
    const row = leadToCompanyRow(lead, tenantId);
    const aliases = computeDedupAliases(lead);
    const b = this.bucket(tenantId);
    const existing = b.get(row.dedup_key);
    if (existing) {
      // fill-only-missing
      for (const [k, v] of Object.entries(row)) {
        if (v === undefined || v === null || v === '') continue;
        const cur = (existing.row as Record<string, unknown>)[k];
        if (cur === undefined || cur === null || cur === '') {
          (existing.row as Record<string, unknown>)[k] = v;
        }
      }
      return { companyId: existing.id, merged: true, aliases };
    }
    const id = `cmp_${tenantId.slice(0, 6)}_${++this.seq}`;
    b.set(row.dedup_key, { id, row });
    return { companyId: id, merged: false, aliases };
  }

  async getCompanies(tenantId: string): Promise<CompanyRow[]> {
    const b = this.store.get(tenantId);
    if (!b) return [];
    return [...b.values()].map((e) => e.row);
  }

  async getCompanyIds(tenantId: string): Promise<string[]> {
    const b = this.store.get(tenantId);
    if (!b) return [];
    return [...b.values()].map((e) => e.id);
  }

  async count(tenantId: string): Promise<number> {
    return this.store.get(tenantId)?.size ?? 0;
  }

  /** Diagnostic — total rows across ALL tenants (tests only; never tenant-scoped). */
  totalAcrossAllTenants(): number {
    let n = 0;
    for (const b of this.store.values()) n += b.size;
    return n;
  }

  /**
   * Tenant-scoped {id, row} pairs — for the dev API server, which needs the
   * stable id alongside each row. Still strictly tenant-scoped (only reads the
   * requested tenant's bucket).
   */
  entries(tenantId: string): Array<{ id: string; row: CompanyRow }> {
    const b = this.store.get(tenantId);
    if (!b) return [];
    return [...b.values()].map((e) => ({ id: e.id, row: { ...e.row } }));
  }

  /** Tenant-scoped fetch of one company by id. */
  getById(tenantId: string, id: string): CompanyRow | undefined {
    const b = this.store.get(tenantId);
    if (!b) return undefined;
    for (const e of b.values()) if (e.id === id) return { ...e.row };
    return undefined;
  }

  /**
   * Patch a company in place (fill-only-missing, like the merge policy): used
   * by the live enrich-field path to write the free-gold result back. Returns
   * the patched row or undefined if not found / wrong tenant.
   */
  patchCompany(tenantId: string, id: string, patch: Record<string, unknown>): CompanyRow | undefined {
    const b = this.store.get(tenantId);
    if (!b) return undefined;
    for (const e of b.values()) {
      if (e.id !== id) continue;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === '') continue;
        const cur = (e.row as Record<string, unknown>)[k];
        if (cur === undefined || cur === null || cur === '') {
          (e.row as Record<string, unknown>)[k] = v;
        }
      }
      return { ...e.row };
    }
    return undefined;
  }
}
