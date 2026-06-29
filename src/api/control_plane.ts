import type { TenantDb } from '../persistence/tenant_db';
import { computeDedupKey } from '../persistence/dedup_key';
import {
  ApiError,
  type TenantContext,
  type EnrichableField,
  type ImportCompaniesRequest,
  type ImportCompaniesResponse,
  type CreateEnrichJobRequest,
  type CreateScrapeJobRequest,
  type CreateJudgmentJobRequest,
  type JudgmentJobKind,
  type JobAccepted,
  type JobStatus,
  type JobStatusView,
  type JobItemView,
  type CostView,
  type AddSuppressionRequest,
} from './types';

/**
 * The API control plane — tenant-scoped handlers behind which a Next.js route
 * handler is a thin adapter. The ONE invariant under test: every method is
 * scoped to `ctx.tenantId`; there is no path by which a request reads or
 * mutates another tenant's data. Writes additionally require a non-viewer role.
 *
 * Job execution (the per-field waterfall + the worker queue) is Phase D / the
 * orchestrator; this layer creates the tenant-scoped, queued work and reports
 * status/cost. Paid execution stays disabled in this pass.
 */

/** Advisory paid prices per field (€/company) for the cost ESTIMATE only. */
const PAID_FIELD_PRICE_EUR: Partial<Record<EnrichableField, number>> = {
  email: 0.02, // email-finder fallback (free tier first)
  decision_maker: 0.1, // people-finder API
  revenue: 0.0, // free (fatturatoitalia)
  pec: 0.0, // free (INI-PEC)
};

interface JobRecord {
  id: string;
  tenantId: string;
  kind: 'scrape_run' | 'enrich_fields' | JudgmentJobKind;
  status: JobStatus;
  fields: EnrichableField[];
  paidEnabled: boolean;
  runCostCeilingEur?: number;
  totalCostEur: number;
  items: Array<{ id: string; companyId?: string; fields: EnrichableField[]; status: JobItemView['status']; costEur: number }>;
}

interface SuppressionRow {
  tenantId: string;
  phoneKey?: string;
  vatKey?: string;
  emailKey?: string;
  reason: string;
}

export class ControlPlane {
  // tenant_id → jobId → JobRecord
  private jobs = new Map<string, Map<string, JobRecord>>();
  private suppression: SuppressionRow[] = [];
  private seq = 0;

  constructor(private readonly db: TenantDb) {}

  // ---- guards ------------------------------------------------------------
  private requireWrite(ctx: TenantContext): void {
    if (!ctx.tenantId || !ctx.userId) throw new ApiError(401, 'unauthenticated');
    if (ctx.role === 'viewer') throw new ApiError(403, 'viewer role cannot write');
  }
  private requireAuth(ctx: TenantContext): void {
    if (!ctx.tenantId || !ctx.userId) throw new ApiError(401, 'unauthenticated');
  }
  private tenantJobs(tenantId: string): Map<string, JobRecord> {
    let m = this.jobs.get(tenantId);
    if (!m) {
      m = new Map();
      this.jobs.set(tenantId, m);
    }
    return m;
  }

  // ---- POST /api/companies/import ---------------------------------------
  async importCompanies(ctx: TenantContext, req: ImportCompaniesRequest): Promise<ImportCompaniesResponse> {
    this.requireWrite(ctx);
    let imported = 0;
    let merged = 0;
    let rejected = 0;
    const companyIds: string[] = [];
    for (const row of req.rows) {
      if (!computeDedupKey(row)) {
        rejected += 1; // un-dedupable — refuse rather than create a dup-prone row
        continue;
      }
      const res = await this.db.upsertCompany(ctx.tenantId, row);
      companyIds.push(res.companyId);
      if (res.merged) merged += 1;
      else imported += 1;
    }
    return { imported, merged, rejected, companyIds };
  }

  // ---- POST /api/jobs (enrich field on selection) -----------------------
  async createEnrichJob(ctx: TenantContext, req: CreateEnrichJobRequest): Promise<JobAccepted> {
    this.requireWrite(ctx);
    if (!req.fields?.length) throw new ApiError(422, 'fields must be non-empty');
    if (!req.companyIds?.length) throw new ApiError(422, 'companyIds must be non-empty');

    // Validate every company belongs to THIS tenant — cross-tenant ids are
    // rejected as 404 (do not leak whether they exist elsewhere).
    const tenantCompanyIds = new Set(await this.db.getCompanyIds(ctx.tenantId));
    for (const id of req.companyIds) {
      if (!tenantCompanyIds.has(id)) throw new ApiError(404, `company ${id} not found in this tenant`);
    }

    const job: JobRecord = {
      id: `job_${ctx.tenantId.slice(0, 6)}_${++this.seq}`,
      tenantId: ctx.tenantId,
      kind: 'enrich_fields',
      status: 'queued',
      fields: req.fields,
      paidEnabled: req.paidEnabled,
      runCostCeilingEur: req.runCostCeilingEur,
      totalCostEur: 0,
      items: req.companyIds.map((cid) => ({
        id: `item_${++this.seq}`,
        companyId: cid,
        fields: req.fields,
        status: 'queued' as const,
        costEur: 0,
      })),
    };
    this.tenantJobs(ctx.tenantId).set(job.id, job);
    return {
      jobId: job.id,
      status: job.status,
      itemCount: job.items.length,
      estimatedCostEur: estimateCost(req.fields, req.companyIds.length, req.paidEnabled),
    };
  }

  // ---- POST /api/jobs (scrape intent → run) -----------------------------
  async createScrapeJob(ctx: TenantContext, req: CreateScrapeJobRequest): Promise<JobAccepted> {
    this.requireWrite(ctx);
    if (!req.category) throw new ApiError(422, 'category is required');
    const job: JobRecord = {
      id: `job_${ctx.tenantId.slice(0, 6)}_${++this.seq}`,
      tenantId: ctx.tenantId,
      kind: 'scrape_run',
      status: 'queued',
      fields: [],
      paidEnabled: req.paidEnabled,
      runCostCeilingEur: req.runCostCeilingEur,
      totalCostEur: 0,
      items: [{ id: `item_${++this.seq}`, fields: [], status: 'queued', costEur: 0 }],
    };
    this.tenantJobs(ctx.tenantId).set(job.id, job);
    return { jobId: job.id, status: job.status, itemCount: 1, estimatedCostEur: 0 };
  }

  // ---- POST /api/jobs/{discovery|collect-signals|judge|validate-export} --
  // The four judgment-layer buttons (L2–L5). Each is an independent, idempotent,
  // re-runnable job kind. Same tenant-scoping + ownership validation as enrich.
  async createDiscoveryJob(ctx: TenantContext, req: CreateJudgmentJobRequest): Promise<JobAccepted> {
    return this.createJudgmentJob(ctx, 'discovery', req);
  }
  async createCollectSignalsJob(ctx: TenantContext, req: CreateJudgmentJobRequest): Promise<JobAccepted> {
    return this.createJudgmentJob(ctx, 'collect_signals', req);
  }
  async createJudgeJob(ctx: TenantContext, req: CreateJudgmentJobRequest): Promise<JobAccepted> {
    return this.createJudgmentJob(ctx, 'judge', req);
  }
  async createValidateExportJob(ctx: TenantContext, req: CreateJudgmentJobRequest): Promise<JobAccepted> {
    return this.createJudgmentJob(ctx, 'validate_export', req);
  }

  private async createJudgmentJob(ctx: TenantContext, kind: JudgmentJobKind, req: CreateJudgmentJobRequest): Promise<JobAccepted> {
    this.requireWrite(ctx);
    if (!req.companyIds?.length) throw new ApiError(422, 'companyIds must be non-empty');
    const tenantCompanyIds = new Set(await this.db.getCompanyIds(ctx.tenantId));
    for (const id of req.companyIds) {
      if (!tenantCompanyIds.has(id)) throw new ApiError(404, `company ${id} not found in this tenant`);
    }
    const job: JobRecord = {
      id: `job_${ctx.tenantId.slice(0, 6)}_${++this.seq}`,
      tenantId: ctx.tenantId,
      kind,
      status: 'queued',
      fields: [],
      paidEnabled: req.paidEnabled ?? false,
      runCostCeilingEur: req.runCostCeilingEur,
      totalCostEur: 0,
      items: req.companyIds.map((cid) => ({ id: `item_${++this.seq}`, companyId: cid, fields: [], status: 'queued' as const, costEur: 0 })),
    };
    this.tenantJobs(ctx.tenantId).set(job.id, job);
    // judge/validate use the LLM (paid); discovery/collect are free-first.
    const estimatedCostEur = req.paidEnabled && (kind === 'judge' || kind === 'validate_export') ? Math.round(req.companyIds.length * 0.04 * 1e4) / 1e4 : 0;
    return { jobId: job.id, status: job.status, itemCount: job.items.length, estimatedCostEur };
  }

  // ---- GET /api/jobs/:id (status / live view) ---------------------------
  async getJobStatus(ctx: TenantContext, jobId: string): Promise<JobStatusView> {
    this.requireAuth(ctx);
    const job = this.tenantJobs(ctx.tenantId).get(jobId);
    if (!job) throw new ApiError(404, 'job not found'); // scoped: another tenant's job is invisible
    return {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      totalCostEur: job.totalCostEur,
      items: job.items.map((it) => ({ id: it.id, companyId: it.companyId, fields: it.fields, status: it.status, costEur: it.costEur })),
    };
  }

  // ---- GET /api/jobs/:id/cost -------------------------------------------
  async getJobCost(ctx: TenantContext, jobId: string): Promise<CostView> {
    this.requireAuth(ctx);
    const job = this.tenantJobs(ctx.tenantId).get(jobId);
    if (!job) throw new ApiError(404, 'job not found');
    return {
      totalCostEur: job.totalCostEur,
      ceilingEur: job.runCostCeilingEur,
      ceilingHit: job.runCostCeilingEur !== undefined && job.totalCostEur >= job.runCostCeilingEur,
      byProvider: {},
      providerDead: [],
    };
  }

  // ---- POST /api/suppression --------------------------------------------
  async addSuppression(ctx: TenantContext, req: AddSuppressionRequest): Promise<{ ok: true }> {
    this.requireWrite(ctx);
    if (!req.phone && !req.vat && !req.email) throw new ApiError(422, 'one of phone/vat/email is required');
    this.suppression.push({
      tenantId: ctx.tenantId,
      phoneKey: req.phone ? req.phone.replace(/\D/g, '') : undefined,
      vatKey: req.vat ? req.vat.replace(/\D/g, '') : undefined,
      emailKey: req.email?.toLowerCase(),
      reason: req.reason,
    });
    return { ok: true };
  }

  /** Tenant-scoped suppression read (used by the engine; never cross-tenant). */
  getSuppression(ctx: TenantContext): SuppressionRow[] {
    this.requireAuth(ctx);
    return this.suppression.filter((s) => s.tenantId === ctx.tenantId);
  }
}

export function estimateCost(fields: EnrichableField[], companyCount: number, paidEnabled: boolean): number {
  if (!paidEnabled) return 0;
  let perCompany = 0;
  for (const f of fields) perCompany += PAID_FIELD_PRICE_EUR[f] ?? 0;
  return Math.round(perCompany * companyCount * 1e4) / 1e4;
}
