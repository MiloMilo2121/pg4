import type { JudgmentConfig } from './types';
import { JUDGMENT_CONFIG_V0 } from './v0';

export type { JudgmentConfig } from './types';
export {
  JUDGMENT_CONFIG_V0,
} from './v0';

/**
 * Active judgment_config registry. The ACTIVE config is a versioned in-code
 * artifact (CRETA). Re-judging with a new version = swap here + re-run L4; never
 * a migration (plan §0/§20). A DB snapshot lives in `judgment_config_versions`
 * purely for reproducibility (see snapshotConfig).
 */
const REGISTRY: Record<string, JudgmentConfig> = {
  [JUDGMENT_CONFIG_V0.version]: JUDGMENT_CONFIG_V0,
};

const ACTIVE_VERSION = JUDGMENT_CONFIG_V0.version;

export function getActiveJudgmentConfig(): JudgmentConfig {
  return REGISTRY[ACTIVE_VERSION];
}

export function getJudgmentConfig(version: string): JudgmentConfig | undefined {
  return REGISTRY[version];
}

export function listJudgmentConfigVersions(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Snapshot a config as DATA for the `judgment_config_versions` table (repro).
 * This is a serialization, NOT logic-in-query: the blob is opaque to SQL.
 */
export function snapshotConfig(cfg: JudgmentConfig): {
  version: string;
  ontology_version: string;
  blob: JudgmentConfig;
} {
  return { version: cfg.version, ontology_version: cfg.ontologyVersion, blob: cfg };
}

/**
 * Collect every CRETA-LOGICA entry with the v2 section `ref` it was transcribed
 * from. Used by the fidelity test to enforce that no judgment logic is
 * "improvised" (plan §0: logica trascritta da v2, only numbers are extension).
 */
export function collectLogicRefs(cfg: JudgmentConfig): Array<{ kind: string; id: string; ref: string }> {
  const out: Array<{ kind: string; id: string; ref: string }> = [];
  for (const s of cfg.judgeA.subdims) out.push({ kind: 'subdim', id: s.dim, ref: s.ref });
  for (const m of cfg.judgeA.modelDeclination) out.push({ kind: 'modelDeclination', id: m.model, ref: m.ref });
  for (const s of cfg.judgeB.surfaces) out.push({ kind: 'surface', id: s.surface, ref: s.ref });
  out.push({ kind: 'websiteRubric', id: 'websiteRubric', ref: cfg.judgeB.websiteRubric.ref });
  for (const w of cfg.judgeB.modelWeights) out.push({ kind: 'modelWeights', id: w.model, ref: w.ref });
  for (const q of cfg.gap.quadrants) out.push({ kind: 'quadrant', id: q.quadrant, ref: q.ref });
  for (const c of cfg.gap.causes) out.push({ kind: 'cause', id: c.cause, ref: c.ref });
  for (const d of cfg.gap.disqualifiers) out.push({ kind: 'disqualifier', id: d.id, ref: d.ref });
  for (const a of cfg.gap.archetypes) out.push({ kind: 'archetype', id: a.id, ref: a.ref });
  for (const l of cfg.gap.levers) out.push({ kind: 'lever', id: l.kind, ref: l.ref });
  for (const t of cfg.gap.cognitiveTraps) out.push({ kind: 'trap', id: String(t.id), ref: t.ref });
  return out;
}

/** The disqualifiers a deterministic Stage-0 triage can check cheaply (§16/§4.5). */
export function cheapDisqualifiers(cfg: JudgmentConfig): string[] {
  return cfg.gap.disqualifiers.filter((d) => d.cheaplyCheckable).map((d) => d.id);
}
