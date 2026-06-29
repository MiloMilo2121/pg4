import { describe, it, expect } from 'vitest';
import { verifyCandidates } from '../../src/enrichment/stages/verify_candidates';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { HttpProvider, HttpFetchResult } from '../../src/types/providers';
import type { Lead } from '../../src/types/lead';

/**
 * R6.1 — verifyCandidates per-lead fetch cache.
 *
 * The Liviana regression in p_recal_pd_free showed PgDetailStage and
 * HyperGuesser fetching the same flaky host within seconds and both
 * timing out independently. The cache makes the second caller see
 * the first caller's result (success or failure) without re-issuing
 * the HTTP request.
 */

class CountingHttp implements HttpProvider {
  id = 'count_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  callCount = 0;
  constructor(private response: Partial<HttpFetchResult> & { html?: string; status: number }) {}
  available() { return true; }
  async fetch(url: string): Promise<HttpFetchResult> {
    this.callCount += 1;
    return {
      status: this.response.status,
      html: this.response.html,
      finalUrl: url,
      duration_ms: 0,
      cost_eur: 0,
      provider: this.id,
      error: this.response.error,
    };
  }
}

const NORM = {
  company_name: 'Foo S.r.l.',
  company_name_variants: [],
  city: 'Padova',
  vat_code: '01234567890',
  phone: '049 1234567',
  quality_score: 0.5,
  raw: {} as Lead,
};

describe('verifyCandidates fetchCache (R6.1)', () => {
  it('caches a SUCCESSFUL fetch — second call to same URL skips the network', async () => {
    const ledger = new CostLedger();
    const http = new CountingHttp({
      status: 200,
      html: `<html><body><h1>Foo S.r.l.</h1><p>Via Roma, Padova. P.IVA 01234567890</p></body></html>`,
    });
    const router = new ProviderRouter([], [http], [], ledger);
    const cache = new Map<string, HttpFetchResult>();
    const lead: Lead = { company_name: 'Foo S.r.l.' };

    const r1 = await verifyCandidates(router, ['https://www.foosrl.com'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    expect(r1.matched).toBe(true);
    expect(http.callCount).toBe(1);

    // Second invocation on the same URL — should hit cache, no new fetch.
    const r2 = await verifyCandidates(router, ['https://www.foosrl.com'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    expect(r2.matched).toBe(true);
    expect(http.callCount).toBe(1); // unchanged — cache hit
  });

  it('caches a FAILED fetch — second caller short-circuits without re-trying', async () => {
    const ledger = new CostLedger();
    const http = new CountingHttp({ status: 0, error: 'ETIMEDOUT' });
    const router = new ProviderRouter([], [http], [], ledger);
    const cache = new Map<string, HttpFetchResult>();
    const lead: Lead = { company_name: 'Liviana Immobiliare' };

    // First caller (e.g. PgDetailStage) fetches → timeout.
    await verifyCandidates(router, ['https://livianaimmobiliare.it'], NORM, lead, {
      retryDelaysMs: [], // disable retries to keep the test deterministic
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    expect(http.callCount).toBe(1);

    // Second caller (e.g. HyperGuesser) on the same URL — must NOT
    // re-fetch. The cached failure is enough.
    await verifyCandidates(router, ['https://livianaimmobiliare.it'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    expect(http.callCount).toBe(1); // crucial: no double-fetch on flaky hosts
  });

  it('canonicalises trailing slash so /contatti and /contatti/ are the same key', async () => {
    const ledger = new CostLedger();
    const http = new CountingHttp({
      status: 200,
      html: `<html><body><h1>Foo S.r.l.</h1><p>P.IVA 01234567890 Padova</p></body></html>`,
    });
    const router = new ProviderRouter([], [http], [], ledger);
    const cache = new Map<string, HttpFetchResult>();
    const lead: Lead = { company_name: 'Foo S.r.l.' };

    await verifyCandidates(router, ['https://www.foosrl.com/contatti'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    await verifyCandidates(router, ['https://www.foosrl.com/contatti/'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
      fetchCache: cache,
    });
    expect(http.callCount).toBe(1);
  });

  it('NO cache provided → every call hits the network (back-compat)', async () => {
    const ledger = new CostLedger();
    const http = new CountingHttp({
      status: 200,
      html: `<html><body><h1>Foo S.r.l.</h1><p>P.IVA 01234567890</p></body></html>`,
    });
    const router = new ProviderRouter([], [http], [], ledger);
    const lead: Lead = { company_name: 'Foo S.r.l.' };

    await verifyCandidates(router, ['https://www.foosrl.com'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
    });
    await verifyCandidates(router, ['https://www.foosrl.com'], NORM, lead, {
      retryDelaysMs: [],
      corroborateWithRdap: false,
    });
    expect(http.callCount).toBe(2);
  });
});
