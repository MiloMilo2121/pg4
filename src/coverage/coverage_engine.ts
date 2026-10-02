/**
 * Coverage engine — the heart of the gap map.
 *
 * Takes the accumulated companies, classifies them into (ATECO division, provincia,
 * region), joins them with the ISTAT universe and computes, for each cell:
 *   have / universe / addressable / coverage% / sample_ok / priority.
 *
 * Honesty invariant (like the rest of pg4): NO silent drops. Companies outside
 * Northern Italy and those that cannot be classified into a division are
 * counted in explicit buckets, not discarded.
 */

import type { Lead } from '../types/lead';
import { atecoDivisionOf, atecoIndex } from './ateco';
import type { AtecoDivision } from './ateco';
import { Crosswalk } from './crosswalk';
import { IstatAsiaUniverse } from './universe';
import type { UniverseSource, UniverseProvenance, UniverseCount } from './universe';
import { loadSectors } from './sectors';
import {
  normProvince,
  regionForProvince,
  macroForProvince,
  isNordProvince,
} from '../geo/regions';
import { provinceForComune } from '../geo/comune_lookup';
import type { MacroArea } from '../geo/regions';
import {
  DEFAULT_COVERAGE_CONFIG,
  directoryFactorForSection,
} from './config';
import type { CoverageConfig } from './config';

/** "Core" enrichment fields on which we measure data completeness. */
interface EnrichmentFillRates {
  website: number; // %
  phone: number;
  email: number;
  pec: number;
  vat: number;
}

interface CellEnrichment {
  /** % of the cell's companies with the field populated (0..100). */
  fillRates: EnrichmentFillRates;
  /** Mean of the core fill rates (0..100) — data completeness of the cell. */
  score: number;
}

export interface CoverageCell {
  division: string;
  atecoLabel: string;
  section: string;
  province: string;
  region: string;
  macroArea: MacroArea;
  // numerator
  have: number;
  withWebsite: number;
  websitePct: number | null; // % of scraped companies with an official website
  // enrichment (QUALITY gap, distinct from the coverage gap)
  enrichment: CellEnrichment;
  // denominator
  universeKnown: boolean;
  universeTotal: number | null; // ISTAT active firms (all)
  universeProvenance: UniverseProvenance | null;
  universeYear: number | null;
  directoryFactor: number;
  addressable: number | null; // universeTotal * directoryFactor (rounded)
  // metrics
  coveragePct: number | null; // have / addressable (0..1+, null if universe unknown)
  minSample: number;
  sampleOk: boolean;
  needForTarget: number | null; // companies missing to reach the target coverage
  needForSample: number; // companies missing to reach the sample threshold
  priorityScore: number | null; // null if universe unknown (sorted after the known ones)
}

export interface RegionRollup {
  region: string;
  macroArea: MacroArea;
  division: string;
  atecoLabel: string;
  section: string;
  have: number;
  withWebsite: number;
  enrichment: CellEnrichment;
  universeKnown: boolean;
  universeTotal: number | null;
  addressable: number | null;
  coveragePct: number | null;
  minSample: number;
  sampleOk: boolean;
  needForTarget: number | null;
  needForSample: number;
  priorityScore: number | null;
  usesSampleUniverse: boolean;
}

interface CoverageBucketSample {
  company_name: string;
  category?: string;
  province?: string;
}

export interface CoverageReport {
  generated: { config: CoverageConfig; universeSource: string; universeHasData: boolean };
  summary: {
    totalLeads: number;
    inScope: number; // North + classified
    outOfScope: number; // outside the North
    unclassified: number; // North but without a division
    cells: number;
    cellsUniverseKnown: number;
    cellsUniverseUnknown: number;
    usesSampleUniverse: boolean; // true if at least one cell uses `sample` rows
  };
  cells: CoverageCell[]; // provincia x division granularity, sorted by priority
  regionRollup: RegionRollup[]; // region x division, sorted by priority
  buckets: {
    outOfScope: { count: number; byProvince: Record<string, number>; samples: CoverageBucketSample[] };
    unclassified: { count: number; byCategory: Record<string, number>; samples: CoverageBucketSample[] };
  };
}

export interface CoverageEngineOptions {
  universe?: UniverseSource;
  crosswalk?: Crosswalk;
  config?: Partial<CoverageConfig>;
}

interface Accum {
  have: number;
  withWebsite: number;
  // enrichment counters (populated core fields)
  website: number;
  phone: number;
  email: number;
  pec: number;
  vat: number;
}

function emptyAccum(): Accum {
  return { have: 0, withWebsite: 0, website: 0, phone: 0, email: 0, pec: 0, vat: 0 };
}

function clampPct(n: number): number {
  return n < 0 ? 0 : n;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

function hasWebsite(lead: Lead): boolean {
  return nonEmpty(lead.official_website) || nonEmpty(lead.website);
}

function pct(n: number, d: number): number {
  return d ? Math.round((1000 * n) / d) / 10 : 0;
}

/**
 * Resolves a lead's ATECO division: first the explicit `ateco` field
 * (from paid enrichment, more reliable), then the crosswalk on `category`.
 */
function divisionOf(lead: Lead, crosswalk: Crosswalk): string | undefined {
  return atecoDivisionOf(typeof lead.ateco === 'string' ? lead.ateco : undefined)
    ?? crosswalk.classify(typeof lead.category === 'string' ? lead.category : undefined);
}

function priorityOf(
  needForTarget: number | null,
  needForSample: number,
  sampleOk: boolean,
  sampleBoost: number,
): number | null {
  if (needForTarget === null) return null;
  const boost = sampleOk ? 1 : sampleBoost;
  // Driver = companies missing to reach the target (large on the markets with the biggest gap),
  // amplified when we cannot even compute statistics on the cell.
  return Math.round((needForTarget * boost + (sampleOk ? 0 : needForSample)) * 100) / 100;
}

/** Builds the coverage report from a set of accumulated leads. */
export function buildCoverageReport(leads: Iterable<Lead>, opts: CoverageEngineOptions = {}): CoverageReport {
  const universe = opts.universe ?? new IstatAsiaUniverse();
  const crosswalk = opts.crosswalk ?? new Crosswalk();
  const config: CoverageConfig = { ...DEFAULT_COVERAGE_CONFIG, ...opts.config };
  const ateco: ReadonlyMap<string, AtecoDivision> = atecoIndex();

  // Multi-division sectors (e.g. construction = ATECO 41+43): map each division
  // of the sector to the full list, so the denominator sums the universe of
  // ALL covered divisions ("impresa edile" leads classify only into 41
  // via the crosswalk, but the sector also covers 43 → otherwise coverage >100%).
  const divisionGroup = new Map<string, string[]>();
  for (const s of loadSectors()) {
    if (s.atecoDivisions.length > 1) for (const d of s.atecoDivisions) divisionGroup.set(d, s.atecoDivisions);
  }
  const universeForCell = (division: string, province: string): UniverseCount | null => {
    const divs = divisionGroup.get(division) ?? [division];
    let firms = 0;
    let known = false;
    let anySample = false;
    let istat = false;
    let year: number | undefined;
    for (const d of divs) {
      const u = universe.count(d, province);
      if (!u) continue;
      known = true;
      firms += u.activeFirms;
      if (u.provenance === 'sample') anySample = true;
      else istat = true;
      year = u.year ?? year;
    }
    if (!known) return null;
    return { activeFirms: firms, year, provenance: anySample ? 'sample' : istat ? 'istat-asia' : 'unknown' };
  };

  const cellAcc = new Map<string, Accum>(); // key = division|province
  const outByProvince: Record<string, number> = {};
  const unclassByCategory: Record<string, number> = {};
  const outSamples: CoverageBucketSample[] = [];
  const unclassSamples: CoverageBucketSample[] = [];

  let total = 0;
  let inScope = 0;
  let outOfScope = 0;
  let unclassified = 0;

  for (const lead of leads) {
    total += 1;
    let province = normProvince(typeof lead.province === 'string' ? lead.province : '');
    if (!province) {
      // The Maps parser does not resolve the province code: recover it from the comune name
      // (city → business_city → query_location). Only when the provincia is
      // EMPTY — a lead that declares a provincia outside the North stays out of scope.
      province =
        provinceForComune(typeof lead.city === 'string' ? lead.city : undefined) ??
        provinceForComune(typeof lead.business_city === 'string' ? lead.business_city : undefined) ??
        provinceForComune(typeof lead.query_location === 'string' ? lead.query_location : undefined) ??
        '';
    }
    if (!isNordProvince(province)) {
      outOfScope += 1;
      const p = province || '—';
      outByProvince[p] = (outByProvince[p] ?? 0) + 1;
      if (outSamples.length < 20) outSamples.push({ company_name: lead.company_name, category: lead.category, province: p });
      continue;
    }
    const division = divisionOf(lead, crosswalk);
    if (!division) {
      unclassified += 1;
      const c = (typeof lead.category === 'string' && lead.category.trim()) || 'sconosciuto';
      unclassByCategory[c] = (unclassByCategory[c] ?? 0) + 1;
      if (unclassSamples.length < 20) unclassSamples.push({ company_name: lead.company_name, category: lead.category, province });
      continue;
    }
    inScope += 1;
    const k = `${division}|${province}`;
    const acc = cellAcc.get(k) ?? emptyAccum();
    acc.have += 1;
    const wsite = hasWebsite(lead);
    if (wsite) acc.withWebsite += 1;
    if (wsite) acc.website += 1;
    if (nonEmpty(lead.phone)) acc.phone += 1;
    if (nonEmpty(lead.email_inferred) || nonEmpty(lead.email)) acc.email += 1;
    if (nonEmpty(lead.pec)) acc.pec += 1;
    if (nonEmpty(lead.vat_code_final) || nonEmpty(lead.vat_code)) acc.vat += 1;
    cellAcc.set(k, acc);
  }

  // ---- provincia x division cells ----
  let usesSampleUniverse = false;
  let cellsUniverseKnown = 0;
  const cells: CoverageCell[] = [];
  for (const [k, acc] of cellAcc) {
    const [division, province] = k.split('|');
    const def = ateco.get(division);
    const section = def?.section ?? '?';
    const region = regionForProvince(province) ?? '?';
    const macroArea = macroForProvince(province) ?? 'Nord-Ovest';
    const u = universeForCell(division, province);
    const universeKnown = u !== null;
    if (universeKnown) cellsUniverseKnown += 1;
    if (u?.provenance === 'sample') usesSampleUniverse = true;
    const directoryFactor = directoryFactorForSection(section);
    const addressable = u ? Math.max(1, Math.round(u.activeFirms * directoryFactor)) : null;
    const coveragePct = addressable ? acc.have / addressable : null;
    const minSample = config.minSampleProvince;
    const sampleOk = acc.have >= minSample;
    const needForTarget = addressable !== null
      ? Math.max(0, Math.ceil(config.targetCoverage * addressable) - acc.have)
      : null;
    const needForSample = Math.max(0, minSample - acc.have);
    const fillRates: EnrichmentFillRates = {
      website: pct(acc.website, acc.have),
      phone: pct(acc.phone, acc.have),
      email: pct(acc.email, acc.have),
      pec: pct(acc.pec, acc.have),
      vat: pct(acc.vat, acc.have),
    };
    const enrichmentScore = Math.round(
      (fillRates.website + fillRates.phone + fillRates.email + fillRates.pec + fillRates.vat) / 5 * 10,
    ) / 10;
    cells.push({
      division,
      atecoLabel: def?.label ?? division,
      section,
      province,
      region,
      macroArea,
      have: acc.have,
      withWebsite: acc.withWebsite,
      websitePct: acc.have ? Math.round((1000 * acc.withWebsite) / acc.have) / 10 : null,
      enrichment: { fillRates, score: enrichmentScore },
      universeKnown,
      universeTotal: u?.activeFirms ?? null,
      universeProvenance: u?.provenance ?? null,
      universeYear: u?.year ?? null,
      directoryFactor,
      addressable,
      coveragePct: coveragePct === null ? null : Math.round(clampPct(coveragePct) * 1000) / 1000,
      minSample,
      sampleOk,
      needForTarget,
      needForSample,
      priorityScore: priorityOf(needForTarget, needForSample, sampleOk, config.sampleBoost),
    });
  }

  // ---- region x division rollup ----
  interface RAcc {
    have: number; withWebsite: number; universeTotal: number; addressable: number;
    universeKnown: boolean; usesSample: boolean; region: string; macroArea: MacroArea; division: string;
    // weighted sum (fill% * have) per field: divided by have at the end it rebuilds the exact fill rate
    fw: number; fp: number; fe: number; fpec: number; fv: number;
  }
  const regionAcc = new Map<string, RAcc>();
  for (const c of cells) {
    const rk = `${c.region}|${c.division}`;
    const r = regionAcc.get(rk) ?? {
      have: 0, withWebsite: 0, universeTotal: 0, addressable: 0,
      universeKnown: false, usesSample: false, region: c.region, macroArea: c.macroArea, division: c.division,
      fw: 0, fp: 0, fe: 0, fpec: 0, fv: 0,
    };
    r.have += c.have;
    r.withWebsite += c.withWebsite;
    r.fw += c.enrichment.fillRates.website * c.have;
    r.fp += c.enrichment.fillRates.phone * c.have;
    r.fe += c.enrichment.fillRates.email * c.have;
    r.fpec += c.enrichment.fillRates.pec * c.have;
    r.fv += c.enrichment.fillRates.vat * c.have;
    if (c.universeKnown && c.universeTotal !== null && c.addressable !== null) {
      r.universeTotal += c.universeTotal;
      r.addressable += c.addressable;
      r.universeKnown = true;
      if (c.universeProvenance === 'sample') r.usesSample = true;
    }
    regionAcc.set(rk, r);
  }
  const regionRollup: RegionRollup[] = [...regionAcc.values()].map((r) => {
    const def = ateco.get(r.division);
    const addressable = r.universeKnown ? r.addressable : null;
    const coveragePct = addressable ? r.have / addressable : null;
    const minSample = config.minSampleRegion;
    const sampleOk = r.have >= minSample;
    const needForTarget = addressable !== null
      ? Math.max(0, Math.ceil(config.targetCoverage * addressable) - r.have)
      : null;
    const needForSample = Math.max(0, minSample - r.have);
    const rFill: EnrichmentFillRates = {
      website: r.have ? Math.round(r.fw / r.have * 10) / 10 : 0,
      phone: r.have ? Math.round(r.fp / r.have * 10) / 10 : 0,
      email: r.have ? Math.round(r.fe / r.have * 10) / 10 : 0,
      pec: r.have ? Math.round(r.fpec / r.have * 10) / 10 : 0,
      vat: r.have ? Math.round(r.fv / r.have * 10) / 10 : 0,
    };
    const rScore = Math.round((rFill.website + rFill.phone + rFill.email + rFill.pec + rFill.vat) / 5 * 10) / 10;
    return {
      region: r.region,
      macroArea: r.macroArea,
      division: r.division,
      atecoLabel: def?.label ?? r.division,
      section: def?.section ?? '?',
      have: r.have,
      withWebsite: r.withWebsite,
      enrichment: { fillRates: rFill, score: rScore },
      universeKnown: r.universeKnown,
      universeTotal: r.universeKnown ? r.universeTotal : null,
      addressable,
      coveragePct: coveragePct === null ? null : Math.round(clampPct(coveragePct) * 1000) / 1000,
      minSample,
      sampleOk,
      needForTarget,
      needForSample,
      priorityScore: priorityOf(needForTarget, needForSample, sampleOk, config.sampleBoost),
      usesSampleUniverse: r.usesSample,
    };
  });

  // sort by priority desc; unknown universe (null) last
  const byPriority = <T extends { priorityScore: number | null }>(a: T, b: T): number => {
    if (a.priorityScore === null && b.priorityScore === null) return 0;
    if (a.priorityScore === null) return 1;
    if (b.priorityScore === null) return -1;
    return b.priorityScore - a.priorityScore;
  };
  cells.sort(byPriority);
  regionRollup.sort(byPriority);

  return {
    generated: { config, universeSource: universe.label, universeHasData: universe.hasData() },
    summary: {
      totalLeads: total,
      inScope,
      outOfScope,
      unclassified,
      cells: cells.length,
      cellsUniverseKnown,
      cellsUniverseUnknown: cells.length - cellsUniverseKnown,
      usesSampleUniverse,
    },
    cells,
    regionRollup,
    buckets: {
      outOfScope: { count: outOfScope, byProvince: outByProvince, samples: outSamples },
      unclassified: { count: unclassified, byCategory: unclassByCategory, samples: unclassSamples },
    },
  };
}
