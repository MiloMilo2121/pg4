import type { CategoryProfile, CategoryBenchmark, SegnaliA, SegnaliB } from '../types/judgment';
import type { JudgmentConfig } from './config/types';

/**
 * §17 category benchmark (two-pass) ⟂ §1.4 relativity-of-category.
 *
 * Pass-1: collect signals across the whole list. Then compute, ONCE, the
 * category profile: presence-rates + numeric medians per signal key. Pass-2: the
 * judges read this profile to judge each company as a SCARTO from the category
 * baseline. Thin cohort (< thresholds.benchmarkMinSample) → `provisional` and the
 * GAP reasoner lowers confidence.
 *
 * Pure + deterministic (numbers are CRETA-NUMERI / system extension, never v2).
 */

export interface SignalSetItem {
  segnali_A?: SegnaliA;
  segnali_B?: SegnaliB;
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums: number[], p: number): number | undefined {
  if (nums.length === 0) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

export function computeCategoryProfile(items: SignalSetItem[], category: string, config: JudgmentConfig, nowIso: string): CategoryProfile {
  // Aggregate per signal key: count present, and collect numeric values.
  const presentCount = new Map<string, number>();
  const numericVals = new Map<string, number[]>();
  let n = 0;
  for (const it of items) {
    n += 1;
    const all = [...(it.segnali_A ?? []), ...(it.segnali_B ?? [])];
    const seenPresent = new Set<string>();
    for (const s of all) {
      if (s.state === 'confirmed_present') {
        if (!seenPresent.has(s.key)) {
          presentCount.set(s.key, (presentCount.get(s.key) ?? 0) + 1);
          seenPresent.add(s.key);
        }
        const num = typeof s.value === 'number' ? s.value : typeof s.value === 'string' && /^\d+(\.\d+)?$/.test(s.value) ? Number(s.value) : undefined;
        if (num !== undefined) {
          const arr = numericVals.get(s.key) ?? [];
          arr.push(num);
          numericVals.set(s.key, arr);
        }
      }
    }
  }

  const benchmarks: Record<string, CategoryBenchmark> = {};
  const keys = new Set<string>([...presentCount.keys(), ...numericVals.keys()]);
  for (const k of keys) {
    const nums = numericVals.get(k) ?? [];
    benchmarks[k] = {
      presenceRate: n > 0 ? Math.round((1000 * (presentCount.get(k) ?? 0)) / n) / 1000 : 0,
      p50: median(nums),
      p90: percentile(nums, 90),
    };
  }

  return {
    category,
    ontologyVersion: config.ontologyVersion,
    sampleSize: n,
    provisional: n < config.thresholds.benchmarkMinSample,
    benchmarks,
    computedAt: nowIso,
  };
}
