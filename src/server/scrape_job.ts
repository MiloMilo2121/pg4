import fs from 'fs';
import { CLI_RUN_TIMEOUT_MS } from './cli_timeout';
import type { ScrapeRequest } from './scrape_request';

/**
 * The dashboard's "Mappa il mercato" job: one `run` CLI invocation per
 * (category, province), one at a time so two browsers never compete for the
 * same machine. A run that dies (timeout, crash, shutdown) keeps what it wrote:
 * each output file is appended row by row, so the partial JSONL is real data.
 */

type ScrapeRunStatus = 'queued' | 'running' | 'done' | 'partial' | 'error';

interface ScrapeRun {
  category: string;
  province: string;
  /** Set by the `rapido` depth: one location instead of the whole province. */
  comuni?: string;
  maxPages?: number;
  outBase: string;
  status: ScrapeRunStatus;
  added?: number;
  /** Rows the run has written so far, per stage (live while it runs). */
  scraped?: number;
  enriched?: number;
  costEur?: number;
  error?: string;
}

export interface ScrapeJob {
  id: string;
  maps: boolean;
  status: 'running' | 'done' | 'partial' | 'error';
  finishedAt?: number;
  /** Companies new to the in-memory store (merges into existing rows are not counted). */
  added: number;
  costEur: number;
  error?: string;
  runs: ScrapeRun[];
}

export interface IngestResult {
  rows: number;
  added: number;
}

export type CliOutcome = { ok: true } | { ok: false; timedOut: boolean; message: string };

export interface ScrapeJobDeps {
  runCli: (args: string[], timeoutMs: number) => Promise<CliOutcome>;
  /** Upserts a JSONL file into the store: rows read, and how many were new companies. */
  ingest: (absPath: string) => Promise<IngestResult>;
  isStopping: () => boolean;
  now: () => number;
  /**
   * When set, the run's output files are ingested every `liveIngestMs` while
   * the CLI is still running, so the dashboard's counts grow row by row
   * instead of jumping at the end.
   */
  liveIngestMs?: number;
}

export function newScrapeJob(id: string, outBase: string, req: ScrapeRequest): ScrapeJob {
  return {
    id,
    maps: req.maps,
    status: 'running',
    added: 0,
    costEur: 0,
    runs: req.targets.map((t, i) => ({ ...t, outBase: `${outBase}_${i + 1}`, status: 'queued' })),
  };
}

function runArgs(run: ScrapeRun, maps: boolean): string[] {
  const where = run.comuni ? ['--comuni', run.comuni] : ['--province', run.province];
  const args = ['tsx', 'src/cli/run.ts', '--category', run.category, ...where, '--out', run.outBase];
  if (run.maxPages !== undefined) args.push('--max-pages', String(run.maxPages));
  if (maps) args.push('--maps');
  return args;
}

/**
 * Total cost of one run from its ledger. The ledger is opened by the enrich
 * stage and appended per provider call, so a missing file means no call was
 * ever recorded (the run died before enrich): 0 is the ledger's own answer.
 */
function readLedgerCostEur(ledgerPath: string): number {
  if (!fs.existsSync(ledgerPath)) return 0;
  let total = 0;
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { kind?: string; cost_eur?: number };
      if (e.kind !== 'summary' && typeof e.cost_eur === 'number') total += e.cost_eur;
    } catch {
      /* a half-written last line from a killed run */
    }
  }
  return total;
}

async function runOne(job: ScrapeJob, run: ScrapeRun, deps: ScrapeJobDeps): Promise<void> {
  run.status = 'running';
  const count = (r: IngestResult): IngestResult => {
    run.added = (run.added ?? 0) + r.added;
    job.added += r.added;
    return r;
  };
  // Raw rows land first and the enriched copy then fills the fields they lack
  // (the store merges fill-only-missing on the phone/name key both copies share).
  const ingestLive = async (): Promise<void> => {
    run.scraped = count(await deps.ingest(`${run.outBase}_raw.jsonl`)).rows;
    run.enriched = count(await deps.ingest(`${run.outBase}_enriched.jsonl`)).rows;
  };
  const stopLive = deps.liveIngestMs ? startLiveIngest(ingestLive, deps.liveIngestMs) : async () => {};
  const outcome = await deps.runCli(runArgs(run, job.maps), CLI_RUN_TIMEOUT_MS);
  await stopLive();
  try {
    if (outcome.ok) {
      run.enriched = count(await deps.ingest(`${run.outBase}_enriched.jsonl`)).rows;
      run.status = 'done';
    } else {
      // Enriched rows first: the store fills only missing fields, so the
      // enriched copy of a lead wins over its raw copy, and the raw file still
      // brings in the leads the enrich stage never reached.
      const enriched = count(await deps.ingest(`${run.outBase}_enriched.jsonl`));
      const raw = count(await deps.ingest(`${run.outBase}_raw.jsonl`));
      run.enriched = enriched.rows;
      run.scraped = raw.rows;
      // Rows that only merged into known companies are still data the run delivered.
      run.status = enriched.rows + raw.rows > 0 ? 'partial' : 'error';
      run.error = outcome.timedOut ? `timed out after ${CLI_RUN_TIMEOUT_MS / 3_600_000} h` : outcome.message;
    }
  } catch (err) {
    run.status = 'error';
    run.error = (err as Error).message.slice(0, 200);
  }
  run.costEur = readLedgerCostEur(`${run.outBase}_enriched.cost-ledger.jsonl`);
}

/** Runs `tick` every `ms` (never two at once); the returned stop waits for the tick in flight. */
function startLiveIngest(tick: () => Promise<void>, ms: number): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = tick()
        .catch(() => {
          /* a live tick is best effort; the final ingest after the run is authoritative */
        })
        .then(() => {
          if (!stopped) schedule();
        });
    }, ms);
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}

export async function runScrapeJob(job: ScrapeJob, deps: ScrapeJobDeps): Promise<void> {
  for (const run of job.runs) {
    if (deps.isStopping()) {
      run.status = 'error';
      run.error = 'not started: the server is shutting down';
      continue;
    }
    await runOne(job, run, deps);
    job.costEur += run.costEur ?? 0;
  }
  const incomplete = job.runs.filter((r) => r.status !== 'done');
  if (incomplete.length === 0) job.status = 'done';
  else if (job.runs.every((r) => r.status === 'error')) job.status = 'error';
  else job.status = 'partial';
  if (incomplete.length) {
    const first = incomplete[0];
    job.error = `${incomplete.length} of ${job.runs.length} runs incomplete; ${first.category} · ${first.province}: ${first.error ?? first.status}`;
  }
  job.finishedAt = deps.now();
}
