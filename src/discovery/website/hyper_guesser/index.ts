import type { NormalizedLead } from '../../../types/discovery';
import { HyperGuesserGenerator } from './generator';
import { HyperGuesserResolver } from './resolver';

export interface HyperGuess {
  domain: string;
  ip: string;
  generation_rank: number;
}

/**
 * Deterministic core of HyperGuesser: generate aggressive permutations,
 * DNS-resolve in batches, return the alive candidates ranked by generation
 * order (which approximates "most plausible first").
 *
 * No AI. No HTTP fetch. No PreVerifyGate. The pipeline calls those next.
 *
 * Adapted from pg3/enricher/core/discovery/hyperguesser_vx (generator + resolver only).
 * AI triage + semantic matcher + validator stay deferred until after Phase 5
 * benchmark proves their incremental value.
 */
export class HyperGuesser {
  static async run(lead: NormalizedLead, opts: { maxCandidates?: number; resolve4?: (host: string) => Promise<string[]> } = {}): Promise<HyperGuess[]> {
    const candidates = HyperGuesserGenerator.generate(lead);
    if (candidates.length === 0) return [];
    const limited = candidates.slice(0, opts.maxCandidates ?? 60);
    const alive = await HyperGuesserResolver.resolveBatch(limited, { resolve4: opts.resolve4 });
    const indexOf = new Map(limited.map((d, i) => [d, i]));
    return alive
      .map((r) => ({ domain: r.domain, ip: r.ip ?? '', generation_rank: indexOf.get(r.domain) ?? 999 }))
      .sort((a, b) => a.generation_rank - b.generation_rank);
  }
}

export { HyperGuesserGenerator } from './generator';
export { HyperGuesserResolver } from './resolver';
export { ItalianNerParser } from './italian_ner_parser';
