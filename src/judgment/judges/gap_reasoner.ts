import type { Lead } from '../../types/lead';
import type { AxisAssessment, AxisLevel, BusinessModel, CategoryProfile, GapVerdict, GapCause, Lever, Quadrant, SegnaliA, SegnaliB, Trajectory } from '../../types/judgment';
import type { JudgmentConfig } from '../config/types';
import { type JudgeLLM, parseJsonLoose, clamp01 } from './shared';

/**
 * GAP reasoner — the ONLY component that sees both axes. It does NOT re-judge;
 * it combines. Order (§5.1): classify model → quadrant + gap (relative to
 * category §1.4) → trajectory (§1.5) → DISQUALIFIERS (§4.5) BEFORE the gap logic
 * → cause (§4.4) → archetype (Parte VI) → verdict → levers (Parte VII). Never
 * fuses the two axes into one score. Deterministic core; LLM refines cause /
 * motivation / levers / extra disqualifiers.
 */

export interface GapDeps {
  config: JudgmentConfig;
  llm?: JudgeLLM;
}

export interface GapOutput {
  verdict: GapVerdict;
  levers: Lever[];
}

/** Deterministic, cheaply-checkable disqualifiers (the §16 triage subset + a few). */
export function deterministicDisqualifiers(lead: Lead, segnaliA: SegnaliA): string[] {
  const out: string[] = [];
  if (lead.permanently_closed === true) out.push('permanently_closed');
  const cat = `${(lead.category as string | undefined) ?? ''}`.toLowerCase();
  if (/rivendit|dropship|intermediazion|grossist/.test(cat)) out.push('pure_reseller');
  // distress from registry activity status (A signal '2.6' carrying the status string)
  const statusSig = segnaliA.find((s) => s.key === '2.6' && typeof s.value === 'string' && /cessat|liquidazion|inattiv|falliment|concordato/i.test(String(s.value)));
  if (statusSig) out.push('distress');
  return out;
}

/**
 * Quadrant from the two axis ASSESSMENTS — three-valued per axis. An `unknown`
 * level becomes `?` (not `-`), so "A not measured" never masquerades as "A low"
 * in the label (the §5.3.5 firewall at the label level). `high` is the
 * score≥axisHigh boolean; anything measured-but-not-high is `-`.
 */
function axisSym(level: AxisLevel, high: boolean): '+' | '-' | '?' {
  if (level === 'unknown') return '?';
  return high ? '+' : '-';
}

export async function gapReason(
  lead: Lead,
  model: BusinessModel,
  aAssessment: AxisAssessment,
  bAssessment: AxisAssessment,
  segnaliA: SegnaliA,
  segnaliB: SegnaliB,
  categoryProfile: CategoryProfile | undefined,
  deps: GapDeps,
): Promise<GapOutput> {
  const t = deps.config.thresholds;
  const scoreA = aAssessment.score;
  const scoreB = bAssessment.score;
  const gap = Math.round((scoreA - scoreB) * 1000) / 1000;
  const aHigh = scoreA >= t.axisHigh;
  const bHigh = scoreB >= t.axisHigh;
  const quadrant = `A${axisSym(aAssessment.level, aHigh)}B${axisSym(bAssessment.level, bHigh)}` as Quadrant;
  const gapWidth = Math.abs(gap) >= t.gapWide ? 'wide' : Math.abs(gap) >= t.gapModerate ? 'moderate' : 'narrow';

  const disqualifiers = deterministicDisqualifiers(lead, segnaliA);

  // target verdict — disqualifiers operate BEFORE the gap logic (§4.5).
  let target: GapVerdict['target'];
  if (disqualifiers.length > 0) target = 'no';
  else if (aAssessment.level === 'unknown') target = 'borderline'; // insufficient A evidence
  // FIREWALL (§5.3.5): B with NO evidence is 'unknown', NOT 'low'. scoreB=0 here
  // means "we didn't observe B", so we must NOT confidently call a target — a
  // failed/missing discovery can never manufacture the A-high/B-low signature.
  else if (bAssessment.level === 'unknown') target = 'borderline';
  else if (quadrant === 'A-B+') target = 'no'; // fuffa
  else if (scoreA >= t.targetMinScoreA && gap >= t.targetMinGap) target = 'yes';
  else if (scoreA >= t.targetMinScoreA - t.borderlineBand && gap >= t.targetMinGap - t.borderlineBand) target = 'borderline';
  else target = 'no';

  // cause (§4.4) — deterministic default.
  let cause: GapCause;
  if (disqualifiers.includes('distress')) cause = 'decline';
  else if (target === 'yes' || target === 'borderline') cause = 'omission';
  else cause = 'unknown';

  const trajectory: Trajectory = 'unknown'; // no time-series in MVP

  // archetype attractor (Parte VI) — first config archetype matching the quadrant.
  const archetype = deps.config.gap.archetypes.find((a) => a.quadrant === quadrant)?.id;

  // confidence — coverage-driven; lowered for provisional baseline.
  const aCov = aAssessment.signalsConsidered ? 1 - aAssessment.signalsUnknown / aAssessment.signalsConsidered : 0;
  const bCov = bAssessment.signalsConsidered ? 1 - bAssessment.signalsUnknown / bAssessment.signalsConsidered : 0;
  let confidence = clamp01(0.3 + 0.7 * ((aCov + bCov) / 2));
  if (categoryProfile?.provisional) confidence = clamp01(confidence - 0.15);

  let motivation =
    `Quadrante ${quadrant} (A=${scoreA.toFixed(2)}, B=${scoreB.toFixed(2)}, gap=${gap.toFixed(2)}, ampiezza ${gapWidth}). ` +
    `${target === 'yes' ? 'Target: forza leggibile da terzi non espressa digitalmente.' : target === 'borderline' ? 'Borderline: evidenze parziali.' : 'Non target.'} ` +
    `${disqualifiers.length ? `Disqualificatori: ${disqualifiers.join(', ')}.` : ''}`;

  let levers = buildLevers(deps.config, target, bAssessment);

  // optional LLM refinement (cause / trajectory / motivation / extra disqualifiers / lever rationale)
  if (deps.llm) {
    const prompt = renderGapPrompt(lead, model, aAssessment, bAssessment, { quadrant, gap, gapWidth, disqualifiers, target }, deps.config);
    const text = await deps.llm({ system: deps.config.prompts.gap, prompt, json_schema: GAP_SCHEMA, temperature: 0 });
    const parsed = parseJsonLoose(text) as
      | { cause?: string; trajectory?: string; motivation?: string; extraDisqualifiers?: string[]; levers?: Array<{ kind: string; rationale?: string }> }
      | undefined;
    if (parsed) {
      if (isCause(parsed.cause)) cause = parsed.cause;
      const traj = isTrajectory(parsed.trajectory) ? parsed.trajectory : trajectory;
      const extra = Array.isArray(parsed.extraDisqualifiers) ? parsed.extraDisqualifiers.filter((d) => typeof d === 'string') : [];
      for (const d of extra) if (!disqualifiers.includes(d)) disqualifiers.push(d);
      // an LLM-detected disqualifier overrides target to 'no' (§4.5 before gap)
      const finalTarget = disqualifiers.length > 0 ? 'no' : target;
      if (typeof parsed.motivation === 'string' && parsed.motivation.trim()) motivation = parsed.motivation.trim();
      if (parsed.levers?.length) levers = mergeLeverRationales(levers, parsed.levers, deps.config);
      return {
        verdict: { businessModel: model, quadrant, scoreA, scoreB, gap, gapWidth, trajectory: traj, cause, disqualifiers, target: finalTarget, archetype, motivation, confidence },
        levers,
      };
    }
  }

  return {
    verdict: { businessModel: model, quadrant, scoreA, scoreB, gap, gapWidth, trajectory, cause, disqualifiers, target, archetype, motivation, confidence },
    levers,
  };
}

function buildLevers(config: JudgmentConfig, target: GapVerdict['target'], bAssessment: AxisAssessment): Lever[] {
  if (target === 'no') return [];
  const want: Array<Lever['kind']> = ['positioning', 'acquisition'];
  // conversion_ops only if there is owned interest to capture (gbp/reviews/website present).
  const hasInterest = (bAssessment.surfaces ?? []).some((s) => ['3.1', '3.3', '3.4'].includes(s.surface) && s.state !== 'unknown' && s.state !== 'absence_abandonment');
  if (hasInterest) want.push('conversion_ops');
  want.push('measurement');
  return want
    .map((kind) => {
      const def = config.gap.levers.find((l) => l.kind === kind);
      if (!def) return undefined;
      return { kind, rationale: `${def.gapNature} (${def.ref})`, sequence: def.sequence, basedOn: [] } as Lever;
    })
    .filter((l): l is Lever => !!l)
    .sort((a, b) => a.sequence - b.sequence);
}

function mergeLeverRationales(base: Lever[], llm: Array<{ kind: string; rationale?: string }>, config: JudgmentConfig): Lever[] {
  const byKind = new Map(llm.map((l) => [l.kind, l]));
  const out = base.map((l) => ({ ...l, rationale: byKind.get(l.kind)?.rationale ?? l.rationale }));
  // allow the LLM to ADD a lever kind that the deterministic pass omitted
  for (const l of llm) {
    if (!out.some((x) => x.kind === l.kind)) {
      const def = config.gap.levers.find((d) => d.kind === l.kind);
      if (def) out.push({ kind: def.kind, rationale: l.rationale ?? `${def.gapNature} (${def.ref})`, sequence: def.sequence, basedOn: [] });
    }
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

function isCause(v: unknown): v is GapCause {
  return ['omission', 'incompetence', 'generational', 'aversion', 'constraint', 'decline', 'unknown'].includes(v as string);
}
function isTrajectory(v: unknown): v is Trajectory {
  return ['improving', 'flat', 'declining', 'unknown'].includes(v as string);
}

export function renderGapPrompt(
  lead: Lead,
  model: BusinessModel,
  a: AxisAssessment,
  b: AxisAssessment,
  det: { quadrant: Quadrant; gap: number; gapWidth: string; disqualifiers: string[]; target: string },
  config: JudgmentConfig,
): string {
  const causes = config.gap.causes.map((c) => `- ${c.cause} (${c.ref}): ${c.signature} [colmabilità ${c.colmability}]`).join('\n');
  const disq = config.gap.disqualifiers.map((d) => `- ${d.id} (${d.ref}, ${d.family}): ${d.test}`).join('\n');
  const traps = config.gap.cognitiveTraps.map((t) => `- ${t.rule}`).join('\n');
  return [
    `${config.goldenRule}`,
    `\nAzienda: ${(lead.company_name as string | undefined) ?? '?'} | categoria: ${(lead.category as string | undefined) ?? '?'} | modello: ${model}`,
    `\nValutazione A: score=${a.score.toFixed(2)} level=${a.level} (subdim: ${(a.subdims ?? []).map((s) => `${s.dim}:${s.level}`).join(', ')})`,
    `Valutazione B: score=${b.score.toFixed(2)} level=${b.level} (superfici present/poor: ${(b.surfaces ?? []).filter((s) => s.state !== 'unknown').map((s) => `${s.surface}:${s.state}`).join(', ') || 'nessuna osservata'})`,
    `\nPre-calcolo deterministico: quadrante=${det.quadrant}, gap=${det.gap.toFixed(2)} (${det.gapWidth}), disqualificatori=${det.disqualifiers.join(',') || 'nessuno'}, target=${det.target}`,
    `\nCAUSE DEL GAP (§4.4):\n${causes}`,
    `\nDISQUALIFICATORI (§4.5) — operano PRIMA del gap:\n${disq}`,
    `\nTRAPPOLE (§5.3) DO-NOT:\n${traps}`,
    `\nRestituisci JSON {cause, trajectory, motivation, extraDisqualifiers:[...], levers:[{kind,rationale}]}. NON fondere A e B. Non inferire stati che i collector hanno marcato unknown.`,
  ].join('\n');
}

export const GAP_SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', enum: ['omission', 'incompetence', 'generational', 'aversion', 'constraint', 'decline', 'unknown'] },
    trajectory: { type: 'string', enum: ['improving', 'flat', 'declining', 'unknown'] },
    motivation: { type: 'string' },
    extraDisqualifiers: { type: 'array', items: { type: 'string' } },
    levers: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, rationale: { type: 'string' } }, required: ['kind'] } },
  },
};
