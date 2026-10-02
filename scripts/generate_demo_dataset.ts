// Generates examples/demo/companies.jsonl: the synthetic dataset behind `pnpm demo`.
// Fictional B2B SaaS and deeptech companies in the northern Italian tech hubs.
// Deterministic (fixed seed), so the file diffs cleanly when this script changes.
//   pnpm exec tsx scripts/generate_demo_dataset.ts
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../src/util/repo_root';
import { NORD_REGIONS } from '../src/geo/regions';

const TOTAL = 480;
const SEED = 20261002;

interface Sector {
  category: string;
  weight: number;
  /** Revenue per employee (EUR): SaaS scales, deeptech burns head-count first. */
  revPerHead: number;
  /** Median annual revenue (EUR). */
  medianRevenue: number;
  stems: string[];
  notes: string[];
}

const SECTORS: Sector[] = [
  {
    category: 'software B2B SaaS', weight: 24, revPerHead: 120_000, medianRevenue: 1_400_000,
    stems: ['Flow', 'Tessera', 'Kalen', 'Orbis', 'Lumen', 'Brava', 'Zefiro', 'Nodo', 'Pivot', 'Argo', 'Verso', 'Cirrus'],
    notes: ['piattaforma SaaS per HR e payroll', 'gestionale cloud per la logistica', 'CRM verticale per studi professionali', 'SaaS di fatturazione e riconciliazione', 'software di pianificazione della produzione', 'API-first platform per il retail B2B', 'procurement e gestione fornitori in cloud'],
  },
  {
    category: 'intelligenza artificiale', weight: 14, revPerHead: 95_000, medianRevenue: 900_000,
    stems: ['Neura', 'Cogni', 'Sensa', 'Mente', 'Veda', 'Logos', 'Sinapsi', 'Oracolo'],
    notes: ['computer vision per il controllo qualità', 'LLM privati per documenti aziendali', 'modelli predittivi per la manutenzione', 'agenti AI per il customer service', 'MLOps e governance dei modelli', 'NLP per contratti e compliance'],
  },
  {
    category: 'cybersecurity', weight: 9, revPerHead: 140_000, medianRevenue: 2_100_000,
    stems: ['Sentin', 'Aegis', 'Cripto', 'Scudo', 'Vigil', 'Bastion', 'Cerbero'],
    notes: ['detection and response gestita', 'sicurezza OT per impianti industriali', 'identity e accessi privilegiati', 'compliance NIS2 e DORA automatizzata', 'threat intelligence per il settore finanziario'],
  },
  {
    category: 'fintech e insurtech', weight: 10, revPerHead: 150_000, medianRevenue: 2_600_000,
    stems: ['Pay', 'Cassa', 'Credi', 'Polis', 'Fido', 'Scambia', 'Mercato'],
    notes: ['pagamenti B2B e open banking', 'scoring creditizio per PMI', 'infrastruttura di embedded insurance', 'tesoreria e cash management in cloud', 'regtech per antiriciclaggio'],
  },
  {
    category: 'robotica e automazione industriale', weight: 10, revPerHead: 105_000, medianRevenue: 3_200_000,
    stems: ['Robo', 'Mecca', 'Kinema', 'Servo', 'Atlas', 'Cobo', 'Manus'],
    notes: ['robot collaborativi per assemblaggio', 'AMR e logistica di magazzino', 'visione guidata per il picking', 'celle robotiche chiavi in mano', 'gemelli digitali di linea'],
  },
  {
    category: 'fotonica e semiconduttori', weight: 7, revPerHead: 130_000, medianRevenue: 4_800_000,
    stems: ['Foto', 'Lumi', 'Laser', 'Chip', 'Spettra', 'Quarzo', 'Prisma'],
    notes: ['sensori ottici per l’industria', 'laser a fibra per la microlavorazione', 'chip fotonici integrati', 'design di ASIC a basso consumo', 'LiDAR per mobilità e infrastrutture'],
  },
  {
    category: 'biotech e medtech', weight: 12, revPerHead: 85_000, medianRevenue: 1_900_000,
    stems: ['Bio', 'Gene', 'Cura', 'Vita', 'Medi', 'Omica', 'Cellula', 'Sanus'],
    notes: ['diagnostica molecolare', 'dispositivi medici software-as-a-medical-device', 'piattaforma per drug discovery', 'terapie cellulari in fase preclinica', 'imaging medicale con AI'],
  },
  {
    category: 'spacetech e aerospazio', weight: 6, revPerHead: 110_000, medianRevenue: 5_500_000,
    stems: ['Orbita', 'Astra', 'Stellar', 'Cosmo', 'Vettore', 'Zenit'],
    notes: ['dati da osservazione della Terra', 'componenti per piccoli satelliti', 'droni per ispezione di infrastrutture', 'propulsione elettrica per CubeSat', 'servizi di analisi geospaziale'],
  },
  {
    category: 'quantum e deeptech', weight: 8, revPerHead: 60_000, medianRevenue: 700_000,
    stems: ['Qubit', 'Quanta', 'Fononi', 'Entangle', 'Tensor', 'Kelvin', 'Fermi'],
    notes: ['software per calcolo quantistico', 'sensori quantistici', 'crittografia post-quantum', 'materiali avanzati e grafene', 'simulazione fisica ad alte prestazioni'],
  },
];

interface Place {
  province: string;
  region: string;
  weight: number;
  /** Share of companies whose official website the pipeline verifies (varies by hub). */
  site: number;
  phone: string;
  cities: string[];
  /** Category affinity multipliers (1 by default): local research strengths. */
  affinity?: Partial<Record<string, number>>;
}

const PLACES: Place[] = [
  { province: 'MI', region: 'Lombardia', weight: 20, site: 0.94, phone: '02', cities: ['Milano', 'Milano', 'Milano', 'Rho', 'Sesto San Giovanni', 'Assago'], affinity: { 'software B2B SaaS': 1.5, 'fintech e insurtech': 1.8, 'cybersecurity': 1.4 } },
  { province: 'MB', region: 'Lombardia', weight: 3, site: 0.92, phone: '039', cities: ['Monza', 'Vimercate', 'Agrate Brianza'], affinity: { 'fotonica e semiconduttori': 2.5 } },
  { province: 'BG', region: 'Lombardia', weight: 3, site: 0.9, phone: '035', cities: ['Bergamo', 'Dalmine'], affinity: { 'robotica e automazione industriale': 1.8 } },
  { province: 'BS', region: 'Lombardia', weight: 3, site: 0.86, phone: '030', cities: ['Brescia'], affinity: { 'robotica e automazione industriale': 1.6 } },
  { province: 'PV', region: 'Lombardia', weight: 2, site: 0.84, phone: '0382', cities: ['Pavia'], affinity: { 'biotech e medtech': 3 } },
  { province: 'TO', region: 'Piemonte', weight: 11, site: 0.9, phone: '011', cities: ['Torino', 'Torino', 'Moncalieri', 'Collegno'], affinity: { 'spacetech e aerospazio': 3, 'intelligenza artificiale': 1.4, 'robotica e automazione industriale': 1.3 } },
  { province: 'BO', region: 'Emilia-Romagna', weight: 9, site: 0.93, phone: '051', cities: ['Bologna', 'Bologna', 'Casalecchio di Reno'], affinity: { 'intelligenza artificiale': 1.8, 'fintech e insurtech': 1.3, 'robotica e automazione industriale': 1.5 } },
  { province: 'MO', region: 'Emilia-Romagna', weight: 2, site: 0.88, phone: '059', cities: ['Modena'], affinity: { 'robotica e automazione industriale': 2 } },
  { province: 'PR', region: 'Emilia-Romagna', weight: 2, site: 0.85, phone: '0521', cities: ['Parma'], affinity: { 'biotech e medtech': 1.8 } },
  { province: 'TN', region: 'Trentino-Alto Adige', weight: 8, site: 0.96, phone: '0461', cities: ['Trento', 'Trento', 'Rovereto'], affinity: { 'quantum e deeptech': 3, 'fotonica e semiconduttori': 2, 'cybersecurity': 1.8 } },
  { province: 'PD', region: 'Veneto', weight: 8, site: 0.91, phone: '049', cities: ['Padova', 'Padova', 'Padova', 'Padova', 'Vigonza', 'Noventa Padovana', 'Selvazzano Dentro', 'Albignasego', 'Abano Terme', 'Cittadella', 'Camposampiero', 'Este', 'Piove di Sacco', 'Monselice'], affinity: { 'biotech e medtech': 1.8, 'robotica e automazione industriale': 1.6, 'quantum e deeptech': 1.5 } },
  { province: 'TV', region: 'Veneto', weight: 4, site: 0.8, phone: '0422', cities: ['Treviso', 'Roncade', 'Castelfranco Veneto'], affinity: { 'software B2B SaaS': 1.6 } },
  { province: 'VR', region: 'Veneto', weight: 4, site: 0.72, phone: '045', cities: ['Verona'], affinity: { 'software B2B SaaS': 1.3 } },
  { province: 'VE', region: 'Veneto', weight: 3, site: 0.68, phone: '041', cities: ['Venezia', 'Mestre'] },
  { province: 'VI', region: 'Veneto', weight: 3, site: 0.6, phone: '0444', cities: ['Vicenza', 'Schio'], affinity: { 'robotica e automazione industriale': 1.8 } },
  { province: 'GE', region: 'Liguria', weight: 6, site: 0.7, phone: '010', cities: ['Genova'], affinity: { 'robotica e automazione industriale': 3, 'cybersecurity': 1.5 } },
  { province: 'TS', region: 'Friuli-Venezia Giulia', weight: 5, site: 0.78, phone: '040', cities: ['Trieste'], affinity: { 'biotech e medtech': 2, 'fotonica e semiconduttori': 2.2, 'spacetech e aerospazio': 1.8, 'quantum e deeptech': 1.6 } },
  { province: 'UD', region: 'Friuli-Venezia Giulia', weight: 3, site: 0.74, phone: '0432', cities: ['Udine'], affinity: { 'robotica e automazione industriale': 1.4 } },
];

const SUFFIXES = ['ly', 'ia', 'ora', 'ix', 'on', 'ware', 'io', 'ex', 'is', 'ar', 'ova', 'ico'];
const FORMS = [
  { form: 'Srl', w: 62 }, { form: 'S.p.A.', w: 12 }, { form: 'Srl Società Benefit', w: 8 },
  { form: 'Srl', w: 10 }, { form: 'S.r.l.s.', w: 4 }, { form: 'Spa', w: 4 },
];
const STREETS = ['Via Roma', 'Via Garibaldi', 'Corso Vittorio Emanuele', 'Via dell’Innovazione', 'Via della Ricerca', 'Viale Europa', 'Via Mazzini', 'Via dei Mille', 'Via Torino', 'Via Galileo Galilei'];

/** mulberry32: tiny seeded PRNG, enough for a reproducible fixture. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
function weighted<T>(xs: readonly T[], w: (x: T) => number): T {
  const total = xs.reduce((s, x) => s + w(x), 0);
  let r = rnd() * total;
  for (const x of xs) {
    r -= w(x);
    if (r <= 0) return x;
  }
  return xs[xs.length - 1]!;
}
/** Standard normal via Box–Muller. */
function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}

/** Italian VAT number: 999 + 7-digit sequence + check digit (always a valid checksum, never a real company). */
function vat(n: number): string {
  const base = '999' + String(n).padStart(7, '0');
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const d = Number(base[i]);
    if (i % 2 === 0) sum += d;
    else sum += d * 2 > 9 ? d * 2 - 9 : d * 2;
  }
  return base + String((10 - (sum % 10)) % 10);
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const eur = (n: number) => '€ ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const BUCKETS: [number, string][] = [[5, '1-5'], [10, '6-10'], [20, '11-20'], [50, '21-50'], [100, '51-100'], [250, '101-250'], [Infinity, '251-500']];
const bucket = (heads: number) => BUCKETS.find(([max]) => heads <= max)![1];

const usedNames = new Set<string>();
const regionNames = new Set(NORD_REGIONS.map((r) => r.name));

function makeName(sector: Sector): { name: string; slug: string; form: string } {
  for (;;) {
    const word = pick(sector.stems) + pick(SUFFIXES);
    const tail = rnd() < 0.3 ? ' ' + pick(['Labs', 'Systems', 'Tech', 'Analytics', 'Robotics', 'Dynamics']) : '';
    const form = weighted(FORMS, (f) => f.w).form;
    const name = `${word}${tail} ${form}`;
    if (usedNames.has(word + tail)) continue;
    usedNames.add(word + tail);
    return { name, slug: slugify(word + tail), form };
  }
}

const lines: string[] = [];
for (let i = 1; i <= TOTAL; i++) {
  const place = weighted(PLACES, (p) => p.weight);
  if (!regionNames.has(place.region)) throw new Error(`unknown region ${place.region}`);
  const sector = weighted(SECTORS, (s) => s.weight * (place.affinity?.[s.category] ?? 1));
  const { name, slug, form } = makeName(sector);
  const city = pick(place.cities);
  const id = `${slug}${i}`;
  const phone = `${place.phone} ${String(i).padStart(7, '0')}`;
  const found = rnd() < place.site;
  const maps = rnd() < 0.55;
  const row: Record<string, unknown> = {
    company_name: name,
    category: sector.category,
    city,
    business_city: city,
    province: place.province,
    region: place.region,
    address: `${pick(STREETS)} ${1 + Math.floor(rnd() * 140)}`,
    phone,
    source: maps ? 'MAPS' : 'PG',
    sources: maps ? ['MAPS', 'PG'] : ['PG'],
    status: found ? 'FOUND' : 'NOT_FOUND',
    pg_url: `https://www.paginegialle.it/${id}`,
    query_location: city,
    discovery_notes: pick(sector.notes),
  };
  if (found) {
    row.official_website = `https://www.${id}.example`;
    if (rnd() < 0.7) { row.email_inferred = `hello@${id}.example`; row.email_type = 'business'; }
    if (rnd() < 0.15) row.instagram = `https://instagram.com/${id}`;
    row.linkedin = `https://www.linkedin.com/company/${id}`;
  }
  if (rnd() < 0.62) row.pec = `${id}@pec.example`;
  if (rnd() < 0.78) {
    row.vat_code_final = vat(i);
    row.legal_form = form.startsWith('S.p.A') || form === 'Spa' ? 'SPA' : 'SRL';
    row.founding_year = String(2008 + Math.floor(rnd() * 17));
  }
  // Firmographics only on a share of the rows: the "enrich" action fills the rest.
  if (rnd() < 0.66) {
    const revenue = Math.max(60_000, Math.min(48_000_000, sector.medianRevenue * Math.exp(gauss() * 1.05)));
    const heads = Math.max(2, revenue / (sector.revPerHead * (0.6 + rnd() * 0.9)));
    row.revenue = eur(revenue);
    row.revenue_year = '2024';
    row.employees = bucket(heads);
  }
  if (maps && rnd() < 0.4) {
    row.rating = (4 + rnd()).toFixed(1);
    row.reviews_count = String(3 + Math.floor(rnd() * 60));
  }
  lines.push(JSON.stringify(row));
}

const out = path.join(REPO_ROOT, 'examples', 'demo', 'companies.jsonl');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} companies → ${path.relative(REPO_ROOT, out)}`);
