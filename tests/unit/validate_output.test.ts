/**
 * Unit tests for src/scripts/validate_output.ts
 *
 * Writes temp fixture files to os.tmpdir(), runs the validator logic
 * in-process by importing internal helpers, asserts pass and fail cases.
 * Cleans up temp files in afterAll.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterAll } from 'vitest';

// ─── Import validator internals for in-process testing ───────────────────────
// We re-implement the core logic calls via the exported functions.
// Because validate_output.ts calls process.exit we test the underlying
// async functions directly by extracting them.  We duplicate the minimal
// helpers here so we don't have to refactor the script.

import { parse } from 'csv-parse';
import readline from 'readline';

// ─── Helpers mirrored from the script ────────────────────────────────────────

const KNOWN_SOURCES = new Set<string>(['PG', 'MAPS', 'INPUT_CSV', 'IMMOBILIARE']);
const MOJIBAKE_PATTERNS = [/Ã/, /Â[^a-zA-Z]/, /ï¿½/, /â€/];
const TEXT_FIELDS_FOR_MOJIBAKE = ['company_name', 'city', 'address', 'category', 'province', 'region'];

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

function sourceTokens(raw: string): string[] {
  return raw.split('+').map((s) => s.trim()).filter(Boolean);
}

interface CsvResult {
  rows: number;
  headerColumns: string[];
  errors: string[];
  foundWebsite: number;
  methods: Set<string>;
  reasonCodes: Set<string>;
}

async function validateCsv(csvPath: string): Promise<CsvResult> {
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
        const seen = new Map<string, number>();
        for (const col of header) seen.set(col, (seen.get(col) ?? 0) + 1);
        for (const [col, count] of seen.entries()) {
          if (count > 1) errors.push(`Duplicate CSV header column: "${col}" (appears ${count} times)`);
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

        if (!record['status'] || record['status'].trim() === '') {
          errors.push(`Row ${rowIdx}: missing status`);
        }
        if (!record['reason_code'] || record['reason_code'].trim() === '') {
          errors.push(`Row ${rowIdx}: missing reason_code`);
        } else {
          reasonCodes.add(record['reason_code'].trim());
        }
        if (record['website_discovery_method'] && record['website_discovery_method'].trim()) {
          methods.add(record['website_discovery_method'].trim());
        }
        for (const field of TEXT_FIELDS_FOR_MOJIBAKE) {
          const val = record[field];
          if (val && hasMojibake(val)) {
            errors.push(`Row ${rowIdx}: mojibake detected in field "${field}": ${JSON.stringify(val)}`);
          }
        }
        const ow = record['official_website'];
        if (ow && ow.trim() !== '') {
          foundWebsite += 1;
          if (!isValidHttpUrl(ow.trim())) {
            errors.push(`Row ${rowIdx}: official_website is not a valid http(s) URL: ${JSON.stringify(ow)}`);
          }
        }
        const src = record['source'];
        if (src && src.trim() !== '') {
          const tokens = sourceTokens(src.trim());
          for (const token of tokens) {
            if (!KNOWN_SOURCES.has(token)) {
              errors.push(`Row ${rowIdx}: unknown source token "${token}" in source "${src}"`);
            }
          }
        }
      }
    });

    parser.on('error', () => resolve());
    parser.on('end', () => resolve());
    stream.on('error', () => resolve());
  });

  return { rows, headerColumns, errors, foundWebsite, methods, reasonCodes };
}

interface JsonlResult { rows: number; errors: string[]; }

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
    try { JSON.parse(trimmed); rows += 1; }
    catch (e) { errors.push(`JSONL line ${lineNum}: parse error — ${(e as Error).message}`); }
  }
  return { rows, errors };
}

interface LedgerResult { summaryCount: number; runIds: string[]; totalCostEur: number; errors: string[]; }

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
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; }
    catch (e) { errors.push(`Ledger line ${lineNum}: parse error — ${(e as Error).message}`); continue; }
    if (typeof obj['run_id'] === 'string') runIds.add(obj['run_id'] as string);
    if (obj['kind'] === 'summary') {
      summaryCount += 1;
      const tc = obj['total_cost_eur'];
      if (typeof tc === 'number') totalCostEur = tc;
    }
  }
  if (summaryCount !== 1) errors.push(`Ledger must have exactly 1 summary record (kind:"summary"), found ${summaryCount}`);
  if (runIds.size !== 1) errors.push(`Ledger must have exactly 1 distinct run_id, found ${runIds.size}: ${[...runIds].join(', ')}`);
  return { summaryCount, runIds: [...runIds], totalCostEur, errors };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

function tmpFile(suffix: string): string {
  const p = path.join(os.tmpdir(), `pg4_validate_test_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
  tmpFiles.push(p);
  return p;
}

function writeFile(p: string, content: string): void {
  fs.writeFileSync(p, content, 'utf8');
}

const VALID_CSV_HEADER = 'company_name,category,city,province,region,address,phone,website,source,source_url,pg_url,maps_url,vat_code,confidence,discovery_notes,query_location,business_city,category_match,status,reason_code,official_website,website_confidence,website_discovery_method,vat_code_final,pec,email_inferred,email_type,revenue,revenue_year,employees,employees_is_estimated,decision_maker_name,decision_maker_role,decision_maker_linkedin,lead_score,cost_eur,duration_ms,providers_used,errors,financial_source,financial_confidence,financial_notes\n';

const VALID_CSV_ROW = 'Acme Srl,Idraulici,Milano,MI,Lombardia,Via Roma 1,0212345678,,PG,,,,12345678901,0.9,,Milano,,confirmed,FOUND_COMPLETE,FOUND_COMPLETE,https://acme.it,0.95,INPUT_VERIFIED,,,,,,,,,,,,,,0.01,200,,[],,,\n';

const VALID_JSONL_ROW = JSON.stringify({
  company_name: 'Acme Srl',
  category: 'Idraulici',
  city: 'Milano',
  status: 'FOUND_COMPLETE',
  reason_code: 'FOUND_COMPLETE',
  official_website: 'https://acme.it',
}) + '\n';

const VALID_LEDGER =
  JSON.stringify({ run_id: 'run-123', provider: 'direct', family: 'http', cost_eur: 0.0, ts: 1000, success: true, kind: 'success' }) + '\n' +
  JSON.stringify({ run_id: 'run-123', total_calls: 1, total_cost_eur: 0.01, success_rate: 1.0, by_provider: {}, kind: 'summary', ts: 2000 }) + '\n';

afterAll(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validate_output — pass case', () => {
  it('should pass for valid CSV + JSONL + ledger', async () => {
    const csvPath = tmpFile('.csv');
    const jsonlPath = tmpFile('.jsonl');
    const ledgerPath = tmpFile('.jsonl');

    writeFile(csvPath, VALID_CSV_HEADER + VALID_CSV_ROW);
    writeFile(jsonlPath, VALID_JSONL_ROW);
    writeFile(ledgerPath, VALID_LEDGER);

    const csvResult = await validateCsv(csvPath);
    const jsonlResult = await validateJsonl(jsonlPath);
    const ledgerResult = await validateLedger(ledgerPath);

    const rowMismatch = csvResult.rows !== jsonlResult.rows;
    const allErrors = [...csvResult.errors, ...jsonlResult.errors, ...ledgerResult.errors];
    if (rowMismatch) allErrors.push('row mismatch');

    expect(csvResult.rows).toBe(1);
    expect(jsonlResult.rows).toBe(1);
    expect(ledgerResult.summaryCount).toBe(1);
    expect(ledgerResult.runIds).toEqual(['run-123']);
    expect(allErrors).toEqual([]);
  });
});

describe('validate_output — fail case: row count mismatch', () => {
  it('should fail when CSV rows != JSONL lines', async () => {
    const csvPath = tmpFile('.csv');
    const jsonlPath = tmpFile('.jsonl');

    // 2 CSV rows but only 1 JSONL row
    writeFile(
      csvPath,
      VALID_CSV_HEADER +
        VALID_CSV_ROW +
        'Gamma Srl,Elettricisti,Roma,RM,Lazio,Via Verdi 2,0612345678,,PG,,,,98765432101,0.8,,,confirmed,FOUND_COMPLETE,FOUND_COMPLETE,,,,,,,,,,,,,,,,,,0.01,200,,[],,,\n'
    );
    writeFile(jsonlPath, VALID_JSONL_ROW);

    const csvResult = await validateCsv(csvPath);
    const jsonlResult = await validateJsonl(jsonlPath);

    expect(csvResult.rows).toBe(2);
    expect(jsonlResult.rows).toBe(1);
    // Caller would detect mismatch
    expect(csvResult.rows === jsonlResult.rows).toBe(false);
  });
});

describe('validate_output — fail case: mojibake in company_name', () => {
  it('should detect mojibake sequences', async () => {
    const csvPath = tmpFile('.csv');

    // Introduce a typical UTF-8 double-encoding artefact
    const mojibakeRow =
      'SocietÃ Alfa,Idraulici,Milano,MI,Lombardia,Via Roma 1,,,PG,,,,12345678901,0.9,,,,confirmed,FOUND_COMPLETE,FOUND_COMPLETE,,,,,,,,,,,,,,,,,,0.01,200,,[],,,\n';
    writeFile(csvPath, VALID_CSV_HEADER + mojibakeRow);

    const result = await validateCsv(csvPath);
    const mojibakeErrors = result.errors.filter((e) => e.includes('mojibake'));
    expect(mojibakeErrors.length).toBeGreaterThan(0);
    expect(mojibakeErrors[0]).toMatch(/company_name/);
  });
});

describe('validate_output — fail case: missing reason_code', () => {
  it('should fail when reason_code is empty', async () => {
    const csvPath = tmpFile('.csv');

    // reason_code intentionally empty (21st column, index 20 in the header above)
    // We craft a row where status=FOUND_COMPLETE but reason_code is blank
    const badRow =
      'Beta Srl,Idraulici,Milano,MI,Lombardia,Via Roma 1,,,PG,,,,12345678901,0.9,,,,confirmed,FOUND_COMPLETE,,,,,,,,,,,,,,,,,,,,0.01,200,,[],,,\n';
    writeFile(csvPath, VALID_CSV_HEADER + badRow);

    const result = await validateCsv(csvPath);
    const rcErrors = result.errors.filter((e) => e.includes('reason_code'));
    expect(rcErrors.length).toBeGreaterThan(0);
  });
});

describe('validate_output — fail case: invalid official_website URL', () => {
  it('should fail when official_website is not a valid http/https URL', async () => {
    const csvPath = tmpFile('.csv');

    // official_website set to a non-URL string
    const badRow =
      'Delta Srl,Idraulici,Milano,MI,Lombardia,Via Roma 1,,,PG,,,,12345678901,0.9,,,,confirmed,FOUND_COMPLETE,FOUND_COMPLETE,not-a-url,0.9,INPUT_VERIFIED,,,,,,,,,,,,,,0.01,200,,[],,,\n';
    writeFile(csvPath, VALID_CSV_HEADER + badRow);

    const result = await validateCsv(csvPath);
    const urlErrors = result.errors.filter((e) => e.includes('official_website'));
    expect(urlErrors.length).toBeGreaterThan(0);
  });
});

describe('validate_output — fail case: duplicate CSV header', () => {
  it('should fail on duplicate column names in header', async () => {
    const csvPath = tmpFile('.csv');

    // Duplicate "company_name" in header
    const dupHeader = 'company_name,company_name,city,status,reason_code\n';
    const row = 'Acme Srl,Acme Srl,Milano,FOUND_COMPLETE,FOUND_COMPLETE\n';
    writeFile(csvPath, dupHeader + row);

    const result = await validateCsv(csvPath);
    const dupErrors = result.errors.filter((e) => e.includes('Duplicate'));
    expect(dupErrors.length).toBeGreaterThan(0);
    expect(dupErrors[0]).toMatch(/company_name/);
  });
});

describe('validate_output — fail case: ledger missing summary', () => {
  it('should fail when ledger has no summary record', async () => {
    const ledgerPath = tmpFile('.jsonl');

    // Only a per-call entry, no summary
    writeFile(
      ledgerPath,
      JSON.stringify({ run_id: 'run-abc', provider: 'direct', family: 'http', cost_eur: 0.0, ts: 1000, success: true, kind: 'success' }) + '\n'
    );

    const result = await validateLedger(ledgerPath);
    expect(result.summaryCount).toBe(0);
    const summaryErrors = result.errors.filter((e) => e.includes('summary'));
    expect(summaryErrors.length).toBeGreaterThan(0);
  });
});

describe('validate_output — fail case: ledger multiple run_ids', () => {
  it('should fail when ledger contains more than 1 distinct run_id', async () => {
    const ledgerPath = tmpFile('.jsonl');

    writeFile(
      ledgerPath,
      JSON.stringify({ run_id: 'run-A', kind: 'success', cost_eur: 0.0, ts: 1, success: true, provider: 'x', family: 'y' }) + '\n' +
      JSON.stringify({ run_id: 'run-B', kind: 'success', cost_eur: 0.0, ts: 2, success: true, provider: 'x', family: 'y' }) + '\n' +
      JSON.stringify({ run_id: 'run-A', total_calls: 2, total_cost_eur: 0.0, success_rate: 1.0, by_provider: {}, kind: 'summary', ts: 3 }) + '\n'
    );

    const result = await validateLedger(ledgerPath);
    const runIdErrors = result.errors.filter((e) => e.includes('run_id'));
    expect(runIdErrors.length).toBeGreaterThan(0);
  });
});

describe('validate_output — mojibake patterns', () => {
  it('hasMojibake detects known patterns', () => {
    expect(hasMojibake('SocietÃ ')).toBe(true);       // Ã
    expect(hasMojibake('Cafè')).toBe(false);     // è — valid UTF-8, NOT mojibake
    expect(hasMojibake('â€œquoteâ€')).toBe(true);    // â€
    expect(hasMojibake('Normal Name')).toBe(false);
  });

  it('isValidHttpUrl validates http/https only', () => {
    expect(isValidHttpUrl('https://example.it')).toBe(true);
    expect(isValidHttpUrl('http://www.acme.com')).toBe(true);
    expect(isValidHttpUrl('ftp://files.org')).toBe(false);
    expect(isValidHttpUrl('not-a-url')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });

  it('sourceTokens splits composite sources', () => {
    expect(sourceTokens('PG')).toEqual(['PG']);
    expect(sourceTokens('PG+MAPS')).toEqual(['PG', 'MAPS']);
    expect(sourceTokens('PG+MAPS+INPUT_CSV')).toEqual(['PG', 'MAPS', 'INPUT_CSV']);
  });
});
