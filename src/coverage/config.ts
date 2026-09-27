/**
 * Coverage gap map parameters. All overridable from the CLI.
 *
 * Priority driver: COVERAGE (how much is missing to reach the target on the
 * addressable market) WITH a minimum sample threshold per cell — below the
 * threshold we cannot even estimate market metrics reliably,
 * so that cell gets a priority boost.
 */

import fs from 'fs';
import path from 'path';

export interface CoverageConfig {
  /** Target coverage fraction of the ADDRESSABLE universe (0..1). */
  targetCoverage: number;
  /** Minimum sample per PROVINCIA x division cell (fine-grained statistical sufficiency). */
  minSampleProvince: number;
  /** Minimum sample per REGION x division cell (proportion estimate ~±10% at 95% CI). */
  minSampleRegion: number;
  /** Priority multiplier when a cell is below the sample threshold. */
  sampleBoost: number;
  /** Minimum number of ISTAT active firms for a division to enter the map. */
  minUniverseForInclusion: number;
}

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  targetCoverage: 0.6,
  minSampleProvince: 15,
  minSampleRegion: 30,
  sampleBoost: 1.5,
  minUniverseForInclusion: 50,
};

/**
 * "ADDRESSABLE-VIA-DIRECTORY" factor per ATECO section: estimated fraction of
 * ISTAT active firms that can plausibly be found on PagineGialle/Maps. It keeps
 * sectors dominated by sole proprietorships (absent from the directories
 * because they do not file financial statements) from being penalized.
 *
 * WARNING: these are HEURISTICS, not measurements. They must be calibrated once we have enough
 * data to estimate the true findable/active ratio per sector. Override via
 * CLI / config file when evidence is available.
 */
export const DIRECTORY_FACTOR_BY_SECTION: Record<string, number> = {
  A: 0.15, // agriculture — many sole proprietorships, little directory presence
  B: 0.4,
  C: 0.55, // manufacturing
  D: 0.5,
  E: 0.5,
  F: 0.35, // construction — many craftsmen/sole proprietors
  G: 0.7, // retail/wholesale trade — strong directory presence
  H: 0.45,
  I: 0.85, // accommodation/food service — very high presence
  J: 0.55,
  K: 0.6,
  L: 0.7, // real estate
  M: 0.5, // professional activities
  N: 0.5,
  O: 0.2, // public administration — out of target
  P: 0.5,
  Q: 0.6,
  R: 0.5,
  S: 0.6, // personal services
  T: 0.05,
  U: 0.05,
};

export const DEFAULT_DIRECTORY_FACTOR = 0.5;

/**
 * EMPIRICAL calibration hook. If
 * `data/reference/directory_factor_calibrated.json` exists (section→factor map,
 * estimated from the `have/universeTotal` observed on reliable cells — sampleOk +
 * istat-asia universe), its values win over the heuristic. Absent ⇒
 * no change (falls back to the heuristic). Read once and cached.
 */
let calibratedFactors: Record<string, number> | null | undefined;
function loadCalibratedFactors(): Record<string, number> | null {
  if (calibratedFactors !== undefined) return calibratedFactors;
  try {
    const p = path.join(path.resolve(__dirname, '..', '..'), 'data', 'reference', 'directory_factor_calibrated.json');
    calibratedFactors = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>) : null;
  } catch {
    calibratedFactors = null;
  }
  return calibratedFactors;
}

export function directoryFactorForSection(section: string | undefined): number {
  if (!section) return DEFAULT_DIRECTORY_FACTOR;
  const cal = loadCalibratedFactors();
  if (cal && typeof cal[section] === 'number') return cal[section];
  return DIRECTORY_FACTOR_BY_SECTION[section] ?? DEFAULT_DIRECTORY_FACTOR;
}
