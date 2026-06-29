/**
 * Italian provinces (sigle automobilistiche) and a curated subset of
 * comuni per province.
 *
 * The full Italian comune list is ~7900 entries; we don't ship that here.
 * Phase 4 covers the provinces commonly hit during pg3 campaigns; the CLI
 * also accepts `--comuni "C1,C2,C3"` to override the list at run time.
 *
 * The data was distilled from `pg3/src/scraper/runner.ts` TARGET_CLUSTERS
 * plus pg3's PROVINCE_CODES.
 */

export const PROVINCE_CODES: ReadonlySet<string> = new Set<string>([
  'AG','AL','AN','AO','AR','AP','AT','AV','BA','BT','BL','BN','BG','BI','BO','BZ','BS','BR',
  'CA','CL','CB','CI','CE','CT','CZ','CH','CO','CS','CR','KR','CN','EN','FM','FE','FI','FG',
  'FC','FR','GE','GO','GR','IM','IS','SP','AQ','LT','LE','LC','LI','LO','LU','MC','MN','MS',
  'MT','VS','ME','MI','MO','MB','NA','NO','NU','OG','OT','OR','PD','PA','PR','PV','PG','PU',
  'PE','PC','PI','PT','PN','PZ','PO','RG','RA','RC','RE','RI','RN','RM','RO','SA','SS','SV',
  'SI','SR','SO','TA','TE','TR','TO','TP','TN','TV','TS','UD','VA','VE','VB','VC','VR','VV',
  'VI','VT',
]);

/**
 * Curated comune lists. The list always begins with the province capital
 * so the orchestrator scrapes that first; on PG-overflow it can drill
 * down through the rest.
 */
export const PROVINCE_COMUNI: Record<string, string[]> = {
  BL: ['Belluno', 'Feltre', 'Sedico', 'Ponte nelle Alpi', 'Pieve di Cadore', 'Agordo', 'Mel', 'Longarone', "Cortina d'Ampezzo"],
  VR: ['Verona', 'Villafranca di Verona', 'San Giovanni Lupatoto', 'Bussolengo', 'Negrar di Valpolicella', 'Pescantina', 'San Bonifacio', 'Soave', 'Legnago', 'Isola della Scala', 'Bardolino', 'Lazise', 'Garda', 'Valeggio sul Mincio'],
  VE: ['Venezia', 'Mestre', 'Marghera', 'Spinea', 'Mirano', 'Dolo', 'Mira', 'Marcon', 'Chioggia', 'San Donà di Piave', 'Jesolo', 'Caorle', 'Portogruaro'],
  PD: ['Padova', 'Albignasego', 'Selvazzano Dentro', 'Vigonza', 'Rubano', 'Cadoneghe', 'Limena', 'Cittadella', 'Camposampiero', 'Abano Terme', 'Monselice', 'Este'],
  VI: ['Vicenza', 'Bassano del Grappa', 'Schio', 'Thiene', 'Arzignano', 'Montecchio Maggiore', 'Valdagno', 'Lonigo', 'Marostica', 'Asiago'],
  TV: ['Treviso', 'Villorba', 'Silea', 'Paese', 'Preganziol', 'Ponzano Veneto', 'Mogliano Veneto', 'Conegliano', 'Pieve di Soligo', 'Vittorio Veneto', 'Montebelluna', 'Asolo', 'Castelfranco Veneto'],
  RO: ['Rovigo', 'Adria', 'Badia Polesine', 'Lendinara', 'Occhiobello', 'Porto Viro'],
  BS: ['Brescia', 'Desenzano del Garda', 'Montichiari', 'Lumezzane', 'Palazzolo sull’Oglio', 'Rovato', 'Ghedi'],
  MN: ['Mantova', 'Castiglione delle Stiviere', 'Suzzara', 'Viadana'],
  MI: ['Milano', 'Sesto San Giovanni', 'Cinisello Balsamo', 'Rho', 'Legnano', 'Magenta', 'Abbiategrasso', 'Corsico', 'San Donato Milanese'],
  TO: ['Torino', 'Moncalieri', 'Collegno', 'Rivoli', 'Settimo Torinese', 'Nichelino', 'Chieri', 'Pinerolo', 'Ivrea'],
  RM: ['Roma', 'Fiumicino', 'Tivoli', 'Pomezia', 'Guidonia Montecelio', 'Velletri', 'Anzio'],
};

/**
 * @returns the comuni list for the requested province code (uppercase 2
 *   letters), or an empty array if the province is not in the curated set.
 *   Caller can fall back to `[provinceCode]` (using only the capital) or
 *   pass `--comuni` explicitly.
 */
export function getComuniForProvince(code: string): string[] {
  const norm = code.trim().toUpperCase();
  if (!PROVINCE_CODES.has(norm)) return [];
  return PROVINCE_COMUNI[norm] ?? [];
}

/**
 * Resolve an arbitrary user-provided list of comuni (CSV-formatted CLI
 * argument), trimming and dropping empties.
 */
export function parseComuniList(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}
