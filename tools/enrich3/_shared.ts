import fs from 'fs';
import path from 'path';
import type { Lead } from '../../src/types/lead';
import { SCHEMA_VERSION } from '../../src/types/lead';
import { readCsvAsLeads } from '../../src/io/csv_reader';
import { readJsonlAsLeads, JsonlWriter } from '../../src/io/jsonl_writer';
import { CsvWriter } from '../../src/io/csv_writer';
import { createRun, type Run } from '../../src/runtime/run_context';
import { buildProviderCatalog } from '../../src/providers/provider_catalog';
import type { ProviderRouter } from '../../src/providers/provider_router';
import { logger } from '../../src/runtime/logger';
import { has } from '../../src/util/values';

/**
 * ENRICH-3 shared plumbing. The state chain is JSONL-first: the enriched CSV
 * flavor drops non-enumerated columns (e.g. `_prov_query`, `_e3_id`), so each
 * pass reads `stateN.jsonl` and writes `stateN+1.jsonl` (+ a CSV twin for
 * human inspection). Every pass is fill-only-empty on data fields, hence
 * idempotent — resume = re-run the pass on the same state.
 */

export async function loadState(p: string): Promise<Lead[]> {
  if (p.endsWith('.jsonl')) return readJsonlAsLeads(p);
  const leads: Lead[] = [];
  for await (const item of readCsvAsLeads(p)) {
    if (item.ingestError) logger.warn({ line: item.lineNumber, err: item.ingestError }, '[enrich3] ingest error (row kept)');
    leads.push(item.lead);
  }
  return leads;
}

/** Write `${base}.jsonl` (lossless) + `${base}.csv` (enriched flavor, inspection). */
export async function saveState(leads: Lead[], outBase: string): Promise<{ jsonl: string; csv: string }> {
  const base = outBase.replace(/\.(jsonl|csv)$/i, '');
  const jsonlPath = `${base}.jsonl`;
  const csvPath = `${base}.csv`;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const jsonl = new JsonlWriter(jsonlPath);
  const csv = new CsvWriter(csvPath, 'enriched');
  for (const lead of leads) {
    lead._schema_version = SCHEMA_VERSION;
    await jsonl.write(lead);
    await csv.write(lead);
  }
  await jsonl.close();
  await csv.close();
  logger.info({ jsonlPath, csvPath, rows: leads.length }, '[enrich3] state saved');
  return { jsonl: jsonlPath, csv: csvPath };
}

export interface E3RunOptions {
  ledgerPath: string;
  paidEnabled: boolean;
  /** Per-lead cost ceiling (EUR). */
  perLeadCapEur?: number;
  /** Aggregate run ceiling (EUR) — the hard stop for the whole pass. */
  runCostCeilingEur?: number;
}

export function buildE3Run(opts: E3RunOptions): { run: Run; router: ProviderRouter } {
  fs.mkdirSync(path.dirname(opts.ledgerPath), { recursive: true });
  const run = createRun({
    ledgerJsonlPath: opts.ledgerPath,
    costCeilingEur: opts.perLeadCapEur,
    paidEnabled: opts.paidEnabled,
    runCostCeilingEur: opts.runCostCeilingEur,
  });
  const router = buildProviderCatalog(run.ledger);
  router.setRunCeilingListener(({ ledgerTotalEur, ceilingEur }) => {
    logger.warn({ ledgerTotalEur, ceilingEur }, '[enrich3] RUN COST CEILING HIT — paid providers disabled for the rest of the pass');
  });
  return { run, router };
}


/** Fill-only-empty merge (the repo-wide discipline). Returns the filled keys. */
export function fillOnlyEmpty(lead: Lead, patch: Partial<Record<keyof Lead, unknown>>): string[] {
  const filled: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!has(v)) continue;
    if (!has((lead as Record<string, unknown>)[k])) {
      (lead as Record<string, unknown>)[k] = v;
      filled.push(k);
    }
  }
  return filled;
}

/**
 * Execute `main` only when the process entrypoint IS this script — the
 * enrich3 scripts export their pure helpers for unit tests, and importing
 * a module must never fire a (possibly paid) pass. Matched on the script
 * FILENAME (import.meta is unavailable under the repo's tsc module setting).
 */
export function runIfMain(scriptFileName: string, main: () => Promise<void>): void {
  const entry = process.argv[1] ? path.basename(process.argv[1]) : '';
  if (entry === scriptFileName) {
    main().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}

/** Flush the ledger summary + log the pass total. Call at the end of every paid pass. */
export function closeLedger(run: Run, passName: string): number {
  const total = run.ledger.getTotal();
  run.ledger.flushSummary();
  logger.info({ pass: passName, total_eur: Number(total.toFixed(4)) }, '[enrich3] pass ledger total');
  return total;
}
