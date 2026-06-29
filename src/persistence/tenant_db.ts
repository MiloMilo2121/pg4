import type { Lead } from '../types/lead';
import { computeDedupKey, computeDedupAliases } from './dedup_key';
import type { DedupAlias } from './dedup_key';

/**
 * The authoritative `companies` value-column set — it must match migration
 * 0001 EXACTLY. This is deliberately NOT derived from ENRICHED_CSV_COLUMNS:
 * the CSV carries per-RUN metadata (duration_ms, providers_used, errors,
 * financial_evidence_count, _schema_version) that belongs to `runs` /
 * `field_evidence`, not to a company row. Identity columns (tenant_id,
 * dedup_key) and bookkeeping (cost_eur, schema_version) are handled
 * separately, so they are absent here.
 */
export const COMPANY_VALUE_COLUMNS = [
  // raw (scraped)
  'company_name', 'category', 'city', 'province', 'region', 'address', 'phone',
  'phone_raw', 'website', 'source', 'source_url', 'pg_url', 'maps_url', 'vat_code',
  'confidence', 'discovery_notes', 'query_location', 'business_city', 'category_match',
  'permanently_closed',
  // enriched
  'status', 'reason_code', 'official_website', 'website_confidence', 'website_discovery_method',
  'vat_code_final', 'pec', 'email_inferred', 'email_type', 'revenue', 'revenue_year',
  'employees', 'employees_is_estimated', 'decision_maker_name', 'decision_maker_role',
  'decision_maker_linkedin', 'lead_score', 'financial_source', 'financial_confidence',
  'financial_notes',
  // schema v2 (Phase 1 free-gold)
  'instagram', 'facebook', 'linkedin',
] as const;

export type CompanyValueColumn = (typeof COMPANY_VALUE_COLUMNS)[number];

/**
 * The tenant-scoped company repository. Every method takes (or is bound to) a
 * tenant id; an implementation MUST NOT return or mutate another tenant's
 * rows. `InMemoryTenantDb` enforces this structurally (storage keyed by tenant)
 * and is the dev/test double; `PgTenantDb` is the production adapter over a
 * `SqlExecutor`, with Postgres RLS as the second, DB-level guard.
 */

/** A `companies` row: the mapped lead columns + tenancy + dedup identity. */
export type CompanyRow = {
  tenant_id: string;
  dedup_key: string;
  schema_version: number;
  cost_eur: number;
} & Partial<Record<CompanyValueColumn, unknown>>;

export interface UpsertResult {
  companyId: string;
  /** True when the row merged into an existing company (dedup hit). */
  merged: boolean;
  aliases: DedupAlias[];
}

export interface TenantDb {
  upsertCompany(tenantId: string, lead: Lead): Promise<UpsertResult>;
  /** Tenant-scoped read — returns ONLY this tenant's companies. */
  getCompanies(tenantId: string): Promise<CompanyRow[]>;
  /** Tenant-scoped company ids (for ownership validation in the API). */
  getCompanyIds(tenantId: string): Promise<string[]>;
  count(tenantId: string): Promise<number>;
}

/**
 * Map a Lead to a CompanyRow. Columns are driven by ENRICHED_CSV_COLUMNS — the
 * same frozen, append-only taxonomy the CSV uses — so the DB schema and the CSV
 * never drift. Throws when the lead has no usable identity (un-dedupable): a
 * row with no stable key would defeat the unique constraint, so the caller must
 * decide what to do rather than persist a duplicate-prone record.
 */
export function leadToCompanyRow(lead: Lead, tenantId: string): CompanyRow {
  if (!tenantId) throw new Error('leadToCompanyRow: tenantId is required (multi-tenant invariant)');
  const dedupKey = computeDedupKey(lead);
  if (!dedupKey) {
    throw new Error(`leadToCompanyRow: lead "${lead.company_name ?? '?'}" has no dedup key (no phone/name+city/name+addr/host/url)`);
  }
  const row: CompanyRow = {
    tenant_id: tenantId,
    dedup_key: dedupKey,
    schema_version: typeof lead._schema_version === 'number' ? lead._schema_version : 2,
    cost_eur: typeof lead.cost_eur === 'number' ? lead.cost_eur : 0,
  };
  for (const col of COMPANY_VALUE_COLUMNS) {
    const v = (lead as Record<string, unknown>)[col];
    if (v !== undefined && v !== null && v !== '') {
      (row as Record<string, unknown>)[col] = v;
    }
  }
  return row;
}

export { computeDedupKey, computeDedupAliases };
export type { DedupAlias };
