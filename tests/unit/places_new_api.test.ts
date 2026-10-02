import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlacesSourceAdapter, pickTopResult } from '../../src/judgment/harvest/adapters/places_adapter';
import type { HarvestContext, FetchInit } from '../../src/judgment/harvest/source_harvest';
import { resetEnvCache } from '../../src/config/env';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CALL_COST_EUR } from '../../src/providers/pricing';

const saved = { enabled: process.env.GOOGLE_PLACES_ENABLED, key: process.env.GOOGLE_PLACES_API_KEY };
beforeAll(() => {
  process.env.GOOGLE_PLACES_ENABLED = 'true';
  process.env.GOOGLE_PLACES_API_KEY = 'k-test-not-a-real-key';
  resetEnvCache();
});
afterAll(() => {
  if (saved.enabled === undefined) delete process.env.GOOGLE_PLACES_ENABLED;
  else process.env.GOOGLE_PLACES_ENABLED = saved.enabled;
  if (saved.key === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = saved.key;
  resetEnvCache();
});

function ctxWith(capture: { url?: string; init?: FetchInit }, body: string | undefined, paidEnabled = true, ledger = new CostLedger()): HarvestContext {
  return {
    tenantId: 't',
    cache: {} as HarvestContext['cache'],
    fetcher: async (url: string, init?: FetchInit) => {
      capture.url = url;
      capture.init = init;
      return body;
    },
    paidEnabled,
    router: new ProviderRouter([], [], [], ledger),
    now: () => 0,
  };
}

const NEW_SHAPE = JSON.stringify({
  places: [{ displayName: { text: 'Trattoria X' }, rating: 4.6, userRatingCount: 213, formattedAddress: 'Via Roma 1, Padova', businessStatus: 'OPERATIONAL' }],
});

describe('Places adapter — New API migration (AC7)', () => {
  it('pickTopResult parses the NEW shape (places[].rating/userRatingCount)', () => {
    const top = pickTopResult(JSON.parse(NEW_SHAPE));
    expect(top).toMatchObject({ rating: 4.6, userRatingCount: 213, formattedAddress: 'Via Roma 1, Padova', businessStatus: 'OPERATIONAL' });
    expect(pickTopResult({ results: [{ rating: 4 }] })).toBeUndefined(); // legacy shape no longer parsed
  });

  it('harvest POSTs to the New endpoint with an X-Goog-FieldMask header', async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const adapter = new PlacesSourceAdapter();
    const res = await adapter.harvest('Trattoria X Padova', ctxWith(cap, NEW_SHAPE));
    expect(cap.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(cap.init?.method).toBe('POST');
    expect(cap.init?.headers?.['X-Goog-FieldMask']).toContain('places.rating');
    expect(cap.url).not.toContain('maps.googleapis.com'); // legacy endpoint gone
    expect(res.ok).toBe(true);
    expect(res.signals.some((s) => s.axis === 'A' && s.key === '2.4')).toBe(true);
    expect(res.attributes.address).toBe('Via Roma 1, Padova');
  });

  it('respects the paid gate (no fetch, ok:false when paidEnabled is false)', async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const res = await new PlacesSourceAdapter().harvest('X', ctxWith(cap, NEW_SHAPE, false));
    expect(cap.url).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it('records the Places call in the router ledger', async () => {
    const ledger = new CostLedger();
    await new PlacesSourceAdapter().harvest('X', ctxWith({}, NEW_SHAPE, true, ledger));
    expect(ledger.getByProvider().google_places?.calls).toBe(1);
    expect(ledger.getTotal()).toBeCloseTo(CALL_COST_EUR.google_places, 6);
  });

  it('makes no request without a router, even with paid enabled', async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const res = await new PlacesSourceAdapter().harvest('X', { ...ctxWith(cap, NEW_SHAPE), router: undefined });
    expect(cap.url).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it('a permanently-closed business does not assert a positive A rating signal', async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const closed = JSON.stringify({ places: [{ rating: 4.9, userRatingCount: 10, businessStatus: 'CLOSED_PERMANENTLY' }] });
    const res = await new PlacesSourceAdapter().harvest('X', ctxWith(cap, closed));
    expect(res.signals.some((s) => s.axis === 'A' && s.key === '2.4')).toBe(false);
    expect(res.attributes.business_status).toBe('CLOSED_PERMANENTLY');
  });
});
