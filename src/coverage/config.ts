/**
 * Parametri della coverage gap map. Tutti override-abili dalla CLI.
 *
 * Driver di priorita': COPERTURA (quanto manca per raggiungere il target sul
 * mercato indirizzabile) CON una soglia minima di campione per cella — sotto la
 * soglia non possiamo nemmeno stimare metriche di mercato in modo affidabile,
 * quindi quella cella riceve un boost di priorita'.
 */

export interface CoverageConfig {
  /** Frazione di copertura target sull'universo INDIRIZZABILE (0..1). */
  targetCoverage: number;
  /** Campione minimo per cella PROVINCIA x divisione (sufficienza statistica fine). */
  minSampleProvince: number;
  /** Campione minimo per cella REGIONE x divisione (stima di proporzione ~±10% IC 95%). */
  minSampleRegion: number;
  /** Moltiplicatore di priorita' quando una cella e' sotto la soglia di campione. */
  sampleBoost: number;
  /** Soglia minima di imprese attive ISTAT perche' una divisione entri nella mappa. */
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
 * Fattore "INDIRIZZABILE-DA-DIRECTORY" per sezione ATECO: frazione stimata delle
 * imprese attive ISTAT che e' plausibile trovare su PagineGialle/Maps. Serve a
 * NON penalizzare i settori dominati da ditte individuali (assenti dalle
 * directory perche' non depositano bilancio).
 *
 * ATTENZIONE: sono EURISTICHE, non misure. Vanno tarate quando avremo abbastanza
 * dati per stimare il vero rapporto findable/attive per settore. Override via
 * CLI / file di config quando disponibile evidenza.
 */
export const DIRECTORY_FACTOR_BY_SECTION: Record<string, number> = {
  A: 0.15, // agricoltura — molte ditte individuali, poco su directory
  B: 0.4,
  C: 0.55, // manifattura
  D: 0.5,
  E: 0.5,
  F: 0.35, // costruzioni — molti artigiani/individuali
  G: 0.7, // commercio — molto presente su directory
  H: 0.45,
  I: 0.85, // alloggio/ristorazione — altissima presenza
  J: 0.55,
  K: 0.6,
  L: 0.7, // immobiliare
  M: 0.5, // attivita' professionali
  N: 0.5,
  O: 0.2, // PA — fuori target
  P: 0.5,
  Q: 0.6,
  R: 0.5,
  S: 0.6, // servizi alla persona
  T: 0.05,
  U: 0.05,
};

export const DEFAULT_DIRECTORY_FACTOR = 0.5;

export function directoryFactorForSection(section: string | undefined): number {
  if (!section) return DEFAULT_DIRECTORY_FACTOR;
  return DIRECTORY_FACTOR_BY_SECTION[section] ?? DEFAULT_DIRECTORY_FACTOR;
}
