import type { BusinessModel, GapCause, LeverKind, Quadrant, SubdimKey } from '../../types/judgment';

/**
 * The `judgment_config` schema — the home of ALL judgment LOGIC ("cemento vs creta").
 * NOTHING here lives in the DB schema or in queries.
 *
 * Two strata, kept conceptually distinct:
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

/** Axis-A subdimension rubric. */
interface SubdimRubric {
  dim: SubdimKey;
  name: string;
  ref: string; // the v2 ontology section this was transcribed from
  definition: string;
  strengthSignals: string[];
  weaknessSignals: string[];
  /** where the signal is reachable from THIRD parties even when B is silent */
  thirdPartySources: string[];
}

/** Axis-A declension per business model. */
interface ModelDeclination {
  model: BusinessModel;
  ref: string; // the v2 ontology section, per-model variant
  whereStrengthLives: string;
  privilegedProxies: string[];
  /** per-subdimension salience priors for this model (CRETA-NUMERI). */
  subdimWeights: Partial<Record<SubdimKey, number>>;
  caveat?: string;
}

/** Axis-B surface rubric, three states. */
interface SurfaceRubric {
  surface: string; // '3.1'..'3.15'
  name: string;
  ref: string;
  excellence: string;
  mediocrity: string;
  absence: string;
  /** hybrid-source note: which part is A vs B */
  axisNote?: string;
}

/** Website rubric — the two lenses from the brief's Appendix A. */
interface WebsiteRubric {
  ref: string;
  /** Lens 1 — validity/ownership: is it really their official site? */
  validityLens: string[];
  /** Lens 2 — quality/expression (Axis B): the concrete "eyes". */
  qualityLens: string[];
}

/** Per-model surface weighting priors — CRETA-NUMERI. */
interface ModelSurfaceWeights {
  model: BusinessModel;
  ref: string;
  /** surface key → weight prior (0..1) */
  weights: Record<string, number>;
}

/** Transversal brand/messaging criteria. */
interface TransversalCriterion {
  name: string;
  check: string;
}

/** The taxonomy of causes a gap can have. */
interface GapCauseDef {
  cause: GapCause;
  ref: string;
  signature: string;
  /** how colmabile / attractive the gap is when this is the cause */
  colmability: 'high' | 'medium' | 'low' | 'none';
}

/** A disqualifier / red-flag that rules a lead out. */
interface DisqualifierDef {
  id: string;
  ref: string;
  family: 'substance' | 'economic' | 'stage' | 'compliance' | 'distress' | 'fake_reputation';
  test: string;
  /** true → checkable in the cheap Stage-0 triage before paid collection */
  cheaplyCheckable: boolean;
}

/** An archetype attractor — the pattern a company is recognised by. */
interface ArchetypeDef {
  id: string;
  ref: string;
  quadrant: Quadrant;
  signature: string;
}

/** A gap→lever mapping: the symptom it presents with and what it really is. */
interface LeverDef {
  kind: LeverKind;
  ref: string;
  symptom: string;
  gapNature: string;
  /** default ordering in the intervention sequence */
  sequence: number;
}

/** A cognitive trap (DO-NOT rule). */
interface CognitiveTrap {
  id: number;
  ref: string;
  rule: string;
}

/** Quadrant definition. */
interface QuadrantDef {
  quadrant: Quadrant;
  ref: string;
  meaning: string;
  isTarget: boolean;
}

/**
 * The ONLY free numbers (CRETA-NUMERI). v2 is non-numeric (Caveat 1); these are
 * conservative system defaults, tuned on the golden set. They are read by
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
interface JudgmentPrompts {
  judgeA: string;
  judgeB: string;
  gap: string;
  critic: string;
}

export interface JudgmentConfig {
  version: string;
  ontologyVersion: string;
  /** The order of questions the GAP reasoner asks. */
  questionOrder: string[];
  /** Golden rule, embedded verbatim in the GAP prompt. */
  goldenRule: string;
  /** Relativity-of-category instruction. */
  categoryRelativity: string;
  /** Trajectory instruction. */
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
