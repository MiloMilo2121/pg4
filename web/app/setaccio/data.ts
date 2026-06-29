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
  hoverCount: number;
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
  hoverCount: 0,
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
  wCats: ['Imprese metalmeccaniche'],
  wProv: ['Vicenza'],
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
  dot: string;
}

export const MARKETS: Market[] = [
  { id: 'vic', settore: 'Imprese metalmeccaniche', territorio: 'Provincia di Vicenza', stato: 'Parzialmente arricchito', aziende: 18420, target: 1840, comuni: 41, cov: 56, ultimo: '2 giorni fa', dot: 'var(--accent)' },
  { id: 'vr', settore: 'Serramenti', territorio: 'Provincia di Verona', stato: 'Mercato acquisito', aziende: 24100, target: 1320, comuni: 38, cov: 22, ultimo: '6 giorni fa', dot: 'var(--accent-2)' },
  { id: 'pd', settore: 'Imprese edili', territorio: 'Provincia di Padova', stato: 'Pronto da raffinare', aziende: 12800, target: 980, comuni: 29, cov: 64, ultimo: '90 giorni fa', dot: 'var(--ink-3)' },
  { id: 'tv', settore: 'Web Agency', territorio: 'Provincia di Treviso', stato: 'Mappatura pronta', aziende: 3400, target: 0, comuni: 14, cov: 8, ultimo: '1 giorno fa', dot: 'var(--ink-3)' },
];

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
  { id: 'vr', name: 'Verona', col: 0, row: 1, cov: 48, az: 24100, target: 1320, tr: '5,5%', ct: '€0,79' },
  { id: 'vi', name: 'Vicenza', col: 1, row: 1, cov: 85, az: 18420, target: 1840, tr: '10,0%', ct: '€0,42' },
  { id: 'tv', name: 'Treviso', col: 2, row: 1, cov: 40, az: 9400, target: 520, tr: '5,5%', ct: '€0,71' },
  { id: 've', name: 'Venezia', col: 3, row: 1, cov: 34, az: 7200, target: 360, tr: '5,0%', ct: '€0,84' },
  { id: 'bl', name: 'Belluno', col: 2, row: 0, cov: 22, az: 1600, target: 90, tr: '5,6%', ct: '€0,90' },
  { id: 'pd', name: 'Padova', col: 2, row: 2, cov: 64, az: 12800, target: 980, tr: '7,7%', ct: '€0,58' },
  { id: 'ro', name: 'Rovigo', col: 2, row: 3, cov: 18, az: 2100, target: 110, tr: '5,2%', ct: '€0,88' },
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

export interface Company {
  /** Real company id (empty for the static demo rows; set for API rows). */
  id?: string;
  nome: string;
  comune: string;
  settore: string;
  fattN: number;
  dip: number;
  mat: string;
  matW: string;
  tier: string;
  kw: string;
}

export const COMPANIES: Company[] = [
  { nome: 'Officine Meccaniche Schio Srl', comune: 'Schio', settore: 'Carpenteria metallica', fattN: 8.2, dip: 34, mat: 'Target', matW: '92%', tier: 'Tier A', kw: 'tornitura acciaio saldatura cnc' },
  { nome: 'Carpenteria Berica SpA', comune: 'Vicenza', settore: 'Carpenteria pesante', fattN: 14.0, dip: 52, mat: 'Target', matW: '100%', tier: 'Tier A', kw: 'travi capannoni strutture acciaio' },
  { nome: 'Veneta Lavorazioni Srl', comune: 'Arzignano', settore: 'Lavorazioni meccaniche', fattN: 6.1, dip: 21, mat: 'Qualificata', matW: '78%', tier: 'Tier B', kw: 'fresatura tornitura conto terzi' },
  { nome: 'F.lli Dal Maso & C.', comune: 'Thiene', settore: 'Meccatronica', fattN: 4.8, dip: 18, mat: 'Qualificata', matW: '70%', tier: 'Tier B', kw: 'automazione robotica assemblaggio' },
  { nome: 'Meccanica Bassanese Srl', comune: 'Bassano', settore: 'Lavorazioni meccaniche', fattN: 2.1, dip: 9, mat: 'Arricchita', matW: '54%', tier: 'Tier C', kw: 'tornitura piccola serie' },
  { nome: 'Torneria Valdagno', comune: 'Valdagno', settore: 'Tornitura', fattN: 0, dip: 0, mat: 'Base', matW: '32%', tier: '—', kw: 'tornitura acciaio ottone' },
  { nome: 'Inox Montecchio Srl', comune: 'Montecchio', settore: 'Carpenteria inox', fattN: 3.4, dip: 12, mat: 'Arricchita', matW: '58%', tier: 'Tier C', kw: 'acciaio inox saldatura alimentare' },
  { nome: 'Carpenterie Lonigo Snc', comune: 'Lonigo', settore: 'Carpenteria leggera', fattN: 0, dip: 0, mat: 'Grezza', matW: '18%', tier: '—', kw: 'lamiera taglio laser' },
  { nome: 'Fonderia Marosticense SpA', comune: 'Marostica', settore: 'Fonderia', fattN: 22.5, dip: 88, mat: 'Target', matW: '96%', tier: 'Tier A', kw: 'pressofusione alluminio getti' },
  { nome: 'Saldature Berica Srl', comune: 'Vicenza', settore: 'Saldatura', fattN: 1.6, dip: 7, mat: 'Arricchita', matW: '48%', tier: 'Tier C', kw: 'saldatura tig mig carpenteria' },
  { nome: 'Utensileria Schio SpA', comune: 'Schio', settore: 'Utensileria', fattN: 9.7, dip: 41, mat: 'Target', matW: '88%', tier: 'Tier A', kw: 'stampi utensili precisione' },
  { nome: 'Lamiere Thiene Srl', comune: 'Thiene', settore: 'Lavorazione lamiera', fattN: 5.3, dip: 24, mat: 'Qualificata', matW: '74%', tier: 'Tier B', kw: 'taglio laser piegatura lamiera' },
  { nome: 'Automazioni Malo Srl', comune: 'Malo', settore: 'Meccatronica', fattN: 3.9, dip: 15, mat: 'Arricchita', matW: '60%', tier: 'Tier C', kw: 'automazione quadri elettrici plc' },
  { nome: 'Meccanica di Precisione Arzignano', comune: 'Arzignano', settore: 'Lavorazioni meccaniche', fattN: 7.8, dip: 29, mat: 'Qualificata', matW: '82%', tier: 'Tier B', kw: 'cnc precisione aerospace' },
  { nome: 'Stampi Montecchio Srl', comune: 'Montecchio', settore: 'Stampi', fattN: 0, dip: 0, mat: 'Grezza', matW: '22%', tier: '—', kw: 'stampaggio plastica stampi' },
  { nome: 'Carpenteria Lonigo Industriale', comune: 'Lonigo', settore: 'Carpenteria pesante', fattN: 11.2, dip: 47, mat: 'Target', matW: '90%', tier: 'Tier A', kw: 'strutture acciaio capannoni' },
];

export interface Comune {
  name: string;
  x: number;
  y: number;
  az: number;
}

export const COMUNI: Comune[] = [
  { name: 'Vicenza', x: 220, y: 210, az: 4200 }, { name: 'Schio', x: 200, y: 110, az: 2100 },
  { name: 'Thiene', x: 250, y: 140, az: 1700 }, { name: 'Bassano', x: 320, y: 100, az: 1900 },
  { name: 'Arzignano', x: 130, y: 250, az: 2400 }, { name: 'Valdagno', x: 150, y: 175, az: 1300 },
  { name: 'Montecchio', x: 175, y: 290, az: 1100 }, { name: 'Lonigo', x: 235, y: 320, az: 900 },
  { name: 'Marostica', x: 300, y: 160, az: 700 }, { name: 'Malo', x: 210, y: 165, az: 600 },
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
  { k: 'piva', label: 'P.IVA', cov: 63, toArr: 4320, costN: 0, cost: '€0', prio: 'Alta' },
  { k: 'fatturato', label: 'Fatturato', cov: 31, toArr: 8910, costN: 142, cost: '€142', prio: 'Alta' },
  { k: 'dipendenti', label: 'Dipendenti', cov: 27, toArr: 9420, costN: 118, cost: '€118', prio: 'Alta' },
  { k: 'email', label: 'Email', cov: 51, toArr: 6150, costN: 28, cost: '€0–40', prio: 'Media' },
  { k: 'pec', label: 'PEC', cov: 44, toArr: 7100, costN: 0, cost: '€0', prio: 'Media' },
  { k: 'social', label: 'Social / LinkedIn', cov: 19, toArr: 10200, costN: 96, cost: '€96', prio: 'Media' },
  { k: 'decisore', label: 'Decisore', cov: 8, toArr: 11580, costN: 580, cost: '€580', prio: 'Bassa' },
  { k: 'ateco', label: 'ATECO', cov: 71, toArr: 3100, costN: 0, cost: '€0', prio: 'Bassa' },
];

export interface RaffFilter {
  k: string;
  label: string;
  removed: number;
}

export const RAFF: RaffFilter[] = [
  { k: 'sito', label: 'Senza sito', removed: 4180 },
  { k: 'categoria', label: 'Fuori categoria', removed: 1120 },
  { k: 'fatturato', label: 'Fatturato sotto soglia', removed: 6800 },
  { k: 'dipendenti', label: 'Dipendenti insufficienti', removed: 2060 },
  { k: 'quadrante', label: 'Quadranti non target', removed: 2710 },
];

export const WIZ_CATS = ['Imprese metalmeccaniche', 'Carpenteria', 'Tornerie', 'Meccatronica', 'Fabbri', 'Serramenti', 'Imprese Edili', 'Elettricisti', 'Idraulici', 'Autofficine', 'Software House', 'Web Agency'];
export const WIZ_PROV = ['Vicenza', 'Verona', 'Padova', 'Treviso', 'Venezia', 'Rovigo', 'Belluno', 'Brescia', 'Milano', 'Bergamo'];

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
  { id: 'rapido', nome: 'Rapido', desc: 'Fonti principali, meno query, copertura minore. Più veloce.', dur: 22 },
  { id: 'completo', nome: 'Completo', desc: 'Più varianti e più fonti, maggiore copertura.', dur: 58 },
  { id: 'esteso', nome: 'Esteso', desc: 'Tutte le combinazioni, query correlate, comuni e categorie vicine. Massimo recall.', dur: 100 },
];

export const TOTAL = REGIONS.reduce((s, r) => s + r.az, 0); // 186.940
