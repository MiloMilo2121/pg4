/**
 * Motore di copertura — il cuore della gap map.
 *
 * Prende le aziende accumulate, le classifica in (divisione ATECO, provincia,
 * regione), fa join con l'universo ISTAT e calcola per ogni cella:
 *   have / universe / addressable / coverage% / sample_ok / priority.
 *
 * Invariante di onesta' (come il resto di pg4): NIENTE drop silenzioso. Le
 * aziende fuori Nord-Italia e quelle non classificabili in una divisione sono
 * contate in bucket espliciti, non scartate.
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
} from './geo_regions';
import { provinceForComune } from '../geo/comune_lookup';
import type { MacroArea } from './geo_regions';
import {
  DEFAULT_COVERAGE_CONFIG,
  directoryFactorForSection,
} from './config';
import type { CoverageConfig } from './config';

/** Campi "core" di enrichment su cui misuriamo la completezza dei dati. */
export interface EnrichmentFillRates {
  website: number; // %
  phone: number;
  email: number;
  pec: number;
  vat: number;
}

export interface CellEnrichment {
  /** % delle aziende della cella con il campo valorizzato (0..100). */
  fillRates: EnrichmentFillRates;
  /** Media dei fill-rate core (0..100) — completezza dato della cella. */
  score: number;
}

export interface CoverageCell {
  division: string;
  atecoLabel: string;
  section: string;
  province: string;
  region: string;
  macroArea: MacroArea;
  // numeratore
  have: number;
  withWebsite: number;
  websitePct: number | null; // % delle scrapate con sito ufficiale
  // enrichment (carenza di QUALITA', distinta dalla carenza di copertura)
  enrichment: CellEnrichment;
  // denominatore
  universeKnown: boolean;
  universeTotal: number | null; // imprese attive ISTAT (tutte)
  universeProvenance: UniverseProvenance | null;
  universeYear: number | null;
  directoryFactor: number;
  addressable: number | null; // universeTotal * directoryFactor (arrotondato)
  // metriche
  coveragePct: number | null; // have / addressable (0..1+, null se universo ignoto)
  minSample: number;
  sampleOk: boolean;
  needForTarget: number | null; // aziende mancanti per il target coverage
  needForSample: number; // aziende mancanti per la soglia campione
  priorityScore: number | null; // null se universo ignoto (ordinato dopo i noti)
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

export interface CoverageBucketSample {
  company_name: string;
  category?: string;
  province?: string;
}

export interface CoverageReport {
  generated: { config: CoverageConfig; universeSource: string; universeHasData: boolean };
  summary: {
    totalLeads: number;
    inScope: number; // Nord + classificate
    outOfScope: number; // fuori Nord
    unclassified: number; // Nord ma senza divisione
    cells: number;
    cellsUniverseKnown: number;
    cellsUniverseUnknown: number;
    usesSampleUniverse: boolean; // true se almeno una cella usa righe `sample`
  };
  cells: CoverageCell[]; // granularita' provincia x divisione, ordinate per priorita'
  regionRollup: RegionRollup[]; // regione x divisione, ordinate per priorita'
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
  // contatori enrichment (campi core valorizzati)
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
 * Risolve la divisione ATECO di un lead: prima il campo `ateco` esplicito
 * (da enrichment a pagamento, piu' affidabile), poi il crosswalk sul `category`.
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
  // Driver = aziende mancanti al target (grande sui mercati dove manca di piu'),
  // amplificato quando non possiamo nemmeno fare statistica sulla cella.
  return Math.round((needForTarget * boost + (sampleOk ? 0 : needForSample)) * 100) / 100;
}

/** Costruisce il report di copertura da un insieme di lead accumulati. */
export function buildCoverageReport(leads: Iterable<Lead>, opts: CoverageEngineOptions = {}): CoverageReport {
  const universe = opts.universe ?? new IstatAsiaUniverse();
  const crosswalk = opts.crosswalk ?? new Crosswalk();
  const config: CoverageConfig = { ...DEFAULT_COVERAGE_CONFIG, ...opts.config };
  const ateco: ReadonlyMap<string, AtecoDivision> = atecoIndex();

  // Settori multi-divisione (es. edilizia = ATECO 41+43): mappa ogni divisione
  // del settore alla lista completa, così il denominatore somma l'universo di
  // TUTTE le divisioni coperte (i lead "impresa edile" classificano solo su 41
  // via crosswalk, ma il settore copre anche 43 → altrimenti copertura >100%).
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
      // Il parser Maps non risolve la sigla: recuperala dal nome comune
      // (city → business_city → query_location). Solo quando la provincia è
      // VUOTA — un lead che dichiara una provincia fuori Nord resta fuori scope.
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

  // ---- celle provincia x divisione ----
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

  // ---- rollup regione x divisione ----
  interface RAcc {
    have: number; withWebsite: number; universeTotal: number; addressable: number;
    universeKnown: boolean; usesSample: boolean; region: string; macroArea: MacroArea; division: string;
    // somma pesata (fill% * have) per campo: divisa per have a fine ricostruisce il fill-rate esatto
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

  // ordina per priorita' desc; universo ignoto (null) in fondo
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
