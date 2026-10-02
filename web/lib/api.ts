// Typed client for the pg4 dev API server (the REAL engine, single tenant).
// No mocks: every call hits http://localhost:8787 (NEXT_PUBLIC_API_BASE).

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787';

export interface Company {
  id: string;
  company_name?: string;
  category?: string;
  city?: string;
  province?: string;
  phone?: string;
  official_website?: string;
  email_inferred?: string;
  pec?: string;
  vat_code_final?: string;
  revenue?: string;
  employees?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  source?: string;
  // schema-v4 fields (already in the /api/companies payload; typed for the drawer).
  tiktok?: string;
  youtube?: string;
  rating?: string;
  reviews_count?: string;
  founding_year?: string;
  net_profit?: string;
  net_profit_year?: string;
  share_capital?: string;
  legal_form?: string;
  ateco?: string;
  rea?: string;
  decision_maker_name?: string;
  [k: string]: unknown;
}

export interface Metrics {
  total: number;
  withWebsite: number;
  mapsBand: { display: string; note: string };
  fillRates: Record<string, number>;
  sources: Record<string, number>;
}

export interface ProviderHealth {
  providerDead: Array<{ provider: string; calls: number; dominant_kind: string }>;
  note: string;
}

export interface Coverage {
  provinces: Array<{ province: string; region?: string; total: number; withWebsite: number; band: string }>;
  unassigned: { province: null; total: number; note: string };
  note: string;
}

export interface Markets {
  markets: Array<{ category: string; total: number; withWebsite: number; provinces: Record<string, number> }>;
}

// ---- gap map (industry × area vs universo ISTAT) ----
export interface GapMapCell {
  division: string;
  atecoLabel: string;
  section: string;
  province: string;
  region: string;
  macroArea: string;
  have: number;
  withWebsite: number;
  universeTotal: number | null;
  addressable: number | null;
  coveragePct: number | null; // 0..1 (null se universo ignoto)
  sampleOk: boolean;
  priorityScore: number | null;
  enrichment: { score: number };
}
export interface GapMap {
  meta: { summary: { totalLeads: number; inScope: number; cells: number; usesSampleUniverse: boolean } };
  regionRollup: Array<{
    region: string;
    division: string;
    atecoLabel: string;
    have: number;
    coveragePct: number | null;
    priorityScore: number | null;
    sampleOk: boolean;
  }>;
  cells: GapMapCell[];
  backlog: Array<{ rank: number; action: 'scrape' | 'enrich'; region: string; atecoLabel: string; reason: string; coveragePct: number | null }>;
}

export interface JudgmentSummary {
  total: number;
  judged: number;
  unjudged: number;
  quadrants: Record<string, number>;
  targets: Record<string, number>;
}

// null = not measured (no ledger to read it from), never a stand-in 0.
export interface Health {
  ok: boolean;
  companies: number;
  seed: string;
  tenant: string;
  /** True when the store is empty: the dashboard shows a `pnpm demo` banner. */
  seedEmpty: boolean;
  seedHint?: string;
}

export interface CostView {
  seedRunCostEur: number | null;
  liveSessionCostEur: number | null;
  liveSessionBreakdown?: { enrichEur: number; judgmentEur: number | null; scrapeEur: number };
  ceilingEur: number | null;
  ceilingHit: boolean;
  note: string;
}

// ---- scrape (the wizard's "Mappa il mercato") ----
export interface ScrapeRequest {
  categories: string[];
  provinces: string[];
  /** Wizard source ids: 'pg' always runs; 'maps' adds Google Maps. */
  sources: string[];
  /** 'rapido' = the province capital, one page (about a minute); the others run the whole province. */
  depth?: 'rapido' | 'completo' | 'esteso';
  /** The dashboard scrape runs the free tiers only; true is refused, not ignored. */
  paidEnabled?: boolean;
}
export type ScrapeStatus = 'running' | 'done' | 'partial' | 'error';
export interface ScrapeJob {
  jobId: string;
  kind: 'scrape';
  status: ScrapeStatus;
  maps: boolean;
  added: number;
  costEur: number;
  error?: string;
  runs: Array<{
    category: string;
    province: string;
    comuni?: string;
    status: 'queued' | 'running' | ScrapeStatus;
    added?: number;
    /** Rows written so far by the scrape and enrich stages (live while the run is going). */
    scraped?: number;
    enriched?: number;
    error?: string;
  }>;
}

export type CellStatus = 'queued' | 'running' | 'filled' | 'failed' | 'not_found';
export interface EnrichJob {
  jobId: string;
  status: 'running' | 'done' | 'error';
  fields: string[];
  costEur: number;
  error?: string;
  items: Array<{ companyId: string; cells: Record<string, { status: CellStatus; value?: string; source?: string; confidence?: number }> }>;
}

// ---- judgment layer (L2–L5) ----
export type JudgmentJobKind = 'discovery' | 'collect_signals' | 'judge' | 'validate_export';
export type SectionState = 'queued' | 'running' | 'filled' | 'partial' | 'failed' | 'not_applicable';
export interface JudgmentJob {
  jobId: string;
  kind: JudgmentJobKind;
  status: 'running' | 'done' | 'error';
  totalCostEur: number | null;
  error?: string;
  items: Array<{ companyId: string; sections: Record<string, { state: SectionState; summary?: string; evidenceCount?: number }> }>;
}

// Full verdict detail (the persisted L2–L5 sections) for the judgment view.
export interface AxisEval {
  axis: 'A' | 'B';
  score: number;
  level: 'high' | 'mid' | 'low' | 'unknown';
  rationale?: string;
  signalsPresent?: number;
  signalsConsidered?: number;
  signalsUnknown?: number;
}
export interface GapVerdict {
  businessModel?: string;
  quadrant?: string;
  scoreA?: number;
  scoreB?: number;
  gap?: number;
  gapWidth?: string;
  trajectory?: string;
  cause?: string;
  disqualifiers?: string[];
  target?: 'yes' | 'no' | 'borderline';
  motivation?: string;
  confidence?: number;
}
export interface Lever {
  kind: string;
  rationale?: string;
  description?: string;
}
export interface JudgmentDetail {
  id: string;
  company_name?: string;
  category?: string;
  official_website?: string;
  verdetto_gap: GapVerdict | null;
  valutazione_a: AxisEval | null;
  valutazione_b: AxisEval | null;
  leva: Lever[] | null;
  contesto_categoria: { category?: string; n?: number; provisional?: boolean } | null;
  judgment_meta: Record<string, unknown> | null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // The API explains a refusal in `error` (e.g. a wizard source it cannot run).
    const detail = await r.json().then((j: { error?: unknown }) => (typeof j.error === 'string' ? j.error : ''), () => '');
    throw new Error(detail || `${path} → ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () => get<Health>('/api/health'),
  companies: (limit = 500, offset = 0, hasWebsite = false) =>
    get<{ total: number; rows: Company[] }>(`/api/companies?limit=${limit}&offset=${offset}${hasWebsite ? '&hasWebsite=1' : ''}`),
  metrics: () => get<Metrics>('/api/metrics'),
  coverage: () => get<Coverage>('/api/coverage'),
  markets: () => get<Markets>('/api/markets'),
  gapMap: () => get<GapMap>('/api/gap-map'),
  judgmentSummary: () => get<JudgmentSummary>('/api/judgment-summary'),
  providerHealth: () => get<ProviderHealth>('/api/provider-health'),
  dedupReview: () => get<{ candidates: unknown[] }>('/api/dedup-review'),
  cost: () => get<CostView>('/api/cost'),
  runs: () => get<{ runs: Array<Record<string, unknown>>; source?: string }>('/api/runs'),
  /** Direct download URL for the companies CSV export. */
  companiesCsvUrl: () => `${BASE}/api/companies.csv`,
  enrich: (companyIds: string[], fields: string[]) => post<{ jobId: string; itemCount: number }>('/api/jobs/enrich', { companyIds, fields }),
  job: (id: string) => get<EnrichJob>(`/api/jobs/${id}`),
  scrape: (body: ScrapeRequest) => post<{ jobId: string; kind: 'scrape'; runs: number; maps: boolean }>('/api/jobs/scrape', body),
  scrapeJob: (id: string) => get<ScrapeJob>(`/api/jobs/${id}`),
  // judgment-layer buttons (L2–L5) — each independent, idempotent, cumulative.
  discovery: (companyIds: string[]) => post<{ jobId: string; kind: JudgmentJobKind; itemCount: number }>('/api/jobs/discovery', { companyIds }),
  collectSignals: (companyIds: string[]) => post<{ jobId: string; kind: JudgmentJobKind; itemCount: number }>('/api/jobs/collect-signals', { companyIds }),
  judge: (companyIds: string[]) => post<{ jobId: string; kind: JudgmentJobKind; itemCount: number }>('/api/jobs/judge', { companyIds }),
  validateExport: (companyIds: string[]) => post<{ jobId: string; kind: JudgmentJobKind; itemCount: number }>('/api/jobs/validate-export', { companyIds }),
  judgmentJob: (id: string) => get<JudgmentJob>(`/api/jobs/${id}`),
  judgmentDetail: (id: string) => get<JudgmentDetail>(`/api/judgment?id=${encodeURIComponent(id)}`),
};

export const API_BASE = BASE;
