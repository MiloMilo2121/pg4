import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Checkpoint } from '../../src/runtime/checkpoint';
import { Deduplicator } from '../../src/discovery/deduper';
import { JsonlWriter, readJsonlAsLeads } from '../../src/io/jsonl_writer';
import type { Lead } from '../../src/types/lead';

/**
 * Phase 4.1 regression: validates the resume contract end-to-end without
 * touching the network. Simulates two runs:
 *   Run A — scrapes Belluno, writes JSONL + checkpoint marks p1 done.
 *   Run B — re-launches, the checkpoint says p1 is already done so the
 *           live navigator skips it. The CLI MUST re-hydrate the lead
 *           set from the prior JSONL or the final CSV would be missing
 *           every Run A lead.
 *
 * The test inlines a minimal version of the rehydrate logic — the CLI
 * code calls the same helpers (readJsonlAsLeads + Deduplicator) so an
 * accidental regression there would also break this test once we wire
 * an end-to-end CLI test (deferred while live mode is opt-in).
 */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-resume-'));

async function rehydrate(jsonlPath: string, dedup: Deduplicator, sink: Lead[]): Promise<number> {
  const prior = await readJsonlAsLeads(jsonlPath);
  let loaded = 0;
  for (const lead of prior) {
    const existing = dedup.find(lead);
    if (existing) {
      dedup.merge(existing, lead);
    } else {
      dedup.add(lead);
      sink.push(lead);
      loaded += 1;
    }
  }
  return loaded;
}

describe('Phase 4.1 resume contract', () => {
  it('Run B rehydrates the lead set from Run A JSONL when checkpoint marks pages done', async () => {
    const dir = tmpDir();
    const jsonl = path.join(dir, 'raw.jsonl');
    const cpFile = path.join(dir, 'checkpoint.json');

    // ---- Run A: write 3 leads + mark p1 done ----
    const w = new JsonlWriter(jsonl);
    const runALeads: Lead[] = [
      { company_name: 'Studio Dolomiti SRL', city: 'Belluno', province: 'BL', pg_url: 'https://www.paginegialle.it/studiodolomiti', sources: ['PG'] },
      { company_name: 'Immobiliare Cadore', city: 'Belluno', province: 'BL', pg_url: 'https://www.paginegialle.it/immobiliarecadore', sources: ['PG'] },
      { company_name: 'Re/Max Belluno', city: 'Sedico', province: 'BL', pg_url: 'https://www.paginegialle.it/remaxbelluno', sources: ['PG'] },
    ];
    for (const l of runALeads) await w.write(l);
    await w.close();
    const cpA = new Checkpoint(cpFile);
    cpA.set(Checkpoint.buildKey({ provider: 'pg', category: 'agenzie immobiliari', location: 'Belluno', page: 1 }), {
      status: 'done',
      page: 1,
      total_cards: 3,
      parsed: 3,
      dropped: 0,
      overflow: false,
    });
    expect(cpA.countDone()).toBe(1);

    // ---- Run B: re-load checkpoint, rehydrate from JSONL ----
    const cpB = new Checkpoint(cpFile);
    expect(cpB.countDone()).toBe(1);   // checkpoint persisted
    const dedup = new Deduplicator();
    const allLeads: Lead[] = [];
    const loaded = await rehydrate(jsonl, dedup, allLeads);

    expect(loaded).toBe(3);
    expect(allLeads.map((l) => l.company_name).sort()).toEqual([
      'Immobiliare Cadore',
      'Re/Max Belluno',
      'Studio Dolomiti SRL',
    ]);

    // ---- Run B then scrapes a NEW comune (not yet in checkpoint), produces ----
    // some duplicates (Studio Dolomiti was already in Run A's JSONL) and one
    // brand-new lead. The deduper must collapse the duplicate so the final
    // CSV/JSONL contains 4 records, not 5.
    const runBNew: Lead[] = [
      { company_name: 'Studio Dolomiti SRL', city: 'Belluno', province: 'BL', pg_url: 'https://www.paginegialle.it/studiodolomiti', sources: ['MAPS'] },
      { company_name: 'Casa Sicura Servizi Immobiliari', city: 'Feltre', province: 'BL', maps_url: 'https://www.google.com/maps/place/casa-sicura', sources: ['MAPS'] },
    ];
    for (const lead of runBNew) {
      const existing = dedup.find(lead);
      if (existing) {
        dedup.merge(existing, lead);
      } else {
        dedup.add(lead);
        allLeads.push(lead);
      }
    }
    expect(allLeads).toHaveLength(4);
    // The Studio Dolomiti record should now have BOTH sources
    const studio = allLeads.find((l) => l.company_name === 'Studio Dolomiti SRL')!;
    expect((studio.sources ?? []).sort()).toEqual(['MAPS', 'PG']);
  });

  it('returns 0 loaded and emits no leads when JSONL is missing (cold start)', async () => {
    const dir = tmpDir();
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    const loaded = await rehydrate(path.join(dir, 'never.jsonl'), dedup, sink);
    expect(loaded).toBe(0);
    expect(sink).toEqual([]);
  });

  it('does not double-count when the JSONL has duplicates', async () => {
    const dir = tmpDir();
    const jsonl = path.join(dir, 'dups.jsonl');
    const w = new JsonlWriter(jsonl);
    await w.write({ company_name: 'Acme', city: 'Belluno', pg_url: 'https://x' });
    await w.write({ company_name: 'Acme', city: 'Belluno', pg_url: 'https://x' }); // dup
    await w.close();
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    const loaded = await rehydrate(jsonl, dedup, sink);
    expect(loaded).toBe(1);
    expect(sink).toHaveLength(1);
  });
});
