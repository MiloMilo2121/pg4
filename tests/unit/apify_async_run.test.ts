import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyProvider, type ApifyHttpGet, type ApifyHttpPost } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';

function enableApify(): void {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  resetEnvCache();
}
function clearEnv(): void {
  for (const k of ['APIFY_ENABLED', 'APIFY_API_KEY']) delete process.env[k];
  resetEnvCache();
}
beforeEach(clearEnv);
afterEach(clearEnv);

const startOk: ApifyHttpPost = async () => ({
  status: 201,
  json: { data: { id: 'run1', defaultDatasetId: 'ds1', status: 'READY' } },
});

describe('ApifyProvider.runActorAsync', () => {
  it('start → poll (RUNNING → SUCCEEDED) → dataset items', async () => {
    enableApify();
    let polls = 0;
    const get: ApifyHttpGet = async (url) => {
      if (url.includes('/actor-runs/run1')) {
        polls += 1;
        return { status: 200, json: { data: { status: polls >= 2 ? 'SUCCEEDED' : 'RUNNING' } } };
      }
      if (url.includes('/datasets/ds1/items')) {
        expect(url).toContain('clean=true');
        expect(url).toContain('limit=10');
        return { status: 200, json: [{ a: 1 }, { a: 2 }] };
      }
      return { status: 404, json: {} };
    };
    const p = new ApifyProvider(startOk, get);
    const items = await p.runActorAsync('maps', { q: 'x' }, { maxItems: 10, pollMs: 0, timeoutMs: 5000 });
    expect(items).toHaveLength(2);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('THROWS on a terminal non-success run (FAILED must not read as empty)', async () => {
    enableApify();
    const get: ApifyHttpGet = async (url) =>
      url.includes('/actor-runs/') ? { status: 200, json: { data: { status: 'FAILED' } } } : { status: 200, json: [] };
    const p = new ApifyProvider(startOk, get);
    await expect(p.runActorAsync('maps', {}, { pollMs: 0 })).rejects.toThrow(/ended FAILED/);
  });

  it('THROWS when the run start is rejected', async () => {
    enableApify();
    const post: ApifyHttpPost = async () => ({ status: 400, json: {} });
    const p = new ApifyProvider(post, async () => ({ status: 200, json: [] }));
    await expect(p.runActorAsync('maps', {})).rejects.toThrow(/run start failed/);
  });

  it('THROWS past the deadline while the run never finishes', async () => {
    enableApify();
    const get: ApifyHttpGet = async () => ({ status: 200, json: { data: { status: 'RUNNING' } } });
    const p = new ApifyProvider(startOk, get);
    await expect(p.runActorAsync('maps', {}, { pollMs: 0, timeoutMs: 1 })).rejects.toThrow(/still RUNNING/);
  });
});
