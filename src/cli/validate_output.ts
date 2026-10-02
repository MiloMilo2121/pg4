/**
 * Output validator CLI. Prints a JSON summary to stdout; exits non-zero if
 * `ok === false`.
 *
 *   tsx src/cli/validate_output.ts --csv <path> --jsonl <path>
 *                                  [--ledger <path>] [--max-cost <eur>]
 *                                  [--flavor raw|enriched]
 *
 * The checks live in `src/io/validation/output_validator.ts`, which the
 * scrape/enrich post-run hooks also call.
 */

import { parseArgs, reqString, optString } from './_args';
import { validateOutputs, type OutputFlavor, type ValidationSummary } from '../io/validation/output_validator';

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
