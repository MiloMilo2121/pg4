import { describe, expect, it } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { InMemoryTenantDb } from '../../src/persistence/in_memory_tenant_db';
import { ControlPlane, estimateCost } from '../../src/api/control_plane';
import { ApiError, type TenantContext } from '../../src/api/types';

const lead = (o: Partial<Lead>): Lead => ({ company_name: 'X', ...o });
const TA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const ctx = (tenantId: string, role: TenantContext['role'] = 'admin'): TenantContext => ({
  tenantId,
  userId: `u_${tenantId.slice(0, 4)}`,
  role,
});

function freshPlane() {
  return new ControlPlane(new InMemoryTenantDb());
}

describe('ControlPlane — auth + role gating', () => {
  it('rejects unauthenticated writes (401)', async () => {
    const cp = freshPlane();
    await expect(cp.importCompanies({ tenantId: '', userId: '', role: 'admin' }, { rows: [] })).rejects.toMatchObject({ status: 401 });
  });

  it('viewer role cannot write (403)', async () => {
    const cp = freshPlane();
    await expect(cp.importCompanies(ctx(TA, 'viewer'), { rows: [lead({ phone: '0491234567' })] })).rejects.toMatchObject({ status: 403 });
  });
});

describe('ControlPlane — import + dedup', () => {
  it('imports, merges on dedup hit, rejects un-dedupable rows', async () => {
    const cp = freshPlane();
    const res = await cp.importCompanies(ctx(TA), {
      rows: [
        lead({ company_name: 'Rossi', city: 'Padova', phone: '0491234567' }),
        lead({ company_name: 'Rossi 2', city: 'Padova', phone: '0039 049 1234567' }), // same phone → merge
        lead({ company_name: 'NoIdentity' }), // un-dedupable → rejected
      ],
    });
    expect(res.imported).toBe(1);
    expect(res.merged).toBe(1);
    expect(res.rejected).toBe(1);
  });
});

describe('ControlPlane — enrich-field job, tenant-scoped', () => {
  it('creates one queued item per company with the requested fields', async () => {
    const cp = freshPlane();
    const imp = await cp.importCompanies(ctx(TA), {
      rows: [lead({ company_name: 'A', city: 'Padova', phone: '0491111111' }), lead({ company_name: 'B', city: 'Padova', phone: '0492222222' })],
    });
    const job = await cp.createEnrichJob(ctx(TA), { companyIds: imp.companyIds, fields: ['email', 'pec'], paidEnabled: false });
    expect(job.itemCount).toBe(2);
    expect(job.status).toBe('queued');
    const view = await cp.getJobStatus(ctx(TA), job.jobId);
    expect(view.items.every((i) => i.fields.includes('email') && i.fields.includes('pec'))).toBe(true);
  });

  it('REJECTS company ids that belong to another tenant (404, no leak)', async () => {
    const cp = freshPlane();
    const impB = await cp.importCompanies(ctx(TB), { rows: [lead({ company_name: 'Beta', city: 'Verona', phone: '0453333333' })] });
    // tenant A tries to enrich tenant B's company id
    await expect(cp.createEnrichJob(ctx(TA), { companyIds: impB.companyIds, fields: ['email'], paidEnabled: false })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a job created by tenant A is INVISIBLE to tenant B (404)', async () => {
    const cp = freshPlane();
    const imp = await cp.importCompanies(ctx(TA), { rows: [lead({ company_name: 'A', city: 'Padova', phone: '0491111111' })] });
    const job = await cp.createEnrichJob(ctx(TA), { companyIds: imp.companyIds, fields: ['email'], paidEnabled: false });
    await expect(cp.getJobStatus(ctx(TB), job.jobId)).rejects.toMatchObject({ status: 404 });
    await expect(cp.getJobCost(ctx(TB), job.jobId)).rejects.toMatchObject({ status: 404 });
  });

  it('validates non-empty fields + companyIds (422)', async () => {
    const cp = freshPlane();
    await expect(cp.createEnrichJob(ctx(TA), { companyIds: [], fields: ['email'], paidEnabled: false })).rejects.toMatchObject({ status: 422 });
  });
});

describe('ControlPlane — cost view + estimate', () => {
  it('estimate is €0 when paid disabled; reflects paid prices when enabled', () => {
    expect(estimateCost(['email', 'decision_maker'], 10, false)).toBe(0);
    expect(estimateCost(['email', 'decision_maker'], 10, true)).toBeCloseTo((0.02 + 0.1) * 10, 4);
    expect(estimateCost(['pec', 'revenue'], 100, true)).toBe(0); // free fields
  });

  it('cost view reports ceiling + ceilingHit, scoped to the job tenant', async () => {
    const cp = freshPlane();
    const imp = await cp.importCompanies(ctx(TA), { rows: [lead({ company_name: 'A', city: 'Padova', phone: '0491111111' })] });
    const job = await cp.createEnrichJob(ctx(TA), { companyIds: imp.companyIds, fields: ['email'], paidEnabled: true, runCostCeilingEur: 0.5 });
    const cost = await cp.getJobCost(ctx(TA), job.jobId);
    expect(cost.ceilingEur).toBe(0.5);
    expect(cost.ceilingHit).toBe(false);
    expect(cost.providerDead).toEqual([]);
  });
});

describe('ControlPlane — suppression, tenant-scoped', () => {
  it('add + scoped read; another tenant never sees it', async () => {
    const cp = freshPlane();
    await cp.addSuppression(ctx(TA), { phone: '+39 049 1234567', reason: 'art21_objection' });
    expect(cp.getSuppression(ctx(TA))).toHaveLength(1);
    expect(cp.getSuppression(ctx(TB))).toHaveLength(0);
  });

  it('requires at least one identifier (422)', async () => {
    const cp = freshPlane();
    await expect(cp.addSuppression(ctx(TA), { reason: 'operator' })).rejects.toBeInstanceOf(ApiError);
  });
});
