import type { AxisLevel, JudgmentRecord, Quadrant, TargetVerdict, BusinessModel } from '../types/judgment';

/**
 * §15 eval / golden-set harness — the antidote to the judge's blindness.
 *
 * A golden item is a hand-judged company. The harness runs the pipeline (or just
 * L4 replay) and compares. Metrics: precision/recall on the TARGET verdict (what
 * matters) + SEPARATE agreement on A and on B (so you know WHICH judge errs —
 * the asymmetry means a target miss could be either) + a quadrant confusion
 * matrix. Pure TS (pandas/sklearn not needed at this scale, plan §15).
 *
 * Human overrides (L5b) append to the golden set as growing ground truth.
 */

export interface GoldenItem {
  id: string;
  /**
   * The BLOCK label for stratified eval (§1.4 + §17): metrics are computed PER block,
   * never pooled — the A of a restaurant (1300 reviews) and the A of a dentist
   * (credentials) are not the same metro, so a single global number is meaningless.
   * Distinct from `lead.category` (the firm's own category); the harness falls back
   * to lead.category when this is absent.
   */
  categoria?: string;
  expectedTarget: TargetVerdict;
  expectedQuadrant?: Quadrant;
  expectedALevel?: AxisLevel;
  expectedBLevel?: AxisLevel;
  expectedModel?: BusinessModel;
}

export interface EvalReport {
  n: number;
  target: { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; tn: number };
  quadrantConfusion: Record<string, Record<string, number>>;
  aAgreement?: number;
  bAgreement?: number;
  modelAgreement?: number;
}

function f1(p: number, r: number): number {
  return p + r > 0 ? Math.round(((2 * p * r) / (p + r)) * 1000) / 1000 : 0;
}

/** Compare predictions (by golden id) against the golden labels. */
export function evaluate(golden: GoldenItem[], predictions: Map<string, JudgmentRecord>): EvalReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const confusion: Record<string, Record<string, number>> = {};
  let aHit = 0;
  let aTot = 0;
  let bHit = 0;
  let bTot = 0;
  let mHit = 0;
  let mTot = 0;

  for (const g of golden) {
    const pred = predictions.get(g.id);
    if (!pred) continue;
    const predTarget = pred.verdetto_gap?.target ?? 'no';
    const expYes = g.expectedTarget === 'yes';
    const predYes = predTarget === 'yes';
    if (predYes && expYes) tp += 1;
    else if (predYes && !expYes) fp += 1;
    else if (!predYes && expYes) fn += 1;
    else tn += 1;

    if (g.expectedQuadrant) {
      const pq = pred.verdetto_gap?.quadrant ?? 'A-B-';
      confusion[g.expectedQuadrant] ??= {};
      confusion[g.expectedQuadrant][pq] = (confusion[g.expectedQuadrant][pq] ?? 0) + 1;
    }
    if (g.expectedALevel) {
      aTot += 1;
      if (pred.valutazione_A?.level === g.expectedALevel) aHit += 1;
    }
    if (g.expectedBLevel) {
      bTot += 1;
      if (pred.valutazione_B?.level === g.expectedBLevel) bHit += 1;
    }
    if (g.expectedModel) {
      mTot += 1;
      if (pred.verdetto_gap?.businessModel === g.expectedModel) mHit += 1;
    }
  }

  const precision = tp + fp > 0 ? Math.round((tp / (tp + fp)) * 1000) / 1000 : 0;
  const recall = tp + fn > 0 ? Math.round((tp / (tp + fn)) * 1000) / 1000 : 0;
  return {
    n: golden.length,
    target: { precision, recall, f1: f1(precision, recall), tp, fp, fn, tn },
    quadrantConfusion: confusion,
    aAgreement: aTot > 0 ? Math.round((aHit / aTot) * 1000) / 1000 : undefined,
    bAgreement: bTot > 0 ? Math.round((bHit / bTot) * 1000) / 1000 : undefined,
    modelAgreement: mTot > 0 ? Math.round((mHit / mTot) * 1000) / 1000 : undefined,
  };
}

export interface MultiBlockReport {
  /** Per-block report, keyed by `categoria`. NEVER pooled into one number (§1.4). */
  blocks: Record<string, EvalReport>;
  /** Block labels, sorted, for stable iteration. */
  categories: string[];
}

/**
 * Group golden items by `categoria` (block) and run `evaluate` PER block. Returns one
 * EvalReport per block — the eval mirrors the per-category benchmark (§17): the judge
 * must be validated as good *within each model*, not on a meaningless cross-block mean.
 * Items without a categoria fall into 'uncategorized'.
 */
export function evaluateByCategory(golden: GoldenItem[], predictions: Map<string, JudgmentRecord>): MultiBlockReport {
  const groups = new Map<string, GoldenItem[]>();
  for (const g of golden) {
    const cat = g.categoria && g.categoria.trim() ? g.categoria.trim() : 'uncategorized';
    const arr = groups.get(cat) ?? [];
    arr.push(g);
    groups.set(cat, arr);
  }
  const blocks: Record<string, EvalReport> = {};
  for (const [cat, items] of groups) blocks[cat] = evaluate(items, predictions);
  return { blocks, categories: [...groups.keys()].sort() };
}
