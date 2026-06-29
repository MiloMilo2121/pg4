import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Checkpoint } from '../../src/runtime/checkpoint';
import { Deduplicator } from '../../src/discovery/deduper';
import { JsonlWriter } from '../../src/io/jsonl_writer';
import { rehydrateFromPriorRun, MissingPriorJsonlError } from '../../src/discovery/resume_prior_run';
import type { Lead } from '../../src/types/lead';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-resume-stop-'));

/**
 * Phase 4.2.1 — resume must HARD ERROR by default when the JSONL is
 * missing but the checkpoint says pages are done. Otherwise the
 * resulting CSV silently loses every lead from those pages.
 */

describe('rehydrateFromPriorRun: missing JSONL', () => {
  it('throws MissingPriorJsonlError when checkpoint has done entries and JSONL is missing', async () => {
    const dir = tmpDir();
    const cpFile = path.join(dir, 'cp.json');
    const cp = new Checkpoint(cpFile);
    cp.set('pg:cat:loc:p1', { status: 'done', total_cards: 10 });
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    await expect(
      rehydrateFromPriorRun({
        jsonlPath: path.join(dir, 'never-existed.jsonl'),
        checkpoint: cp,
        dedup,
        sink,
      })
    ).rejects.toBeInstanceOf(MissingPriorJsonlError);
    expect(sink).toEqual([]);
  });

  it('proceeds with a logged error when --allow-missing-jsonl is passed', async () => {
    const dir = tmpDir();
    const cp = new Checkpoint(path.join(dir, 'cp.json'));
    cp.set('pg:cat:loc:p1', { status: 'done', total_cards: 10 });
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    const loaded = await rehydrateFromPriorRun({
      jsonlPath: path.join(dir, 'still-missing.jsonl'),
      checkpoint: cp,
      dedup,
      sink,
      allowMissingJsonl: true,
    });
    expect(loaded).toBe(0);
    expect(sink).toEqual([]); // operator opted into the data loss
  });

  it('cold start (empty checkpoint) works regardless of JSONL presence', async () => {
    const dir = tmpDir();
    const cp = new Checkpoint(path.join(dir, 'cp.json'));
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    const loaded = await rehydrateFromPriorRun({
      jsonlPath: path.join(dir, 'absent.jsonl'),
      checkpoint: cp,
      dedup,
      sink,
    });
    expect(loaded).toBe(0); // no error, no leads — cold start
  });

  it('happy path: prior JSONL + checkpoint → leads loaded', async () => {
    const dir = tmpDir();
    const jsonl = path.join(dir, 'raw.jsonl');
    const w = new JsonlWriter(jsonl);
    await w.write({ company_name: 'Studio Foo', city: 'Belluno', pg_url: 'https://www.paginegialle.it/foo' });
    await w.write({ company_name: 'Acme', city: 'Belluno' });
    await w.close();
    const cp = new Checkpoint(path.join(dir, 'cp.json'));
    cp.set('pg:cat:loc:p1', { status: 'done' });
    const dedup = new Deduplicator();
    const sink: Lead[] = [];
    const loaded = await rehydrateFromPriorRun({
      jsonlPath: jsonl,
      checkpoint: cp,
      dedup,
      sink,
    });
    expect(loaded).toBe(2);
    expect(sink.map((l) => l.company_name).sort()).toEqual(['Acme', 'Studio Foo']);
  });

  it('error message points the operator at --fresh and --allow-missing-jsonl', async () => {
    const dir = tmpDir();
    const cp = new Checkpoint(path.join(dir, 'cp.json'));
    cp.set('pg:cat:loc:p1', { status: 'done' });
    try {
      await rehydrateFromPriorRun({
        jsonlPath: path.join(dir, 'gone.jsonl'),
        checkpoint: cp,
        dedup: new Deduplicator(),
        sink: [],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingPriorJsonlError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/--fresh/);
      expect(msg).toMatch(/--allow-missing-jsonl/);
      expect(msg).toMatch(/silently lose/i);
    }
  });
});
