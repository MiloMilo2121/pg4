// Data layer for the Setaccio dashboard. TanStack Query hooks + adapters that
// map the REAL pg4 API (web/lib/api.ts) into the exact shapes the design views
// expect — so the JSX/markup/styling never changes, only the data source.
//
// Honesty rule (carried from the engine): never fabricate. Fields the real API
// cannot supply are 0 or honestly labelled, never invented.
'use client';

import { useQuery } from '@tanstack/react-query';
import { api, type Company as ApiCompany } from '../../lib/api';
import type { Company as ViewCompany, Comune, Market, Province, Region, EnrichField } from './data';
import { REGIONS, PROVINCES, COMUNI_PD, ENRICH, tierForQuadrant } from './data';
import { EMPTY } from './helpers';

/**
 * Single source of truth: Setaccio enrich-field keys → the engine's free
 * EnrichableField names. Keys absent here (decisore, ateco) have NO free server
 * field — the enrich POST would 422 on them, so the wiring filters them out.
 */
export const ENRICH_KEY_TO_API: Record<string, 'vat' | 'revenue' | 'employees' | 'email' | 'pec' | 'linkedin'> = {
  piva: 'vat', fatturato: 'revenue', dipendenti: 'employees', email: 'email', pec: 'pec', social: 'linkedin',
};

// ---- parsers ----
function parseRevenueMillions(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const digits = String(v).replace(/[^\d]/g, '');
  if (!digits) return 0;
  return Math.round((Number(digits) / 1e6) * 10) / 10;
}
/** "34" → 34; a range like "11-20" → its midpoint. */
function parseEmployees(v: unknown): number {
  const nums = String(v ?? '').match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
const FILL_FIELDS = ['official_website', 'phone', 'email_inferred', 'pec', 'vat_code_final', 'revenue', 'employees'];
function completeness(c: ApiCompany): number {
  const present = FILL_FIELDS.filter((f) => {
    const v = c[f];
    return v !== undefined && v !== null && v !== '';
  }).length;
  return present / FILL_FIELDS.length;
}
function maturita(c: ApiCompany): string {
  const t = (c.verdetto_gap as { target?: unknown } | undefined)?.target;
  if (t === 'yes' || t === true) return 'Target';
  const comp = completeness(c);
  if (comp >= 0.7) return 'Qualificata';
  if (comp >= 0.4) return 'Arricchita';
  if (c.official_website) return 'Arricchita';
  if (comp > 0.15) return 'Grezza';
  return 'Base';
}
/** Tier from the real judgment (same grid as Valutazione), never from data completeness. */
function tier(c: ApiCompany): string {
  return tierForQuadrant((c.verdetto_gap as { quadrant?: string } | undefined)?.quadrant);
}

/** Real Company → the view's Company shape (design-preserving). */
function toViewCompany(c: ApiCompany): ViewCompany {
  return {
    id: c.id,
    nome: c.company_name ?? EMPTY,
    comune: c.city ?? (c.province as string) ?? EMPTY,
    settore: c.category ?? EMPTY,
    fattN: parseRevenueMillions(c.revenue),
    dip: parseEmployees(c.employees),
    mat: maturita(c),
    matW: `${Math.round(completeness(c) * 100)}%`,
    tier: tier(c),
    excluded: (c.verdetto_gap as { target?: unknown } | undefined)?.target === 'no',
    kw: String(c.discovery_notes ?? c.category ?? ''),
  };
}

// ---- hooks ----

/** All companies (real), adapted to the Aziende view shape + the raw rows + ids. */
export function useCompanies() {
  const q = useQuery({ queryKey: ['companies'], queryFn: () => api.companies(2000, 0) });
  const rows = q.data?.rows ?? [];
  return {
    ...q,
    total: q.data?.total ?? 0,
    raw: rows,
    companies: rows.map(toViewCompany),
    ids: rows.map((r) => r.id),
  };
}

export function useMetrics() {
  return useQuery({ queryKey: ['metrics'], queryFn: () => api.metrics() });
}

/** Server health incl. the empty-seed flag that drives the `pnpm demo` banner. */
export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => api.health() });
}
export function useCost() {
  return useQuery({ queryKey: ['cost'], queryFn: () => api.cost(), refetchInterval: 5000 });
}

/** A euro amount the engine measured; EMPTY while loading or when it could not be measured (null). */
export function fmtEur(v: number | null | undefined): string {
  return typeof v === 'number' ? `€ ${v.toFixed(2).replace('.', ',')}` : EMPTY;
}
export function useProviderHealth() {
  return useQuery({ queryKey: ['provider-health'], queryFn: () => api.providerHealth() });
}
export function useRuns() {
  return useQuery({ queryKey: ['runs'], queryFn: () => api.runs() });
}
export function useDedupReview() {
  return useQuery({ queryKey: ['dedup-review'], queryFn: () => api.dedupReview() });
}
export function useJudgmentSummary() {
  return useQuery({ queryKey: ['judgment-summary'], queryFn: () => api.judgmentSummary() });
}

/** Real total companies (Home/Analytics headline). */
export function useTotal(): number {
  const m = useMetrics();
  return m.data?.total ?? 0;
}

/** Real markets → the Mercati view's Market shape. */
export function useMarkets(): Market[] {
  const q = useQuery({ queryKey: ['markets'], queryFn: () => api.markets() });
  return (q.data?.markets ?? []).map((m) => {
    // The engine buckets rows without a province under an em dash key (data, not copy).
    // eslint-disable-next-line no-restricted-syntax
    const provs = Object.entries(m.provinces).filter(([k]) => k !== '\u2014');
    const top = provs.sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      id: m.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24),
      settore: m.category,
      territorio: top ? `Provincia di ${top}` : 'Multi-provincia',
      stato: m.withWebsite > 0 ? 'Parzialmente arricchito' : 'Mappatura pronta',
      aziende: m.total,
      target: m.withWebsite, // qualified proxy: has a verified website (honest, not a judged-target count)
      comuni: provs.length, // distinct provinces (the view labels it as such)
      cov: m.total ? Math.round((100 * m.withWebsite) / m.total) : 0,
      ultimo: EMPTY,
    };
  });
}

/** Gap map industry × area (copertura vs universo ISTAT + backlog). Alimenta la
 *  vista Italia con i "modi mappa" reali (copertura per cella, priorità, backlog). */
export function useGapMap() {
  return useQuery({ queryKey: ['gap-map'], queryFn: () => api.gapMap() });
}

/** Real coverage mapped onto the static Veneto province layout (svg col/row kept,
 *  numbers from real data). Provinces with no real rows keep 0 — surfaced, not hidden. */
export function useProvincesCoverage(): Province[] {
  const q = useQuery({ queryKey: ['coverage'], queryFn: () => api.coverage() });
  const byProv = new Map((q.data?.provinces ?? []).map((p) => [p.province.toUpperCase(), p]));
  // PROVINCES static ids are lowercase 2-letter (vr, vi, tv, ve, bl, pd, ro).
  return PROVINCES.map((p) => {
    const real = byProv.get(p.id.toUpperCase());
    if (!real) return { ...p, az: 0, cov: 0, target: 0 };
    return { ...p, az: real.total, cov: real.total ? Math.round((100 * real.withWebsite) / real.total) : 0, target: real.withWebsite };
  });
}

/** Real province totals, biggest first (every province the data touches, not only the Veneto layout). */
export function useCoverage() {
  return useQuery({ queryKey: ['coverage'], queryFn: () => api.coverage() });
}

/** Region names as the engine writes them → the id of the static map layout. */
const REGION_ID_BY_NAME: Record<string, string> = {
  "Valle d'Aosta": 'vda', Piemonte: 'pie', Lombardia: 'lom', 'Trentino-Alto Adige': 'taa',
  'Friuli-Venezia Giulia': 'fvg', Veneto: 'ven', Liguria: 'lig', 'Emilia-Romagna': 'emr',
  Toscana: 'tos', Umbria: 'umb', Marche: 'mar', Lazio: 'laz', Abruzzo: 'abr', Molise: 'mol',
  Campania: 'cam', Puglia: 'pug', Basilicata: 'bas', Calabria: 'cal', Sicilia: 'sic', Sardegna: 'sar',
};

/** Real coverage rolled up to every region the data touches (the map layout stays static). */
export function useRegionsCoverage(): Region[] {
  const q = useCoverage();
  const { raw } = useCompanies();
  const acc = new Map<string, { az: number; web: number; prov: number; cats: Set<string> }>();
  const slot = (name: string | undefined) => {
    const id = REGION_ID_BY_NAME[name ?? ''];
    if (!id) return undefined;
    const e = acc.get(id) ?? { az: 0, web: 0, prov: 0, cats: new Set<string>() };
    acc.set(id, e);
    return e;
  };
  for (const p of q.data?.provinces ?? []) {
    const e = slot(p.region);
    if (e) { e.az += p.total; e.web += p.withWebsite; e.prov += 1; }
  }
  for (const c of raw) slot(c.region as string | undefined)?.cats.add(String(c.category ?? ''));
  return REGIONS.map((r) => {
    const e = acc.get(r.id);
    return e
      ? { ...r, az: e.az, cov: e.az ? Math.round((100 * e.web) / e.az) : 0, prov: e.prov, mercati: e.cats.size, nuove: 0 }
      : { ...r, az: 0, cov: 0, nuove: 0, prov: 0, mercati: 0, rec: 0 };
  });
}

/** One province's companies broken down by comune, laid out on the static comuni map. */
export function useComuniCoverage(province: string): Comune[] {
  const { raw } = useCompanies();
  const byCity = new Map<string, { az: number; web: number; cats: Map<string, number> }>();
  for (const c of raw) {
    if (String(c.province ?? '').toUpperCase() !== province.toUpperCase()) continue;
    const city = String(c.city ?? '');
    const e = byCity.get(city) ?? { az: 0, web: 0, cats: new Map<string, number>() };
    e.az += 1;
    if (c.official_website) e.web += 1;
    const cat = String(c.category ?? '');
    e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
    byCity.set(city, e);
  }
  return COMUNI_PD.map((l) => {
    const e = byCity.get(l.name);
    const top = e ? [...e.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    return { ...l, az: e?.az ?? 0, withSite: e?.web ?? 0, topCategory: top ?? EMPTY };
  });
}

/** Real fill-rates → the Raffinazione/Analytics EnrichField rows (cov from data,
 *  cost/prio kept from the static config). */
export function useEnrichFields(): EnrichField[] {
  const m = useMetrics();
  const fr = m.data?.fillRates ?? {};
  const total = m.data?.total ?? 0;
  return ENRICH.map((e) => {
    const apiKey = ENRICH_KEY_TO_API[e.k];
    const cov = apiKey && fr[apiKey] !== undefined ? Math.round(fr[apiKey]) : e.cov;
    const toArr = total ? Math.round(((100 - cov) / 100) * total) : e.toArr;
    return { ...e, cov, toArr };
  });
}
