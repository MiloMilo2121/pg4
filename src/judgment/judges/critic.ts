import type { AxisAssessment, GapVerdict, SegnaliA, SegnaliB, ValidationResult } from '../../types/judgment';
import type { JudgmentConfig } from '../config/types';
import { type JudgeLLM, parseJsonLoose, clamp01 } from './shared';

/**
 * L5a — agentic validator (Critic). Does NOT re-judge: it checks the verdict for
 * consistency + guardrail breaches. Deterministic pre-filter catches the
 * structural breaches (asymmetry / uncited / hallucinated-state) for free; the
 * LLM (optional) adds a semantic consistency pass. Produces a validation_score
 * that gates the L5b human review (fast-track vs mandatory deep review).
 */

export interface CriticDeps {
  config: JudgmentConfig;
  llm?: JudgeLLM;
}

export function validateDeterministic(
  verdict: GapVerdict,
  a: AxisAssessment,
  b: AxisAssessment,
  segnaliA: SegnaliA,
  segnaliB: SegnaliB,
): ValidationResult {
  const flags: string[] = [];

  // 1) asymmetry breach — A verdict may only cite A signals, B only B.
  const aBreach = (a.subdims ?? []).some((s) => s.citations.some((c) => c.startsWith('signal_b:')));
  const bBreach = (b.surfaces ?? []).some((s) => s.citations.some((c) => c.startsWith('signal_a:')));
  if (aBreach || bBreach) flags.push('asymmetry_breach');

  // 2) hallucinated state — a non-unknown verdict for a key with only unknown signals.
  const aPresentKeys = new Set(segnaliA.filter((s) => s.state !== 'unknown_not_found').map((s) => s.key));
  for (const sd of a.subdims ?? []) if (sd.level !== 'insufficient_evidence' && !aPresentKeys.has(sd.dim)) flags.push(`hallucinated_state:A:${sd.dim}`);
  const bPresentKeys = new Set(segnaliB.filter((s) => s.state !== 'unknown_not_found').map((s) => s.key));
  for (const sv of b.surfaces ?? []) if (sv.state !== 'unknown' && !bPresentKeys.has(sv.surface)) flags.push(`hallucinated_state:B:${sv.surface}`);

  // 3) uncited claims — a graded verdict with no citations.
  for (const sd of a.subdims ?? []) if (sd.level !== 'insufficient_evidence' && sd.citations.length === 0) flags.push(`uncited:A:${sd.dim}`);
  for (const sv of b.surfaces ?? []) if (sv.state !== 'unknown' && sv.citations.length === 0) flags.push(`uncited:B:${sv.surface}`);

  // 4) thin coverage.
  const aCov = a.signalsConsidered ? 1 - a.signalsUnknown / a.signalsConsidered : 0;
  const bCov = b.signalsConsidered ? 1 - b.signalsUnknown / b.signalsConsidered : 0;
  if (aCov < 0.34 || bCov < 0.34) flags.push('thin_coverage');

  // 5) single-score sanity — the verdict must carry BOTH axis scores separately.
  if (typeof verdict.scoreA !== 'number' || typeof verdict.scoreB !== 'number') flags.push('missing_axis_score');

  const critical = flags.some((f) => f.startsWith('asymmetry_breach') || f.startsWith('hallucinated_state') || f.startsWith('missing_axis_score'));
  const penalty = flags.reduce((p, f) => p + (f.startsWith('asymmetry') || f.startsWith('hallucinated') || f.startsWith('missing') ? 0.4 : 0.1), 0);
  const validationScore = clamp01(Math.min(verdict.confidence, 1 - penalty));
  return { validationScore, consistent: !critical, flags, reviewedBy: 'agent' };
}

export async function critic(
  verdict: GapVerdict,
  a: AxisAssessment,
  b: AxisAssessment,
  segnaliA: SegnaliA,
  segnaliB: SegnaliB,
  deps: CriticDeps,
): Promise<ValidationResult> {
  const det = validateDeterministic(verdict, a, b, segnaliA, segnaliB);
  if (!deps.llm) return det;

  const prompt = [
    `Verdetto: ${JSON.stringify({ quadrant: verdict.quadrant, scoreA: verdict.scoreA, scoreB: verdict.scoreB, gap: verdict.gap, target: verdict.target, cause: verdict.cause, disqualifiers: verdict.disqualifiers })}`,
    `Motivazione: ${verdict.motivation}`,
    `Controlli deterministici già rilevati: ${det.flags.join(', ') || 'nessuno'}`,
    `Verifica la COERENZA semantica verdetto↔motivazione e segnala incoerenze non già rilevate. Restituisci JSON {consistent:boolean, flags:[...], note}.`,
  ].join('\n');
  const text = await deps.llm({ system: deps.config.prompts.critic, prompt, json_schema: CRITIC_SCHEMA, temperature: 0 });
  const parsed = parseJsonLoose(text) as { consistent?: boolean; flags?: string[] } | undefined;
  if (!parsed) return det;
  const extraFlags = Array.isArray(parsed.flags) ? parsed.flags.filter((f) => typeof f === 'string') : [];
  const flags = [...det.flags, ...extraFlags.filter((f) => !det.flags.includes(f))];
  const consistent = det.consistent && parsed.consistent !== false;
  const validationScore = clamp01(Math.min(det.validationScore, consistent ? 1 : 0.5));
  return { validationScore, consistent, flags, reviewedBy: 'agent' };
}

export const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    consistent: { type: 'boolean' },
    flags: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['consistent'],
};
