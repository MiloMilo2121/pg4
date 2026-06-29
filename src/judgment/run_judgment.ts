import type { Lead } from '../types/lead';
import type { CategoryProfile, JudgmentMeta, JudgmentRecord, GapVerdict } from '../types/judgment';
import type { HarvestContext, HarvestBundle } from './harvest/source_harvest';
import { emptyBundle } from './harvest/source_harvest';
import type { JudgmentConfig } from './config/types';
import type { JudgeLLM } from './judges/shared';
import { triage } from './triage';
import { runDiscovery } from './discovery/footprint';
import { collectA } from './collectors/collect_a';
import { collectB } from './collectors/collect_b';
import { judgeA } from './judges/judge_a';
import { judgeB } from './judges/judge_b';
import { gapReason } from './judges/gap_reasoner';
import { critic } from './judges/critic';
import { classifyBusinessModel } from './business_model';

/**
 * The L2→L5 pipeline for ONE company. Each layer reads the shared HarvestBundle
 * (so a source is fetched once across discovery + both collectors — the cost
 * principle) and writes only its own section. Returns a JudgmentRecord whose
 * sections are the materialized projection of this run.
 */
export interface JudgmentDeps {
  config: JudgmentConfig;
  /** optional LLM caller (wraps ProviderRouter.complete). Absent → deterministic. */
  llm?: JudgeLLM;
  /** category benchmark (§17 two-pass); absent for single-company runs. */
  categoryProfile?: CategoryProfile;
  /** the concrete model id when an LLM produced the verdict (for meta). */
  modelId?: string;
  chaseSocial?: boolean;
}

export async function runJudgment(lead: Lead, ctx: HarvestContext, deps: JudgmentDeps, bundle: HarvestBundle = emptyBundle()): Promise<JudgmentRecord> {
  const { config } = deps;
  const iso = () => new Date(ctx.now()).toISOString();
  const baseMeta: JudgmentMeta = {
    ontologyVersion: config.ontologyVersion,
    judgmentConfigVersion: config.version,
    judgePromptVersion: config.version,
    modelId: deps.modelId ?? (deps.llm ? 'llm' : 'deterministic'),
  };

  // §16 Stage-0 triage — drop near-certain non-targets before any cost.
  const t = triage(lead, config);
  if (!t.pass) {
    const verdict: GapVerdict = {
      businessModel: classifyBusinessModel(lead),
      quadrant: 'A?B?', // triage drop: neither axis was measured — honest, NOT A-B-
      scoreA: 0,
      scoreB: 0,
      gap: 0,
      gapWidth: 'narrow',
      trajectory: 'unknown',
      cause: t.disqualifier === 'distress' ? 'decline' : 'unknown',
      disqualifiers: [t.disqualifier ?? 'triage_drop'],
      target: 'no',
      motivation: `Scartata in triage (§16): ${t.reason ?? t.disqualifier}.`,
      confidence: 0.9,
    };
    return { verdetto_gap: verdict, leva: [], meta: { ...baseMeta, verdictAt: iso() } };
  }

  // L2 discovery
  const { footprint, bundle: b } = await runDiscovery(lead, ctx, { chaseSocial: deps.chaseSocial }, bundle);
  const footprintAt = iso();

  // L3 collectors (separate; share the bundle so the site is fetched once)
  const segnali_A = await collectA(lead, ctx, b);
  const segnali_B = await collectB(lead, ctx, b, footprint);
  const signalsAt = iso();

  // L4 judges (A sees only A, B sees only B)
  const model = footprint.businessModelHint ?? classifyBusinessModel(lead);
  const valutazione_A = await judgeA(segnali_A, model, deps.categoryProfile, { config, llm: deps.llm });
  const valutazione_B = await judgeB(segnali_B, footprint, model, { config, llm: deps.llm });

  // GAP reasoner (the only bi-axial component)
  const { verdict, levers } = await gapReason(lead, model, valutazione_A, valutazione_B, segnali_A, segnali_B, deps.categoryProfile, { config, llm: deps.llm });
  const verdictAt = iso();

  // L5a agentic validation
  const validazione = await critic(verdict, valutazione_A, valutazione_B, segnali_A, segnali_B, { config, llm: deps.llm });

  return {
    footprint,
    segnali_A,
    segnali_B,
    valutazione_A,
    valutazione_B,
    contesto_categoria: deps.categoryProfile,
    verdetto_gap: verdict,
    leva: levers,
    validazione,
    meta: { ...baseMeta, footprintAt, signalsAt, verdictAt, validatedAt: iso() },
  };
}
