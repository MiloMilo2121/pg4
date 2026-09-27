import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyProvider, ApifyRunError, type ApifyHttpGet, type ApifyHttpPost } from '../../src/providers/apify/apify_provider';
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
    const p = new ApifyProvider(startOk, get, { retryBaseMs: 0 });
    const run = await p.runActorAsync('maps', { q: 'x' }, { maxItems: 10, pollMs: 0, timeoutMs: 5000 });
    expect(run.items).toHaveLength(2);
    expect(run.runId).toBe('run1');
    expect(run.datasetId).toBe('ds1');
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('THROWS on a terminal non-success run (FAILED must not read as empty)', async () => {
    enableApify();
    const get: ApifyHttpGet = async (url) =>
      url.includes('/actor-runs/') ? { status: 200, json: { data: { status: 'FAILED' } } } : { status: 200, json: [] };
    const p = new ApifyProvider(startOk, get, { retryBaseMs: 0 });
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
    const p = new ApifyProvider(startOk, get, { retryBaseMs: 0 });
    await expect(p.runActorAsync('maps', {}, { pollMs: 0, timeoutMs: 1 })).rejects.toThrow(/still RUNNING/);
  });
});

/** GET mock: run SUCCEEDED, dataset metadata says `itemCount`, items endpoint scripted per call. */
function succeededGet(itemCount: number | undefined, itemsReplies: Array<{ status: number; json: unknown }>): { get: ApifyHttpGet; itemsCalls: () => number } {
  let n = 0;
  const get: ApifyHttpGet = async (url) => {
    if (url.includes('/actor-runs/run1')) return { status: 200, json: { data: { status: 'SUCCEEDED' } } };
    if (url.includes('/datasets/ds1/items')) return itemsReplies[Math.min(n++, itemsReplies.length - 1)];
    if (url.includes('/datasets/ds1?')) return itemCount === undefined ? { status: 500, json: {} } : { status: 200, json: { data: { itemCount } } };
    return { status: 404, json: {} };
  };
  return { get, itemsCalls: () => n };
}

describe('ApifyProvider.runActorAsync — money safety', () => {
  const MAPS_UNIT = 0.002;

  it('costs what the actor PUSHED, not what `limit` downloaded (maxItems overshoot)', async () => {
    enableApify();
    const { get } = succeededGet(5, [{ status: 200, json: [{ a: 1 }, { a: 2 }] }]);
    const run = await new ApifyProvider(startOk, get, { retryBaseMs: 0 }).runActorAsync('maps', {}, { maxItems: 2, pollMs: 0 });
    expect(run.items).toHaveLength(2);
    expect(run.billedItems).toBe(5);
    expect(run.cost_eur).toBeCloseTo(5 * MAPS_UNIT);
  });

  it('falls back to the downloaded count when dataset metadata is unreadable', async () => {
    enableApify();
    const { get } = succeededGet(undefined, [{ status: 200, json: [{ a: 1 }, { a: 2 }, { a: 3 }] }]);
    const run = await new ApifyProvider(startOk, get, { retryBaseMs: 0 }).runActorAsync('maps', {}, { pollMs: 0 });
    expect(run.billedItems).toBe(3);
  });

  it('retries a transient 5xx on the items download', async () => {
    enableApify();
    const { get, itemsCalls } = succeededGet(1, [{ status: 502, json: {} }, { status: 200, json: [{ a: 1 }] }]);
    const run = await new ApifyProvider(startOk, get, { retryBaseMs: 0 }).runActorAsync('maps', {}, { pollMs: 0 });
    expect(run.items).toHaveLength(1);
    expect(itemsCalls()).toBe(2);
  });

  it('a SUCCEEDED run whose download keeps failing THROWS with ids + real cost (never a silent [] / €0)', async () => {
    enableApify();
    const { get } = succeededGet(4, [{ status: 503, json: {} }]);
    const err = await new ApifyProvider(startOk, get, { retryBaseMs: 0 })
      .runActorAsync('maps', {}, { pollMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApifyRunError);
    const e = err as ApifyRunError;
    expect(e.succeeded).toBe(true);
    expect(e.runId).toBe('run1');
    expect(e.datasetId).toBe('ds1');
    expect(e.cost_eur).toBeCloseTo(4 * MAPS_UNIT);
  });

  it('a non-array 200 body is a failure, not "the actor found nothing"', async () => {
    enableApify();
    const { get } = succeededGet(0, [{ status: 200, json: { error: 'weird' } }]);
    await expect(new ApifyProvider(startOk, get, { retryBaseMs: 0 }).runActorAsync('maps', {}, { pollMs: 0 })).rejects.toBeInstanceOf(ApifyRunError);
  });

  it('ABORTS the run on deadline (it would keep billing) and reports the pushed cost', async () => {
    enableApify();
    const posts: string[] = [];
    const post: ApifyHttpPost = async (url) => {
      posts.push(url);
      return url.includes('/abort') ? { status: 200, json: {} } : { status: 201, json: { data: { id: 'run1', defaultDatasetId: 'ds1', status: 'READY' } } };
    };
    const get: ApifyHttpGet = async (url) =>
      url.includes('/datasets/ds1?') ? { status: 200, json: { data: { itemCount: 7 } } } : { status: 200, json: { data: { status: 'RUNNING' } } };
    const err = (await new ApifyProvider(post, get, { retryBaseMs: 0 })
      .runActorAsync('maps', {}, { pollMs: 0, timeoutMs: 1 })
      .catch((e: unknown) => e)) as ApifyRunError;
    expect(posts.some((u) => u.includes('/actor-runs/run1/abort'))).toBe(true);
    expect(err.cost_eur).toBeCloseTo(7 * MAPS_UNIT);
  });

  it('a 4xx start costs €0; a 5xx start is unknown spend (router falls back to worst case)', async () => {
    enableApify();
    const noop: ApifyHttpGet = async () => ({ status: 200, json: [] });
    const e4 = (await new ApifyProvider(async () => ({ status: 400, json: {} }), noop).runActorAsync('maps', {}).catch((e: unknown) => e)) as ApifyRunError;
    expect(e4.cost_eur).toBe(0);
    const e5 = (await new ApifyProvider(async () => ({ status: 500, json: {} }), noop).runActorAsync('maps', {}).catch((e: unknown) => e)) as ApifyRunError;
    expect(e5.cost_eur).toBeUndefined();
  });

  it('fetchDatasetItems re-downloads a paid dataset without starting a run', async () => {
    enableApify();
    const post: ApifyHttpPost = async () => {
      throw new Error('must not start a run');
    };
    const { get } = succeededGet(2, [{ status: 200, json: [{ a: 1 }, { a: 2 }] }]);
    expect(await new ApifyProvider(post, get, { retryBaseMs: 0 }).fetchDatasetItems('ds1', 10)).toHaveLength(2);
  });
});
