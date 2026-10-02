import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadLeadFiles } from '../../src/io/lead_files';

function tmp(name: string, body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-leads-')), name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('loadLeadFiles', () => {
  it('skips and counts a CSV row without company_name instead of loading an empty lead', async () => {
    const csv = tmp('in.csv', 'company_name,city\nAlfa Srl,Padova\n,Vicenza\n');
    const { leads, skipped } = await loadLeadFiles([csv]);
    expect(leads.map((l) => l.company_name)).toEqual(['Alfa Srl']);
    expect(skipped).toBe(1);
  });

  it('skips and counts a malformed JSONL line, and reads several files in order', async () => {
    const a = tmp('a.jsonl', '{"company_name":"A"}\n{"company_na\n\n');
    const b = tmp('b.jsonl', '{"company_name":"B"}\n');
    const { leads, skipped } = await loadLeadFiles([a, b]);
    expect(leads.map((l) => l.company_name)).toEqual(['A', 'B']);
    expect(skipped).toBe(1);
  });

  it('fails loudly on a missing input', async () => {
    await expect(loadLeadFiles(['/nonexistent/x.jsonl'])).rejects.toThrow(/input not found/);
  });
});
