import { describe, expect, it } from 'vitest';
import { getActiveJudgmentConfig } from '../../../src/judgment/config';
import { judgeA } from '../../../src/judgment/judges/judge_a';
import { judgeB } from '../../../src/judgment/judges/judge_b';
import { validateDeterministic } from '../../../src/judgment/judges/critic';
import type { GapVerdict, SegnaliA, SegnaliB, Signal } from '../../../src/types/judgment';
import { stubLLM } from '../../helpers/stub_llm';

const config = getActiveJudgmentConfig();
const ev = [{ source: 's', observedAt: '', confidence: 0.6 }];

describe('Judge B firewall: the LLM cannot fabricate a state out of no evidence', () => {
  const unknownB: SegnaliB = ['3.1', '3.2', '3.8'].map((k): Signal => ({ axis: 'B', key: k, state: 'unknown_not_found', evidence: [] }));

  it.each(['excellence', 'mediocrity', 'absence_abandonment'])('keeps an unknown surface unknown when the LLM claims %s', async (claimed) => {
    const llm = stubLLM({ surfaces: [{ surface: '3.1', state: claimed, citations: ['signal_b:3.1'], rationale: 'invented' }], rationale: 'llm' });
    const b = await judgeB(unknownB, undefined, 'B2B_manufacturing', { config, llm });
    expect(llm.calls).toHaveLength(1);
    const s31 = b.surfaces!.find((s) => s.surface === '3.1')!;
    expect(s31.state).toBe('unknown');
    expect(s31.citations).toEqual([]);
    expect(b.score).toBe(0);
    expect(b.level).toBe('unknown');
  });

  it('still lets the LLM refine an evidenced surface (mediocrity → excellence)', async () => {
    const presentB: SegnaliB = [{ axis: 'B', key: '3.1', state: 'confirmed_present', value: ['h1'], evidence: ev }];
    const det = await judgeB(presentB, undefined, 'B2B_manufacturing', { config });
    expect(det.surfaces!.find((s) => s.surface === '3.1')!.state).toBe('mediocrity');
    const llm = stubLLM({ surfaces: [{ surface: '3.1', state: 'excellence', citations: ['signal_b:3.1'] }] });
    const b = await judgeB(presentB, undefined, 'B2B_manufacturing', { config, llm });
    expect(b.surfaces!.find((s) => s.surface === '3.1')!.state).toBe('excellence');
    expect(b.score).toBeGreaterThan(det.score);
  });

  it('lets the LLM downgrade an evidenced surface to unknown (conservative direction)', async () => {
    const absentB: SegnaliB = [{ axis: 'B', key: '3.1', state: 'confirmed_absent', evidence: ev }];
    const llm = stubLLM({ surfaces: [{ surface: '3.1', state: 'unknown' }] });
    const b = await judgeB(absentB, undefined, 'B2B_manufacturing', { config, llm });
    expect(b.surfaces!.find((s) => s.surface === '3.1')!.state).toBe('unknown');
  });

  it('the critic sees no hallucinated B state after an LLM that claimed excellence on nothing', async () => {
    const llm = stubLLM({ surfaces: unknownB.map((s) => ({ surface: s.key, state: 'excellence', citations: [`signal_b:${s.key}`] })) });
    const b = await judgeB(unknownB, undefined, 'B2B_manufacturing', { config, llm });
    const a = await judgeA([], 'B2B_manufacturing', undefined, { config });
    const verdict = { scoreA: a.score, scoreB: b.score, confidence: 1 } as GapVerdict;
    const v = validateDeterministic(verdict, a, b, [], unknownB);
    expect(v.flags.filter((f) => f.startsWith('hallucinated_state'))).toEqual([]);
  });
});

describe('Judge A firewall: the LLM cannot grade a subdimension with no evidence', () => {
  const unknownA: SegnaliA = ['2.1', '2.2', '2.6'].map((k): Signal => ({ axis: 'A', key: k, state: 'unknown_not_found', evidence: [] }));

  it.each(['strong', 'moderate', 'weak'])('keeps insufficient_evidence when the LLM claims %s', async (claimed) => {
    const llm = stubLLM({ subdims: [{ dim: '2.1', level: claimed, citations: ['signal_a:2.1'], rationale: 'invented' }], rationale: 'llm' });
    const a = await judgeA(unknownA, 'B2B_manufacturing', undefined, { config, llm });
    expect(llm.calls).toHaveLength(1);
    const sd = a.subdims!.find((s) => s.dim === '2.1')!;
    expect(sd.level).toBe('insufficient_evidence');
    expect(sd.citations).toEqual([]);
    expect(a.score).toBe(0);
    expect(a.level).toBe('unknown');
  });

  it('still lets the LLM refine an evidenced subdimension (moderate → strong)', async () => {
    const oneA: SegnaliA = [{ axis: 'A', key: '2.1', state: 'confirmed_present', value: 'x', evidence: ev }];
    const llm = stubLLM({ subdims: [{ dim: '2.1', level: 'strong', citations: ['signal_a:2.1'] }] });
    const a = await judgeA(oneA, 'B2B_manufacturing', undefined, { config, llm });
    expect(a.subdims!.find((s) => s.dim === '2.1')!.level).toBe('strong');
  });

  it('falls back to the deterministic baseline when the LLM returns nothing usable', async () => {
    const llm = stubLLM(null);
    const a = await judgeA(unknownA, 'B2B_manufacturing', undefined, { config, llm });
    expect(a.rationale).toBe('deterministic baseline (no LLM)');
    expect(a.subdims!.every((s) => s.level === 'insufficient_evidence')).toBe(true);
  });
});
