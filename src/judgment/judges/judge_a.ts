import type { AxisAssessment, BusinessModel, CategoryProfile, EvidenceRef, SegnaliA, SubdimKey, SubdimVerdict, StrengthLevel } from '../../types/judgment';
import type { JudgmentConfig } from '../config/types';
import { type JudgeLLM, levelFromScore, parseJsonLoose, clamp01 } from './shared';

/**
 * Judge A — intrinsic product/narrative strength (Axis A). Consumes ONLY
 * segnali_A (third-party). Enforced by signature: there is no parameter through
 * which a B signal could enter. Runs deterministically offline; refines with an
 * LLM when provided. Per subdimension §2.1–2.7, declined by model §2.8.
 */

const SUBDIMS: SubdimKey[] = ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7'];
const LEVEL_NUM: Record<StrengthLevel, number | null> = { strong: 1, moderate: 0.6, weak: 0.15, insufficient_evidence: null };

export interface JudgeADeps {
  config: JudgmentConfig;
  llm?: JudgeLLM;
}

function deterministicSubdims(segnaliA: SegnaliA): SubdimVerdict[] {
  return SUBDIMS.map((dim) => {
    const sigs = segnaliA.filter((s) => s.key === dim);
    const present = sigs.filter((s) => s.state === 'confirmed_present');
    const absent = sigs.filter((s) => s.state === 'confirmed_absent');
    let level: StrengthLevel;
    if (present.length >= 2) level = 'strong';
    else if (present.length === 1) level = 'moderate';
    else if (absent.length > 0) level = 'weak';
    else level = 'insufficient_evidence';
    const citations = present.map((s) => `signal_a:${s.key}`);
    return { dim, level, confidence: present.length ? 0.6 : absent.length ? 0.5 : 0.2, citations, rationale: `det: ${present.length} present, ${absent.length} absent` };
  });
}

function scoreFromSubdims(subdims: SubdimVerdict[], model: BusinessModel, config: JudgmentConfig): number {
  const decl = config.judgeA.modelDeclination.find((d) => d.model === model);
  const weightFor = (dim: SubdimKey) => decl?.subdimWeights[dim] ?? 0.6;
  let num = 0;
  let den = 0;
  for (const sd of subdims) {
    const val = LEVEL_NUM[sd.level];
    if (val === null) continue; // insufficient → excluded from denominator
    const w = weightFor(sd.dim);
    num += w * val;
    den += w;
  }
  return den > 0 ? clamp01(num / den) : 0;
}

export async function judgeA(segnaliA: SegnaliA, model: BusinessModel, categoryProfile: CategoryProfile | undefined, deps: JudgeADeps): Promise<AxisAssessment> {
  const { config } = deps;
  let subdims = deterministicSubdims(segnaliA);
  let rationale = 'deterministic baseline (no LLM)';

  // optional LLM refinement of the per-subdim LEVELS (semantic). Numbers stay ours.
  if (deps.llm) {
    const prompt = renderJudgeAPrompt(segnaliA, model, categoryProfile, config);
    const text = await deps.llm({ system: config.prompts.judgeA, prompt, json_schema: JUDGE_A_SCHEMA, temperature: 0 });
    const parsed = parseJsonLoose(text) as { subdims?: Array<{ dim: string; level: string; rationale?: string; citations?: string[] }>; rationale?: string } | undefined;
    if (parsed?.subdims?.length) {
      const byDim = new Map(parsed.subdims.map((s) => [s.dim, s]));
      subdims = SUBDIMS.map((dim) => {
        const llmSd = byDim.get(dim);
        const base = subdims.find((s) => s.dim === dim)!;
        const level = isStrength(llmSd?.level) ? (llmSd!.level as StrengthLevel) : base.level;
        return { dim, level, confidence: base.confidence, citations: llmSd?.citations?.length ? llmSd.citations : base.citations, rationale: llmSd?.rationale ?? base.rationale };
      });
      rationale = parsed.rationale ?? 'LLM-refined';
    }
  }

  const score = scoreFromSubdims(subdims, model, config);
  const present = segnaliA.filter((s) => s.state === 'confirmed_present');
  const basedOn: EvidenceRef[] = present.flatMap((s) => s.evidence);
  return {
    axis: 'A',
    score,
    level: levelFromScore(score, config.thresholds),
    rationale,
    signalsConsidered: segnaliA.length,
    signalsPresent: present.length,
    signalsUnknown: segnaliA.filter((s) => s.state === 'unknown_not_found').length,
    subdims,
    basedOn,
  };
}

function isStrength(v: unknown): v is StrengthLevel {
  return v === 'strong' || v === 'moderate' || v === 'weak' || v === 'insufficient_evidence';
}

export function renderJudgeAPrompt(segnaliA: SegnaliA, model: BusinessModel, categoryProfile: CategoryProfile | undefined, config: JudgmentConfig): string {
  const rubrics = config.judgeA.subdims.map((s) => `- ${s.dim} ${s.name} (${s.ref}): ${s.definition}\n  forza: ${s.strengthSignals.join('; ')}\n  debolezza: ${s.weaknessSignals.join('; ')}`).join('\n');
  const decl = config.judgeA.modelDeclination.find((d) => d.model === model);
  const declTxt = decl ? `Modello ${model} (${decl.ref}): proxy privilegiati ${decl.privilegedProxies.join(', ')}. ${decl.caveat ?? ''}` : `Modello ${model}.`;
  const rel = categoryProfile ? `\nBenchmark di categoria (${categoryProfile.category}, n=${categoryProfile.sampleSize}${categoryProfile.provisional ? ', PROVVISORIO' : ''}): ${JSON.stringify(categoryProfile.benchmarks)}` : '';
  const signalsTxt = segnaliA.map((s) => `[${s.key}] ${s.state}${s.value !== undefined ? ` = ${JSON.stringify(s.value)}` : ''}${s.notes ? ` (${s.notes})` : ''}`).join('\n');
  return [
    `${config.categoryRelativity}`,
    `\nRUBRICHE ASSE A (§2.1–2.7):\n${rubrics}`,
    `\nDECLINAZIONE PER MODELLO (§2.8): ${declTxt}`,
    rel,
    `\nSEGNALI A (solo terze parti):\n${signalsTxt}`,
    `\nValuta ogni sotto-dimensione (strong/moderate/weak/insufficient_evidence), cita le chiavi dei segnali, e restituisci JSON {subdims:[{dim,level,citations,rationale}], rationale}.`,
  ].join('\n');
}

export const JUDGE_A_SCHEMA = {
  type: 'object',
  properties: {
    subdims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dim: { type: 'string' },
          level: { type: 'string', enum: ['strong', 'moderate', 'weak', 'insufficient_evidence'] },
          citations: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['dim', 'level'],
      },
    },
    rationale: { type: 'string' },
  },
  required: ['subdims'],
};
