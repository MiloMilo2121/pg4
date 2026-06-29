import type { Lead } from '../types/lead';
import type { LeadSink, LeadWriteOutcome } from './lead_sink';
import type { TenantDb } from './tenant_db';

/**
 * A LeadSink that persists to a tenant-scoped database (any `TenantDb` — the
 * in-memory dev double or the production `PgTenantDb`). It is BOUND to one
 * tenant at construction: every write carries that tenant id, so a single sink
 * instance can never write across tenants. This is the app-layer half of the
 * isolation guarantee; Postgres RLS is the DB-layer half.
 */
export class TenantLeadSink implements LeadSink {
  constructor(
    private readonly tenantId: string,
    private readonly db: TenantDb
  ) {
    if (!tenantId) throw new Error('TenantLeadSink: tenantId is required (multi-tenant invariant)');
  }

  async write(lead: Lead): Promise<LeadWriteOutcome> {
    const res = await this.db.upsertCompany(this.tenantId, lead);
    return { id: res.companyId, merged: res.merged };
  }

  async close(): Promise<void> {
    /* the db backend owns its own lifecycle */
  }
}
