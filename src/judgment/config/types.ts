import type { BusinessModel, GapCause, LeverKind, Quadrant, SubdimKey } from '../../types/judgment';

/**
 * The `judgment_config` schema — the home of ALL judgment LOGIC (plan §0
 * "cemento vs creta"). NOTHING here lives in the DB schema or in queries.
 *
 * Two strata, kept conceptually distinct (§0):
 *  - CRETA-LOGICA: rubrics, taxonomies, traps, levers, causes, archetypes —
 *    TRANSCRIBED from the v2 ontology, never invented. Every entry carries a
 *    `ref` to its v2 section so fidelity is auditable (a test enforces this).
 *  - CRETA-NUMERI: thresholds + weights — the ONLY free parameters (v2 is
 *    non-numeric, Caveat 1). Conservative defaults, tuned on the golden set.
 *
 * The judges (L4) are LLM-driven: the structured content here is rendered into
 * their prompts. The deterministic parts (thresholds, weights, the
 * `cheaplyCheckable` disqualifier subset, quadrant placement) are read directly
 * by code.
 */

/** Axis-A subdimension rubric (§2.1–2.7). */
export interface SubdimRubric {
  dim: SubdimKey;
  name: string;
  ref: string; // v2 section, e.g. '§2.1'
  definition: string;
  strengthSignals: string[];
  weaknessSignals: string[];
  /** where the signal is reachable from THIRD parties even when B is silent */
  thirdPartySources: string[];
}

/** Axis-A declension per business model (§2.8). */
export interface ModelDeclination {
  model: BusinessModel;
  ref: string; // §2.8.x
  whereStrengthLives: string;
  privilegedProxies: string[];
  /** per-subdimension salience priors for this model (CRETA-NUMERI). */
  subdimWeights: Partial<Record<SubdimKey, number>>;
  caveat?: string;
}

/** Axis-B surface rubric, three states (§3.1–3.15). */
export interface SurfaceRubric {
  surface: string; // '3.1'..'3.15'
  name: string;
  ref: string;
  excellence: string;
  mediocrity: string;
  absence: string;
  /** hybrid-source note: which part is A vs B (§3.4/§3.13/§3.14) */
  axisNote?: string;
}

/** Website rubric — the two lenses from the brief's Appendix A. */
export interface WebsiteRubric {
  ref: string;
  /** Lens 1 — validity/ownership: is it really their official site? */
  validityLens: string[];
  /** Lens 2 — quality/expression (Axis B): the concrete "eyes". */
  qualityLens: string[];
}

/** Per-model surface weighting priors (§3.0.2) — CRETA-NUMERI. */
export interface ModelSurfaceWeights {
  model: BusinessModel;
  ref: string;
  /** surface key → weight prior (0..1) */
  weights: Record<string, number>;
}

/** §3.16 transversal brand/messaging criteria. */
export interface TransversalCriterion {
  name: string;
  check: string;
}

/** §4.4 gap-cause taxonomy. */
export interface GapCauseDef {
  cause: GapCause;
  ref: string;
  signature: string;
  /** how colmabile / attractive the gap is when this is the cause */
  colmability: 'high' | 'medium' | 'low' | 'none';
}

/** §4.5 disqualifier / red-flag. */
export interface DisqualifierDef {
  id: string;
  ref: string;
  family: 'substance' | 'economic' | 'stage' | 'compliance' | 'distress' | 'fake_reputation';
  test: string;
  /** true → checkable in the cheap Stage-0 triage (§16) before paid collection */
  cheaplyCheckable: boolean;
}

/** Parte VI archetype attractor. */
export interface ArchetypeDef {
  id: string;
  ref: string;
  quadrant: Quadrant;
  signature: string;
}

/** Parte VII gap→lever. */
export interface LeverDef {
  kind: LeverKind;
  ref: string;
  symptom: string;
  gapNature: string;
  /** default ordering in the intervention sequence (§7.5) */
  sequence: number;
}

/** §5.3 cognitive trap (DO-NOT rule). */
export interface CognitiveTrap {
  id: number;
  ref: string;
  rule: string;
}

/** Quadrant definition (§4.1). */
export interface QuadrantDef {
  quadrant: Quadrant;
  ref: string;
  meaning: string;
  isTarget: boolean;
}

/**
 * The ONLY free numbers (CRETA-NUMERI). v2 is non-numeric (Caveat 1); these are
 * conservative system defaults, tuned on the golden set (§15). They are read by
 * deterministic code, NEVER baked into SQL.
 */
export interface JudgmentThresholds {
  /** axis score (0..1) → level */
  axisHigh: number;
  axisMid: number;
  /** |gap| bands */
  gapWide: number;
  gapModerate: number;
  /** target=yes requires gap >= targetMinGap AND scoreA >= targetMinScoreA */
  targetMinGap: number;
  targetMinScoreA: number;
  /** within ± of a boundary → borderline */
  borderlineBand: number;
  /** L5 validation: >= → fast-track human approve */
  validationAccept: number;
  /** verdict confidence below this → mandatory deep human review */
  reviewBelow: number;
  /** category cohort smaller than this → provisional baseline + lowered confidence */
  benchmarkMinSample: number;
}

/** System-prompt preambles (role + hard rules). The rubric BODY is rendered from the structured fields. */
export interface JudgmentPrompts {
  judgeA: string;
  judgeB: string;
  gap: string;
  critic: string;
}

export interface JudgmentConfig {
  version: string;
  ontologyVersion: string;
  /** §5.1 — the order of questions the GAP reasoner asks. */
  questionOrder: string[];
  /** §5.4 — golden rule, embedded verbatim in the GAP prompt. */
  goldenRule: string;
  /** §1.4 — relativity-of-category instruction. */
  categoryRelativity: string;
  /** §1.5 — trajectory instruction. */
  trajectory: string;
  judgeA: {
    subdims: SubdimRubric[];
    modelDeclination: ModelDeclination[];
  };
  judgeB: {
    surfaces: SurfaceRubric[];
    websiteRubric: WebsiteRubric;
    transversalCriteria: TransversalCriterion[];
    modelWeights: ModelSurfaceWeights[];
  };
  gap: {
    quadrants: QuadrantDef[];
    gapLogic: string;
    causes: GapCauseDef[];
    disqualifiers: DisqualifierDef[];
    archetypes: ArchetypeDef[];
    levers: LeverDef[];
    cognitiveTraps: CognitiveTrap[];
  };
  thresholds: JudgmentThresholds;
  prompts: JudgmentPrompts;
}
