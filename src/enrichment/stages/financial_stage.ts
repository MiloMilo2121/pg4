import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { emptyFinancialResult } from '../financial/financial_types';
import type { FinancialResult } from '../financial/financial_types';
import { normalizeVatCode, validateItalianVatChecksum } from '../financial/vat';

/**
 * R13 — Financial enrichment stage SKELETON.
 *
 * DISABLED BY DEFAULT and NOT wired into the production ladder
 * (`enrichment_pipeline.ts`). This is a safe placeholder that establishes
 * the contract; the live/paid paths land in later phases (see
 * docs/r13_financial_enrichment_audit.md §9).
 *
 * Hard rules (enforced here):
 *   - NO network. The only work done is PURE: validate the input
 *     `vat_code`'s checksum and promote it to `vat_code_final`.
 *   - NO paid provider, ever.
 *   - NO failure breaks lead output — everything is wrapped; the worst
 *     case is a `skipped` outcome.
 *   - Every signal written carries a source + confidence (via
 *     `FinancialResult.evidence`), mirrored onto the lead's flat fields.
 *   - Missing data is NOT an error — it is `not_found`/`skipped`.
 *
 * When `enabled` is false the stage is a strict no-op (`skipped`), so it is
 * safe to add to the ladder before the live paths exist.
 */
export interface FinancialStageOptions {
  /** Master switch. Default false → no-op `skipped`. */
  enabled?: boolean;
}

export class FinancialStage implements Stage {
  readonly name = 'financial';
  private readonly enabled: boolean;

  constructor(opts: FinancialStageOptions = {}) {
    this.enabled = opts.enabled === true;
  }

  async run(_ctx: PerLeadContext, lead: Lead, _normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();

    if (!this.enabled) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'financial_stage_disabled' };
    }

    try {
      const result = this.deriveFromInput(lead);
      this.applyToLead(lead, result);

      const hasVat = Boolean(result.vat_code_final);
      if (hasVat) {
        return {
          stage: this.name,
          status: 'success',
          duration_ms: Date.now() - start,
          evidence_count: result.evidence.length,
          provider: result.financial_source,
          detail: 'vat_code_final from checksum-valid input',
        };
      }

      // No signal is NOT an error.
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        evidence_count: 0,
        detail: 'no_pure_financial_signal',
      };
    } catch (err) {
      // A financial failure must never break the lead. Degrade to skipped.
      return {
        stage: this.name,
        status: 'skipped',
        duration_ms: Date.now() - start,
        detail: `financial_stage_soft_error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * PURE derivation from already-present input. No network. Currently only
   * validates the input P.IVA checksum and records provenance. Future
   * phases extend this with parsed-page revenue (still pure) and gated
   * live lookups (VIES / fatturatoitalia).
   *
   * ⚠️ WRONG-ENTITY CONTRACT (audit 2026-06-16): the per-field cascade
   * (`run_field_cascade` / `field_registry`) is the CANONICAL field-enrichment path
   * and already carries the franchise/entity guards (vatResolve + isWrongEntity) and
   * the fatturatoitalia rate-limiter. This CLI stage is intentionally PURE (no fetch),
   * so it cannot mis-attribute a franchisor's/accountant's firmographics. If a future
   * phase adds a VIES/fatturatoitalia lookup HERE, it MUST reuse the per-field cascade
   * (or `isWrongEntity` + the rate-limiter) — do NOT re-implement an un-guarded fetch,
   * or the €58M franchise-collision class re-opens on the CLI path. The purity is
   * locked by financial_stage.test.ts ("pure — never fetches revenue/employees").
   */
  private deriveFromInput(lead: Lead): FinancialResult {
    const result = emptyFinancialResult();

    const candidate = normalizeVatCode(lead.vat_code_final || lead.vat_code);
    if (candidate && validateItalianVatChecksum(candidate)) {
      result.vat_code_final = candidate;
      result.financial_source = 'input';
      result.financial_confidence = 0.6; // checksum-only; bumps to ~0.9 once VIES-validated
      result.evidence.push({
        field: 'vat_code',
        source: 'input',
        confidence: 0.6,
        raw: lead.vat_code ?? candidate,
        detail: 'italian_piva_checksum_ok',
      });
    }

    return result;
  }

  /** Mirror the structured result onto the lead's flat fields. Idempotent. */
  private applyToLead(lead: Lead, result: FinancialResult): void {
    if (result.vat_code_final && !lead.vat_code_final) {
      lead.vat_code_final = result.vat_code_final;
    }
    if (result.revenue && !lead.revenue) lead.revenue = result.revenue;
    if (result.revenue_year && !lead.revenue_year) lead.revenue_year = result.revenue_year;
    if (result.employees && !lead.employees) {
      lead.employees = result.employees;
      lead.employees_is_estimated = result.employees_is_estimated ?? false;
    }
    // Provenance — written only when we actually produced a signal.
    if (result.financial_source && result.financial_confidence !== undefined) {
      lead.financial_source = result.financial_source;
      lead.financial_confidence = result.financial_confidence;
    }
    if (result.evidence.length > 0) {
      lead.financial_evidence_count = result.evidence.length;
    }
    const notes = buildNotes(result);
    if (notes && !lead.financial_notes) lead.financial_notes = notes;
  }
}

/** Flatten the evidence trail + non-fatal errors into a compact note string. */
function buildNotes(result: FinancialResult): string | undefined {
  const parts: string[] = [];
  for (const e of result.evidence) parts.push(`${e.field}:${e.detail ?? e.source}`);
  if (result.financial_errors) parts.push(...result.financial_errors);
  return parts.length > 0 ? parts.join('; ') : undefined;
}
