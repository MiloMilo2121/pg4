import { describe, it, expect } from 'vitest';
import { verifyCandidates } from '../../src/enrichment/stages/verify_candidates';
import { normalizeLead } from '../../src/discovery/input_normalizer';
import type { Lead } from '../../src/types/lead';
import { ProviderRouter } from '../../src/providers/provider_router';
import type { RouteOptions } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { HttpFetchResult } from '../../src/types/providers';

/**
 * Phase D.2 — single retry on transport flap (pianon.eu / ECONNREFUSED).
 * Phase D.3 — scheduled multi-retry [300, 1000, 3000]ms with jitter,
 *             extended to 502/503/504; per-candidate budget cap;
 *             ledger logs every attempt; breaker not amplified.
 *
 * Rules pinned by this file (must hold across both phases):
 *   1. Retry only on `transport` / `timeout` / 502 / 503 / 504.
 *   2. Never retry on 4xx (404/403), 429 (rate-limit), semantic reject,
 *      sector conflict, parked / tiny page, common-stem reject.
 *   3. Each retry uses `bypassBreakerRecord: true` — first attempt
 *      already counted toward the breaker.
 *   4. Retry budget cap: cumulative delay never exceeds the budget.
 */

type PlannedFetch = Pick<HttpFetchResult, 'status'> & Partial<Omit<HttpFetchResult, 'status' | 'duration_ms' | 'cost_eur' | 'provider'>>;

class FakeRouter extends ProviderRouter {
  private calls = 0;
  private readonly seen: Array<{ url: string; bypassBreakerRecord?: boolean }> = [];

  constructor(private readonly plan: PlannedFetch[]) {
    super([], [], [], new CostLedger());
  }

  override async fetch(url: string, opts: RouteOptions & { timeoutMs?: number } = {}): Promise<HttpFetchResult> {
    this.seen.push({ url, bypassBreakerRecord: opts.bypassBreakerRecord });
    const next = this.plan[Math.min(this.calls, this.plan.length - 1)];
    this.calls++;
    return { provider: 'direct_fetch', duration_ms: 5, cost_eur: 0, ...next };
  }

  fetchCalls(): number {
    return this.calls;
  }

  seenOpts(): Array<{ url: string; bypassBreakerRecord?: boolean }> {
    return this.seen;
  }
}

function fakeRouter(plan: PlannedFetch[]): FakeRouter {
  return new FakeRouter(plan);
}

const realEstateBody =
  'Compravendita e locazione di appartamenti. Immobili in vendita. ' +
  'Trovi monolocale, bilocale, trilocale, ville e immobili commerciali. ' +
  'Servizio di valutazione gratuita. Consulenza per mutuo. Selezioniamo ' +
  'accuratamente gli immobili in linea con le richieste della clientela. ' +
  'Pubblichiamo costantemente nuove proposte di immobili in vendita e in affitto. ' +
  'Servizi offerti: gestione contratti di locazione, consulenza fiscale sugli ' +
  'investimenti, verifica della regolarità urbanistica e catastale. ' +
  'Iscritta al ruolo agenti immobiliari. ' +
  'Contatti per richiedere informazioni o fissare un appuntamento. ' +
  'La nostra agenzia opera da oltre venti anni nel territorio bellunese, ' +
  'garantendo serieta e professionalita a chi cerca o vende casa nelle Dolomiti. ' +
  'Lavoriamo con appartamenti, case singole, ville, terreni edificabili, attivita commerciali. ' +
  'Visita la sede in centro a Belluno per scoprire tutte le proposte disponibili.';
const goodHtml = `<html><head><title>Pianon</title></head><body><h1>Pianon</h1><p>${realEstateBody}</p></body></html>`;

const lead: Lead = { company_name: 'Pianon Immobiliare', city: 'Belluno', category: 'agenzie immobiliari' };
const normalized = normalizeLead(lead);
const noOpRdap = async () => ({ confidence: 0, evidence: 'none' as const });
const baseOpts = {
  timeoutMs: 1000,
  rdapProbe: noOpRdap,
  jitter: (d: number) => d,
  sleep: async (_: number) => {},
};

describe('verifyCandidates — Phase D.2 single retry (legacy invariants)', () => {
  it('retries once on ECONNREFUSED and accepts on the second try (200)', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED 167.235.73.251' },
      { status: 200, html: goodHtml },
    ]);
    const lead2: Lead = { ...lead };
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, lead2, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(true);
    expect(router.fetchCalls()).toBe(2);
    expect(lead2.official_website).toBe('https://pianon.eu');
  });

  it('retries once on ETIMEDOUT and accepts on the second try', async () => {
    const router = fakeRouter([
      { status: 0, error: 'request ETIMEDOUT after 5000ms' },
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(true);
    expect(router.fetchCalls()).toBe(2);
  });

  it('does NOT retry on 404 (per-target outcome, not transport)', async () => {
    const router = fakeRouter([
      { status: 404, error: 'not found' },
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(1);
  });

  it('does NOT retry on 429 rate-limit (would re-trigger the limit)', async () => {
    const router = fakeRouter([
      { status: 429, error: 'rate limit exceeded' },
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(1);
  });

  it('does NOT retry when gate semantically rejects a fetched page', async () => {
    const conflictHtml =
      '<html><body>' +
      'Cartoleria e cancelleria, toner e cartucce per stampanti. '.repeat(15) +
      '</body></html>';
    const router = fakeRouter([{ status: 200, html: conflictHtml }]);
    const verdict = await verifyCandidates(router, ['https://ufficio.com'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(1);
  });

  it('retry sets bypassBreakerRecord so a flapped target does not double-count toward breaker', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    const seen = router.seenOpts();
    expect(seen.length).toBe(2);
    expect(seen[0].bypassBreakerRecord).toBeFalsy();
    expect(seen[1].bypassBreakerRecord).toBe(true);
  });

  it('retryDelaysMs=[] disables retry entirely', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [],
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(1);
  });
});

describe('verifyCandidates — Phase D.3 scheduled multi-retry', () => {
  it('two transport fails then 200 → matched (2 retries used out of 3 max)', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0, 0, 0],
    });
    expect(verdict.matched).toBe(true);
    expect(router.fetchCalls()).toBe(3);
  });

  it('all attempts fail → NOT_FOUND (3 attempts: 1 initial + 2 retries, all ECONNREFUSED)', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' }, // attempt 1
      { status: 0, error: 'ECONNREFUSED' }, // attempt 2 (retry 1)
      { status: 0, error: 'ECONNREFUSED' }, // attempt 3 (retry 2)
      { status: 200, html: goodHtml }, // never reached
    ]);
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0, 0], // 2 retries
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(3); // 1 first + 2 retries; never reaches plan[3]
  });

  it('retries on upstream 502 / 503 / 504 (transient infra failure)', async () => {
    for (const code of [502, 503, 504]) {
      const router = fakeRouter([
        { status: code, error: `upstream ${code}` },
        { status: 200, html: goodHtml },
      ]);
      const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
        ...baseOpts,
        retryDelaysMs: [0, 0, 0],
      });
      expect(verdict.matched, `code=${code}`).toBe(true);
      expect(router.fetchCalls(), `code=${code}`).toBe(2);
    }
  });

  it('retry budget caps cumulative delay — third retry skipped when over budget', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    // schedule [300, 1000, 3000] but budget is 1500ms → only first 2
    // delays fit (300+1000=1300 ≤ 1500); third (would be +3000) skipped.
    const verdict = await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [300, 1000, 3000],
      retryBudgetMs: 1500,
    });
    expect(verdict.matched).toBe(false);
    expect(router.fetchCalls()).toBe(3); // 1 first + 2 retries (3rd budget-skipped)
  });

  it('all retry attempts go through the router and are recorded by ledger', async () => {
    // The router fake counts every fetch — proxy for "the ledger sees
    // every attempt", since the real router records to ledger on each
    // call. Phase D.3 invariant: retries must NOT bypass ledger.
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0, 0, 0],
    });
    expect(router.fetchCalls()).toBe(3); // full visibility
  });

  it('every retry attempt sets bypassBreakerRecord (no breaker amplification)', async () => {
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0, 0, 0],
    });
    const seen = router.seenOpts();
    expect(seen.length).toBe(4);
    expect(seen[0].bypassBreakerRecord).toBeFalsy();
    // Every subsequent attempt must bypass the breaker.
    expect(seen[1].bypassBreakerRecord).toBe(true);
    expect(seen[2].bypassBreakerRecord).toBe(true);
    expect(seen[3].bypassBreakerRecord).toBe(true);
  });

  it('per-candidate plan: weak plan (retryDelaysMs=[]) gets one attempt, strong plan gets the budget', async () => {
    // D.4: HyperGuesserStage gives `weak` candidates `retryDelaysMs: []`
    // so a flapping homonym does not eat the per-stage budget. Strong
    // candidates inherit the global default schedule.
    const { verifyPlannedCandidates } = await import('../../src/enrichment/stages/verify_candidates');
    const plan = [
      { url: 'https://weak-homonym.com', retryDelaysMs: [] as number[], retryBudgetMs: 0 }, // weak: no retry
      { url: 'https://pianon.eu' }, // strong: default schedule, lead-matching domain
    ];
    const router = fakeRouter([
      // weak attempt — fail, no retry
      { status: 0, error: 'ECONNREFUSED' },
      // strong attempt 1 — fail, retry
      { status: 0, error: 'ECONNREFUSED' },
      // strong retry — success
      { status: 200, html: goodHtml },
    ]);
    const verdict = await verifyPlannedCandidates(router, plan, normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0, 0],
    });
    expect(verdict.matched).toBe(true);
    expect(router.fetchCalls()).toBe(3); // weak: 1, strong: 2 (1 + 1 retry)
  });

  it('Phase G hotfix — directory / registry URL is rejected before fetch', async () => {
    // The pg4 SerpDeduplicator's registry-pivot logic kept paginegialle.it
    // around for a hypothetical pivot, but pg4 has no pivot stage. Such
    // URLs must NEVER reach verify let alone become official_website.
    const router = fakeRouter([{ status: 200, html: goodHtml }]);
    const verdict = await verifyCandidates(router, ['https://www.paginegialle.it/some-listing'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [0],
    });
    expect(verdict.matched).toBe(false);
    expect(verdict.rejectDetail).toBe('directory_or_portal');
    // Crucially: no fetch happened.
    expect(router.fetchCalls()).toBe(0);
  });

  it('jitter is applied to each scheduled delay', async () => {
    const slept: number[] = [];
    const router = fakeRouter([
      { status: 0, error: 'ECONNREFUSED' },
      { status: 0, error: 'ECONNREFUSED' },
      { status: 200, html: goodHtml },
    ]);
    await verifyCandidates(router, ['https://pianon.eu'], normalized, { ...lead }, {
      ...baseOpts,
      retryDelaysMs: [100, 1000],
      jitter: (d) => d * 1.5, // deterministic non-identity jitter
      sleep: async (ms: number) => { slept.push(ms); },
    });
    expect(slept).toEqual([150, 1500]);
  });
});
