import type { AxisLevel, Signal } from '../../types/judgment';
import type { JudgmentThresholds } from '../config/types';
import type { LLMCompletionRequest } from '../../types/providers';

/**
 * Shared judge utilities. The judges run DETERMINISTICALLY offline (testable, no
 * key) and OPTIONALLY refine with an LLM when one is provided. Both paths honor
 * the guardrails: axes never fused, three states preserved, unknown never read
 * as a negative.
 */

/** An injected LLM caller (wraps ProviderRouter.complete). Returns text or null. */
export type JudgeLLM = (req: LLMCompletionRequest) => Promise<string | null>;

export function levelFromScore(score: number, t: JudgmentThresholds): AxisLevel {
  if (score <= 0) return 'unknown';
  if (score >= t.axisHigh) return 'high';
  if (score >= t.axisMid) return 'mid';
  return 'low';
}

/** Count present/absent/unknown across a set of signals. */
export function coverage(signals: Signal[]): { present: number; absent: number; unknown: number; total: number } {
  let present = 0;
  let absent = 0;
  let unknown = 0;
  for (const s of signals) {
    if (s.state === 'confirmed_present') present += 1;
    else if (s.state === 'confirmed_absent') absent += 1;
    else unknown += 1;
  }
  return { present, absent, unknown, total: signals.length };
}

/** Best-effort JSON extraction from an LLM text response (handles code fences / prose). */
export function parseJsonLoose(text: string | null | undefined): unknown {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // try to slice the outermost {...}
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
