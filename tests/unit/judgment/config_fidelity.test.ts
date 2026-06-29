import { describe, expect, it } from 'vitest';
import { getActiveJudgmentConfig, collectLogicRefs, cheapDisqualifiers, snapshotConfig } from '../../../src/judgment/config';
import { JUDGMENT_SECTIONS } from '../../../src/types/judgment';

/**
 * Plan §0 / §4bis: the judgment LOGIC is TRANSCRIBED from ontology v2, not
 * improvised. This test enforces that every logic entry carries a v2 section ref
 * (the "creta-logica ancorata a v2" contract). Only the numbers are free.
 */
describe('judgment_config fidelity to ontology v2', () => {
  const cfg = getActiveJudgmentConfig();

  it('is anchored to ontology v2', () => {
    expect(cfg.ontologyVersion).toBe('v2');
    expect(cfg.version).toMatch(/^\d{4}\.\d{2}/);
  });

  it('every logic entry carries a v2 section ref (not improvised)', () => {
    const refs = collectLogicRefs(cfg);
    expect(refs.length).toBeGreaterThan(30);
    const refPattern = /§|Parte|Appendice|Brief/;
    for (const r of refs) {
      expect(r.ref, `${r.kind}:${r.id} must cite a v2 section`).toMatch(refPattern);
    }
  });

  it('covers Judge A §2.1–2.7 + the §2.8 per-model declension', () => {
    expect(cfg.judgeA.subdims.map((s) => s.dim).sort()).toEqual(['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7']);
    expect(cfg.judgeA.modelDeclination.map((m) => m.model)).toContain('B2B_manufacturing');
    expect(cfg.judgeA.modelDeclination.map((m) => m.model)).toContain('professional_local');
  });

  it('covers Judge B surfaces §3.1–3.15 + website rubric + §3.16', () => {
    expect(cfg.judgeB.surfaces.length).toBe(15);
    expect(cfg.judgeB.websiteRubric.validityLens.length).toBeGreaterThan(3);
    expect(cfg.judgeB.websiteRubric.qualityLens.length).toBeGreaterThan(6);
    expect(cfg.judgeB.transversalCriteria.length).toBe(6);
  });

  it('covers the GAP machinery: quadrants, causes §4.4, disqualifiers §4.5, archetypes VI, levers VII, traps §5.3', () => {
    expect(cfg.gap.quadrants.length).toBe(4);
    expect(cfg.gap.quadrants.filter((q) => q.isTarget).map((q) => q.quadrant)).toEqual(['A+B-']); // only the target quadrant
    expect(cfg.gap.causes.length).toBe(6);
    expect(cfg.gap.disqualifiers.length).toBeGreaterThanOrEqual(8);
    expect(cfg.gap.archetypes.some((a) => a.quadrant === 'A+B-')).toBe(true);
    expect(cfg.gap.levers.map((l) => l.kind).sort()).toEqual(['acquisition', 'conversion_ops', 'measurement', 'positioning']);
    expect(cfg.gap.cognitiveTraps.length).toBe(11);
  });

  it('exposes a non-empty cheaply-checkable disqualifier subset for the §16 triage', () => {
    expect(cheapDisqualifiers(cfg).length).toBeGreaterThan(0);
  });

  it('numbers (the only system extension) are sane bounds', () => {
    const t = cfg.thresholds;
    for (const v of [t.axisHigh, t.axisMid, t.gapWide, t.gapModerate, t.targetMinGap, t.targetMinScoreA, t.validationAccept, t.reviewBelow]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(t.axisHigh).toBeGreaterThan(t.axisMid);
    expect(t.gapWide).toBeGreaterThan(t.gapModerate);
    expect(t.benchmarkMinSample).toBeGreaterThan(0);
  });

  it('snapshots as opaque DATA for judgment_config_versions (repro, not logic-in-query)', () => {
    const snap = snapshotConfig(cfg);
    expect(snap.version).toBe(cfg.version);
    expect(snap.ontology_version).toBe('v2');
    expect(() => JSON.stringify(snap.blob)).not.toThrow();
  });

  it('the nine+one record sections are declared', () => {
    expect(JUDGMENT_SECTIONS).toContain('segnali_a');
    expect(JUDGMENT_SECTIONS).toContain('segnali_b');
    expect(JUDGMENT_SECTIONS).toContain('verdetto_gap');
    expect(JUDGMENT_SECTIONS).toContain('validazione');
  });
});
