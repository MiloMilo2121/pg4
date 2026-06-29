import { describe, expect, it } from 'vitest';
import { PlacesSourceAdapter, pickTopResult } from '../../src/judgment/harvest/adapters/places_adapter';
import type { HarvestContext, FetchInit } from '../../src/judgment/harvest/source_harvest';

function ctxWith(capture: { url?: string; init?: FetchInit }, body: string | undefined, paidEnabled = true): HarvestContext {
  return {
    tenantId: 't',
    cache: {} as HarvestContext['cache'],
    fetcher: async (url: string, init?: FetchInit) => {
      capture.url = url;
      capture.init = init;
      return body;
    },
    paidEnabled,
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

  it('a permanently-closed business does not assert a positive A rating signal', async () => {
    const cap: { url?: string; init?: FetchInit } = {};
    const closed = JSON.stringify({ places: [{ rating: 4.9, userRatingCount: 10, businessStatus: 'CLOSED_PERMANENTLY' }] });
    const res = await new PlacesSourceAdapter().harvest('X', ctxWith(cap, closed));
    expect(res.signals.some((s) => s.axis === 'A' && s.key === '2.4')).toBe(false);
    expect(res.attributes.business_status).toBe('CLOSED_PERMANENTLY');
  });
});
