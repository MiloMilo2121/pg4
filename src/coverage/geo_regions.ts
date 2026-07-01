/**
 * Geografia per la coverage gap map — gerarchia Macro-area → Regione → Provincia,
 * limitata al NORD ITALIA.
 *
 * `src/discovery/sources/italy_geo.ts` modella solo province (sigle) e una lista
 * curata di comuni; non raggruppa per regione. Qui aggiungiamo il raggruppamento
 * che serve alla vista gerarchica Regione → drill-down Provincia, riusando
 * `PROVINCE_CODES` come unica fonte di verità per validare le sigle.
 *
 * "Nord Italia" = le 8 regioni ISTAT del Nord-Ovest + Nord-Est.
 */

import { PROVINCE_CODES } from '../discovery/sources/italy_geo';

export type MacroArea = 'Nord-Ovest' | 'Nord-Est';

export interface RegionDef {
  /** Nome regione (chiave canonica). */
  name: string;
  macroArea: MacroArea;
  /** Sigle provinciali (2 lettere, maiuscole). */
  provinces: string[];
}

/**
 * Le 8 regioni del Nord con le rispettive province (sigle automobilistiche).
 * Fonte ripartizioni: ISTAT (Nord-Ovest: Piemonte, Valle d'Aosta, Liguria,
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

/** Tutte le sigle provinciali del Nord Italia (47 province). */
export const NORD_ITALIA_PROVINCES: ReadonlySet<string> = new Set(
  NORD_REGIONS.flatMap((r) => r.provinces),
);

/** Mappa sigla provincia → regione (solo Nord). */
export const PROVINCE_TO_REGION: ReadonlyMap<string, string> = new Map(
  NORD_REGIONS.flatMap((r) => r.provinces.map((p) => [p, r.name] as const)),
);

/** Mappa sigla provincia → macro-area (solo Nord). */
export const PROVINCE_TO_MACRO: ReadonlyMap<string, MacroArea> = new Map(
  NORD_REGIONS.flatMap((r) => r.provinces.map((p) => [p, r.macroArea] as const)),
);

/**
 * Guardia d'integrita': ogni sigla del Nord deve esistere in PROVINCE_CODES.
 * Eseguita al load del modulo cosi' un refuso non passa silenzioso.
 */
const unknown = [...NORD_ITALIA_PROVINCES].filter((p) => !PROVINCE_CODES.has(p));
if (unknown.length > 0) {
  throw new Error(`[geo_regions] sigle non in PROVINCE_CODES: ${unknown.join(', ')}`);
}

/** Normalizza una sigla provincia (trim + uppercase). */
export function normProvince(code: string | undefined | null): string {
  return (code ?? '').trim().toUpperCase();
}

/** True se la provincia appartiene al Nord Italia. */
export function isNordProvince(code: string | undefined | null): boolean {
  return NORD_ITALIA_PROVINCES.has(normProvince(code));
}

/** Regione di una provincia del Nord, o undefined se fuori scope. */
export function regionForProvince(code: string | undefined | null): string | undefined {
  return PROVINCE_TO_REGION.get(normProvince(code));
}

/** Macro-area di una provincia del Nord, o undefined se fuori scope. */
export function macroForProvince(code: string | undefined | null): MacroArea | undefined {
  return PROVINCE_TO_MACRO.get(normProvince(code));
}
