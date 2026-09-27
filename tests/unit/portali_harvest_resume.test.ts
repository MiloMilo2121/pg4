import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApifyProvider, type ApifyHttpGet } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';
import { recoverPaidDataset } from '../../tools/enrich3/portali_harvest';

let dir: string;
let pending: string;
beforeEach(() => {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  resetEnvCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-portali-'));
  pending = path.join(dir, 'unit.jsonl.pending.json');
});
afterEach(() => {
  delete process.env.APIFY_ENABLED;
  delete process.env.APIFY_API_KEY;
  resetEnvCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const noRun = async (): Promise<never> => {
  throw new Error('must not start a run');
};
const provider = (get: ApifyHttpGet) => new ApifyProvider(noRun, get, { retryBaseMs: 0 });

describe('portali_harvest — resume of an already-paid dataset', () => {
  it('re-downloads the dataset (no new run)', async () => {
    fs.writeFileSync(pending, JSON.stringify({ runId: 'r', datasetId: 'ds1' }));
    const out = await recoverPaidDataset(provider(async () => ({ status: 200, json: [{ a: 1 }] })), pending, 10);
    expect(out).toEqual([{ a: 1 }]);
  });

  it('a transient failure keeps the pending file for the next resume', async () => {
    fs.writeFileSync(pending, JSON.stringify({ datasetId: 'ds1' }));
    expect(await recoverPaidDataset(provider(async () => ({ status: 503, json: {} })), pending, 10)).toBe('retry-later');
    expect(fs.existsSync(pending)).toBe(true);
  });

  it.each([
    ['a dataset gone past retention (404)', JSON.stringify({ datasetId: 'ds1' }), { status: 404, json: {} }],
    ['an empty dataset', JSON.stringify({ datasetId: 'ds1' }), { status: 200, json: [] }],
    ['a corrupt pending file', '{not json', { status: 200, json: [] }],
    ['a pending file without datasetId', JSON.stringify({ runId: 'r' }), { status: 200, json: [] }],
  ])('%s drops the pending file so the unit is harvested again (never stuck)', async (_label, content, reply) => {
    fs.writeFileSync(pending, content);
    expect(await recoverPaidDataset(provider(async () => reply), pending, 10)).toBe('none');
    expect(fs.existsSync(pending)).toBe(false);
  });
});
