// All static datasets + shared state types for the Setaccio dashboard.
// Mirrors the `DCLogic` data block of the Antigravity design prototype.

export type Nav =
  | 'home'
  | 'mercati'
  | 'aziende'
  | 'italia'
  | 'raff'
  | 'val'
  | 'analytics'
  | 'liste'
  | 'sistema';

export type JobKind = 'enrich' | 'scrape' | 'discovery' | 'collect_signals' | 'judge' | 'validate_export';
export interface ActiveJob {
  id: string;
  kind: JobKind;
}

export type ItLevel = 'nazione' | 'regione' | 'provincia';
export type ItMode =
  | 'copertura'
  | 'profondita'
  | 'fatturato'
  | 'target'
  | 'settori'
  | 'recenza'
  | 'opportunita';

export interface State {
  nav: Nav;
  market: string;
  miloOpen: boolean;
  miloStep: number;
  itLevel: ItLevel;
  itMode: ItMode;
  hover: string | null;
  raffTab: 'enrichment' | 'imbuto' | 'viste';
  enrich: Record<string, boolean>;
  filters: Record<string, boolean>;
  valTab: 'matrice' | 'coda' | 'golden' | 'evals' | 'config' | 'validation';
  cell: number;
  anTab:
    | 'overview'
    | 'mercato'
    | 'enrichment'
    | 'raffinazione'
    | 'giudizio'
    | 'geografica'
    | 'provider'
    | 'costi';
  aziView: 'tutte' | 'grezze' | 'arricchite' | 'giudicate' | 'target' | 'escluse';
  query: string;
  wizardOpen: boolean;
  wStep: number;
  wCats: string[];
  wProv: string[];
  wSrc: string[];
  wDepth: 'rapido' | 'completo' | 'esteso';
  // FE↔BE wiring: the job currently polled + the progress modal + the company drawer.
  activeJob: ActiveJob | null;
  jobModalOpen: boolean;
  selectedCompanyId: string | null;
}

export const INITIAL_STATE: State = {
  nav: 'home',
  market: 'vic',
  miloOpen: false,
  miloStep: 0,
  itLevel: 'nazione',
  itMode: 'copertura',
  hover: null,
  raffTab: 'enrichment',
  enrich: { piva: true, fatturato: true, dipendenti: true },
  filters: { sito: true, categoria: true, fatturato: true, dipendenti: true, quadrante: true },
  valTab: 'matrice',
  cell: 4,
  anTab: 'overview',
  aziView: 'tutte',
  query: '',
  wizardOpen: false,
  wStep: 0,
  wCats: ['Software B2B SaaS'],
  wProv: ['Milano'],
  wSrc: ['pg', 'maps'],
  wDepth: 'completo',
  activeJob: null,
  jobModalOpen: false,
  selectedCompanyId: null,
};

export interface Market {
  id: string;
  settore: string;
  territorio: string;
  stato: string;
  aziende: number;
  target: number;
  comuni: number;
  cov: number;
  ultimo: string;
}

export interface Region {
  id: string;
  name: string;
  abbr: string;
  col: number;
  row: number;
  cov: number;
  az: number;
  nuove: number;
  prov: number;
  mercati: number;
  rec: number;
}

export const REGIONS: Region[] = [
  { id: 'vda', name: "Valle d'Aosta", abbr: 'VDA', col: 1, row: 1, cov: 0, az: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 },
  { id: 'pie', name: 'Piemonte', abbr: 'PIE', col: 2, row: 1, cov: 12, az: 9100, nuove: 60, prov: 2, mercati: 1, rec: 40 },
  { id: 'lom', name: 'Lombardia', abbr: 'LOM', col: 3, row: 1, cov: 22, az: 28400, nuove: 210, prov: 4, mercati: 3, rec: 55 },
  { id: 'taa', name: 'Trentino-A.A.', abbr: 'TAA', col: 4, row: 0, cov: 8, az: 3200, nuove: 20, prov: 1, mercati: 1, rec: 30 },
  { id: 'fvg', name: 'Friuli-V.G.', abbr: 'FVG', col: 5, row: 0, cov: 26, az: 6400, nuove: 80, prov: 2, mercati: 1, rec: 60 },
  { id: 'ven', name: 'Veneto', abbr: 'VEN', col: 4, row: 1, cov: 78, az: 75620, nuove: 184, prov: 7, mercati: 8, rec: 92 },
  { id: 'lig', name: 'Liguria', abbr: 'LIG', col: 2, row: 2, cov: 6, az: 2400, nuove: 12, prov: 1, mercati: 0, rec: 25 },
  { id: 'emr', name: 'Emilia-Romagna', abbr: 'EMR', col: 3, row: 2, cov: 18, az: 16200, nuove: 120, prov: 3, mercati: 2, rec: 50 },
  { id: 'tos', name: 'Toscana', abbr: 'TOS', col: 3, row: 3, cov: 9, az: 7800, nuove: 40, prov: 1, mercati: 1, rec: 35 },
  { id: 'umb', name: 'Umbria', abbr: 'UMB', col: 4, row: 3, cov: 3, az: 900, nuove: 4, prov: 0, mercati: 0, rec: 15 },
  { id: 'mar', name: 'Marche', abbr: 'MAR', col: 5, row: 3, cov: 5, az: 1900, nuove: 10, prov: 1, mercati: 0, rec: 20 },
  { id: 'laz', name: 'Lazio', abbr: 'LAZ', col: 3, row: 4, cov: 4, az: 1200, nuove: 6, prov: 0, mercati: 0, rec: 18 },
  { id: 'abr', name: 'Abruzzo', abbr: 'ABR', col: 4, row: 4, cov: 2, az: 500, nuove: 2, prov: 0, mercati: 0, rec: 10 },
  { id: 'mol', name: 'Molise', abbr: 'MOL', col: 5, row: 4, cov: 0, az: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 },
  { id: 'cam', name: 'Campania', abbr: 'CAM', col: 4, row: 5, cov: 1, az: 300, nuove: 0, prov: 0, mercati: 0, rec: 6 },
  { id: 'pug', name: 'Puglia', abbr: 'PUG', col: 6, row: 5, cov: 2, az: 600, nuove: 0, prov: 0, mercati: 0, rec: 8 },
  { id: 'bas', name: 'Basilicata', abbr: 'BAS', col: 5, row: 6, cov: 0, az: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 },
  { id: 'cal', name: 'Calabria', abbr: 'CAL', col: 5, row: 7, cov: 0, az: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 },
  { id: 'sic', name: 'Sicilia', abbr: 'SIC', col: 4, row: 8, cov: 1, az: 200, nuove: 0, prov: 0, mercati: 0, rec: 4 },
  { id: 'sar', name: 'Sardegna', abbr: 'SAR', col: 1, row: 5, cov: 0, az: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 },
];

export interface Province {
  id: string;
  name: string;
  col: number;
  row: number;
  cov: number;
  az: number;
  target: number;
  tr: string;
  ct: string;
}

export const PROVINCES: Province[] = [
  { id: 'vr', name: 'Verona', col: 0, row: 1, cov: 48, az: 24100, target: 1320, tr: '6,1%', ct: '€0,74' },
  { id: 'vi', name: 'Vicenza', col: 1, row: 1, cov: 85, az: 18420, target: 1840, tr: '7,0%', ct: '€0,61' },
  { id: 'tv', name: 'Treviso', col: 2, row: 1, cov: 40, az: 9400, target: 520, tr: '9,8%', ct: '€0,49' },
  { id: 've', name: 'Venezia', col: 3, row: 1, cov: 34, az: 7200, target: 360, tr: '5,2%', ct: '€0,83' },
  { id: 'bl', name: 'Belluno', col: 2, row: 0, cov: 22, az: 1600, target: 90, tr: '4,0%', ct: '€0,92' },
  { id: 'pd', name: 'Padova', col: 2, row: 2, cov: 64, az: 12800, target: 980, tr: '12,4%', ct: '€0,38' },
  { id: 'ro', name: 'Rovigo', col: 2, row: 3, cov: 18, az: 2100, target: 110, tr: '3,5%', ct: '€0,95' },
];

// Maps a Veneto province id → svg outline id in geo/veneto-provinces.json.
export const VEN_SVG: Record<string, string> = {
  vr: 'vr', vi: 'vi', tv: 'tv', ve: 've', bl: 'bl', pd: 'pd', ro: 'ro',
};

// Maps a region id → svg outline id in geo/italy-regions.json.
export const SVGID: Record<string, string> = {
  vda: 'aosta-valley', pie: 'piedmont', lom: 'lombardy', taa: 'trentino-south-tyrol',
  fvg: 'friuli-venezia-giulia', ven: 'veneto', lig: 'liguria', emr: 'emilia-romagna',
  tos: 'tuscany', umb: 'umbria', mar: 'marche', laz: 'lazio', abr: 'abruzzo',
  mol: 'molise', cam: 'campania', pug: 'apulia', bas: 'basilicata', cal: 'calabria',
  sic: 'sicily', sar: 'sardinia',
};

export interface Credit {
  id: string;
  nome: string;
  piano: string;
  unit: string;
  resN: number;
  totN: number;
  res: string;
  tot: string;
  cons: string;
  giorni: number;
  soglia: number;
}

export const CREDITS: Credit[] = [
  { id: 'fi', nome: 'FatturatoItalia', piano: 'Pay-as-you-go', unit: '€', resN: 128, totN: 400, res: '€128', tot: '€400', cons: '€142 / 30gg', giorni: 27, soglia: 50 },
  { id: 'oa', nome: 'Openapi', piano: 'Pacchetto 10k', unit: 'call', resN: 4200, totN: 10000, res: '4.200', tot: '10.000 call', cons: '3.100 / 30gg', giorni: 41, soglia: 1500 },
  { id: 'li', nome: 'LinkedIn · sniper', piano: 'Lookup 1k/mese', unit: 'lookup', resN: 180, totN: 1000, res: '180', tot: '1.000 lookup', cons: '820 / 30gg', giorni: 7, soglia: 200 },
  { id: 'ri', nome: 'Registro Imprese · PEC', piano: 'Prepagato', unit: '€', resN: 86, totN: 200, res: '€86', tot: '€200', cons: '€34 / 30gg', giorni: 76, soglia: 30 },
];

/** Tier label of a company the judgment layer has not scored yet. */
export const NO_TIER = 'Non giudicata';

export interface Company {
  /** Real company id (set for API rows). */
  id?: string;
  nome: string;
  comune: string;
  settore: string;
  fattN: number;
  dip: number;
  mat: string;
  matW: string;
  tier: string;
  /** Judged and ruled out as a target (verdetto_gap.target === 'no'). */
  excluded?: boolean;
  kw: string;
}

export interface ComuneSlot {
  name: string;
  x: number;
  y: number;
}

export interface Comune extends ComuneSlot {
  az: number;
  withSite: number;
  topCategory: string;
}

/** Layout of the comuni bubble map for the province of Padova (abstract viewBox 460×420, north up). */
export const COMUNI_PD: ComuneSlot[] = [
  { name: 'Padova', x: 235, y: 215 }, { name: 'Cittadella', x: 170, y: 70 },
  { name: 'Camposampiero', x: 285, y: 110 }, { name: 'Noventa Padovana', x: 330, y: 220 },
  { name: 'Vigonza', x: 375, y: 150 }, { name: 'Selvazzano Dentro', x: 130, y: 165 },
  { name: 'Albignasego', x: 250, y: 295 }, { name: 'Abano Terme', x: 140, y: 265 },
  { name: 'Monselice', x: 210, y: 360 }, { name: 'Este', x: 95, y: 370 },
  { name: 'Piove di Sacco', x: 365, y: 310 },
];

export interface EnrichField {
  k: string;
  label: string;
  cov: number;
  toArr: number;
  costN: number;
  cost: string;
  prio: string;
}

export const ENRICH: EnrichField[] = [
  { k: 'piva', label: 'P.IVA', cov: 63, toArr: 3560, costN: 0, cost: '€0', prio: 'Alta' },
  { k: 'fatturato', label: 'Fatturato', cov: 31, toArr: 6650, costN: 96, cost: '€96', prio: 'Media' },
  { k: 'dipendenti', label: 'Dipendenti', cov: 27, toArr: 7040, costN: 74, cost: '€74', prio: 'Alta' },
  { k: 'email', label: 'Email', cov: 51, toArr: 4720, costN: 28, cost: '€0–40', prio: 'Media' },
  { k: 'pec', label: 'PEC', cov: 44, toArr: 5400, costN: 0, cost: '€0', prio: 'Media' },
  { k: 'social', label: 'Social / LinkedIn', cov: 38, toArr: 5980, costN: 121, cost: '€121', prio: 'Alta' },
  { k: 'decisore', label: 'Decisore', cov: 14, toArr: 8290, costN: 310, cost: '€310', prio: 'Alta' },
  { k: 'ateco', label: 'ATECO', cov: 71, toArr: 2600, costN: 0, cost: '€0', prio: 'Bassa' },
];

export interface RaffFilter {
  k: string;
  label: string;
  removed: number;
}

export const RAFF: RaffFilter[] = [
  { k: 'sito', label: 'Senza sito', removed: 1380 },
  { k: 'categoria', label: 'Fuori categoria', removed: 1650 },
  { k: 'fatturato', label: 'Fatturato sotto soglia', removed: 3120 },
  { k: 'dipendenti', label: 'Dipendenti insufficienti', removed: 1040 },
  { k: 'quadrante', label: 'Quadranti non target', removed: 1280 },
];

/** Static funnel universe of the prototype (tech companies mapped in Nord Italia); the imbuto and analytics views share it. */
export const UNIVERSO = 9640;

export const WIZ_CATS = ['Software B2B SaaS', 'Intelligenza artificiale', 'Cybersecurity', 'Fintech e insurtech', 'Robotica e automazione', 'Fotonica e semiconduttori', 'Biotech e medtech', 'Spacetech e aerospazio', 'Quantum e deeptech', 'Data e analytics', 'Climate tech', 'Industrial IoT'];
export const WIZ_PROV = ['Milano', 'Torino', 'Bologna', 'Trento', 'Padova', 'Genova', 'Trieste', 'Treviso', 'Verona', 'Monza e Brianza'];

export interface WizSource {
  id: string;
  nome: string;
  tipo: string;
  costo: string;
  cov: string;
}
export const WIZ_SOURCES: WizSource[] = [
  { id: 'pg', nome: 'PagineGialle', tipo: 'Anagrafica + categorie', costo: 'Gratis', cov: 'Alta' },
  { id: 'maps', nome: 'Google Maps', tipo: 'Geo + recensioni', costo: 'Gratis', cov: 'Alta' },
  { id: 'fi', nome: 'FatturatoItalia', tipo: 'Dati societari + fatturato', costo: 'A consumo', cov: 'Media' },
  { id: 'oa', nome: 'Openapi', tipo: 'P.IVA + bilanci', costo: 'A consumo', cov: 'Media' },
];

export interface WizDepth {
  id: 'rapido' | 'completo' | 'esteso';
  nome: string;
  desc: string;
  dur: number;
}
export const WIZ_DEPTH: WizDepth[] = [
  { id: 'rapido', nome: 'Rapido', desc: 'Solo il capoluogo, prima pagina di risultati. Circa un minuto, dati reali.', dur: 22 },
  { id: 'completo', nome: 'Completo', desc: 'Più varianti e più fonti, maggiore copertura.', dur: 58 },
  { id: 'esteso', nome: 'Esteso', desc: 'Tutte le combinazioni, query correlate, comuni e categorie vicine. Massimo recall.', dur: 100 },
];

// Structural template of the 3×3 A×B grid (axis level + design tier). The cell
// COUNT is overlaid from the real judgment-summary quadrant histogram: the
// engine emits quadrants as `A{s}B{s}` with s ∈ {+ , - , ?}; the view's three
// buckets per axis map +→A (alta), ?→M (media/indeterminato), -→B (bassa).
export const CELLS: { a: 'A' | 'M' | 'B'; b: 'A' | 'M' | 'B'; tier: string }[] = [
  { a: 'B', b: 'A', tier: 'Tier C' }, { a: 'M', b: 'A', tier: 'Tier B' }, { a: 'A', b: 'A', tier: 'Tier A' },
  { a: 'B', b: 'M', tier: 'Tier C' }, { a: 'M', b: 'M', tier: 'Tier C' }, { a: 'A', b: 'M', tier: 'Tier B' },
  { a: 'B', b: 'B', tier: 'Tier D' }, { a: 'M', b: 'B', tier: 'Tier D' }, { a: 'A', b: 'B', tier: 'Tier C' },
];
const AXIS_SYM: Record<'A' | 'M' | 'B', string> = { A: '+', M: '?', B: '-' };
/** real quadrant key for a view cell, e.g. a='A' b='B' → 'A+B-'. */
export function cellQuadrant(c: { a: 'A' | 'M' | 'B'; b: 'A' | 'M' | 'B' }): string {
  return `A${AXIS_SYM[c.a]}B${AXIS_SYM[c.b]}`;
}

const TIER_BY_QUADRANT: Record<string, string> = Object.fromEntries(CELLS.map((c) => [cellQuadrant(c), c.tier]));
/** The design tier of a judged company's quadrant; NO_TIER when it has not been judged. */
export function tierForQuadrant(quadrant: string | undefined): string {
  return (quadrant && TIER_BY_QUADRANT[quadrant]) || NO_TIER;
}
