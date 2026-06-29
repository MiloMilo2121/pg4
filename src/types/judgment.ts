/**
 * Judgment-layer vocabulary — the shared types for discovery refinement (L2),
 * signal collection (L3), judging (L4) and validation (L5).
 *
 * Design invariants (from the approved plan, §0/§3/§4):
 *  - THREE evidence states EVERYWHERE (`EvidenceState`). A failed/uncertain
 *    discovery is `unknown_not_found`, NEVER `confirmed_absent`, and must never
 *    be read as a negative B signal.
 *  - Axis A and Axis B signals live in SEPARATE arrays/columns; only the GAP
 *    reasoner ever sees both. No type fuses the two axes into one score.
 *  - Every assertion carries evidence (`EvidenceRef`): source + excerpt + ts +
 *    confidence. These project 1:1 onto `field_evidence` rows.
 *  - The judgment LOGIC (rubrics, weights, prompts, causes, disqualifiers,
 *    levers) is NOT here — it lives in the versioned `judgment_config`
 *    artifact. These types describe only the OUTPUTS and their provenance.
 */

export type EvidenceState = 'confirmed_present' | 'confirmed_absent' | 'unknown_not_found';

export type Axis = 'A' | 'B';

/**
 * Business model, used to declension Judge A (ontology §2.8) and to weight
 * Judge B surfaces (§3.0.2). A PRIOR, never a rigid rule.
 */
export type BusinessModel =
  | 'B2B_manufacturing' // §2.8.1
  | 'B2C_product' // §2.8.2
  | 'professional_local' // §2.8.3
  | 'hospitality_retail' // §2.8.4
  | 'B2B2C' // §2.8.5
  | 'unknown';

/** Provenance of a single observed assertion. Maps to a `field_evidence` row. */
export interface EvidenceRef {
  /** adapter/provider id: 'google_maps_gbp' | 'openapi' | 'ad_library_meta' | 'website_body' | ... */
  source: string;
  /** the load-bearing snippet (→ field_evidence.evidence_blob.excerpt) */
  excerpt?: string;
  url?: string;
  /** ISO timestamp string (stamped by the caller, never Date.now() inside pure code) */
  observedAt: string;
  /** 0..1 */
  confidence: number;
}

// ---------------------------------------------------------------------------
// L2 — Digital footprint (three-state per surface)
// ---------------------------------------------------------------------------

export type FootprintChannel =
  | 'website'
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'linkedin_company'
  | 'linkedin_founder'
  | 'facebook'
  | 'gbp'
  | 'marketplace'
  | 'ecommerce'
  | 'ad_library';

export type Ownership = 'owned_confirmed' | 'candidate_unverified' | 'rejected_third_party' | 'na';

export interface ChannelFootprint {
  channel: FootprintChannel;
  state: EvidenceState;
  url?: string;
  ownership: Ownership;
  discoveryMethod?: string; // 'website_link' | 'serp' | 'platform_lookup' | 'registry' | ...
  /**
   * THE gate for `confirmed_absent`: a channel may be marked absent ONLY when a
   * serious search actually ran (provider not breaker-tripped, non-degraded
   * result set, no candidate passed brand-match). Otherwise → `unknown`.
   */
  searchedSeriously: boolean;
  confidence: number; // 0..1 ownership/identity confidence
  evidence?: EvidenceRef[];
  lastCheckedAt: string;
}

export interface Footprint {
  resolvedDomain?: string;
  domainConfidence: number;
  businessModelHint?: BusinessModel;
  channels: ChannelFootprint[];
  /** website discovery hit-rate context, when computed over a batch */
  hitRate?: number;
}

// ---------------------------------------------------------------------------
// L3 — Raw signal packets (A and B collected SEPARATELY)
// ---------------------------------------------------------------------------

export interface Signal {
  axis: Axis;
  /** ontology subdimension key (e.g. '2.1') for A, or surface key (e.g. '3.4') for B */
  key: string;
  state: EvidenceState;
  value?: string | number | boolean | string[];
  /** category-relative salience, optional (from CategoryProfile) */
  weight?: number;
  /** ≥1 ref required when state === 'confirmed_present' (anti-hallucination) */
  evidence: EvidenceRef[];
  notes?: string;
}

/** Two physically separate packets — never share a container. */
export type SegnaliA = Signal[]; // every item axis === 'A', third-party sources only
export type SegnaliB = Signal[]; // every item axis === 'B', owned sources only

// ---------------------------------------------------------------------------
// L4 — Assessments (per axis, INDEPENDENT) + GAP verdict
// ---------------------------------------------------------------------------

export type SubdimKey = '2.1' | '2.2' | '2.3' | '2.4' | '2.5' | '2.6' | '2.7';
export type StrengthLevel = 'strong' | 'moderate' | 'weak' | 'insufficient_evidence';

export interface SubdimVerdict {
  dim: SubdimKey;
  level: StrengthLevel;
  confidence: number;
  /** keys of the signal packets this verdict cites */
  citations: string[];
  rationale: string;
}

export type SurfaceState = 'excellence' | 'mediocrity' | 'absence_abandonment' | 'unknown';

export interface SurfaceVerdict {
  /** surface key, e.g. '3.1' */
  surface: string;
  state: SurfaceState;
  /** §3.0.1 — the target's signature: present but does not express the real strength */
  presentButPoor: boolean;
  /** §3.0.2 model weight applied to this surface */
  weight: number;
  confidence: number;
  citations: string[];
  rationale: string;
}

export type AxisLevel = 'high' | 'mid' | 'low' | 'unknown';

export interface AxisAssessment {
  axis: Axis;
  /** 0..1 — INDEPENDENT per axis; never a fused number */
  score: number;
  level: AxisLevel;
  rationale: string;
  signalsConsidered: number;
  signalsPresent: number;
  /** surfaced so the operator sees evidence coverage */
  signalsUnknown: number;
  /** axis A only */
  subdims?: SubdimVerdict[];
  /** axis B only */
  surfaces?: SurfaceVerdict[];
  basedOn: EvidenceRef[];
}

// category benchmark (§1.4 relativity, §17 two-pass)
export interface CategoryBenchmark {
  p50?: number;
  p90?: number;
  presenceRate?: number;
  typical?: string | number;
}

export interface CategoryProfile {
  category: string;
  ontologyVersion: string;
  sampleSize: number;
  /** true when the cohort is too thin to trust the baseline */
  provisional: boolean;
  benchmarks: Record<string, CategoryBenchmark>;
  computedAt: string;
}

/**
 * Quadrant label. `+` = high, `-` = measured-low, `?` = NOT measured (axis
 * unknown). The `?` variants are load-bearing: a `?` axis must NEVER read as `-`
 * (the §5.3.5 firewall at the LABEL level). 'A?B+' is "B high, A not looked at"
 * — an indeterminate quadrant, NOT the "fuffa" A-B+. The ontology's four
 * canonical quadrants (§4.1) are the four +/- combinations; the `?` variants are
 * the honest "insufficient evidence" overlay.
 */
export type Quadrant =
  | 'A+B+'
  | 'A+B-'
  | 'A+B?'
  | 'A-B+'
  | 'A-B-'
  | 'A-B?'
  | 'A?B+'
  | 'A?B-'
  | 'A?B?';
export type Trajectory = 'improving' | 'flat' | 'declining' | 'unknown';
/** §4.4 cause taxonomy. */
export type GapCause = 'omission' | 'incompetence' | 'generational' | 'aversion' | 'constraint' | 'decline' | 'unknown';
export type TargetVerdict = 'yes' | 'no' | 'borderline';

export interface GapVerdict {
  businessModel: BusinessModel;
  quadrant: Quadrant;
  /** copied for audit; canonical lives in valutazione_A/B */
  scoreA: number;
  scoreB: number;
  /** A − B (can be negative); the separately-stored derived value */
  gap: number;
  gapWidth: 'narrow' | 'moderate' | 'wide';
  trajectory: Trajectory; // §1.5
  cause: GapCause; // §4.4
  /** §4.5 — hard knock-outs applied BEFORE the gap logic */
  disqualifiers: string[];
  target: TargetVerdict;
  /** illustrative archetype matched (Parte VI) */
  archetype?: string;
  /** traceable motivation citing A-subdims and B-surfaces */
  motivation: string;
  confidence: number;
}

// Lever (Parte VII)
export type LeverKind = 'positioning' | 'acquisition' | 'conversion_ops' | 'measurement';
export interface Lever {
  kind: LeverKind;
  rationale: string;
  /** ordering in the recommended intervention sequence (§7.5) */
  sequence: number;
  basedOn: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// L5 — Agentic validation + human gate
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** 0..1 — agentic validator's confidence the verdict is sound + grounded */
  validationScore: number;
  consistent: boolean;
  /** e.g. 'asymmetry_breach', 'uncited_claim', 'hallucinated_state', 'thin_coverage' */
  flags: string[];
  reviewedBy: 'agent' | 'human';
  humanDecision?: 'approved' | 'overridden' | 'pending';
}

// ---------------------------------------------------------------------------
// meta (versioning → reproducibility, §20)
// ---------------------------------------------------------------------------

export interface JudgmentMeta {
  ontologyVersion: string;
  judgmentConfigVersion: string;
  judgePromptVersion: string;
  modelId?: string;
  footprintAt?: string;
  signalsAt?: string;
  verdictAt?: string;
  validatedAt?: string;
}

/**
 * The umbrella the UI reads. Physically: nine JSONB columns on `companies`
 * (Postgres) or nine nested keys on the in-memory CompanyRow. Each section is a
 * PURE PROJECTION of the append-only `field_evidence` atoms — never edited
 * independently (watch-item #4).
 */
export interface JudgmentRecord {
  footprint?: Footprint;
  segnali_A?: SegnaliA;
  segnali_B?: SegnaliB;
  valutazione_A?: AxisAssessment;
  valutazione_B?: AxisAssessment;
  contesto_categoria?: CategoryProfile;
  verdetto_gap?: GapVerdict;
  leva?: Lever[];
  validazione?: ValidationResult;
  meta?: JudgmentMeta;
}

/** The nine judgment section keys (column names / in-memory keys). */
export const JUDGMENT_SECTIONS = [
  'footprint',
  'segnali_a',
  'segnali_b',
  'valutazione_a',
  'valutazione_b',
  'contesto_categoria',
  'verdetto_gap',
  'leva',
  'validazione',
  'judgment_meta',
] as const;
export type JudgmentSection = (typeof JUDGMENT_SECTIONS)[number];
