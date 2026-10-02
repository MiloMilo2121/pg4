import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { parseArgs, optString, hasHelp, reportFatal } from './_args';
import { UserError } from '../runtime/errors';

/**
 * Data-subject lookup (GDPR right-to-access / right-to-deletion support).
 *
 *   pnpm run lookup -- --piva 01234567897
 *   pnpm run lookup -- --phone "+39 0422 000177"
 *   pnpm run lookup -- --phone 0422000177 --dir output
 *
 * Scans every *.csv and *.jsonl under --dir (default: output/, recursive)
 * and reports each file + line where the subject appears. Matching is
 * normalization-tolerant: phones compare digit-only with the Italian
 * country prefix stripped; P.IVA compares the 11-digit form.
 *
 * Output: human-readable list + JSON summary on the last line (for
 * scripting). Exit 0 when the scan completed (matches or not); the
 * `found` count is in the summary.
 *
 * Deliberately a READER: deletion stays a manual operator action on the
 * reported files (sed/reissue), because silent automated rewriting of
 * delivered artifacts would desynchronize them from any copy already
 * sent to a client. The report tells the operator exactly where to act.
 */

interface Hit {
  file: string;
  line: number;
  company_name?: string;
  matched_on: 'phone' | 'vat';
}

function normPhone(s: string): string | undefined {
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('0039')) digits = digits.slice(4);
  else if (digits.length >= 11 && digits.startsWith('39')) digits = digits.slice(2);
  return digits.length >= 6 ? digits : undefined;
}

function normVat(s: string): string | undefined {
  const digits = s.replace(/\D/g, '');
  return digits.length === 11 ? digits : undefined;
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.(csv|jsonl)$/i.test(e.name) && !e.name.endsWith('.cost-ledger.jsonl') && !e.name.endsWith('.log.jsonl')) {
      yield full;
    }
  }
}

async function scanFile(file: string, phoneKey?: string, vatKey?: string): Promise<Hit[]> {
  const hits: Hit[] = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  for await (const line of rl) {
    lineNum += 1;
    // Normalization-tolerant containment: strip the line to digits once and
    // search for the keys. Cheap and format-independent (works for both CSV
    // cells and JSONL fields, spaced or not).
    const lineDigits = line.replace(/\D/g, '');
    let matched: Hit['matched_on'] | undefined;
    if (phoneKey && lineDigits.includes(phoneKey)) matched = 'phone';
    else if (vatKey && lineDigits.includes(vatKey)) matched = 'vat';
    if (!matched) continue;
    // Best-effort company name extraction for the report.
    let company: string | undefined;
    if (line.startsWith('{')) {
      try {
        company = (JSON.parse(line) as { company_name?: string }).company_name;
      } catch {
        /* not JSON */
      }
    } else {
      company = line.split(',')[0]?.replace(/^"|"$/g, '') || undefined;
    }
    hits.push({ file, line: lineNum, company_name: company, matched_on: matched });
  }
  return hits;
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) {
    printUsage();
    return 0;
  }
  if (!optString(args, 'piva') && !optString(args, 'phone')) {
    printUsage();
    return 2; // invoked without a subject: usage error
  }
  const dir = optString(args, 'dir') ?? 'output';
  const pivaArg = optString(args, 'piva');
  const phoneArg = optString(args, 'phone');

  const vatKey = pivaArg ? normVat(pivaArg) : undefined;
  if (pivaArg && !vatKey) throw new UserError(`--piva must contain an 11-digit P.IVA, got "${pivaArg}"`);
  const phoneKey = phoneArg ? normPhone(phoneArg) : undefined;
  if (phoneArg && !phoneKey) throw new UserError(`--phone must contain at least 6 digits, got "${phoneArg}"`);

  const allHits: Hit[] = [];
  let filesScanned = 0;
  for (const file of walk(dir)) {
    filesScanned += 1;
    allHits.push(...(await scanFile(file, phoneKey, vatKey)));
  }

  for (const h of allHits) {
    process.stdout.write(`${h.file}:${h.line}  [${h.matched_on}]  ${h.company_name ?? '(name n/a)'}\n`);
  }
  process.stdout.write(
    JSON.stringify({ found: allHits.length, files_scanned: filesScanned, dir, piva: vatKey ?? null, phone: phoneKey ?? null }) + '\n'
  );
  return 0;
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run lookup -- --piva 01234567897 [--dir output]
  pnpm run lookup -- --phone "+39 0422 000177" [--dir output]

Searches every *.csv / *.jsonl under --dir (default: output/) for the data
subject and reports file + line of each appearance. Supports GDPR
right-to-access and right-to-deletion: the report tells the operator exactly
which files to edit or re-issue. Deletion itself stays manual by design.
`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    reportFatal('lookup', err);
    process.exit(2);
  });
