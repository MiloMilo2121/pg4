import type { Lead } from '../types/lead';
import type { EnrichmentResult, PerLeadContext, Stage } from '../types/enrichment';
import type { StageOutcome, ReasonCode } from '../types/output';
import { LeadStatus, ReasonCode as RC } from '../types/output';
import { normalizeLead } from '../discovery/input_normalizer';
import type { ProviderRouter } from '../providers/provider_router';
import type { Run } from '../runtime/run_context';
import { logger } from '../runtime/logger';
import { classifyError } from '../runtime/errors';
import { InputWebsiteStage } from './stages/input_website_stage';
import { PgDetailStage } from './stages/pg_detail_stage';
import { HyperGuesserStage } from './stages/hyper_guesser_stage';
import { SerpStage } from './stages/serp_stage';
import { RdapBoostStage } from './stages/rdap_stage';
import { FinancialStage } from './stages/financial_stage';
import { ApifyMapsStage } from './stages/apify_maps_stage';
import { PerplexityResolveStage } from './stages/perplexity_resolve_stage';
import { ApifyRegistroStage } from './stages/apify_registro_stage';
import { applyFreeGoldExtraction } from './extract/apply_free_gold';
import { PgDetailHarvester } from '../discovery/sources/pagine_gialle_detail_harvester';
import { runFieldCascades } from './fields/run_field_cascade';
import type { EnrichableField } from '../api/types';
import { getEnv } from '../config/env';

/**
 * Enrichment pipeline.
 *
 * Owns:
 *   - input ingest gating (`ingestError`, `INPUT_QUALITY_TOO_LOW`)
 *   - stage ordering (Phase 4.4: kept identical to Phase 4.2)
 *   - per-stage cost sync from the canonical `CostLedger.costForLead()`
 *   - reason-code policy: keep the FIRST informative reason; only fall
 *     back to `DISCOVERY_EXHAUSTED` when nothing more specific surfaced
 *   - finalize: project the lead into the output shape with cost / duration
 *
 * Stage IMPLEMENTATIONS live in `stages/*.ts`. Adding a new stage means
 * a new file under `stages/` and one extra entry in the `stages` array
 * below — nothing else has to change here.
 */

export interface PipelineInput {
  run: Run;
  perLead: PerLeadContext;
  router: ProviderRouter;
  lead: Lead;
  ingestError?: string;
  /**
   * Optional DNS resolver injected from outside (tests). Defaults to system DNS.
   * Used by HyperGuesserStage to keep tests offline.
   */
  dnsResolver?: (host: string) => Promise<string[]>;
  /**
   * R1 — optional PG harvester. Tests inject a mock to keep the
   * suite 0-network. Defaults to a fresh `PgDetailHarvester` per
   * pipeline invocation. Production callers (CLI) can pass a
   * SHARED instance to take advantage of the run-scoped cache
   * across leads with the same `pg_url`.
   */
  pgHarvester?: PgDetailHarvester;
  /**
   * Optional RDAP rescue stage. Unit tests inject a no-network implementation;
   * production retains the default live RDAP stage.
   */
  rdapStage?: Stage;
  /**
   * R13.1 — financial enrichment stage. Runs AFTER the website discovery
   * ladder, UNCONDITIONALLY (it is orthogonal to website success). Defaults
   * to an enabled, NO-NETWORK instance that only promotes a checksum-valid
   * input P.IVA to `vat_code_final` and records provenance. Tests inject a
   * custom / disabled instance. It emits no `reason_code` and never sets
   * the lead status, so the website-discovery verdict is unaffected.
   */
  financialStage?: FinancialStage;
  /** Apify Google-Maps enrichment stage (paid, default-OFF). Tests inject a mock. */
  apifyMapsStage?: ApifyMapsStage;
  /** Perplexity entity-resolution stage (paid, default-OFF, last-resort). */
  perplexityResolveStage?: PerplexityResolveStage;
  /** Apify Registro-Imprese firmographics stage (paid, default-OFF, by P.IVA). */
  apifyRegistroStage?: ApifyRegistroStage;
  /**
   * GDPR hook — true if an email is on the do-not-contact list. Forwarded to the
   * email-inference seam so a suppressed address is never synthesised/probed.
   */
  isSuppressedEmail?: (email: string) => boolean;
}

export async function runEnrichmentPipeline(input: PipelineInput): Promise<EnrichmentResult> {
  const start = Date.now();
  const { lead, run, perLead, router, ingestError } = input;

  // ---- Ingest error short-circuit ----
  if (ingestError) {
    return finalize(lead, {
      status: LeadStatus.ERROR,
      reason_code: RC.ERROR_INVALID_INPUT_ROW,
      stage_outcomes: {
        ingest: { stage: 'ingest', status: 'error', duration_ms: 0, reason_code: RC.ERROR_INVALID_INPUT_ROW, detail: ingestError },
      },
      start,
      perLead,
      outcome: 'error',
      run,
    });
  }

  // ---- Normalize ----
  const normalized = normalizeLead(lead);
  perLead.layersAttempted.push('NORMALIZE');

  if (normalized.quality_score < 0.3) {
    return finalize(lead, {
      status: LeadStatus.SKIPPED,
      reason_code: RC.INPUT_QUALITY_TOO_LOW,
      stage_outcomes: {
        normalize: {
          stage: 'normalize',
          status: 'skipped',
          duration_ms: 0,
          reason_code: RC.INPUT_QUALITY_TOO_LOW,
          detail: `quality=${normalized.quality_score}`,
        },
      },
      start,
      perLead,
      outcome: 'not_found',
      run,
    });
  }

  // ---- Multi-stage discovery ladder ----
  // R1 — `PgDetailStage` runs BEFORE HyperGuesser/SERP. When the
  // lead has a `pg_url`, it harvests the PG company-detail page for
  // official_website / P.IVA / phone / email / address and
  // backfills the lead. This both short-circuits the ladder when
  // PG already advertises the site AND enriches the input for the
  // downstream stages.
  // Phase G — `paidFallbackEnabled` is forwarded from the per-lead
  // context. The router still enforces per-call cost gates as
  // defence-in-depth.
  const harvester = input.pgHarvester ?? new PgDetailHarvester();
  const stages: Stage[] = [
    new InputWebsiteStage(router),
    new PgDetailStage(router, harvester),
    new HyperGuesserStage(router, input.dnsResolver),
    new SerpStage(router, { paidFallbackEnabled: perLead.paidEnabled === true }),
    input.rdapStage ?? new RdapBoostStage(),
  ];

  const stageOutcomes: Record<string, StageOutcome> = {};
  let lastReasonCode: ReasonCode | undefined;

  for (const stage of stages) {
    perLead.layersAttempted.push(stage.name);
    try {
      const outcome = await stage.run(perLead, lead, normalized);
      stageOutcomes[stage.name] = outcome;
      if (outcome.provider) perLead.providersUsed.add(outcome.provider);
      // Phase 4.2.1: source-of-truth for per-lead cost is the CostLedger.
      // Stages may forget to populate StageOutcome.cost_eur; the ledger
      // already saw every router call (with meta.lead_id), so we sync
      // from there. This keeps `tierCapForLead()` honest in the next
      // iteration AND `lead.cost_eur` correct at finalize time.
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
      if (outcome.status === 'success') break; // discovery succeeded — stop ladder
      lastReasonCode = outcome.reason_code ?? lastReasonCode;
    } catch (err) {
      const reason = classifyError(err);
      stageOutcomes[stage.name] = {
        stage: stage.name,
        status: 'error',
        duration_ms: 0,
        reason_code: reason,
        detail: (err as Error).message,
      };
      lastReasonCode = reason;
      // Sync cost even on stage error — the failed call may still have
      // cost the operator something (paid SERP that 5xx'd, etc.).
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
      logger.warn({ stage: stage.name, err: (err as Error).message }, '[pipeline] stage threw');
    }
  }

  // ---- Financial enrichment (R13.1, orthogonal to website discovery) ----
  // Runs for EVERY lead that reached the ladder, regardless of whether a
  // website was found. Safe / no-network: it only promotes a checksum-valid
  // input P.IVA to `vat_code_final` and records provenance. It emits no
  // reason_code and never sets the lead status, so the website-discovery
  // verdict computed below is unaffected. Wrapped so a throw can never
  // break the lead's output row.
  const financialStage = input.financialStage ?? new FinancialStage({ enabled: true });
  perLead.layersAttempted.push(financialStage.name);
  try {
    const finOutcome = await financialStage.run(perLead, lead, normalized);
    stageOutcomes[financialStage.name] = finOutcome;
    // NOTE: deliberately NOT added to providersUsed — the financial source
    // ('input') is provenance, not a network provider.
  } catch (err) {
    stageOutcomes[financialStage.name] = {
      stage: financialStage.name,
      status: 'skipped',
      duration_ms: 0,
      detail: `financial_stage_threw: ${(err as Error).message}`,
    };
    logger.warn({ err: (err as Error).message }, '[pipeline] financial stage threw');
  }

  // ---- Free-gold extraction (Phase 1, orthogonal, ZERO network cost) ----
  // When a stage above accepted a strong website match, it stashed the
  // firm's own page body on `perLead.verifiedBody`. Mine it for email /
  // PEC / social / VAT — €0 marginal cost (the body was already fetched
  // for verification). Wrapped so a throw can never break the output row;
  // makes no provider calls, so `lead.cost_eur` and budgets are untouched.
  try {
    const fg = applyFreeGoldExtraction(lead, perLead.verifiedBody);
    if (fg.applied) {
      stageOutcomes['free_gold'] = {
        stage: 'free_gold',
        status: 'success',
        duration_ms: 0,
        detail: `filled=${fg.filled.join(',')}`,
      };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[pipeline] free-gold extraction threw');
  }

  // ---- Post-discovery field cascades — official data + email (opt-in, guarded) ----
  // The CANONICAL per-field path (field_registry + run_field_cascade): a
  // VIES-confirmed VAT, fatturatoitalia revenue/employees (franchise-guarded +
  // rate-limited), and email inference + MX/SMTP handshake. FinancialStage above
  // stays PURE (checksum only) by contract; the guarded network lookups live
  // here. Each field is independently flag-gated and the pass is skipped when
  // nothing is on — so default + offline runs make ZERO extra network calls and
  // stay €0. VAT runs first so pec/revenue/employees can key on vat_code_final.
  const fcEnv = getEnv();
  const cascadeFields: EnrichableField[] = [];
  if (fcEnv.OFFICIAL_DATA_ENRICH_ENABLED) cascadeFields.push('vat', 'pec', 'revenue', 'employees');
  if (fcEnv.EMAIL_INFERENCE_MX_ENABLED && !lead.email_inferred) cascadeFields.push('email');
  if (cascadeFields.length > 0) {
    try {
      const outcomes = await runFieldCascades(lead, cascadeFields, {
        body: perLead.verifiedBody,
        ledger: run.ledger,
        meta: { lead_id: perLead.leadId, stage: 'field_cascade' },
        isSuppressedEmail: input.isSuppressedEmail,
      });
      const emailOutcome = outcomes.find((o) => o.field === 'email');
      if (emailOutcome?.resolved && lead.email_inferred && !lead.email_type) lead.email_type = 'business';
      const resolved = outcomes.filter((o) => o.resolved).map((o) => `${o.field}:${o.source}`);
      stageOutcomes['field_cascade'] = {
        stage: 'field_cascade',
        status: resolved.length > 0 ? 'success' : 'skipped',
        duration_ms: 0,
        detail: resolved.length > 0 ? resolved.join(' ') : `ran=${cascadeFields.join(',')} none_resolved`,
      };
      // Sync any cost the cascades recorded (free today; defence-in-depth).
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[pipeline] field cascade pass threw');
    }
  }

  // ---- PAID escalation — runs LAST, only on what the free path left missing ----
  // Ordered AFTER free-gold + the field cascades so the paid stages fire purely
  // as last-resort (a lead whose website/socials the FREE path already filled
  // never triggers a paid call). Both default-OFF, cost-gated via the router.

  // Snapshot the verified body: if a paid stage (Perplexity) discovers + verifies
  // a NEW website, its captured body must be free-gold-mined too (the first
  // free-gold pass already ran above, before this website existed).
  const bodyBeforePaid = perLead.verifiedBody;

  // Apify Google-Maps: rating + reviews (the judgment A-axis) + website recall /
  // phone / socials. Skips when disabled or already complete.
  const apifyMaps = input.apifyMapsStage ?? new ApifyMapsStage(router);
  try {
    const mapsOutcome = await apifyMaps.run(perLead, lead, normalized);
    if (mapsOutcome.status !== 'skipped') {
      stageOutcomes[apifyMaps.name] = mapsOutcome;
      if (mapsOutcome.provider) perLead.providersUsed.add(mapsOutcome.provider);
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[pipeline] apify maps stage threw');
  }

  // Perplexity entity-resolution: for leads STILL missing a website or any social,
  // Sonar live-searches and proposes website/socials/vat, hard-guarded.
  const perplexityResolve = input.perplexityResolveStage ?? new PerplexityResolveStage(router);
  try {
    const pxOutcome = await perplexityResolve.run(perLead, lead, normalized);
    if (pxOutcome.status !== 'skipped') {
      stageOutcomes[perplexityResolve.name] = pxOutcome;
      if (pxOutcome.provider) perLead.providersUsed.add(pxOutcome.provider);
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[pipeline] perplexity resolve stage threw');
  }

  // Apify Registro-Imprese: firmographics + financials (utile/dipendenti/capitale/
  // forma giuridica/ATECO/PEC) by P.IVA, when the lead has a checksum-valid VAT.
  const apifyRegistro = input.apifyRegistroStage ?? new ApifyRegistroStage(router);
  try {
    const regOutcome = await apifyRegistro.run(perLead, lead, normalized);
    if (regOutcome.status !== 'skipped') {
      stageOutcomes[apifyRegistro.name] = regOutcome;
      if (regOutcome.provider) perLead.providersUsed.add(regOutcome.provider);
      perLead.costEur = run.ledger.costForLead(perLead.leadId);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[pipeline] apify registro stage threw');
  }

  // Second free-gold pass — ONLY if a paid stage captured a fresh website body
  // (Perplexity). Idempotent (fills empty fields only) + ZERO network: mines the
  // newly-discovered site for email / socials / VAT the first pass couldn't see.
  if (perLead.verifiedBody && perLead.verifiedBody !== bodyBeforePaid) {
    try {
      const fg2 = applyFreeGoldExtraction(lead, perLead.verifiedBody);
      if (fg2.applied) {
        const prev = stageOutcomes['free_gold'];
        stageOutcomes['free_gold'] = {
          stage: 'free_gold',
          status: 'success',
          duration_ms: 0,
          detail: [prev?.detail, `paid_body:${fg2.filled.join(',')}`].filter(Boolean).join(' '),
        };
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[pipeline] second free-gold pass threw');
    }
  }

  const found = !!lead.official_website;
  const status: typeof LeadStatus[keyof typeof LeadStatus] = found ? LeadStatus.FOUND_WEBSITE_ONLY : LeadStatus.NOT_FOUND;
  // Reason policy: keep the FIRST informative reason_code from the ladder.
  // Generic "no candidates" / "discovery exhausted" only win when nothing
  // more specific was produced upstream (e.g. the input website was a
  // directory — that's a more useful signal to the operator than "we
  // couldn't find anything else either").
  const GENERIC_REASONS = new Set<ReasonCode>([RC.DISCOVERY_EXHAUSTED, RC.NOT_FOUND_NO_CANDIDATES]);
  const informative = Object.values(stageOutcomes)
    .map((o) => o.reason_code)
    .filter((rc): rc is ReasonCode => !!rc && !GENERIC_REASONS.has(rc));
  const reasonCode: ReasonCode = found
    ? RC.FOUND_WEBSITE_ONLY
    : (informative[0] ?? lastReasonCode ?? RC.DISCOVERY_EXHAUSTED);

  return finalize(lead, {
    status,
    reason_code: reasonCode,
    stage_outcomes: stageOutcomes,
    start,
    perLead,
    outcome: found ? 'success' : 'not_found',
    run,
  });
}

function finalize(
  lead: Lead,
  args: {
    status: typeof LeadStatus[keyof typeof LeadStatus];
    reason_code: ReasonCode;
    stage_outcomes: Record<string, StageOutcome>;
    start: number;
    perLead: PerLeadContext;
    outcome: 'success' | 'partial' | 'not_found' | 'error';
    run: Run;
  }
): EnrichmentResult {
  lead.status = args.status;
  lead.reason_code = args.reason_code;
  lead.duration_ms = Date.now() - args.start;
  // Phase 4.2.1: lead.cost_eur is sourced from the canonical CostLedger
  // (filtered by lead_id), NOT from the in-memory perLead.costEur which
  // depended on stages remembering to populate StageOutcome.cost_eur.
  // Stages may attribute their cost only via router.fetch/search/complete
  // (which always tags the entry with meta.lead_id) — this guarantees
  // the final number matches what was actually billable.
  args.perLead.costEur = args.run.ledger.costForLead(args.perLead.leadId);
  lead.cost_eur = args.perLead.costEur;
  lead.providers_used = Array.from(args.perLead.providersUsed);
  lead.stage_outcomes = args.stage_outcomes;
  return {
    lead,
    outcome: args.outcome,
    stage_outcomes: args.stage_outcomes,
    duration_ms: lead.duration_ms,
    cost_eur: lead.cost_eur,
  };
}
