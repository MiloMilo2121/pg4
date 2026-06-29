import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCsvAsLeads } from '../../src/io/csv_reader';
import { CsvWriter } from '../../src/io/csv_writer';
import { JsonlWriter } from '../../src/io/jsonl_writer';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-csv-'));

describe('CSV reader', () => {
  it('reads rows and yields Lead objects', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 'in.csv');
    fs.writeFileSync(p, 'company_name,city,province\nAcme,Milano,MI\nBeta,Roma,RM\n');
    const out: string[] = [];
    for await (const { lead } of readCsvAsLeads(p)) {
      out.push(lead.company_name);
    }
    expect(out).toEqual(['Acme', 'Beta']);
  });

  it('flags rows missing company_name with ingestError', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 'in.csv');
    fs.writeFileSync(p, 'company_name,city\n,Milano\n');
    const items = [];
    for await (const i of readCsvAsLeads(p)) items.push(i);
    expect(items).toHaveLength(1);
    expect(items[0].ingestError).toBeDefined();
  });
});

describe('CsvWriter', () => {
  it('writes deterministic enriched columns', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 'out.csv');
    const w = new CsvWriter(p, 'enriched');
    await w.write({ company_name: 'Acme', city: 'Milano', status: 'FOUND_WEBSITE_ONLY', reason_code: 'FOUND_WEBSITE_ONLY', official_website: 'https://acme.it' });
    await w.close();
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    expect(lines[0]).toContain('company_name');
    expect(lines[0]).toContain('reason_code');
    expect(lines[0]).toContain('official_website');
    expect(lines[1]).toContain('Acme');
    expect(lines[1]).toContain('FOUND_WEBSITE_ONLY');
  });
});

describe('JsonlWriter', () => {
  it('writes one JSON object per line', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 'out.jsonl');
    const w = new JsonlWriter(p);
    await w.write({ a: 1 });
    await w.write({ b: 2 });
    await w.close();
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ b: 2 });
  });
});
