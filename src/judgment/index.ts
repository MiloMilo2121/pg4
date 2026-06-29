/**
 * Judgment layer — public surface.
 *
 * Pipeline: L2 discovery (footprint) → L3 collectors (segnali_A/B, separate) →
 * L4 judges (Judge A | Judge B | GAP reasoner) → L5 agentic validation. Logic is
 * versioned config (judgment_config), transcribed from ontology v2; only numbers
 * are system extension. Everything runs deterministically offline and refines
 * with an LLM (Claude via ProviderRouter.complete) when enabled.
 */
export { runJudgment } from './run_judgment';
export type { JudgmentDeps } from './run_judgment';
export { triage } from './triage';
export type { TriageResult } from './triage';
export { computeCategoryProfile } from './benchmark';
export { evaluate } from './eval';
export type { GoldenItem, EvalReport } from './eval';
export { classifyBusinessModel } from './business_model';

export { runDiscovery, buildFootprint } from './discovery/footprint';
export { collectA } from './collectors/collect_a';
export { collectB } from './collectors/collect_b';
export { judgeA } from './judges/judge_a';
export { judgeB } from './judges/judge_b';
export { gapReason } from './judges/gap_reasoner';
export { critic, validateDeterministic } from './judges/critic';
export type { JudgeLLM } from './judges/shared';

export { getActiveJudgmentConfig, getJudgmentConfig, snapshotConfig, collectLogicRefs, cheapDisqualifiers } from './config';
export type { JudgmentConfig } from './config/types';

export { defaultSourceAdapters } from './harvest/adapters';
export { harvestSource, emptyBundle } from './harvest/source_harvest';
export type { SourceAdapter, HarvestContext, HarvestResult, HarvestBundle, PageFetcher, SourceKind } from './harvest/source_harvest';
export { ATTRIBUTE_SOURCE_ROUTES, SIGNAL_SOURCE_ROUTES, SOURCE_TTL_DAYS } from './harvest/routing';
