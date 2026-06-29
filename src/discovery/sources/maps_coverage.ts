/**
 * R5 — Maps coverage modes.
 *
 * pg4's default Maps run does ONE query per comune
 * (`<category> <comune>`). Audits show this leaves ~30 % of a
 * province's real estate agencies on the floor — Google Maps' SERP
 * for "agenzie immobiliari Padova" returns ~110 cards before the cap
 * triggers, but the actual population in PD is several hundred. The
 * cheapest way to lift recall without paying for Bright Data /
 * Firecrawl is to fire DIVERSIFYING SECTOR-KEYWORD queries on the
 * SAME comune; the existing Deduplicator collapses overlap.
 *
 * `--coverage default` keeps today's behaviour (single query).
 *
 * `--coverage full` expands the category to a curated list of
 * synonym + sub-sector queries per category. Each variant is a real
 * phrase Italians use on Google Maps for the same business class —
 * not random keyword stuffing. The expansion table is hand-curated
 * (no LLM), with provenance comments so we can prune variants that
 * R6 benchmark shows are pure noise.
 *
 * Keep variants ordered most-general → most-specific so the run can
 * be interrupted early without losing the highest-yield query.
 */

export type CoverageMode = 'default' | 'full';

const MAPS_FULL_COVERAGE_VARIANTS: Record<string, string[]> = {
  // Real estate (the production category for the recalibration runs).
  // Variants verified against a sample of PD/TV/VR Maps SERPs:
  //   - "agenzie immobiliari": canonical (also today's default)
  //   - "agenzia immobiliare": singular form, returns a slightly
  //     different ranked set on Maps
  //   - "consulenza immobiliare": consulting/advisory firms not
  //     branded as "agenzia"
  //   - "compravendita immobiliare": brokerage-only firms whose
  //     Google profile names them this way
  //   - "mediatore immobiliare": individual brokers / one-person
  //     studios that don't show up under "agenzie"
  'agenzie immobiliari': [
    'agenzie immobiliari',
    'agenzia immobiliare',
    'consulenza immobiliare',
    'compravendita immobiliare',
    'mediatore immobiliare',
  ],
};

/**
 * Normalise a category for variant lookup. Lower-cased, whitespace
 * collapsed. We don't strip articles — variant keys mirror the
 * categories an operator would type on the CLI.
 */
function normaliseCategory(category: string): string {
  return category.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Expand a category into a list of Maps query variants based on the
 * coverage mode. Always returns at least one variant (the original
 * category) — falls back to the original when no expansion is known.
 *
 * The order is meaningful: variants[0] is the most-general /
 * highest-yield, variants[-1] the narrowest sub-sector. R5 callers
 * use that ordering to prioritise queries when a checkpoint must be
 * resumed mid-comune.
 */
export function expandMapsQueryVariants(category: string, mode: CoverageMode): string[] {
  if (mode === 'default') return [category];
  const key = normaliseCategory(category);
  const variants = MAPS_FULL_COVERAGE_VARIANTS[key];
  if (!variants || variants.length === 0) return [category];
  // Defensive copy so callers can't mutate the table.
  return [...variants];
}

/**
 * True when the requested category has a curated full-coverage
 * variant table. R5 logs a warning when the operator passes
 * `--coverage full` for a category we don't know how to expand —
 * the run still proceeds with the single default query.
 */
export function hasFullCoverageVariants(category: string): boolean {
  return Boolean(MAPS_FULL_COVERAGE_VARIANTS[normaliseCategory(category)]);
}
