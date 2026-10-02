import type { Lead } from '../../types/lead';
import type { ProviderRouter, RouteOptions } from '../../providers/provider_router';
import type { EnrichableField } from '../../types/api';
import { extractFromBody } from '../extract/extract_from_body';
import type { BodyExtraction } from '../extract/extract_from_body';
import { FIELD_BY_NAME } from './field_registry';
import type { EnrichmentFieldDescriptor, EnrichmentStep, FieldStepContext, StepResult } from './field_types';

/**
 * The per-field cascade runner — the pipeline loop shape lifted out and made
 * field-generic. For one field it walks the cascade free→paid, applying the
 * triple gate (step.enabled · paidEnabled for tier-2 · per-field budget), stops
 * at the first value whose confidence ≥ the field's stopConfidence and writes it
 * to the lead. A costed step runs only through `router.invoke`, which adds the
 * run ceiling, the per-lead cap and the circuit breaker, and records what the
 * step actually cost in the router's ledger.
 */

export interface FieldCascadeOutcome {
  field: EnrichableField;
  resolved: boolean;
  value?: string;
  source?: string;
  confidence: number;
  costEur: number;
  /** Per-step trace for observability + the dashboard's evidence drill-down. */
  steps: Array<{ id: string; tier: number; ran: boolean; reason?: StepResult['skippedReason']; costEur: number }>;
}

export interface RunFieldOptions {
  /** Raw HTML of the firm's own website (the free-gold body), if available. */
  body?: string;
  /** Pre-computed extraction (skips re-parsing the body). */
  extraction?: BodyExtraction;
  paidEnabled?: boolean;
  /**
   * Required for any costed step: without it a costed step is `paid_gated`. Its
   * ledger is the one charged.
   */
  router?: ProviderRouter;
  /** Run-level cap forwarded to the router for every costed step. */
  runCostCeilingEur?: number;
  /** Per-lead cap forwarded to the router (re-read from its ledger via `meta.lead_id`). */
  leadCostCeilingEur?: number;
  /** meta for ledger attribution (tenant_id, lead_id, job_item_id). */
  meta?: Record<string, string | number | boolean>;
  /** GDPR hook forwarded to steps — true if an email is suppressed (do-not-contact). */
  isSuppressedEmail?: (email: string) => boolean;
}

/**
 * Run an explicit field descriptor (the core runner). Exported so the gating
 * logic — including ENABLED paid steps — can be tested without mutating the
 * shipped registry (whose paid steps are all disabled this pass).
 */
export async function runFieldDescriptor(lead: Lead, descriptor: EnrichmentFieldDescriptor, opts: RunFieldOptions = {}): Promise<FieldCascadeOutcome> {
  const extraction = opts.extraction ?? (opts.body ? extractFromBody(opts.body, lead) : undefined);
  return runOne(lead, descriptor, extraction, opts);
}

async function runOne(lead: Lead, descriptor: EnrichmentFieldDescriptor, extraction: BodyExtraction | undefined, opts: RunFieldOptions): Promise<FieldCascadeOutcome> {
  const paidEnabled = opts.paidEnabled === true;
  const steps: FieldCascadeOutcome['steps'] = [];
  let spentOnField = 0;

  for (const step of descriptor.cascade) {
    // Gate 1 — wired-but-disabled steps never run.
    if (!step.enabled) {
      steps.push({ id: step.id, tier: step.tier, ran: false, reason: 'disabled', costEur: 0 });
      continue;
    }
    // Gate 2 — a paid (tier-2) step needs the global paid switch.
    if (step.tier >= 2 && !paidEnabled) {
      steps.push({ id: step.id, tier: step.tier, ran: false, reason: 'paid_gated', costEur: 0 });
      continue;
    }
    // Gate 3 — a costed step must fit the per-field ceiling.
    if (step.costEur > 0 && spentOnField + step.costEur > descriptor.ceilingEur) {
      steps.push({ id: step.id, tier: step.tier, ran: false, reason: 'budget', costEur: 0 });
      continue;
    }

    const stepCtx = { lead, extraction, paidEnabled, isSuppressedEmail: opts.isSuppressedEmail };
    let res: StepResult;
    if (step.costEur > 0) {
      if (!opts.router) {
        steps.push({ id: step.id, tier: step.tier, ran: false, reason: 'paid_gated', costEur: 0 });
        continue;
      }
      const invoked = await invokeCostedStep(opts.router, step, stepCtx, descriptor.field, paidEnabled, opts);
      if (!invoked) {
        steps.push({ id: step.id, tier: step.tier, ran: false, reason: 'budget', costEur: 0 });
        continue;
      }
      res = invoked;
      spentOnField += res.costEur;
    } else {
      res = await runStep(step, stepCtx);
    }
    steps.push({ id: step.id, tier: step.tier, ran: true, reason: res.value ? undefined : res.skippedReason, costEur: step.costEur > 0 ? res.costEur : 0 });

    if (res.value && res.confidence >= descriptor.stopConfidence) {
      // Fill-only-missing: never overwrite an existing value (input/earlier wins).
      const cur = (lead as Record<string, unknown>)[descriptor.target as string];
      if (cur === undefined || cur === null || cur === '') {
        (lead as Record<string, unknown>)[descriptor.target as string] = res.value;
      }
      // Companion fields from the same fetch (e.g. revenue → revenue_year),
      // same fill-only-empty discipline as the target.
      if (res.extras) {
        for (const [k, v] of Object.entries(res.extras)) {
          if (!v) continue;
          const curX = (lead as Record<string, unknown>)[k];
          if (curX === undefined || curX === null || curX === '') (lead as Record<string, unknown>)[k] = v;
        }
      }
      return {
        field: descriptor.field,
        resolved: true,
        value: res.value,
        source: res.source,
        confidence: res.confidence,
        costEur: spentOnField,
        steps,
      };
    }
  }
  return { field: descriptor.field, resolved: false, confidence: 0, costEur: spentOnField, steps };
}

/** tier-0 steps are sync, network steps return a Promise — await either. A
 *  throwing step degrades to "no value" rather than failing the cascade. */
async function runStep(step: EnrichmentStep, ctx: FieldStepContext): Promise<StepResult> {
  try {
    return await step.run(ctx);
  } catch {
    return { confidence: 0, source: step.id, costEur: 0, skippedReason: 'no_value' };
  }
}

/**
 * Run a costed step through `router.invoke` — the same gate pipeline every paid
 * provider call uses (paid gate, breaker, per-lead cap, run-ceiling reservation,
 * ledger). The ledger is charged the cost the step REPORTS, since a step can stop
 * before its API call (no domain, no VAT) and spend nothing. Returns `null` when
 * the router refused to run the step.
 */
async function invokeCostedStep(
  router: ProviderRouter,
  step: EnrichmentStep,
  ctx: FieldStepContext,
  field: EnrichableField,
  paidEnabled: boolean,
  opts: RunFieldOptions,
): Promise<StepResult | null> {
  let called = false;
  let res: StepResult | undefined;
  const route: RouteOptions = {
    paidEnabled,
    runCostCeilingEur: opts.runCostCeilingEur,
    leadCostCeilingEur: opts.leadCostCeilingEur,
    meta: { ...opts.meta, field },
  };
  await router.invoke(
    { id: step.id, family: step.family ?? 'official', tier: step.tier, costPerCallEur: step.costEur, available: () => step.enabled },
    async () => {
      called = true;
      res = await step.run(ctx);
      return { ok: !!res.value, value: res, cost_eur: res.costEur };
    },
    route,
  );
  if (res) return res;
  // A step that threw after admission degrades to "no value"; the router has
  // already charged its worst-case cost, so the field budget counts it too.
  if (called) return { confidence: 0, source: step.id, costEur: step.costEur, skippedReason: 'no_value' };
  return null;
}

/** Run one field's cascade. */
export async function runFieldCascade(lead: Lead, field: EnrichableField, opts: RunFieldOptions = {}): Promise<FieldCascadeOutcome> {
  const descriptor = FIELD_BY_NAME.get(field);
  if (!descriptor) throw new Error(`unknown enrichment field: ${field}`);
  const extraction = opts.extraction ?? (opts.body ? extractFromBody(opts.body, lead) : undefined);
  return runOne(lead, descriptor, extraction, opts);
}

/**
 * Run several fields over one lead. The website body is parsed ONCE (free-gold)
 * and shared across every field's free tier — the cost principle made concrete.
 * Fields run sequentially so a master-key field (VAT) resolved by an earlier
 * cascade is visible to a later one (e.g. PEC/revenue keyed on vat_code_final).
 */
export async function runFieldCascades(lead: Lead, fields: EnrichableField[], opts: RunFieldOptions = {}): Promise<FieldCascadeOutcome[]> {
  const extraction = opts.extraction ?? (opts.body ? extractFromBody(opts.body, lead) : undefined);
  const out: FieldCascadeOutcome[] = [];
  for (const f of fields) {
    const descriptor = FIELD_BY_NAME.get(f);
    if (!descriptor) throw new Error(`unknown enrichment field: ${f}`);
    out.push(await runOne(lead, descriptor, extraction, opts));
  }
  return out;
}
