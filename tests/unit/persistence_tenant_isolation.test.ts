import { describe, expect, it } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { dedupeLeads } from '../../src/discovery/deduper';
import { computeDedupKey } from '../../src/persistence/dedup_key';
import { leadToCompanyRow } from '../../src/persistence/tenant_db';
import { InMemoryTenantDb } from '../../src/persistence/in_memory_tenant_db';
import { TenantLeadSink } from '../../src/persistence/tenant_lead_sink';
import { PgTenantDb } from '../../src/persistence/pg_tenant_db';
import type { SqlExecutor } from '../../src/persistence/pg_tenant_db';
import { InMemoryEnrichmentCache, cacheKey } from '../../src/persistence/enrichment_cache';

const lead = (o: Partial<Lead>): Lead => ({ company_name: 'X', ...o });
const TA = '11111111-1111-1111-1111-111111111111';
const TB = '22222222-2222-2222-2222-222222222222';

describe('dedup_key ↔ Deduplicator consistency', () => {
  it('two leads the deduper MERGES share a dedup_key (same phone)', () => {
    const a = lead({ company_name: 'Rossi', city: 'Padova', phone: '+39 049 1234567' });
    const b = lead({ company_name: 'Rossi 2', city: 'Padova', phone: '0491234567' });
    expect(dedupeLeads([a, b])).toHaveLength(1); // deduper merges (phone)
    expect(computeDedupKey(a)).toBe(computeDedupKey(b)); // dedup_key agrees
  });

  it('legal-form variants share a dedup_key (name+city, no phone)', () => {
    const a = lead({ company_name: 'Immobiliare Rossi S.r.l.', city: 'Padova' });
    const b = lead({ company_name: 'Immobiliare Rossi SRL', city: 'Padova' });
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
  });

  it('distinct entities get distinct keys', () => {
    const a = lead({ company_name: 'Rossi', city: 'Padova', phone: '0491111111' });
    const b = lead({ company_name: 'Bianchi', city: 'Verona', phone: '0452222222' });
    expect(computeDedupKey(a)).not.toBe(computeDedupKey(b));
  });

  it('un-dedupable lead → undefined key (caller must reject)', () => {
    expect(computeDedupKey(lead({ company_name: 'X' }))).toBeUndefined();
  });
});

describe('leadToCompanyRow', () => {
  it('requires a tenantId', () => {
    expect(() => leadToCompanyRow(lead({ phone: '0491234567' }), '')).toThrow(/tenantId/i);
  });
  it('requires a dedup key', () => {
    expect(() => leadToCompanyRow(lead({ company_name: 'X' }), TA)).toThrow(/dedup key/i);
  });
  it('maps RAW + ENRICHED + v2 social columns, stamps tenant + schema_version', () => {
    const row = leadToCompanyRow(
      lead({ company_name: 'Rossi', city: 'Padova', phone: '0491234567', email_inferred: 'a@rossi.it', instagram: 'https://instagram.com/rossi' }),
      TA
    );
    expect(row.tenant_id).toBe(TA);
    expect(row.dedup_key).toBe('phone:0491234567'); // domestic leading-0 kept (matches deduper)
    expect(row.email_inferred).toBe('a@rossi.it');
    expect(row.instagram).toBe('https://instagram.com/rossi');
    expect(row.schema_version).toBe(2);
  });
});

describe('TenantLeadSink — tenant isolation (the irreversible invariant)', () => {
  it('refuses construction without a tenant id', () => {
    expect(() => new TenantLeadSink('', new InMemoryTenantDb())).toThrow(/tenantId/i);
  });

  it('tenant A writes are NEVER visible to tenant B', async () => {
    const db = new InMemoryTenantDb();
    const sinkA = new TenantLeadSink(TA, db);
    const sinkB = new TenantLeadSink(TB, db);

    await sinkA.write(lead({ company_name: 'Alpha', city: 'Padova', phone: '0491111111' }));
    await sinkB.write(lead({ company_name: 'Beta', city: 'Verona', phone: '0452222222' }));

    const aRows = await db.getCompanies(TA);
    const bRows = await db.getCompanies(TB);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].company_name).toBe('Alpha');
    expect(bRows[0].company_name).toBe('Beta');
    // cross-tenant leakage is structurally impossible:
    expect(aRows.some((r) => r.company_name === 'Beta')).toBe(false);
    expect(db.totalAcrossAllTenants()).toBe(2);
  });

  it('the SAME lead under two tenants produces two independent rows', async () => {
    const db = new InMemoryTenantDb();
    const l = lead({ company_name: 'Shared Srl', city: 'Padova', phone: '0491234567' });
    await new TenantLeadSink(TA, db).write(l);
    await new TenantLeadSink(TB, db).write(l);
    expect(await db.count(TA)).toBe(1);
    expect(await db.count(TB)).toBe(1);
  });

  it('fill-only-missing merge: re-write fills empty fields, never overwrites', async () => {
    const db = new InMemoryTenantDb();
    const sink = new TenantLeadSink(TA, db);
    const first = await sink.write(lead({ company_name: 'Rossi', city: 'Padova', phone: '0491234567', email_inferred: 'first@rossi.it' }));
    const second = await sink.write(lead({ company_name: 'Rossi', city: 'Padova', phone: '0491234567', email_inferred: 'second@rossi.it', pec: 'rossi@pec.it' }));
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);
    const rows = await db.getCompanies(TA);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_inferred).toBe('first@rossi.it'); // existing wins
    expect(rows[0].pec).toBe('rossi@pec.it'); // empty field filled
  });
});

describe('PgTenantDb — production SQL (unwired; shape verified vs a fake executor)', () => {
  it('emits a tenant-scoped fill-only-missing UPSERT + alias inserts', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const fake: SqlExecutor = {
      async query<T>(sql: string, params: unknown[]): Promise<T[]> {
        calls.push({ sql, params });
        if (sql.startsWith('insert into companies')) return [{ id: 'cmp1', inserted: true } as unknown as T];
        return [] as T[];
      },
    };
    const db = new PgTenantDb(fake);
    const res = await db.upsertCompany(TA, lead({ company_name: 'Rossi', city: 'Padova', phone: '0491234567', website: 'https://rossi.it' }));

    expect(res.companyId).toBe('cmp1');
    expect(res.merged).toBe(false); // inserted=true
    const insert = calls.find((c) => c.sql.startsWith('insert into companies'))!;
    expect(insert.sql).toContain('on conflict (tenant_id, dedup_key)');
    expect(insert.sql.toLowerCase()).toContain('coalesce(companies.'); // fill-only-missing
    // no duplicate column in the INSERT column list (the cost_eur-twice bug)
    const colList = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
    expect(colList.filter((c) => c === 'cost_eur')).toHaveLength(1);
    expect(new Set(colList).size).toBe(colList.length);
    expect(insert.params[0]).toBe(TA); // tenant-scoped
    // alias rows indexed (phone + name_city + host for this lead)
    const aliasInserts = calls.filter((c) => c.sql.startsWith('insert into company_dedup_aliases'));
    expect(aliasInserts.length).toBeGreaterThanOrEqual(2);
    expect(aliasInserts.every((c) => c.params[0] === TA)).toBe(true);
  });

  it('getCompanies + count are tenant-scoped', async () => {
    const calls: string[] = [];
    const fake: SqlExecutor = {
      async query<T>(sql: string, params: unknown[]): Promise<T[]> {
        calls.push(sql);
        expect(params[0]).toBe(TA);
        if (sql.includes('count(')) return [{ n: '3' } as unknown as T];
        return [] as T[];
      },
    };
    const db = new PgTenantDb(fake);
    await db.getCompanies(TA);
    expect(await db.count(TA)).toBe(3);
    expect(calls.every((s) => s.includes('where tenant_id = $1'))).toBe(true);
  });
});

describe('cross-run enrichment cache', () => {
  it('tenant-scoped get/set; a cached field is a cross-run hit', async () => {
    const cache = new InMemoryEnrichmentCache();
    const key = cacheKey('pec', 'vat', '01234567897');
    expect(await cache.get(TA, key)).toBeUndefined();
    await cache.set(TA, key, { value: 'rossi@pec.it', source: 'inipec', fetchedAt: 0, ttlDays: undefined });
    expect((await cache.get(TA, key))?.value).toBe('rossi@pec.it');
    // other tenant does not see it
    expect(await cache.get(TB, key)).toBeUndefined();
  });
});
