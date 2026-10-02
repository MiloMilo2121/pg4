/**
 * Contracts shared by the local API server and the dashboard.
 */

/** The enrichable fields a per-field job can target (see the enrich registry). */
export type EnrichableField =
  | 'official_website'
  | 'email'
  | 'pec'
  | 'vat'
  | 'revenue'
  | 'employees'
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'tiktok'
  | 'youtube'
  | 'decision_maker';

/** Judgment-layer jobs (L2–L5); each is an independent, idempotent, cumulative button. */
export type JudgmentJobKind = 'discovery' | 'collect_signals' | 'judge' | 'validate_export';

/** Per-section status — the section-grained analogue of the per-field CellStatus. */
type SectionState = 'queued' | 'running' | 'filled' | 'partial' | 'failed' | 'not_applicable';
export interface SectionStatus {
  state: SectionState;
  summary?: string;
  evidenceCount?: number;
}
