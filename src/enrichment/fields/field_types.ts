import type { Lead } from '../../types/lead';
import type { BodyExtraction } from '../extract/extract_from_body';
import type { EnrichableField } from '../../types/api';
import type { ProviderFamily, ProviderRole } from '../../types/providers';

/**
 * Per-field enrichment waterfall — the single website-discovery ladder
 * generalized into one ordered free→paid cascade PER FIELD.
 *
 * This is DATA, not code: a field declares its cascade of steps, a per-field
 * cost ceiling, and a stop condition. The runner (run_field_cascade.ts) is the
 * pipeline loop shape lifted out — it reuses the engine's CostLedger and the
 * triple-gate (a paid step runs only if enabled + paidEnabled + within the
 * per-field budget). Born free-first and safe; paid steps are wired but
 * DISABLED in this pass.
 */

type Tier = 0 | 1 | 2; // 0 free-deterministic · 1 free-network · 2 paid

export interface StepResult {
  value?: string;
  confidence: number; // 0..1
  source: string;
  costEur: number;
  /** Set when a step could not run (disabled / gated / no input). */
  skippedReason?: 'disabled' | 'paid_gated' | 'budget' | 'no_input' | 'no_value' | 'vat_unverified';
  /**
   * Companion fields resolved by the SAME fetch as `value` (the cascade is
   * single-target; without this channel a step like revenue drops the year it
   * already parsed). Applied by the runner fill-only-empty, same discipline as
   * the target. Typed whitelist — widen deliberately, not ad hoc.
   */
  extras?: Partial<Record<'revenue_year', string>>;
}

/** Inputs every step receives. The body extraction is computed ONCE (free-gold). */
export interface FieldStepContext {
  lead: Lead;
  /** Parsed result of the already-fetched website body. */
  extraction?: BodyExtraction;
  paidEnabled: boolean;
  /**
   * GDPR hook — returns true if an email is on the suppression list. The email
   * inference step consults it so a do-not-contact address is never synthesised
   * or probed. Optional; absent on paths without a loaded suppression list.
   */
  isSuppressedEmail?: (email: string) => boolean;
}

export interface EnrichmentStep {
  id: string;
  tier: Tier;
  /** Estimated/actual cost of this step in EUR (0 for free tiers). */
  costEur: number;
  /** Wired-but-disabled paid steps set this false until activated. */
  enabled: boolean;
  /** Ledger family of a costed step's provider (defaults to 'official'). */
  family?: ProviderFamily;
  /**
   * Resolve the field for this step. Tier-0 free steps are synchronous (they
   * read the already-fetched body); tier-1/2 network steps (VIES,
   * fatturatoitalia, paid APIs) return a Promise. The runner awaits either.
   */
  run(ctx: FieldStepContext): StepResult | Promise<StepResult>;
}

export interface EnrichmentFieldDescriptor {
  field: EnrichableField;
  /** The target Lead property the resolved value is written to. */
  target: keyof Lead;
  /**
   * The functional ProviderRole this field's cascade fulfils (role_registry.ts).
   * Lets the role layer + the field cascade stay consistent (cross-check test AC8).
   */
  role?: ProviderRole;
  cascade: EnrichmentStep[];
  /** Per-field cost ceiling (EUR). Paid steps are skipped once it is reached. */
  ceilingEur: number;
  /** Stop when a step's confidence is ≥ this. */
  stopConfidence: number;
}
