import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * fetchFatturatoItalia behaviour contract — the two-step flow (search POST →
 * slug GET) mocked at the network boundary. Pins the transient-vs-definitive
 * memoisation rules and the site-wide circuit breaker: an unchecked GET status
 * memoised error shells as definitive misses.
 *
 * Module state (memo, breaker) is per-import, so every test re-imports a FRESH
 * module via vi.resetModules(). The rate limiter is stubbed (the real one paces
 * ~1 req/4s — measured good-citizen spacing, pointless in a unit test).
 */

const requestMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));
vi.mock('../../src/providers/http/direct_fetch', () => ({
  DirectFetchProvider: class {
    fetch(...a: unknown[]) {
      return fetchMock(...a);
    }
  },
}));
vi.mock('../../src/runtime/rate_limiter', () => ({
  RateLimiter: class {
    configure() {}
    async acquire() {}
  },
}));

// Checksum-valid synthetic P.IVAs (Luhn-style Italian check digit).
const VATS = ['11111111115', '22222222220', '33333333335', '44444444440', '55555555550', '66666666665'];

// `headers` is part of every real undici response — the redirect helper reads
// `headers.location` on each hop, so a stub without it models nothing.
const searchHit = (vat: string, url: string) => ({
  statusCode: 200,
  headers: {},
  body: { json: async () => ({ success: true, results: [{ tax_code: vat, url }] }), dump: async () => {} },
});
const searchEmpty = () => ({
  statusCode: 200,
  headers: {},
  body: { json: async () => ({ success: true, results: [] }), dump: async () => {} },
});
const searchError = (statusCode: number) => ({
  statusCode,
  headers: {},
  body: { json: async () => ({}), dump: async () => {} },
});

const PAGE_OK = `<html><body><h1>ESEMPIO SPA</h1><table><tbody>
<tr><th scope="row">Ragione sociale</th><td>ESEMPIO SPA</td></tr>
<tr><th scope="row">Fatturato 2024</th><td>&euro; 1.000.000</td></tr>
</tbody></table></body></html>`;

async function freshFetch() {
  vi.resetModules();
  const mod = await import('../../src/enrichment/financial/fatturato_italia_fetch.js');
  return mod.fetchFatturatoItalia;
}

beforeEach(() => {
  requestMock.mockReset();
  fetchMock.mockReset();
});

describe('fetchFatturatoItalia — two-step flow + memo rules', () => {
  it('resolves search→slug→page, absolutises the relative url, memoises the hit', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchHit(VATS[0], '/esempio-spa-' + VATS[0]));
    fetchMock.mockResolvedValue({ status: 200, html: PAGE_OK });

    const r1 = await fetchFatturatoItalia(VATS[0]);
    expect(r1?.revenue_amount).toBe(1_000_000);
    expect(fetchMock).toHaveBeenCalledWith(`https://www.fatturatoitalia.it/esempio-spa-${VATS[0]}`, expect.anything());

    const r2 = await fetchFatturatoItalia(VATS[0]); // memo hit — no new network
    expect(r2?.revenue_amount).toBe(1_000_000);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('memoises an empty search result as a DEFINITIVE miss (VAT not indexed)', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchEmpty());

    expect(await fetchFatturatoItalia(VATS[1])).toBeUndefined();
    expect(await fetchFatturatoItalia(VATS[1])).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1); // second call served from memo
  });

  it('does NOT memoise a search HTTP error (transient — retried on next call)', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchError(500));

    expect(await fetchFatturatoItalia(VATS[2])).toBeUndefined();
    expect(await fetchFatturatoItalia(VATS[2])).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(2); // retried — not memoised
  });

  it('treats an error-status page GET (403/404/5xx shell) as TRANSIENT, never parsing it', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchHit(VATS[3], `/esempio-spa-${VATS[3]}`));
    fetchMock.mockResolvedValue({ status: 403, html: '<html><body>Access denied</body></html>' });

    expect(await fetchFatturatoItalia(VATS[3])).toBeUndefined();
    expect(await fetchFatturatoItalia(VATS[3])).toBeUndefined();
    // both calls went to the network — the 403 was NOT memoised as a miss
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after 5 consecutive transient failures and stops hitting the site', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchError(503));

    for (let i = 0; i < 5; i++) {
      expect(await fetchFatturatoItalia(VATS[i])).toBeUndefined();
    }
    expect(requestMock).toHaveBeenCalledTimes(5);

    // breaker open: the 6th lookup answers fast with NO network call
    expect(await fetchFatturatoItalia(VATS[5])).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(5);
  });

  it('a success resets the transient streak (no spurious circuit opening)', async () => {
    const fetchFatturatoItalia = await freshFetch();
    // 4 transients, then a success, then 1 more transient → breaker must stay closed
    requestMock
      .mockResolvedValueOnce(searchError(500))
      .mockResolvedValueOnce(searchError(500))
      .mockResolvedValueOnce(searchError(500))
      .mockResolvedValueOnce(searchError(500))
      .mockResolvedValueOnce(searchHit(VATS[4], `/esempio-spa-${VATS[4]}`))
      .mockResolvedValue(searchError(500));
    fetchMock.mockResolvedValue({ status: 200, html: PAGE_OK });

    for (let i = 0; i < 4; i++) await fetchFatturatoItalia(VATS[i]);
    expect((await fetchFatturatoItalia(VATS[4]))?.revenue_amount).toBe(1_000_000);
    await fetchFatturatoItalia(VATS[5]); // 1 transient after the reset
    // breaker closed → this next call still reaches the network
    await fetchFatturatoItalia(VATS[0]);
    expect(requestMock).toHaveBeenCalledTimes(7);
  });
});

describe('fetchFatturatoItalia — breaker per host and per window, not a process-wide trip-wire', () => {
  const T0 = new Date('2026-09-30T08:00:00Z').getTime();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transients scattered across a long run never add up to an open circuit', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchError(503));

    for (let i = 0; i < 4; i++) await fetchFatturatoItalia(VATS[i]);
    vi.setSystemTime(T0 + 121_000); // the 120 s window has passed
    for (let i = 0; i < 4; i++) await fetchFatturatoItalia(VATS[i]);
    // 8 transients, never 5 inside one window → still closed, still calling
    await fetchFatturatoItalia(VATS[5]);
    expect(requestMock).toHaveBeenCalledTimes(9);
  });

  it("one lead's missing page (404/410) is not a host failure", async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockImplementation(async (_url: string, o: { body?: string }) => {
      const vat = new URLSearchParams(o.body ?? '').get('search_query') ?? '';
      return searchHit(vat, `/gone-${vat}`);
    });
    fetchMock.mockResolvedValueOnce({ status: 410, html: 'gone' }).mockResolvedValue({ status: 404, html: 'not found' });

    for (const vat of VATS) expect(await fetchFatturatoItalia(vat)).toBeUndefined();
    // six lookups, six searches: the breaker never opened
    expect(requestMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('a WAF on the pages trips the breaker even though the search keeps answering', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockImplementation(async (_url: string, o: { body?: string }) => {
      const vat = new URLSearchParams(o.body ?? '').get('search_query') ?? '';
      return searchHit(vat, `/esempio-${vat}`);
    });
    fetchMock.mockResolvedValue({ status: 403, html: '<html>Access denied</html>' });

    for (let i = 0; i < 5; i++) await fetchFatturatoItalia(VATS[i]);
    expect(await fetchFatturatoItalia(VATS[5])).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(5); // the 6th never left
  });

  it('half-opens after the cool-down: one probe goes out, a failure re-opens at once, a success closes', async () => {
    const fetchFatturatoItalia = await freshFetch();
    requestMock.mockResolvedValue(searchError(503));
    for (let i = 0; i < 5; i++) await fetchFatturatoItalia(VATS[i]);
    await fetchFatturatoItalia(VATS[5]);
    expect(requestMock).toHaveBeenCalledTimes(5); // open

    vi.setSystemTime(T0 + 300_000); // cool-down over → half-open
    await fetchFatturatoItalia(VATS[5]); // the probe fails …
    expect(requestMock).toHaveBeenCalledTimes(6);
    await fetchFatturatoItalia(VATS[0]); // … and the circuit is open again
    expect(requestMock).toHaveBeenCalledTimes(6);

    vi.setSystemTime(T0 + 600_000);
    requestMock.mockResolvedValue(searchHit(VATS[1], `/esempio-spa-${VATS[1]}`));
    fetchMock.mockResolvedValue({ status: 200, html: PAGE_OK });
    expect((await fetchFatturatoItalia(VATS[1]))?.revenue_amount).toBe(1_000_000);
    requestMock.mockResolvedValue(searchEmpty());
    await fetchFatturatoItalia(VATS[2]); // closed: the next lookup goes out
    expect(requestMock).toHaveBeenCalledTimes(8);
  });
});
