import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { ReasonCode as RC, DiscoveryMethod } from '../../types/output';
import { SerpDeduplicator } from '../../discovery/website/serp_deduplicator';
import { DEFAULTS } from '../../config/defaults';
import type { ProviderRouter } from '../../providers/provider_router';
import { resolveFreeSerpRoute } from '../../providers/provider_policy';
import { getEnv } from '../../config/env';
import { tierCapForLead } from '../../runtime/run_context';
import { verifyCandidates } from './verify_candidates';
import { evaluateSerperGate } from '../../discovery/website/smart_serper_gate';
import { evaluatePaidEvidence } from '../../discovery/website/paid_evidence_gate';
import { logger } from '../../runtime/logger';

/**
 * Query free SERP providers, dedupe candidates, verify top hits.
 *
 * Phase D — reason-code split. Replaces the catch-all `REJECTED_DIRECTORY`
 * with three operator-actionable signals:
 *   - `SERP_EMPTY_ALL_PROVIDERS`  every provider returned []
 *   - `SERP_DIRECTORY_ONLY`       results existed but all classified as
 *                                 directory by `SerpDeduplicator`
 *   - `SERP_REJECTED_BY_VERIFY`   candidates fetched but the verify step
 *                                 (PreVerifyGate / RDAP) rejected them
 *
 * Phase G — paid fallback. After the free pass returns no verified
 * match, optionally run a paid SERP pass (Serper) gated by:
 *   - `paidEnabled === true` on the per-lead context
 *   - per-lead remaining budget covers the paid call cost
 *   - paid provider available (key + env flag)
 * The paid pass goes through the SAME directory/preverify/RDAP
 * pipeline. Discovery method on a paid match is `SERP_PAID`.
 */
export interface SerpStageOpts {
  /**
   * Phase G — when true the stage will run a paid SERP fallback if
   * the free pass returns no verified match. The router still
   * enforces per-lead budget, key presence, and env flags. When
   * false (default), the stage behaves exactly as in Phase F.
   */
  paidFallbackEnabled?: boolean;
  /** List of provider ids to use in the paid fallback. Default `['serper']`. */
  paidProviderIds?: ReadonlyArray<string>;
}

export class SerpStage implements Stage {
  readonly name = 'serp';
  private dedup = new SerpDeduplicator();
  constructor(
    private router: ProviderRouter,
    private opts: SerpStageOpts = {},
  ) {}

  async run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    const query = this.buildQuery(normalized);

    // ---- Free pass (tier ≤ 1, paid disabled) --------------------------------
    // R14 — per-category routing. Skip proven zero-yield free SERP providers
    // for the italian_real_estate profile (provider_policy.ts). dns_mx/crtsh/
    // ddg_lite converted 0 final websites on the R12 PD batch; the override
    // SERP_EXPANDED_FREE_ENABLED restores the full set for evaluation.
    const route = resolveFreeSerpRoute(lead.category, getEnv().SERP_EXPANDED_FREE_ENABLED === true);
    if (route.excludeProviderIds.length > 0) {
      logger.debug(
        { lead_id: ctx.leadId, run_id: ctx.runId, profile: route.profile, skipped: route.excludeProviderIds },
        '[serp.free] category routing — skipping low-yield providers',
      );
    }
    const maxTier = Math.min(1, tierCapForLead(ctx, 1));
    const free = await this.router.search(query, {
      maxTier,
      excludeProviderIds: route.excludeProviderIds.length > 0 ? route.excludeProviderIds : undefined,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name },
    });

    if (free.results && free.results.length > 0) {
      const ranked = this.dedup.dedupe([free.results], { limit: 8 });
      if (ranked.length > 0) {
        const candidateUrls = ranked.slice(0, 5).map((c) => c.best_url);
        const verdict = await verifyCandidates(this.router, candidateUrls, normalized, lead, {
          timeoutMs: DEFAULTS.pipeline.requestTimeoutMs,
          meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name },
          fetchCache: ctx.httpFetchCache,
        });
        if (verdict.matched) {
          lead.website_discovery_method = DiscoveryMethod.SERP_COMPANY;
          lead.website_confidence = verdict.confidence;
          if (verdict.body) ctx.verifiedBody = verdict.body; // Phase 1 free-gold seam
          return {
            stage: this.name,
            status: 'success',
            duration_ms: Date.now() - start,
            provider: verdict.provider,
            detail: `serp=${free.provider} top=${ranked[0].host} ${verdict.detail ?? ''}`.trim(),
          };
        }
      }
    }

    // ---- Paid fallback (Serper / tier 2) ------------------------------------
    // R4 — SmartSerperGate is the EARLIER veto layer. The lead must
    // have a deterministic signal beyond the name (P.IVA, phone,
    // email-domain, pg_url, address+locality) AND the brand must not
    // be in COMMON_BARE_STEMS. Budget gates in ProviderRouter remain
    // as defence-in-depth.
    if (this.opts.paidFallbackEnabled === true && ctx.paidEnabled === true) {
      const decision = evaluateSerperGate(normalized, lead);
      if (!decision.allow) {
        logger.info(
          { lead_id: ctx.leadId, run_id: ctx.runId, reasons: decision.reasons },
          '[serp.paid] gate denied — skipping paid pass',
        );
      } else {
        // Use the gate's top-priority recommended query (R2 variant).
        // pg4 keeps paid as a scalpel: ONE targeted query per lead.
        const paidQuery = decision.recommendedQueries[0]?.query ?? query;
        const paidVerdict = await this.runPaidPass(
          ctx,
          lead,
          normalized,
          paidQuery,
          free.provider,
          start,
        );
        if (paidVerdict !== null) return paidVerdict;
      }
    }

    // ---- Free-only failure paths --------------------------------------------
    if (!free.results || free.results.length === 0) {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: RC.SERP_EMPTY_ALL_PROVIDERS,
        detail: 'no_serp_results',
      };
    }
    const ranked = this.dedup.dedupe([free.results], { limit: 8 });
    if (ranked.length === 0) {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: RC.SERP_DIRECTORY_ONLY,
        detail: `serp=${free.provider} input=${free.results.length} dropped_all_as_directory`,
      };
    }
    return {
      stage: this.name,
      status: 'not_found',
      duration_ms: Date.now() - start,
      reason_code: RC.SERP_REJECTED_BY_VERIFY,
      detail: `serp=${free.provider} candidates=${ranked.length}`,
    };
  }

  /**
   * Phase G — paid SERP fallback. Returns a populated `StageOutcome`
   * when the paid pass yields a verified match, or `null` to let the
   * free-pass failure paths run.
   */
  private async runPaidPass(
    ctx: PerLeadContext,
    lead: Lead,
    normalized: NormalizedLead,
    query: string,
    freeProvider: string,
    start: number,
  ): Promise<StageOutcome | null> {
    const remaining = (ctx.costCeilingEur ?? 0) - ctx.costEur;
    const paidIds = this.opts.paidProviderIds; // undefined → router picks any paid provider
    // Phase G fix — `paidOnly: true` excludes free providers. Without
    // this, router's tier-ascending loop returns on the first free
    // provider that produces results (bing_html), so Serper is never
    // reached. p90 first-attempt ledger showed 372 paid-pass calls
    // and 0 actual Serper calls because of this.
    // Phase G hotfix — `runCostCeilingEur` threaded so the router
    // can enforce the run-level cap. p90 second-attempt blew past
    // the €0.10 cap (spent €0.229) because the cap was previously
    // threaded but never gated.
    const paid = await this.router.search(query, {
      paidEnabled: true,
      paidOnly: true,
      remainingLeadBudgetEur: remaining,
      runCostCeilingEur: ctx.runCostCeilingEur,
      includeProviderIds: paidIds,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name, pass: 'paid' },
    });
    if (!paid.results || paid.results.length === 0) return null;
    const ranked = this.dedup.dedupe([paid.results], { limit: 8 });
    if (ranked.length === 0) return null;
    const candidateUrls = ranked.slice(0, 5).map((c) => c.best_url);
    const verdict = await verifyCandidates(this.router, candidateUrls, normalized, lead, {
      timeoutMs: DEFAULTS.pipeline.requestTimeoutMs,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name, pass: 'paid' },
      fetchCache: ctx.httpFetchCache,
    });
    // R7.0 — precision-first: paid SERP must clear the SAME strong-
    // evidence bar as R6.1's PgDetailStage. Reject `method === 'semantic'`.
    // Audit lesson: Serper returns a long tail of brand-name-aggregator
    // pages (luxuryestate.com, casavenezia.it, …) whose body mentions
    // the lead's brand as a marketing token without any P.IVA / phone
    // corroboration. Layer-A semantic match accepts those at confidence
    // 0.7–0.8 and we end up paying for a directory leak. The same fix
    // that worked for PG-attestation works here: only piva or phone
    // match counts.
    const isStrongVerdict = verdict.matched && (verdict.method === 'piva' || verdict.method === 'phone');
    // R9 — structural Paid Evidence Gate. piva_match alone is not
    // enough: BL → VR generalization showed 14 FPs slipping past
    // piva_match (cross-vat wrong-sector firms publishing the lead's
    // vat, aggregators publishing many firms' vats, govt/research
    // sites publishing business data). The gate inspects the
    // VERIFIED body for:
    //   1) aggregator pattern (distinct vat count ≥ 4 → veto)
    //   2) real-estate sector vocabulary density (< 3 → veto)
    // Audit data: R9 offline simulation on BL+VR brought VR precision
    // 75.9 % → 100 % at 9.1 % TP recall loss.
    const gateOk = isStrongVerdict && verdict.body
      ? evaluatePaidEvidence(verdict.body, normalized, lead)
      : { allow: false, reasons: ['no_strong_verdict_or_body'] };
    if (isStrongVerdict && gateOk.allow) {
      lead.website_discovery_method = DiscoveryMethod.SERP_PAID;
      lead.website_confidence = verdict.confidence;
      if (verdict.body) ctx.verifiedBody = verdict.body; // Phase 1 free-gold seam
      // Phase G.1 — providers_used must record the PAID SERP that
      // produced the candidate, not just the HTTP fetcher used to
      // verify it. Without this every SERP_PAID lead reports only
      // `direct_fetch` and the cost-attribution chain breaks.
      ctx.providersUsed.add(paid.provider);
      return {
        stage: this.name,
        status: 'success',
        duration_ms: Date.now() - start,
        provider: verdict.provider,
        detail:
          `serp_free=${freeProvider} serp_paid=${paid.provider} top=${ranked[0].host} ` +
          `${verdict.detail ?? ''} method=${verdict.method} ` +
          `paid_gate=ok:${gateOk.reasons.join(',')}`.trim(),
      };
    }
    if (isStrongVerdict && !gateOk.allow) {
      logger.info(
        { lead_id: ctx.leadId, run_id: ctx.runId, reasons: gateOk.reasons },
        '[serp.paid] paid_evidence_gate rejected piva-matched candidate',
      );
    }
    // R7.0 — undo verifyCandidates side-effects on a semantic-only
    // (or otherwise rejected) verdict. Same pattern PgDetailStage
    // adopted in R6.1: the helper writes `lead.official_website`
    // BEFORE returning, so a caller that downgrades the verdict must
    // unset the field. Without this the lead would carry the rejected
    // URL through to finalize even though the stage returned null.
    lead.official_website = undefined;
    lead.website_confidence = undefined;
    lead.website_discovery_method = undefined;
    return null;
  }

  private buildQuery(n: NormalizedLead): string {
    const parts = [n.company_name];
    if (n.city) parts.push(n.city);
    if (n.vat_code) parts.push(`P.IVA ${n.vat_code}`);
    parts.push('sito ufficiale');
    return parts.join(' ');
  }
}
