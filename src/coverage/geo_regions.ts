/**
 * Geography for the coverage gap map — Macro-area → Region → Provincia hierarchy,
 * limited to NORTHERN ITALY.
 *
 * `src/discovery/sources/italy_geo.ts` models only provinces (codes) and a curated
 * list of comuni; it does not group by region. Here we add the grouping
 * needed by the hierarchical Region → Provincia drill-down view, reusing
 * `PROVINCE_CODES` as the single source of truth to validate the codes.
 *
 * "Nord Italia" = the 8 ISTAT regions of Nord-Ovest + Nord-Est.
 */

import { PROVINCE_CODES } from '../discovery/sources/italy_geo';

export type MacroArea = 'Nord-Ovest' | 'Nord-Est';

export interface RegionDef {
  /** Region name (canonical key). */
  name: string;
  macroArea: MacroArea;
  /** Provincia codes (2 letters, uppercase). */
  provinces: string[];
}

/**
 * The 8 Northern regions with their provinces (vehicle registration codes).
 * Source of the geographic divisions: ISTAT (Nord-Ovest: Piemonte, Valle d'Aosta, Liguria,
 * Lombardia; Nord-Est: Trentino-Alto Adige, Veneto, Friuli-Venezia Giulia,
 * Emilia-Romagna).
 */
export const NORD_REGIONS: readonly RegionDef[] = [
  { name: 'Piemonte', macroArea: 'Nord-Ovest', provinces: ['TO', 'VC', 'NO', 'CN', 'AT', 'AL', 'BI', 'VB'] },
  { name: "Valle d'Aosta", macroArea: 'Nord-Ovest', provinces: ['AO'] },
  { name: 'Liguria', macroArea: 'Nord-Ovest', provinces: ['GE', 'IM', 'SP', 'SV'] },
  { name: 'Lombardia', macroArea: 'Nord-Ovest', provinces: ['MI', 'BG', 'BS', 'CO', 'CR', 'LC', 'LO', 'MN', 'MB', 'PV', 'SO', 'VA'] },
  { name: 'Trentino-Alto Adige', macroArea: 'Nord-Est', provinces: ['TN', 'BZ'] },
  { name: 'Veneto', macroArea: 'Nord-Est', provinces: ['VR', 'VI', 'BL', 'TV', 'VE', 'PD', 'RO'] },
  { name: 'Friuli-Venezia Giulia', macroArea: 'Nord-Est', provinces: ['UD', 'GO', 'PN', 'TS'] },
  { name: 'Emilia-Romagna', macroArea: 'Nord-Est', provinces: ['BO', 'FC', 'FE', 'MO', 'PR', 'PC', 'RA', 'RE', 'RN'] },
] as const;

/** All provincia codes of Northern Italy (47 provinces). */
export const NORD_ITALIA_PROVINCES: ReadonlySet<string> = new Set(
  NORD_REGIONS.flatMap((r) => r.provinces),
);

/** Provincia code → region map (North only). */
export const PROVINCE_TO_REGION: ReadonlyMap<string, string> = new Map(
  NORD_REGIONS.flatMap((r) => r.provinces.map((p) => [p, r.name] as const)),
);

/** Provincia code → macro-area map (North only). */
export const PROVINCE_TO_MACRO: ReadonlyMap<string, MacroArea> = new Map(
  NORD_REGIONS.flatMap((r) => r.provinces.map((p) => [p, r.macroArea] as const)),
);

/**
 * Integrity guard: every Northern code must exist in PROVINCE_CODES.
 * Runs at module load so a typo does not slip through silently.
 */
const unknown = [...NORD_ITALIA_PROVINCES].filter((p) => !PROVINCE_CODES.has(p));
if (unknown.length > 0) {
  throw new Error(`[geo_regions] sigle non in PROVINCE_CODES: ${unknown.join(', ')}`);
}

/** Normalizes a provincia code (trim + uppercase). */
export function normProvince(code: string | undefined | null): string {
  return (code ?? '').trim().toUpperCase();
}

/** True if the provincia belongs to Northern Italy. */
export function isNordProvince(code: string | undefined | null): boolean {
  return NORD_ITALIA_PROVINCES.has(normProvince(code));
}

/** Region of a Northern provincia, or undefined if out of scope. */
export function regionForProvince(code: string | undefined | null): string | undefined {
  return PROVINCE_TO_REGION.get(normProvince(code));
}

/** Macro-area of a Northern provincia, or undefined if out of scope. */
export function macroForProvince(code: string | undefined | null): MacroArea | undefined {
  return PROVINCE_TO_MACRO.get(normProvince(code));
}
