import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { ReasonCode as RC, DiscoveryMethod } from '../../types/output';
import { DEFAULTS } from '../../config/defaults';
import type { ProviderRouter } from '../../providers/provider_router';
import { PgDetailHarvester } from '../../discovery/sources/pagine_gialle_detail_harvester';
import type { PgDetailHarvest } from '../../discovery/sources/pagine_gialle_detail_harvester';
import { verifyCandidates } from './verify_candidates';

/**
 * R1 — PG detail pre-stage. Runs BEFORE HyperGuesser/SERP whenever
 * the lead has a `pg_url`. The stage:
 *
 *   1. Harvests the PG company-detail page (HTTP-only) for
 *      official_website / P.IVA / phone / email / name / address.
 *   2. If a candidate website is found, verifies it through
 *      `verifyCandidates` (same gate as every other stage).
 *   3. Regardless of website outcome, BACKFILLS the lead with any
 *      non-website evidence found (P.IVA, email, phone, address)
 *      so downstream stages (HyperGuesser, SerpStage) get richer
 *      input.
 *
 * Inspired by pg3's PG-Phone pre-stage in MasterPipeline. Different
 * from pg3 in two ways:
 *   - the harvested website is filtered through pg4's
 *     `isDirectoryOrSocial` blocklist BEFORE acceptance
 *   - the stage NEVER returns success on registry/directory pages
 *
 * Cache: an instance per pipeline run. Because the same pg_url can
 * appear in dedup-collapsed leads, the run-scoped cache avoids
 * redundant fetches.
 */
export class PgDetailStage implements Stage {
  readonly name = 'pg_detail';
  constructor(
    private router: ProviderRouter,
    private harvester: PgDetailHarvester = new PgDetailHarvester(),
  ) {}

  async run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    const pgUrl = lead.pg_url?.trim();
    if (!pgUrl) {
      return {
        stage: this.name,
        status: 'skipped',
        duration_ms: 0,
        detail: 'no_pg_url',
      };
    }

    let harvest: PgDetailHarvest | null;
    try {
      harvest = await this.harvester.harvest(pgUrl);
    } catch (err) {
      return {
        stage: this.name,
        status: 'error',
        duration_ms: Date.now() - start,
        reason_code: RC.ERROR_INTERNAL,
        detail: `harvest_error: ${(err as Error).message}`,
      };
    }
    if (!harvest) {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: RC.NOT_FOUND_NO_CANDIDATES,
        detail: 'pg_detail_no_evidence',
      };
    }

    // R1 — backfill non-website evidence. This is the load-bearing
    // win: HyperGuesser + SerpStage downstream now get the lead's
    // P.IVA / phone / email / address even when no website.
    PgDetailStage.backfillLead(lead, normalized, harvest);

    // If the harvest produced a candidate website that's not
    // directory/social, verify it through PreVerifyGate.
    const candidate = harvest.official_website;
    if (!candidate) {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: RC.NOT_FOUND_NO_CANDIDATES,
        detail: PgDetailStage.fmtBackfillDetail(harvest, false),
      };
    }

    const verdict = await verifyCandidates(this.router, [candidate], normalized, lead, {
      timeoutMs: DEFAULTS.pipeline.requestTimeoutMs,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name },
      fetchCache: ctx.httpFetchCache,
    });
    // R6.1 — REJECT semantic-only verdicts for PG-advertised websites.
    // Audit (PD p_recal_pd_free): "Italy Prime Estates" had PG advertise
    // caseimperiali.com (Atlas SRL / Remax ABC Case in Rubano) as its
    // official site. The harvested URL contained NEITHER the lead's
    // P.IVA NOR the lead's phone — verify accepted on Layer A name-stem
    // match alone (`Italy` / `Prime` / `Estates` are generic English
    // tokens). PG's website attestation can be wrong; without a strong
    // corroborator on the SITE itself (piva or phone match) we don't
    // accept the URL. The lead still benefits from backfill (P.IVA,
    // phone, email) and downstream stages (HyperGuesser, SERP) get the
    // enriched input.
    const isStrongVerdict = verdict.matched && (verdict.method === 'piva' || verdict.method === 'phone');
    if (isStrongVerdict) {
      lead.website_discovery_method = DiscoveryMethod.PG_PHONE_SOURCE_TRUST;
      lead.website_confidence = verdict.confidence;
      if (verdict.body) ctx.verifiedBody = verdict.body; // Phase 1 free-gold seam
      return {
        stage: this.name,
        status: 'success',
        duration_ms: Date.now() - start,
        provider: verdict.provider,
        detail:
          PgDetailStage.fmtBackfillDetail(harvest, true) +
          ` verify=ok method=${verdict.method}`,
      };
    }
    const rejectDetail = verdict.matched
      ? `semantic_only_rejected_method=${verdict.method ?? 'semantic'}`
      : `verify_reject=${verdict.rejectDetail ?? 'unknown'}`;
    // R6.1 — undo any side effects `verifyCandidates` left on the
    // lead. The shared verify helper sets `lead.official_website` on
    // ANY positive match (including semantic). When we reject a
    // semantic-only verdict, we must clear it so the pipeline doesn't
    // finalize with the harvested URL anyway. The PD audit caught
    // this: Italy Prime Estates ended up with status=FOUND_WEBSITE_ONLY
    // and official_website=caseimperiali.com despite every stage
    // outcome reporting `not_found`.
    lead.official_website = undefined;
    lead.website_confidence = undefined;
    lead.website_discovery_method = undefined;
    return {
      stage: this.name,
      status: 'not_found',
      duration_ms: Date.now() - start,
      reason_code: RC.SERP_REJECTED_BY_VERIFY,
      detail: PgDetailStage.fmtBackfillDetail(harvest, false) + ` ${rejectDetail}`,
    };
  }

  /**
   * Backfill the lead's missing identity fields with PG-harvested
   * values. Existing values on the lead always win (CSV input is
   * authoritative). Pure / side-effecting only on the lead object.
   */
  static backfillLead(lead: Lead, normalized: NormalizedLead, h: PgDetailHarvest): void {
    if (!lead.vat_code && h.vat_code) {
      lead.vat_code = h.vat_code;
      normalized.vat_code = h.vat_code;
    }
    if (!lead.phone && h.phone) {
      lead.phone = h.phone;
      // We don't re-normalize the phone here — `normalized.phone`
      // mirrors the original input post-normalization. Leaving it
      // alone is safer than re-running normalization mid-pipeline.
    }
    if (!lead.email && h.email) {
      lead.email = h.email;
    }
    if (!lead.address && h.address) {
      lead.address = h.address;
    }
  }

  private static fmtBackfillDetail(h: PgDetailHarvest, hasWebsite: boolean): string {
    const parts: string[] = [];
    if (h.official_website) parts.push(`web=${hasWebsite ? 'verified' : 'rejected'}`);
    if (h.vat_code) parts.push('vat');
    if (h.phone) parts.push('phone');
    if (h.email) parts.push('email');
    if (h.address) parts.push('address');
    return parts.length > 0 ? `pg=[${parts.join(',')}]` : 'pg=[empty]';
  }
}
