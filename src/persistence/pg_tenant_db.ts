import type { Lead } from '../types/lead';
import type { CompanyRow, TenantDb, UpsertResult } from './tenant_db';
import { leadToCompanyRow, computeDedupAliases, COMPANY_VALUE_COLUMNS } from './tenant_db';

/**
 * Minimal SQL execution seam. The production adapter implements this with the
 * Supabase JS client or `pg` (provided at activation — see the PRODUCTION
 * ACTIVATION CHECKLIST). Keeping it an interface means `PgTenantDb` is real,
 * reviewable SQL with ZERO hard dependency on a specific client, and stays
 * unwired (no live DB) for this pass.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
}

const INSERT_COLUMNS = ['tenant_id', 'dedup_key', 'schema_version', 'cost_eur', ...COMPANY_VALUE_COLUMNS] as const;
// Columns that get fill-only-missing on conflict (everything except identity).
const MERGE_COLUMNS = INSERT_COLUMNS.filter((c) => c !== 'tenant_id' && c !== 'dedup_key');

/**
 * Production TenantDb over Postgres. Every statement is tenant-scoped and the
 * UPSERT implements the scraper's fill-only-missing merge:
 *   ON CONFLICT (tenant_id, dedup_key)
 *   DO UPDATE SET col = COALESCE(companies.col, excluded.col)
 * so an existing non-null value always wins (first source wins), matching
 * Deduplicator.merge(). RLS (migration 0001) is the second guard.
 *
 * NOT WIRED in this pass: construct it with a real SqlExecutor only after the
 * activation checklist. Until then the engine uses InMemoryTenantDb.
 */
export class PgTenantDb implements TenantDb {
  constructor(private readonly sql: SqlExecutor) {}

  async upsertCompany(tenantId: string, lead: Lead): Promise<UpsertResult> {
    const row = leadToCompanyRow(lead, tenantId);
    const aliases = computeDedupAliases(lead);

    const cols = INSERT_COLUMNS.filter((c) => (row as Record<string, unknown>)[c] !== undefined);
    const placeholders = cols.map((_c, i) => `$${i + 1}`);
    const params = cols.map((c) => (row as Record<string, unknown>)[c]);
    const updateSet = MERGE_COLUMNS.filter((c) => cols.includes(c))
      .map((c) => `${c} = COALESCE(companies.${c}, excluded.${c})`)
      .concat('updated_at = now()')
      .join(', ');

    const sql =
      `insert into companies (${cols.join(', ')}) values (${placeholders.join(', ')}) ` +
      `on conflict (tenant_id, dedup_key) do update set ${updateSet} ` +
      `returning id, (xmax = 0) as inserted`;
    const rows = await this.sql.query<{ id: string; inserted: boolean }>(sql, params);
    const r = rows[0];

    // Index the secondary keys → this company (idempotent).
    for (const a of aliases) {
      await this.sql.query(
        `insert into company_dedup_aliases (tenant_id, alias_key, key_type, company_id) ` +
          `values ($1, $2, $3, $4) on conflict (tenant_id, alias_key) do nothing`,
        [tenantId, a.alias_key, a.key_type, r.id]
      );
    }
    return { companyId: r.id, merged: !r.inserted, aliases };
  }

  async getCompanies(tenantId: string): Promise<CompanyRow[]> {
    return this.sql.query<CompanyRow>(`select * from companies where tenant_id = $1`, [tenantId]);
  }

  async getCompanyIds(tenantId: string): Promise<string[]> {
    const rows = await this.sql.query<{ id: string }>(`select id from companies where tenant_id = $1`, [tenantId]);
    return rows.map((r) => r.id);
  }

  async count(tenantId: string): Promise<number> {
    const rows = await this.sql.query<{ n: string }>(`select count(*)::text as n from companies where tenant_id = $1`, [tenantId]);
    return Number(rows[0]?.n ?? 0);
  }
}
