// Data layer for the Setaccio dashboard. TanStack Query hooks + adapters that
// map the REAL pg4 API (web/lib/api.ts) into the exact shapes the design views
// expect — so the JSX/markup/styling never changes, only the data source.
//
// Honesty rule (carried from the engine): never fabricate. Fields the real API
// cannot supply are 0 or honestly labelled, never invented.
'use client';

import { useQuery } from '@tanstack/react-query';
import { api, type Company as ApiCompany } from '../../lib/api';
import type { Company as ViewCompany, Market, Province, Region, EnrichField } from './data';
import { REGIONS, PROVINCES, ENRICH } from './data';

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
function parseEmployees(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
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
function tier(c: ApiCompany): string {
  const comp = completeness(c);
  if (comp >= 0.7) return 'Tier A';
  if (comp >= 0.45) return 'Tier B';
  if (comp >= 0.25) return 'Tier C';
  return '—';
}

/** Real Company → the view's Company shape (design-preserving). */
function toViewCompany(c: ApiCompany): ViewCompany {
  return {
    id: c.id,
    nome: c.company_name ?? '—',
    comune: c.city ?? (c.province as string) ?? '—',
    settore: c.category ?? '—',
    fattN: parseRevenueMillions(c.revenue),
    dip: parseEmployees(c.employees),
    mat: maturita(c),
    matW: `${Math.round(completeness(c) * 100)}%`,
    tier: tier(c),
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
export function useCost() {
  return useQuery({ queryKey: ['cost'], queryFn: () => api.cost(), refetchInterval: 5000 });
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
  const accents = ['var(--accent)', 'var(--accent-2)', 'var(--ink-3)'];
  return (q.data?.markets ?? []).map((m, i) => {
    const provs = Object.entries(m.provinces).filter(([k]) => k !== '—');
    const top = provs.sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      id: m.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24),
      settore: m.category,
      territorio: top ? `Provincia di ${top}` : 'Multi-provincia',
      stato: m.withWebsite > 0 ? 'Parzialmente arricchito' : 'Mappatura pronta',
      aziende: m.total,
      target: m.withWebsite, // qualified proxy: has a verified website (honest, not a judged-target count)
      comuni: provs.length,
      cov: m.total ? Math.round((100 * m.withWebsite) / m.total) : 0,
      ultimo: '—',
      dot: accents[i % accents.length],
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

/** Real coverage rolled up to regions (only Veneto has data in this seed). */
export function useRegionsCoverage(): Region[] {
  const provinces = useProvincesCoverage();
  const venTotal = provinces.reduce((s, p) => s + p.az, 0);
  const venWeighted = provinces.reduce((s, p) => s + p.cov * p.az, 0);
  const venCov = venTotal ? Math.round(venWeighted / venTotal) : 0;
  return REGIONS.map((r) =>
    r.id === 'ven'
      ? { ...r, az: venTotal, cov: venCov, prov: provinces.filter((p) => p.az > 0).length }
      : { ...r, az: 0, cov: 0, nuove: 0, prov: 0, mercati: 0 },
  );
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
