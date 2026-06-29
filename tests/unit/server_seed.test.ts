import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadSeed, DEV_TENANT_ID } from '../../src/server/seed';
import { InMemoryTenantDb } from '../../src/persistence/in_memory_tenant_db';
import type { Lead } from '../../src/types/lead';

const lead = (o: Partial<Lead>): Lead => ({ company_name: 'X', ...o });

describe('dev seed — loads real-shaped free-gold JSONL into a single tenant', () => {
  it('loads rows, dedups, and derives provider-health from the ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-seed-'));
    const jsonl = path.join(dir, 'seed.jsonl');
    fs.writeFileSync(
      jsonl,
      [
        JSON.stringify({ company_name: 'Alfa Srl', city: 'Padova', phone: '0491111111', official_website: 'https://alfa.it' }),
        JSON.stringify({ company_name: 'Alfa S.R.L.', city: 'Padova', phone: '0039 049 1111111' }), // dup (phone+legal-form)
        JSON.stringify({ company_name: 'Beta', city: 'Verona', phone: '0452222222' }),
        JSON.stringify({ company_name: 'NoIdentity' }), // un-dedupable → rejected
      ].join('\n'),
      'utf8'
    );
    // a ledger with a dead provider (0 successes in many calls)
    const ledger = jsonl.replace(/\.jsonl$/, '.cost-ledger.jsonl');
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ provider: 'dns_mx', cost_eur: 0, success: false, kind: 'empty' }));
    rows.push(JSON.stringify({ provider: 'bing_html', cost_eur: 0, success: true, kind: 'success' }));
    fs.writeFileSync(ledger, rows.join('\n'), 'utf8');

    const seed = await loadSeed(dir, jsonl);
    expect(seed.loaded).toBe(3); // Alfa+Alfa merged into 1 → but loaded counts upserts; rejected counts the un-dedupable
    expect(seed.rejected).toBe(1);
    expect(await seed.db.count(DEV_TENANT_ID)).toBe(2); // Alfa (merged) + Beta
    expect(seed.providerDead.map((d) => d.provider)).toContain('dns_mx');
    expect(seed.providerDead.map((d) => d.provider)).not.toContain('bing_html');
  });

  it('missing seed file → empty store, no crash', async () => {
    const seed = await loadSeed('/tmp', 'does/not/exist.jsonl');
    expect(seed.loaded).toBe(0);
    expect(await seed.db.count(DEV_TENANT_ID)).toBe(0);
  });
});

describe('InMemoryTenantDb — server helpers stay tenant-scoped', () => {
  const TA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('entries + getById are tenant-scoped', async () => {
    const db = new InMemoryTenantDb();
    const a = await db.upsertCompany(TA, lead({ company_name: 'A', city: 'Padova', phone: '0491111111' }));
    await db.upsertCompany(TB, lead({ company_name: 'B', city: 'Verona', phone: '0452222222' }));
    expect(db.entries(TA)).toHaveLength(1);
    expect(db.entries(TB)).toHaveLength(1);
    expect(db.getById(TA, a.companyId)?.company_name).toBe('A');
    // B's id is invisible from A's scope
    const bId = (await db.getCompanyIds(TB))[0];
    expect(db.getById(TA, bId)).toBeUndefined();
  });

  it('patchCompany fills only missing fields, tenant-scoped', async () => {
    const db = new InMemoryTenantDb();
    const a = await db.upsertCompany(TA, lead({ company_name: 'A', city: 'Padova', phone: '0491111111', email_inferred: 'pre@a.it' }));
    const patched = db.patchCompany(TA, a.companyId, { email_inferred: 'new@a.it', vat_code_final: '01234567897' });
    expect(patched?.email_inferred).toBe('pre@a.it'); // existing wins
    expect(patched?.vat_code_final).toBe('01234567897'); // empty filled
    expect(db.patchCompany(TB, a.companyId, { city: 'x' })).toBeUndefined(); // wrong tenant
  });
});
