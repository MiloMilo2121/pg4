import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateOutputs } from '../../src/io/validation/output_validator';

/**
 * Programmatic validator entry point + raw/enriched flavors.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-valfn-'));
}

const RAW_HEADER = 'company_name,category,city,phone,website,source,_schema_version';
const ENR_HEADER = 'company_name,category,city,phone,website,source,status,reason_code,official_website,_schema_version';

describe('validateOutputs', () => {
  it('raw flavor: rows without status/reason_code pass', async () => {
    const dir = tmpDir();
    const csv = path.join(dir, 'raw.csv');
    const jsonl = path.join(dir, 'raw.jsonl');
    fs.writeFileSync(csv, `${RAW_HEADER}\nStudio Rossi,agenzie immobiliari,Padova,+390491234567,,PG,5\n`, 'utf8');
    fs.writeFileSync(jsonl, JSON.stringify({ company_name: 'Studio Rossi' }) + '\n', 'utf8');

    const summary = await validateOutputs({ csvPath: csv, jsonlPath: jsonl, flavor: 'raw' });
    expect(summary.errors).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.csv_rows).toBe(1);
  });

  it('enriched flavor (default): missing status/reason_code is an error', async () => {
    const dir = tmpDir();
    const csv = path.join(dir, 'enr.csv');
    const jsonl = path.join(dir, 'enr.jsonl');
    fs.writeFileSync(csv, `${ENR_HEADER}\nStudio Rossi,agenzie immobiliari,Padova,,,PG,,,,5\n`, 'utf8');
    fs.writeFileSync(jsonl, JSON.stringify({ company_name: 'Studio Rossi' }) + '\n', 'utf8');

    const summary = await validateOutputs({ csvPath: csv, jsonlPath: jsonl });
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.includes('missing status'))).toBe(true);
    expect(summary.errors.some((e) => e.includes('missing reason_code'))).toBe(true);
  });

  it('row count mismatch between CSV and JSONL is an error', async () => {
    const dir = tmpDir();
    const csv = path.join(dir, 'x.csv');
    const jsonl = path.join(dir, 'x.jsonl');
    fs.writeFileSync(csv, `${RAW_HEADER}\nA,c,Padova,,,PG,5\nB,c,Padova,,,PG,5\n`, 'utf8');
    fs.writeFileSync(jsonl, JSON.stringify({ company_name: 'A' }) + '\n', 'utf8');

    const summary = await validateOutputs({ csvPath: csv, jsonlPath: jsonl, flavor: 'raw' });
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.includes('Row count mismatch'))).toBe(true);
  });

  it('schema version: missing column or wrong value is an error (C.1)', async () => {
    const dir = tmpDir();
    const noCol = path.join(dir, 'nocol.csv');
    const jsonl = path.join(dir, 'n.jsonl');
    fs.writeFileSync(noCol, 'company_name,source\nA,PG\n', 'utf8');
    fs.writeFileSync(jsonl, JSON.stringify({ company_name: 'A' }) + '\n', 'utf8');
    const s1 = await validateOutputs({ csvPath: noCol, jsonlPath: jsonl, flavor: 'raw' });
    expect(s1.errors.some((e) => e.includes('Missing _schema_version column'))).toBe(true);

    const wrongVal = path.join(dir, 'wrong.csv');
    fs.writeFileSync(wrongVal, `${RAW_HEADER}\nA,c,Padova,,,PG,99\n`, 'utf8');
    const s2 = await validateOutputs({ csvPath: wrongVal, jsonlPath: jsonl, flavor: 'raw' });
    expect(s2.errors.some((e) => e.includes('_schema_version is "99"'))).toBe(true);
  });

  it('never exits the process — returns the summary even on missing files', async () => {
    const dir = tmpDir();
    const summary = await validateOutputs({
      csvPath: path.join(dir, 'absent.csv'),
      jsonlPath: path.join(dir, 'absent.jsonl'),
      flavor: 'raw',
    });
    expect(summary.ok).toBe(false);
    expect(summary.errors.length).toBeGreaterThanOrEqual(2);
  });
});
