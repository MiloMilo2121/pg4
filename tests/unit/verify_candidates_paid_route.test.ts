import { describe, it, expect } from 'vitest';
import { verifyCandidates, routeFromLeadContext } from '../../src/enrichment/stages/verify_candidates';
import { ProviderRouter, type RouteOptions } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { HttpFetchResult, HttpProvider } from '../../src/types/providers';
import type { Lead } from '../../src/types/lead';
import { normalizeLead } from '../../src/discovery/input_normalizer';

type FetchOpts = RouteOptions & { timeoutMs?: number };

function capturingRouter(responses: Array<{ status: number; html?: string; error?: string }>): { router: ProviderRouter; calls: FetchOpts[] } {
  const calls: FetchOpts[] = [];
  let i = 0;
  const router = {
    fetch: async (_url: string, opts: FetchOpts) => {
      calls.push(opts);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { provider: 'direct_fetch', status: r.status, html: r.html, error: r.error, duration_ms: 1, cost_eur: 0 };
    },
  } as unknown as ProviderRouter;
  return { router, calls };
}

const LEAD = { company_name: 'Immobiliare Acme' } as Lead;
const NORM = normalizeLead({ company_name: 'Immobiliare Acme', city: 'Padova' } as Lead);

describe('verify_candidates paid-route passthrough', () => {
  it('threads route (paidEnabled + budgets) into the fetch call', async () => {
    const { router, calls } = capturingRouter([{ status: 200, html: '<html><body>nothing relevant</body></html>' }]);
    await verifyCandidates(router, ['https://acme.it'], NORM, { ...LEAD }, {
      corroborateWithRdap: false,
      retryDelaysMs: [],
      route: { paidEnabled: true, remainingLeadBudgetEur: 0.05, runCostCeilingEur: 2 },
    });
    expect(calls[0].paidEnabled).toBe(true);
    expect(calls[0].remainingLeadBudgetEur).toBeCloseTo(0.05);
    expect(calls[0].runCostCeilingEur).toBe(2);
  });

  it('default stays free (no route → no paidEnabled on the fetch)', async () => {
    const { router, calls } = capturingRouter([{ status: 200, html: '<html><body>x</body></html>' }]);
    await verifyCandidates(router, ['https://acme.it'], NORM, { ...LEAD }, { corroborateWithRdap: false, retryDelaysMs: [] });
    expect(calls[0].paidEnabled).toBeUndefined();
    expect(calls[0].remainingLeadBudgetEur).toBeUndefined();
  });

  it('the transport-retry fetch carries the SAME route (and the breaker bypass)', async () => {
    const { router, calls } = capturingRouter([
      { status: 0, error: 'ETIMEDOUT' },
      { status: 200, html: '<html><body>x</body></html>' },
    ]);
    await verifyCandidates(router, ['https://acme.it'], NORM, { ...LEAD }, {
      corroborateWithRdap: false,
      retryDelaysMs: [1],
      jitter: () => 0,
      sleep: async () => {},
      route: { paidEnabled: true, remainingLeadBudgetEur: 0.03, runCostCeilingEur: 5 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].paidEnabled).toBe(true);
    expect(calls[1].remainingLeadBudgetEur).toBeCloseTo(0.03);
    expect(calls[1].bypassBreakerRecord).toBe(true);
  });
});

describe('routeFromLeadContext', () => {
  it('derives the remaining per-lead budget and clamps at 0', () => {
    const route = routeFromLeadContext({ paidEnabled: true, costCeilingEur: 0.1, costEur: 0.03, runCostCeilingEur: 5 });
    expect(route?.paidEnabled).toBe(true);
    expect(route?.remainingLeadBudgetEur).toBeCloseTo(0.07);
    expect(route?.runCostCeilingEur).toBe(5);
    // The live cap the router re-reads from the ledger before every paid attempt.
    expect(route?.leadCostCeilingEur).toBe(0.1);
    const exhausted = routeFromLeadContext({ paidEnabled: true, costCeilingEur: 0.02, costEur: 0.05, runCostCeilingEur: 5 });
    expect(exhausted?.remainingLeadBudgetEur).toBe(0);
  });

  it('paidEnabled defaults to false when the context does not opt in', () => {
    const route = routeFromLeadContext({ costCeilingEur: 0.1, costEur: 0 });
    expect(route?.paidEnabled).toBe(false);
  });
});

describe('verify_candidates — per-lead cap holds across candidates × retries (real router)', () => {
  it('6 candidates on a paid-only route never spend past the lead cap', async () => {
    let paidCalls = 0;
    const paid: HttpProvider = {
      id: 'paid_render',
      family: 'http',
      tier: 2,
      costPerCallEur: 0.01,
      available: () => true,
      fetch: async (): Promise<HttpFetchResult> => {
        paidCalls += 1;
        return { status: 503, error: 'upstream 503', duration_ms: 1, cost_eur: 0.01 };
      },
    };
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [paid], [], ledger);
    const candidates = Array.from({ length: 6 }, (_, i) => `https://acme${i}.it`);
    await verifyCandidates(router, candidates, NORM, { ...LEAD }, {
      corroborateWithRdap: false,
      retryDelaysMs: [1],
      jitter: () => 0,
      sleep: async () => {},
      meta: { lead_id: 'L1' },
      route: routeFromLeadContext({ paidEnabled: true, costCeilingEur: 0.03, costEur: 0, runCostCeilingEur: 5 }),
    });
    expect(paidCalls).toBe(3);
    expect(ledger.costForLead('L1')).toBeCloseTo(0.03);
  });
});
