/**
 * UniverseSource — the DENOMINATOR of the coverage gap map.
 *
 * Deliberate abstraction: today the only impl is `IstatAsiaUniverse` (free ISTAT
 * ASIA CSV, active firms per ATECO division x provincia). The interface is
 * the hook for plugging in a paid company-by-company source in the future
 * (Registro Imprese / openapi) without touching the coverage engine.
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { normProvince } from '../geo/regions';
import { atecoDivisionOf } from './ateco';
import { REPO_ROOT } from '../util/repo_root';

export type UniverseProvenance = 'istat-asia' | 'sample' | string;

export interface UniverseCount {
  /** Number of active firms (total universe, incl. sole proprietorships). */
  activeFirms: number;
  year?: number;
  provenance: UniverseProvenance;
}

export interface UniverseSource {
  /** Universe count for (2-digit ATECO division, provincia code), or null if unknown. */
  count(division: string, province: string): UniverseCount | null;
  /** True if the source has at least one row loaded. */
  hasData(): boolean;
  /** Source label (for provenance in the report). */
  readonly label: string;
}

const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'istat_asia_universe.csv');

interface Row {
  ateco_division?: string;
  province?: string;
  active_firms?: string;
  year?: string;
  provenance?: string;
}

function key(division: string, province: string): string {
  return `${division}|${province}`;
}

/** Universe from the ISTAT ASIA CSV. Prefers `istat-asia` rows over `sample` for the same cell. */
export class IstatAsiaUniverse implements UniverseSource {
  readonly label = 'istat-asia';
  private readonly map = new Map<string, UniverseCount>();

  constructor(file: string = DEFAULT_PATH) {
    if (!fs.existsSync(file)) return; // no data: count() returns null, the engine reports "unknown"
    const rows = parse(fs.readFileSync(file, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Row[];
    for (const r of rows) {
      const division = atecoDivisionOf(r.ateco_division);
      const province = normProvince(r.province);
      const firms = Number(r.active_firms);
      if (!division || !province || !Number.isFinite(firms)) continue;
      const provenance = (r.provenance || 'unknown').trim();
      const entry: UniverseCount = {
        activeFirms: firms,
        year: r.year ? Number(r.year) : undefined,
        provenance,
      };
      const k = key(division, province);
      const existing = this.map.get(k);
      // Real data always wins over sample; on a tie the first one is kept.
      if (!existing || (existing.provenance === 'sample' && provenance !== 'sample')) {
        this.map.set(k, entry);
      }
    }
  }

  count(division: string, province: string): UniverseCount | null {
    return this.map.get(key(division, normProvince(province))) ?? null;
  }

  hasData(): boolean {
    return this.map.size > 0;
  }
}
