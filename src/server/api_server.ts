import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { stringify } from 'csv-stringify/sync';
import type { Lead } from '../types/lead';
import { ENRICHED_CSV_COLUMNS } from '../types/lead';
import { loadSeed, DEV_TENANT_ID } from './seed';
import type { SeedResult } from './seed';
import { Deduplicator } from '../discovery/deduper';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { BingHtmlProvider } from '../providers/serp/bing_html';
import { suppressionForCommand } from '../compliance/suppression';
import type { SuppressionList } from '../compliance/suppression';
import type { EnrichableField, JudgmentJobKind, SectionStatus } from '../types/api';
import type { JudgmentSection, JudgmentRecord } from '../types/judgment';
import { runJudgment } from '../judgment/run_judgment';
import { getActiveJudgmentConfig } from '../judgment/config';
import { emptyBundle } from '../judgment/harvest/source_harvest';
import type { HarvestContext } from '../judgment/harvest/source_harvest';
import { buildPageFetcher } from '../judgment/harvest/page_fetcher';
import { InMemoryEnrichmentCache } from '../persistence/enrichment_cache';
import { buildCoverageReport } from '../coverage/coverage_engine';
import { buildBacklog } from '../coverage/backlog';
import { isAllowedDashboardOrigin, isAllowedHostHeader, resolveApiHost } from './local_api_access';
import { readJsonBody } from './request_body';
import { evictFinishedJobs } from './job_registry';
import { parseScrapeRequest } from './scrape_request';
import { newScrapeJob, runScrapeJob } from './scrape_job';
import type { CliOutcome, IngestResult, ScrapeJob } from './scrape_job';
import { enrichCompanyFields, FIELD_FILL_TARGETS } from './dashboard_enrich';
import type { EnrichCell } from './dashboard_enrich';
import { onShutdownSignal } from '../runtime/shutdown';
import { pool } from '../runtime/pool';
import { buildTsxCommand } from './tsx_command';
import { REPO_ROOT } from '../util/repo_root';

/**
 * pg4 dev API server — single-tenant, local, zero-cloud. Wraps the REAL engine
 * (no mocks): the in-memory store is seeded from real free-gold output, the
 * enrich-field endpoint runs the real per-field cascade against the real sites
 * via direct_fetch (free), and the metrics/provider-health/dedup come from the
 * real data. The multi-tenant schema + Postgres adapter are untouched; this app
 * just pins one tenant. Run with `pnpm run serve`.
 */

const PORT = Number(process.env.PG4_API_PORT ?? 8787);
const API_HOST = resolveApiHost();
const FETCH = new DirectFetchProvider();
// Free SERP (Bing HTML, €0) wired into the judgment A-collector so Axis A is
// not structurally off in dev: press/awards/patents/historic-marks are actually
// searched. Measured low-yield on free search + degrades to `unknown` on
// failure — the STRONG A sources (registry/Places) stay key-gated by design.
const SERP = new BingHtmlProvider();

// ---- in-memory job registry for the async enrich-field UX (polling) ----
interface EnrichJob {
  id: string;
  fields: EnrichableField[];
  status: 'running' | 'done' | 'error';
  finishedAt?: number;
  costEur: number;
  error?: string;
  items: Map<string, { companyId: string; cells: Record<string, EnrichCell> }>;
}
const jobs = new Map<string, EnrichJob>();
let jobSeq = 0;

/**
 * Cost of the jobs this server has run, by kind. Kept apart from the job
 * registries because those evict finished jobs. `null` means a job of that kind
 * ran with a cost this server cannot know.
 */
const sessionCost: { enrichEur: number; judgmentEur: number | null; scrapeEur: number } = { enrichEur: 0, judgmentEur: 0, scrapeEur: 0 };

// ---- judgment-layer jobs (L2–L5) ----
// Shared cross-button cache so re-running "judge" after "discovery" reuses the
// already-fetched website harvest (cache-first / cost-first: never re-pay for a
// harvest that is already in hand).
const JCACHE = new InMemoryEnrichmentCache();
interface JudgmentJob {
  id: string;
  kind: JudgmentJobKind;
  status: 'running' | 'done' | 'error';
  finishedAt?: number;
  costEur: number | null;
  error?: string;
  items: Map<string, { companyId: string; sections: Partial<Record<JudgmentSection, SectionStatus>> }>;
}
const jJobs = new Map<string, JudgmentJob>();

// Dev judgments are free-first and deterministic (no LLM). With paid harvest
// off, no call a judgment makes can cost money, so its cost is a known 0; with
// it on, this server has no ledger to read the cost from, so it is unknown.
const JUDGMENT_PAID_ENABLED = false;
const JUDGMENT_JOB_COST_EUR: number | null = JUDGMENT_PAID_ENABLED ? null : 0;

/** Which record sections each button writes (independent, cumulative). */
const KIND_SECTIONS: Record<JudgmentJobKind, JudgmentSection[]> = {
  discovery: ['footprint'],
  collect_signals: ['footprint', 'segnali_a', 'segnali_b'],
  judge: ['valutazione_a', 'valutazione_b', 'contesto_categoria', 'verdetto_gap', 'leva'],
  validate_export: ['validazione'],
};

const RECORD_KEY: Record<JudgmentSection, keyof JudgmentRecord | null> = {
  footprint: 'footprint',
  segnali_a: 'segnali_A',
  segnali_b: 'segnali_B',
  valutazione_a: 'valutazione_A',
  valutazione_b: 'valutazione_B',
  contesto_categoria: 'contesto_categoria',
  verdetto_gap: 'verdetto_gap',
  leva: 'leva',
  validazione: 'validazione',
  judgment_meta: 'meta',
};

function sectionSummary(section: JudgmentSection, rec: JudgmentRecord): SectionStatus {
  switch (section) {
    case 'footprint': {
      const ch = rec.footprint?.channels ?? [];
      const present = ch.filter((c) => c.state === 'confirmed_present').length;
      const unknown = ch.filter((c) => c.state === 'unknown_not_found').length;
      return { state: ch.length ? 'filled' : 'partial', summary: `${present} present / ${unknown} unknown / ${ch.length} surfaces`, evidenceCount: present };
    }
    case 'segnali_a':
    case 'segnali_b': {
      const arr = (section === 'segnali_a' ? rec.segnali_A : rec.segnali_B) ?? [];
      const present = arr.filter((s) => s.state === 'confirmed_present').length;
      return { state: arr.length ? 'filled' : 'partial', summary: `${present} present / ${arr.length} signals`, evidenceCount: present };
    }
    case 'verdetto_gap': {
      const v = rec.verdetto_gap;
      return { state: v ? 'filled' : 'failed', summary: v ? `${v.quadrant} A=${v.scoreA.toFixed(2)} B=${v.scoreB.toFixed(2)} gap=${v.gap.toFixed(2)} target=${v.target}` : 'no verdict' };
    }
    case 'valutazione_a':
      return { state: rec.valutazione_A ? 'filled' : 'partial', summary: rec.valutazione_A ? `A=${rec.valutazione_A.score.toFixed(2)} (${rec.valutazione_A.level})` : undefined };
    case 'valutazione_b':
      return { state: rec.valutazione_B ? 'filled' : 'partial', summary: rec.valutazione_B ? `B=${rec.valutazione_B.score.toFixed(2)} (${rec.valutazione_B.level})` : undefined };
    case 'leva':
      return { state: rec.leva ? 'filled' : 'not_applicable', summary: (rec.leva ?? []).map((l) => l.kind).join(' → ') || 'none' };
    case 'validazione':
      return { state: rec.validazione ? 'filled' : 'partial', summary: rec.validazione ? `score=${rec.validazione.validationScore.toFixed(2)} ${rec.validazione.consistent ? 'consistent' : 'INCONSISTENT'}` : undefined };
    case 'contesto_categoria':
      return { state: rec.contesto_categoria ? 'filled' : 'not_applicable' };
    case 'judgment_meta':
      return { state: rec.meta ? 'filled' : 'partial' };
  }
}

function judgmentCtx(): HarvestContext {
  return {
    tenantId: DEV_TENANT_ID,
    cache: JCACHE,
    fetcher: buildPageFetcher(8000),
    // free SERP for the A-collector's third-party searches (press/awards/patents).
    // Failures/blocks degrade to `unknown` (never fabricated absence).
    search: async (query: string) => {
      try {
        return await SERP.search(query, { limit: 8 });
      } catch {
        return [];
      }
    },
    paidEnabled: JUDGMENT_PAID_ENABLED,
    now: () => Date.now(),
  };
}

async function runJudgmentOnCompany(job: JudgmentJob, cid: string, suppression: SuppressionList): Promise<void> {
  const row = seed.db.getById(DEV_TENANT_ID, cid) as Record<string, unknown> | undefined;
  const item = job.items.get(cid)!;
  const sections = KIND_SECTIONS[job.kind];
  for (const s of sections) item.sections[s] = { state: 'running' };
  if (!row) {
    for (const s of sections) item.sections[s] = { state: 'failed', summary: 'company not found' };
    return;
  }
  // Same contract as `pnpm judge` (cli/judge.ts): a lead on the suppression
  // list is never judged — judging would re-contact a do-not-contact subject
  // via website fetch + SERP. Mark every section so the UI shows the skip.
  if (suppression.matches(row as unknown as Lead)) {
    for (const s of sections) item.sections[s] = { state: 'failed', summary: 'suppressed: on the do-not-contact list' };
    return;
  }
  try {
    const lead = { ...row } as unknown as Lead;
    suppression.dropSuppressedEmails(lead);
    const rec = await runJudgment(lead, judgmentCtx(), { config: getActiveJudgmentConfig() }, emptyBundle());
    // persist the kind's sections onto the company row (cumulative, section-replace)
    const patch: Record<string, unknown> = {};
    for (const s of sections) {
      const k = RECORD_KEY[s];
      if (k) patch[s] = rec[k];
      item.sections[s] = sectionSummary(s, rec);
    }
    patch['judgment_meta'] = rec.meta;
    seed.db.patchCompany(DEV_TENANT_ID, cid, patch);
  } catch (err) {
    for (const s of sections) item.sections[s] = { state: 'failed', summary: (err as Error).message.slice(0, 80) };
  }
}

async function runJudgmentJob(job: JudgmentJob, companyIds: string[], suppression: SuppressionList): Promise<void> {
  const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ENRICH_JOB_TIMEOUT_MS).unref?.());
  const work = pool(companyIds, ENRICH_CONCURRENCY, (cid) => runJudgmentOnCompany(job, cid, suppression));
  try {
    const r = await Promise.race([work.then(() => 'done' as const), deadline]);
    job.status = r === 'timeout' ? 'error' : 'done';
    if (r === 'timeout') job.error = `job exceeded ${ENRICH_JOB_TIMEOUT_MS / 1000}s`;
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
  }
  job.finishedAt = Date.now();
}

const JUDGMENT_ROUTES: Record<string, JudgmentJobKind> = {
  '/api/jobs/discovery': 'discovery',
  '/api/jobs/collect-signals': 'collect_signals',
  '/api/jobs/judge': 'judge',
  '/api/jobs/validate-export': 'validate_export',
};

// F0 — footgun guards: bound concurrency + cap total job duration so a large
// selection can't serialise hundreds of 8s fetches into a 67-min event-loop
// stall, and a stuck host can't orphan a job forever.
const ENRICH_CONCURRENCY = 5;
const ENRICH_JOB_TIMEOUT_MS = 180_000;
export const ENRICH_MAX_SELECTION = 200; // the API rejects larger selections


let seed: SeedResult;
let boundPort = PORT;

/** Shown by the dashboard when the store is empty (Fase 5.5): a silent empty
 *  dashboard used to look like a bug; now it points at `pnpm demo`. */
export const SEED_EMPTY_HINT = 'Run pnpm demo to load the demo dataset';

// ---------------------------------------------------------------------------
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!origin) return true; // CLI/curl clients are local too; CORS is browser-only.
  if (!isAllowedDashboardOrigin(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('vary', 'Origin');
  return true;
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(payload);
}

function roundEur(eur: number | null): number | null {
  return eur === null ? null : Math.round(eur * 1e4) / 1e4;
}

/** Reads the JSON body, or answers the 400/413 itself and returns undefined. */
async function readBodyOrReject(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
  const body = await readJsonBody(req);
  if (body.ok) return body.value;
  // An oversized body is left unread; closing the connection discards it.
  json(res, body.status, { error: body.error }, body.status === 413 ? { connection: 'close' } : {});
  return undefined;
}

// ---- intelligence computed from the REAL seeded data ----
function companies(): Array<{ id: string; row: Record<string, unknown> }> {
  return seed.db.entries(DEV_TENANT_ID).map((e) => ({ id: e.id, row: e.row as Record<string, unknown> }));
}

function fillRate(rows: Array<Record<string, unknown>>, field: string): number {
  if (rows.length === 0) return 0;
  const n = rows.filter((r) => r[field] !== undefined && r[field] !== null && r[field] !== '').length;
  return Math.round((1000 * n) / rows.length) / 10;
}

function computeMetrics() {
  const rows = companies().map((c) => c.row);
  const withWebsite = rows.filter((r) => r.official_website).length;
  const sources: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.source ?? 'UNKNOWN');
    sources[s] = (sources[s] ?? 0) + 1;
  }
  return {
    total: rows.length,
    withWebsite,
    // Maps non-determinism honesty: a Maps-heavy count is a point estimate of a
    // wide band (measured 6× swing), so we expose it as "≥ N", not a fact.
    mapsBand: { display: `≥ ${rows.length}`, note: 'Maps counts swing run-to-run (measured 6×); treat as a lower bound.' },
    fillRates: {
      official_website: fillRate(rows, 'official_website'),
      phone: fillRate(rows, 'phone'),
      email: fillRate(rows, 'email_inferred'),
      pec: fillRate(rows, 'pec'),
      vat: fillRate(rows, 'vat_code_final'),
      revenue: fillRate(rows, 'revenue'),
      employees: fillRate(rows, 'employees'),
      instagram: fillRate(rows, 'instagram'),
      facebook: fillRate(rows, 'facebook'),
      linkedin: fillRate(rows, 'linkedin'),
    },
    sources,
  };
}

function computeDedupReview() {
  const dd = new Deduplicator();
  for (const c of companies()) dd.add(c.row as unknown as Lead);
  return dd.getReviewCandidates().slice(0, 50);
}

// ---- derived read-only views (pure aggregations over the seeded data) ----

/** Coverage by province (+region), with the Maps "≥ N" band and an explicit
 *  null-province bucket — rows without a resolved province are surfaced, never
 *  silently dropped (the honesty rule). Feeds the Italia + Analytics views. */
function computeCoverage() {
  const rows = companies().map((c) => c.row);
  const byProv = new Map<string, { province: string; region?: string; total: number; withWebsite: number }>();
  let unassigned = 0;
  for (const r of rows) {
    const prov = String(r.province ?? '').trim();
    if (!prov) { unassigned += 1; continue; }
    const e = byProv.get(prov) ?? { province: prov, region: (r.region as string) || undefined, total: 0, withWebsite: 0 };
    e.total += 1;
    if (r.official_website) e.withWebsite += 1;
    byProv.set(prov, e);
  }
  const provinces = [...byProv.values()]
    .sort((a, b) => b.total - a.total)
    .map((p) => ({ ...p, band: `≥ ${p.total}` }));
  return {
    provinces,
    unassigned: { province: null as null, total: unassigned, note: 'rows without a resolved province — surfaced, not dropped' },
    note: 'Maps counts swing run-to-run (measured 6×); each province total is a LOWER bound (≥ N).',
  };
}

/** Markets = (category × province) breakdown. Feeds the Mercati + Home views. */
function computeMarkets() {
  const rows = companies().map((c) => c.row);
  const byCat = new Map<string, { category: string; total: number; withWebsite: number; provinces: Record<string, number> }>();
  for (const r of rows) {
    const cat = String(r.category ?? 'sconosciuto').trim() || 'sconosciuto';
    const prov = String(r.province ?? '—').trim() || '—';
    const e = byCat.get(cat) ?? { category: cat, total: 0, withWebsite: 0, provinces: {} };
    e.total += 1;
    if (r.official_website) e.withWebsite += 1;
    e.provinces[prov] = (e.provinces[prov] ?? 0) + 1;
    byCat.set(cat, e);
  }
  return { markets: [...byCat.values()].sort((a, b) => b.total - a.total) };
}

/** Gap map = copertura industry x area (Nord Italia): have/universo/coverage%/
 *  sufficienza-campione/enrichment + backlog prioritizzato (scrape vs enrich).
 *  Riusa il motore di coverage sui dati seeded reali. Feeds la vista Coverage. */
function computeGapMap() {
  const leads = companies().map((c) => c.row as unknown as Lead);
  const report = buildCoverageReport(leads);
  const backlog = buildBacklog(report);
  return { meta: { generated: report.generated, summary: report.summary }, buckets: report.buckets, regionRollup: report.regionRollup, cells: report.cells, backlog };
}

/** Judgment roll-up: quadrant histogram + target tally + judged/unjudged counts.
 *  Feeds the Valutazione (matrice/coda) + Analytics/giudizio views. */
function computeJudgmentSummary() {
  const rows = companies().map((c) => c.row);
  const judged = rows.filter((r) => r.verdetto_gap);
  const quadrants: Record<string, number> = {};
  const targets: Record<string, number> = {};
  for (const r of judged) {
    const v = r.verdetto_gap as { quadrant?: string; target?: unknown };
    if (v.quadrant) quadrants[v.quadrant] = (quadrants[v.quadrant] ?? 0) + 1;
    const t = typeof v.target === 'string' ? v.target : (v.target as { verdict?: string })?.verdict;
    if (t) targets[t] = (targets[t] ?? 0) + 1;
  }
  return { total: rows.length, judged: judged.length, unjudged: rows.length - judged.length, quadrants, targets };
}

/** All companies as an enriched-schema CSV string (the Liste/Aziende export). */
function companiesCsv(): string {
  const rows = companies().map((c) => c.row);
  const records = rows.map((r) =>
    ENRICHED_CSV_COLUMNS.map((col) => {
      const v = (r as Record<string, unknown>)[col];
      if (v === undefined || v === null) return '';
      return Array.isArray(v) ? v.join('|') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }),
  );
  return stringify([[...ENRICHED_CSV_COLUMNS], ...records]);
}

/** Ingest a run's JSONL into the in-memory db (upsert by dedup key). Lets a
 *  fresh scrape appear in the dashboard without a server restart. */
async function ingestJsonlIntoDb(absPath: string): Promise<IngestResult> {
  if (!fs.existsSync(absPath)) return { rows: 0, added: 0 };
  const raw = fs.readFileSync(absPath, 'utf8');
  let rows = 0;
  let added = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const lead = JSON.parse(t) as Lead;
      const { merged } = await seed.db.upsertCompany(DEV_TENANT_ID, lead);
      rows += 1;
      if (!merged) added += 1;
    } catch {
      /* skip un-dedupable / malformed rows — never abort the ingest */
    }
  }
  return { rows, added };
}

/** Real run history, file-backed from output/_runs.jsonl (falls back to the seed run). */
function readRunsFromFile(): Array<Record<string, unknown>> {
  const abs = path.join(REPO_ROOT, 'output', '_runs.jsonl');
  if (!fs.existsSync(abs)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return out.slice(-50).reverse();
}

// ---- the live enrich-field job (free-gold body + official-data steps) ----
async function fetchHtml(url: string): Promise<string | undefined> {
  try {
    return (await FETCH.fetch(url, { timeoutMs: 8000 })).html;
  } catch {
    return undefined; // host down/slow → fields fall through to not_found/registry
  }
}

function enrichOneCompany(job: EnrichJob, cid: string, suppression: SuppressionList): Promise<void> {
  const row = seed.db.getById(DEV_TENANT_ID, cid) as Record<string, unknown> | undefined;
  const item = job.items.get(cid)!;
  return enrichCompanyFields(row, job.fields, {
    fetchHtml,
    suppression,
    setCell: (f, cell) => (item.cells[f] = cell),
    patch: (fields) => seed.db.patchCompany(DEV_TENANT_ID, cid, fields),
    addCost: (eur) => {
      job.costEur += eur;
      sessionCost.enrichEur += eur;
    },
  });
}

async function runEnrichJob(job: EnrichJob, companyIds: string[], suppression: SuppressionList): Promise<void> {
  const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ENRICH_JOB_TIMEOUT_MS).unref?.());
  const work = pool(companyIds, ENRICH_CONCURRENCY, (cid) => enrichOneCompany(job, cid, suppression));
  try {
    const r = await Promise.race([work.then(() => 'done' as const), deadline]);
    if (r === 'timeout') {
      job.status = 'error';
      job.error = `job exceeded ${ENRICH_JOB_TIMEOUT_MS / 1000}s — partial results kept`;
      // mark any still-running cells as failed so the UI never hangs
      for (const it of job.items.values())
        for (const [f, st] of Object.entries(it.cells)) if (st.status === 'running' || st.status === 'queued') it.cells[f] = { status: 'failed' };
    } else {
      job.status = 'done';
    }
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
  }
  job.finishedAt = Date.now();
}

// ---- real scrape jobs: shell out to the validated CLI, ingest as each run ends ----
const scrapeJobs = new Map<string, ScrapeJob>();
/** Live scrape child processes — killed on shutdown so no orphan keeps scraping. */
const scrapeChildren = new Set<ChildProcess>();
let shuttingDown = false;

/**
 * Runs the validated scrape→enrich `run` CLI (argv array, no shell). Output is
 * not buffered: the run logs to its own file, and a 12-hour run can print more
 * than any maxBuffer, which would kill it early. Only the stderr tail is kept
 * for the error message.
 */
function spawnRunCli(args: string[], timeoutMs: number): Promise<CliOutcome> {
  return new Promise((resolve) => {
    // Local tsx, never `npx tsx` (Fase 5.2): `args` keeps the legacy
    // `['tsx', script, …]` shape at the seam; buildTsxCommand strips it.
    const cmd = buildTsxCommand(REPO_ROOT, args);
    const child = spawn(cmd.file, cmd.args, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    scrapeChildren.add(child);
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => (stderrTail = (stderrTail + chunk).slice(-2000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref();
    let settled = false;
    const settle = (outcome: CliOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scrapeChildren.delete(child);
      resolve(outcome);
    };
    child.once('error', (err) => settle({ ok: false, timedOut: false, message: err.message.slice(0, 200) }));
    child.once('close', (code, signal) => {
      if (code === 0) return settle({ ok: true });
      const lastLine = stderrTail.trim().split('\n').pop() ?? '';
      settle({ ok: false, timedOut, message: `exit ${code ?? signal}${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}` });
    });
  });
}

/** How often a running scrape's output is ingested, so the dashboard counts grow while it runs. */
const LIVE_INGEST_MS = 2000;

async function runDashboardScrape(job: ScrapeJob): Promise<void> {
  await runScrapeJob(job, {
    runCli: spawnRunCli,
    ingest: ingestJsonlIntoDb,
    isStopping: () => shuttingDown,
    now: () => Date.now(),
    liveIngestMs: LIVE_INGEST_MS,
  });
  sessionCost.scrapeEur += job.costEur;
}

function scrapeJobView(job: ScrapeJob) {
  return {
    jobId: job.id,
    kind: 'scrape',
    status: job.status,
    maps: job.maps,
    added: job.added,
    costEur: job.costEur,
    error: job.error,
    runs: job.runs.map(({ category, province, comuni, status, added, scraped, enriched, error }) => ({
      category,
      province,
      comuni,
      status,
      added,
      scraped,
      enriched,
      error,
    })),
  };
}

// ---------------------------------------------------------------------------
function jobView(job: EnrichJob) {
  return {
    jobId: job.id,
    status: job.status,
    fields: job.fields,
    costEur: job.costEur,
    error: job.error,
    items: [...job.items.values()],
  };
}

function jJobView(job: JudgmentJob) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    totalCostEur: job.costEur,
    error: job.error,
    items: [...job.items.values()],
  };
}

/** Runs before each new job is registered, so the registries stay bounded. */
function evictFinishedJobsEverywhere(): void {
  const now = Date.now();
  evictFinishedJobs(jobs, now);
  evictFinishedJobs(jJobs, now);
  evictFinishedJobs(scrapeJobs, now);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isAllowedHostHeader(req.headers.host, boundPort)) return json(res, 403, { error: 'host not allowed' });
  const url = new URL(req.url ?? '/', `http://localhost:${boundPort}`);
  const p = url.pathname;
  if (!applyCors(req, res)) return json(res, 403, { error: 'origin not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (p === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    const seedEmpty = companies().length === 0;
    return json(res, 200, {
      ok: true,
      tenant: DEV_TENANT_ID,
      companies: companies().length,
      seed: seed.sourceFile,
      seedEmpty,
      ...(seedEmpty ? { seedHint: SEED_EMPTY_HINT } : {}),
    });
  }

  if (p === '/api/companies' && req.method === 'GET') {
    const limit = Math.min(2000, Number(url.searchParams.get('limit') ?? 200));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const onlyWebsite = url.searchParams.get('hasWebsite') === '1';
    let rows = companies().map((c) => ({ id: c.id, ...c.row }));
    if (onlyWebsite) rows = rows.filter((r) => (r as Record<string, unknown>).official_website);
    return json(res, 200, { total: rows.length, rows: rows.slice(offset, offset + limit) });
  }

  // Full judgment detail for ONE company (the persisted L2–L5 sections), so the
  // dashboard can SHOW the verdict, not just a target/quadrant badge. Read-only.
  if (p === '/api/judgment' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    const row = (seed.db.getById(DEV_TENANT_ID, id) ?? undefined) as Record<string, unknown> | undefined;
    if (!row) return json(res, 404, { error: 'company not found' });
    return json(res, 200, {
      id,
      company_name: row.company_name,
      category: row.category,
      official_website: row.official_website,
      verdetto_gap: row.verdetto_gap ?? null,
      valutazione_a: row.valutazione_a ?? null,
      valutazione_b: row.valutazione_b ?? null,
      leva: row.leva ?? null,
      contesto_categoria: row.contesto_categoria ?? null,
      judgment_meta: row.judgment_meta ?? null,
    });
  }

  if (p === '/api/metrics' && req.method === 'GET') return json(res, 200, computeMetrics());

  // ---- derived read-only views (feed the Italia / Mercati / Valutazione / Liste UI) ----
  if (p === '/api/coverage' && req.method === 'GET') return json(res, 200, computeCoverage());
  if (p === '/api/markets' && req.method === 'GET') return json(res, 200, computeMarkets());
  if (p === '/api/gap-map' && req.method === 'GET') return json(res, 200, computeGapMap());
  if (p === '/api/judgment-summary' && req.method === 'GET') return json(res, 200, computeJudgmentSummary());
  if (p === '/api/companies.csv' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="companies.csv"',
    });
    res.end(companiesCsv());
    return;
  }

  if (p === '/api/provider-health' && req.method === 'GET') {
    return json(res, 200, {
      providerDead: seed.providerDead,
      note: seed.providerDead.length
        ? 'A provider made calls this run but never succeeded — surfaced, not hidden (the dns_mx/crtsh class).'
        : 'All providers healthy in the seed run.',
    });
  }

  if (p === '/api/dedup-review' && req.method === 'GET') {
    return json(res, 200, { candidates: computeDedupReview() });
  }

  if (p === '/api/cost' && req.method === 'GET') {
    const { enrichEur, judgmentEur, scrapeEur } = sessionCost;
    const live = judgmentEur === null ? null : enrichEur + judgmentEur + scrapeEur;
    return json(res, 200, {
      // null = not measured (no ledger), never a stand-in 0.
      seedRunCostEur: roundEur(seed.ledgerTotalEur),
      liveSessionCostEur: roundEur(live),
      liveSessionBreakdown: { enrichEur: roundEur(enrichEur), judgmentEur: roundEur(judgmentEur), scrapeEur: roundEur(scrapeEur) },
      ceilingEur: null,
      ceilingHit: false,
      note:
        'Free tiers only this pass — paid waterfalls disabled behind their tested ceiling.' +
        (seed.ledgerTotalEur === null ? ' The seed has no cost ledger next to it, so its run cost is unknown.' : ''),
    });
  }

  if (p === '/api/jobs/enrich' && req.method === 'POST') {
    const body = (await readBodyOrReject(req, res)) as { companyIds?: string[]; fields?: string[] } | undefined;
    if (!body) return;
    const ids = Array.isArray(body.companyIds) ? body.companyIds : [];
    const fields = (Array.isArray(body.fields) ? body.fields : []).filter((f) => f in FIELD_FILL_TARGETS) as EnrichableField[];
    if (!ids.length || !fields.length) return json(res, 422, { error: 'companyIds and fields are required' });
    if (ids.length > ENRICH_MAX_SELECTION)
      return json(res, 422, { error: `selection too large (${ids.length}); max ${ENRICH_MAX_SELECTION} per enrich job` });
    // Same resolution as the CLI (SUPPRESSION_LIST, else output/suppression.csv),
    // re-read per job so an edit applies without a restart. An explicit list
    // that cannot be read fails the request: running without it is not safe.
    let suppression: SuppressionList;
    try {
      suppression = suppressionForCommand({}, path.join(REPO_ROOT, 'output', 'dashboard.csv'));
    } catch (err) {
      return json(res, 500, { error: `suppression list unreadable: ${(err as Error).message}` });
    }
    const job: EnrichJob = {
      id: `job_${++jobSeq}`,
      fields,
      status: 'running',
      costEur: 0,
      items: new Map(ids.map((cid) => [cid, { companyId: cid, cells: Object.fromEntries(fields.map((f) => [f, { status: 'queued' as const }])) }])),
    };
    evictFinishedJobsEverywhere();
    jobs.set(job.id, job);
    // fire-and-forget; the UI polls /api/jobs/:id
    void runEnrichJob(job, ids, suppression);
    return json(res, 202, { jobId: job.id, itemCount: ids.length });
  }

  // ---- judgment-layer buttons (L2–L5): discovery / collect-signals / judge / validate-export ----
  const jKind = JUDGMENT_ROUTES[p];
  if (jKind && req.method === 'POST') {
    const body = (await readBodyOrReject(req, res)) as { companyIds?: string[] } | undefined;
    if (!body) return;
    const ids = Array.isArray(body.companyIds) ? body.companyIds : [];
    if (!ids.length) return json(res, 422, { error: 'companyIds is required' });
    if (ids.length > ENRICH_MAX_SELECTION) return json(res, 422, { error: `selection too large (${ids.length}); max ${ENRICH_MAX_SELECTION}` });
    // Same suppression resolution as the enrich button and the CLI: re-read
    // per job so an edit applies without a restart. An explicit list that
    // cannot be read fails the request — running without it is not safe.
    let suppression: SuppressionList;
    try {
      suppression = suppressionForCommand({}, path.join(REPO_ROOT, 'output', 'dashboard.csv'));
    } catch (err) {
      return json(res, 500, { error: `suppression list unreadable: ${(err as Error).message}` });
    }
    const job: JudgmentJob = {
      id: `jjob_${++jobSeq}`,
      kind: jKind,
      status: 'running',
      costEur: JUDGMENT_JOB_COST_EUR,
      items: new Map(
        ids.map((cid) => [
          cid,
          { companyId: cid, sections: Object.fromEntries(KIND_SECTIONS[jKind].map((s) => [s, { state: 'queued' as const }])) as Partial<Record<JudgmentSection, SectionStatus>> },
        ]),
      ),
    };
    evictFinishedJobsEverywhere();
    jJobs.set(job.id, job);
    sessionCost.judgmentEur = job.costEur === null || sessionCost.judgmentEur === null ? null : sessionCost.judgmentEur + job.costEur;
    void runJudgmentJob(job, ids, suppression);
    return json(res, 202, { jobId: job.id, kind: jKind, itemCount: ids.length });
  }

  // scrape jobs must POST before this GET matcher; check all three job maps.
  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    const sj = scrapeJobs.get(jobMatch[1]);
    if (sj) return json(res, 200, scrapeJobView(sj));
    const jj = jJobs.get(jobMatch[1]);
    if (jj) return json(res, 200, jJobView(jj));
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    return json(res, 200, jobView(job));
  }

  if (p === '/api/jobs/scrape' && req.method === 'POST') {
    const body = await readBodyOrReject(req, res);
    if (!body) return;
    const request = parseScrapeRequest(body);
    if (!request.ok) return json(res, request.status, { error: request.error });
    const job = newScrapeJob(`sjob_${++jobSeq}`, path.join(REPO_ROOT, 'output', `dash_${Date.now()}`), request.value);
    evictFinishedJobsEverywhere();
    scrapeJobs.set(job.id, job);
    // Real background runs via the validated scrape→enrich CLI (free tiers); the
    // dashboard polls /api/jobs/:id, and each run's rows are ingested as it ends
    // so they appear without a server restart. Live + best-effort (browser/network).
    void runDashboardScrape(job);
    return json(res, 202, { jobId: job.id, kind: 'scrape', runs: job.runs.length, maps: job.maps });
  }

  if (p === '/api/runs' && req.method === 'GET') {
    const fileRuns = readRunsFromFile();
    if (fileRuns.length > 0) return json(res, 200, { runs: fileRuns, source: 'output/_runs.jsonl' });
    // fallback: the seed run (no _runs.jsonl yet)
    return json(res, 200, {
      source: 'seed',
      runs: [
        {
          run_id: 'seed-r12',
          command: 'enrich',
          status: 'ok',
          leads_out: companies().length,
          with_website: companies().filter((c) => (c.row as Record<string, unknown>).official_website).length,
          total_cost_eur: roundEur(seed.ledgerTotalEur),
          provider_dead: seed.providerDead.map((d) => d.provider),
        },
      ],
    });
  }

  return json(res, 404, { error: 'not found', path: p });
}

/** Auto-load the accumulated campaign dataset so the dashboard is never empty.
 *  Runs only when no explicit PG4_SEED_FILE was given AND the default seed was
 *  absent (seed.loaded === 0). Ingests every raw JSONL from the campaign output
 *  dirs; upsertCompany collapses the baseline/recall overlap on the dedup key. */
async function autoLoadCampaignData(): Promise<number> {
  let added = 0;
  for (const d of ['output/recall', 'output/veneto']) {
    const abs = path.join(REPO_ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('_raw.jsonl')) added += (await ingestJsonlIntoDb(path.join(abs, f))).added;
    }
  }
  return added;
}

/** Loads the seed and listens; resolves once bound. Exported so tests can run
 *  the real handler on an ephemeral port (port 0). */
export async function startApiServer(opts: { port: number; host: string; seedFile?: string }): Promise<http.Server> {
  process.stderr.write('[api] loading seed dataset…\n');
  seed = await loadSeed(REPO_ROOT, opts.seedFile);
  process.stderr.write(`[api] seeded ${seed.loaded} companies (${seed.rejected} rejected) from ${seed.sourceFile}\n`);
  if (!opts.seedFile && seed.loaded === 0) {
    const auto = await autoLoadCampaignData();
    if (auto > 0) process.stderr.write(`[api] auto-loaded ${auto} companies from campaign output (recall+veneto)\n`);
  }
  if (seed.providerDead.length) {
    process.stderr.write(`[api] provider-health: ${seed.providerDead.map((d) => `${d.provider}(${d.calls},${d.dominant_kind})`).join(', ')}\n`);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => json(res, 500, { error: (err as Error).message }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The Host check compares against the port actually bound (port 0 in tests).
  boundPort = (server.address() as AddressInfo).port;
  return server;
}

async function main(): Promise<void> {
  const server = await startApiServer({ port: PORT, host: API_HOST, seedFile: process.env.PG4_SEED_FILE });
  process.stderr.write(`[api] pg4 dev API on http://${API_HOST}:${boundPort} (tenant ${DEV_TENANT_ID})\n`);
  onShutdownSignal('api', async () => {
    shuttingDown = true;
    for (const child of scrapeChildren) child.kill('SIGTERM');
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
}

// Importing the module (tests) must not bind the real port.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[api] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
