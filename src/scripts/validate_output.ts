/**
 * validate_output.ts — reusable output validator for pg4 pipeline outputs.
 *
 * CLI: tsx src/scripts/validate_output.ts --csv <path> --jsonl <path>
 *                                          [--ledger <path>] [--max-cost <eur>]
 *                                          [--flavor raw|enriched]
 *
 * Prints a JSON summary to stdout.  Exits non-zero if ok===false.
 *
 * Phase B.2 — also exported as `validateOutputs()` so scrape/enrich call it
 * automatically at the end of every run (warn-only: validation errors are
 * logged + notified but never change the run's exit code).
 *
 * Flavors: `enriched` (default, full checks) vs `raw` — scrape outputs have
 * no status/reason_code columns, so those per-row checks are skipped.
 */

import fs from 'fs';
import readline from 'readline';
import { parse } from 'csv-parse';
import { parseArgs, reqString, optString } from '../cli/_args';
import { SCHEMA_VERSION } from '../types/lead';

// ─── Known source values (derived from codebase, not guessed) ────────────────
// src/types/lead.ts: 'PG' | 'MAPS' | 'INPUT_CSV' | 'IMMOBILIARE'
// csv_writer serialises sources[] as 'PG+MAPS' etc., so joined combos are valid.
const KNOWN_SOURCES = new Set<string>([
  'PG',
  'MAPS',
  'INPUT_CSV',
  'IMMOBILIARE',
]);

// ─── Mojibake sentinel sequences ─────────────────────────────────────────────
const MOJIBAKE_PATTERNS = [
  /Ã/,
  /Â[^a-zA-Z]/,  // Â followed by non-letter (common UTF-8 mis-decode artefact)
  /ï¿½/,
  /â€/,
];

// Key text fields to check for mojibake
const TEXT_FIELDS_FOR_MOJIBAKE = [
  'company_name',
  'city',
  'address',
  'category',
  'province',
  'region',
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface ValidationSummary {
  ok: boolean;
  csv_rows: number;
  jsonl_rows: number;
  ledger_summaries: number;
  run_ids: string[];
  found_website: number;
  methods: string[];
  reason_codes: string[];
  errors: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasMojibake(text: string): boolean {
  return MOJIBAKE_PATTERNS.some((re) => re.test(text));
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Derive the set of distinct base source tokens in a joined string like 'PG+MAPS'. */
function sourceTokens(raw: string): string[] {
  return raw.split('+').map((s) => s.trim()).filter(Boolean);
}

// ─── CSV validation ───────────────────────────────────────────────────────────

interface CsvResult {
  rows: number;
  headerColumns: string[];
  errors: string[];
  foundWebsite: number;
  methods: Set<string>;
  reasonCodes: Set<string>;
}

export type OutputFlavor = 'raw' | 'enriched';

async function validateCsv(csvPath: string, flavor: OutputFlavor = 'enriched'): Promise<CsvResult> {
  const errors: string[] = [];
  const methods = new Set<string>();
  const reasonCodes = new Set<string>();
  let rows = 0;
  let headerColumns: string[] = [];
  let foundWebsite = 0;

  if (!fs.existsSync(csvPath)) {
    return { rows: 0, headerColumns: [], errors: [`CSV not found: ${csvPath}`], foundWebsite: 0, methods, reasonCodes };
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(csvPath);
    const parser = parse({
      columns: (header: string[]) => {
        headerColumns = header;

        // Check for duplicate header columns
        const seen = new Map<string, number>();
        for (const col of header) {
          seen.set(col, (seen.get(col) ?? 0) + 1);
        }
        for (const [col, count] of seen.entries()) {
          if (count > 1) {
            errors.push(`Duplicate CSV header column: "${col}" (appears ${count} times)`);
          }
        }

        return header;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
    });

    stream.pipe(parser);

    parser.on('readable', () => {
      let record: Record<string, string> | null;
      while ((record = parser.read() as Record<string, string> | null) !== null) {
        rows += 1;
        const rowIdx = rows;

        // Enriched-only per-row checks: raw scrape outputs have no
        // status/reason_code columns by design.
        if (flavor === 'enriched') {
          if (!record['status'] || record['status'].trim() === '') {
            errors.push(`Row ${rowIdx}: missing status`);
          }
          if (!record['reason_code'] || record['reason_code'].trim() === '') {
            errors.push(`Row ${rowIdx}: missing reason_code`);
          } else {
            reasonCodes.add(record['reason_code'].trim());
          }
        } else if (record['reason_code'] && record['reason_code'].trim()) {
          reasonCodes.add(record['reason_code'].trim());
        }

        // Collect website_discovery_method values
        if (record['website_discovery_method'] && record['website_discovery_method'].trim()) {
          methods.add(record['website_discovery_method'].trim());
        }

        // Check mojibake on key text fields
        for (const field of TEXT_FIELDS_FOR_MOJIBAKE) {
          const val = record[field];
          if (val && hasMojibake(val)) {
            errors.push(`Row ${rowIdx}: mojibake detected in field "${field}": ${JSON.stringify(val)}`);
          }
        }

        // Validate official_website when present
        const ow = record['official_website'];
        if (ow && ow.trim() !== '') {
          foundWebsite += 1;
          if (!isValidHttpUrl(ow.trim())) {
            errors.push(`Row ${rowIdx}: official_website is not a valid http(s) URL: ${JSON.stringify(ow)}`);
          }
        }

        // Validate source values (only if non-empty)
        const src = record['source'];
        if (src && src.trim() !== '') {
          const tokens = sourceTokens(src.trim());
          for (const token of tokens) {
            if (!KNOWN_SOURCES.has(token)) {
              errors.push(`Row ${rowIdx}: unknown source token "${token}" in source "${src}"`);
            }
          }
        }

        // Phase C.1 — schema version stamp. Every current output must carry
        // the column with the expected value; legacy (pre-v1) files fail
        // loudly so the operator knows the file predates versioning.
        const sv = record['_schema_version'];
        if (sv === undefined) {
          if (rowIdx === 1) errors.push(`Missing _schema_version column (pre-v${SCHEMA_VERSION} output?)`);
        } else if (sv.trim() !== String(SCHEMA_VERSION)) {
          errors.push(`Row ${rowIdx}: _schema_version is "${sv}", expected "${SCHEMA_VERSION}"`);
        }
      }
    });

    parser.on('error', (err: Error) => {
      errors.push(`CSV parse error: ${err.message}`);
      resolve(); // don't reject — partial results are still useful
    });

    parser.on('end', () => resolve());
    stream.on('error', (err: Error) => {
      errors.push(`CSV read error: ${err.message}`);
      resolve();
    });
  });

  return { rows, headerColumns, errors, foundWebsite, methods, reasonCodes };
}

// ─── JSONL validation ─────────────────────────────────────────────────────────

interface JsonlResult {
  rows: number;
  errors: string[];
}

async function validateJsonl(jsonlPath: string): Promise<JsonlResult> {
  const errors: string[] = [];
  let rows = 0;

  if (!fs.existsSync(jsonlPath)) {
    return { rows: 0, errors: [`JSONL not found: ${jsonlPath}`] };
  }

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNum += 1;
    try {
      JSON.parse(trimmed);
      rows += 1;
    } catch (e) {
      errors.push(`JSONL line ${lineNum}: parse error — ${(e as Error).message}`);
    }
  }

  return { rows, errors };
}

// ─── Ledger validation ────────────────────────────────────────────────────────

interface LedgerResult {
  summaryCount: number;
  runIds: string[];
  totalCostEur: number;
  errors: string[];
}

async function validateLedger(ledgerPath: string): Promise<LedgerResult> {
  const errors: string[] = [];
  const runIds = new Set<string>();
  let summaryCount = 0;
  let totalCostEur = 0;

  if (!fs.existsSync(ledgerPath)) {
    return { summaryCount: 0, runIds: [], totalCostEur: 0, errors: [`Ledger not found: ${ledgerPath}`] };
  }

  const stream = fs.createReadStream(ledgerPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNum += 1;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (e) {
      errors.push(`Ledger line ${lineNum}: parse error — ${(e as Error).message}`);
      continue;
    }

    if (typeof obj['run_id'] === 'string') {
      runIds.add(obj['run_id'] as string);
    }

    if (obj['kind'] === 'summary') {
      summaryCount += 1;
      const tc = obj['total_cost_eur'];
      if (typeof tc === 'number') {
        totalCostEur = tc; // summary carries the aggregate
      }
    }
  }

  // Exactly 1 summary record
  if (summaryCount !== 1) {
    errors.push(`Ledger must have exactly 1 summary record (kind:"summary"), found ${summaryCount}`);
  }

  // Exactly 1 distinct run_id
  if (runIds.size !== 1) {
    errors.push(`Ledger must have exactly 1 distinct run_id, found ${runIds.size}: ${[...runIds].join(', ')}`);
  }

  return { summaryCount, runIds: [...runIds], totalCostEur, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface ValidateOutputsOptions {
  csvPath: string;
  jsonlPath: string;
  ledgerPath?: string;
  maxCost?: number;
  flavor?: OutputFlavor;
}

/**
 * Phase B.2 — programmatic entry point. Runs every check and returns the
 * summary; never exits the process. The CLI wrapper below and the
 * scrape/enrich post-run hooks both call this.
 */
export async function validateOutputs(opts: ValidateOutputsOptions): Promise<ValidationSummary> {
  const flavor = opts.flavor ?? 'enriched';
  const allErrors: string[] = [];

  // --- CSV ---
  const csvResult = await validateCsv(opts.csvPath, flavor);
  allErrors.push(...csvResult.errors);

  // --- JSONL ---
  const jsonlResult = await validateJsonl(opts.jsonlPath);
  allErrors.push(...jsonlResult.errors);

  // --- Row count parity ---
  if (csvResult.rows !== jsonlResult.rows) {
    allErrors.push(
      `Row count mismatch: CSV has ${csvResult.rows} data rows, JSONL has ${jsonlResult.rows} lines`
    );
  }

  // --- Ledger ---
  let ledgerSummaries = 0;
  let runIds: string[] = [];
  let totalCostEur: number | undefined;

  if (opts.ledgerPath) {
    const ledgerResult = await validateLedger(opts.ledgerPath);
    allErrors.push(...ledgerResult.errors);
    ledgerSummaries = ledgerResult.summaryCount;
    runIds = ledgerResult.runIds;
    totalCostEur = ledgerResult.totalCostEur;
  }

  // --- Max cost ---
  if (opts.maxCost !== undefined && totalCostEur !== undefined && totalCostEur > opts.maxCost) {
    allErrors.push(
      `Cost exceeded: total_cost_eur=${totalCostEur.toFixed(4)} > max-cost=${opts.maxCost}`
    );
  }

  return {
    ok: allErrors.length === 0,
    csv_rows: csvResult.rows,
    jsonl_rows: jsonlResult.rows,
    ledger_summaries: ledgerSummaries,
    run_ids: runIds,
    found_website: csvResult.foundWebsite,
    methods: [...csvResult.methods].sort(),
    reason_codes: [...csvResult.reasonCodes].sort(),
    errors: allErrors,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const flavorRaw = optString(args, 'flavor');
  if (flavorRaw !== undefined && flavorRaw !== 'raw' && flavorRaw !== 'enriched') {
    throw new Error(`--flavor must be "raw" or "enriched", got "${flavorRaw}"`);
  }
  const maxCostStr = optString(args, 'max-cost');
  const summary = await validateOutputs({
    csvPath: reqString(args, 'csv', 'path to output CSV'),
    jsonlPath: reqString(args, 'jsonl', 'path to JSONL output'),
    ledgerPath: optString(args, 'ledger'),
    maxCost: maxCostStr !== undefined ? Number(maxCostStr) : undefined,
    flavor: flavorRaw as OutputFlavor | undefined,
  });

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(summary.ok ? 0 : 1);
}

// Only run as CLI when invoked directly (tsx src/scripts/validate_output.ts),
// not when imported by the scrape/enrich post-run hooks.
const invokedDirectly = process.argv[1]?.includes('validate_output');
if (invokedDirectly) {
  main().catch((err: Error) => {
    const out: ValidationSummary = {
      ok: false,
      csv_rows: 0,
      jsonl_rows: 0,
      ledger_summaries: 0,
      run_ids: [],
      found_website: 0,
      methods: [],
      reason_codes: [],
      errors: [`Fatal: ${err.message}`],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  });
}
