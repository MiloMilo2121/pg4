import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonlWriter, readJsonlObjects, readJsonlAsLeads } from '../../src/io/jsonl_writer';

const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-jsonl-')), name);

describe('readJsonlObjects', () => {
  it('round-trips JsonlWriter output', async () => {
    const f = tmpFile('round.jsonl');
    const w = new JsonlWriter(f);
    await w.write({ a: 1 });
    await w.write({ a: 2, b: 'x' });
    await w.close();
    const out = await readJsonlObjects(f);
    expect(out).toEqual([{ a: 1 }, { a: 2, b: 'x' }]);
  });

  it('returns [] for missing file (resume on first run)', async () => {
    expect(await readJsonlObjects('/tmp/this-does-not-exist-pg4.jsonl')).toEqual([]);
  });

  it('skips malformed lines without crashing', async () => {
    const f = tmpFile('bad.jsonl');
    fs.writeFileSync(f, '{"ok":1}\nthis is not json\n{"ok":2}\n\n');
    const out = await readJsonlObjects(f);
    expect(out).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('readJsonlAsLeads pins the type', async () => {
    const f = tmpFile('leads.jsonl');
    const w = new JsonlWriter(f);
    await w.write({ company_name: 'Acme', city: 'Milano' });
    await w.close();
    const out = await readJsonlAsLeads(f);
    expect(out[0].company_name).toBe('Acme');
    expect(out[0].city).toBe('Milano');
  });
});
