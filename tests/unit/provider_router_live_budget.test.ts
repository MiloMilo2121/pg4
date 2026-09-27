import { describe, it, expect } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { CostedMeta, HttpFetchResult, HttpProvider } from '../../src/types/providers';

/** Paid HTTP provider that always answers 503 (so the caller keeps retrying). */
class FlakyPaidHttp implements HttpProvider {
  id = 'paid_render';
  family = 'http' as const;
  tier = 2;
  costPerCallEur = 0.01;
  calls = 0;
  available() {
    return true;
  }
  async fetch(): Promise<HttpFetchResult> {
    this.calls += 1;
    return { status: 503, html: undefined, error: 'upstream 503', duration_ms: 1, cost_eur: this.costPerCallEur };
  }
}

function paidMeta(cost: number): CostedMeta {
  return { id: 'apify_x', family: 'apify', tier: 2, costPerCallEur: cost, available: () => true };
}

describe('ProviderRouter — live per-lead cap (leadCostCeilingEur)', () => {
  it('a route REUSED across attempts stops at the lead cap (the €0.10 → €0.229 class of bug)', async () => {
    const ledger = new CostLedger();
    const paid = new FlakyPaidHttp();
    const router = new ProviderRouter([], [paid], [], ledger);
    // One route object built once and reused for 6 attempts — exactly what
    // verify_candidates does across candidates × transport retries.
    const route = { paidEnabled: true, remainingLeadBudgetEur: 0.025, leadCostCeilingEur: 0.025, meta: { lead_id: 'L1' } };
    for (let i = 0; i < 6; i++) await router.fetch('https://x.example', route);
    expect(paid.calls).toBe(2);
    expect(ledger.costForLead('L1')).toBeCloseTo(0.02);
  });

  it('the cap is per lead: another lead still has its own budget', async () => {
    const ledger = new CostLedger();
    const paid = new FlakyPaidHttp();
    const router = new ProviderRouter([], [paid], [], ledger);
    for (let i = 0; i < 3; i++) await router.fetch('u', { paidEnabled: true, leadCostCeilingEur: 0.01, meta: { lead_id: 'A' } });
    await router.fetch('u', { paidEnabled: true, leadCostCeilingEur: 0.01, meta: { lead_id: 'B' } });
    expect(paid.calls).toBe(2);
  });

  it('in-flight reservations count against the lead cap (concurrent attempts)', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    let running = 0;
    const call = async () => {
      running += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, value: 1, cost_eur: 0.01 };
    };
    const opts = { paidEnabled: true, leadCostCeilingEur: 0.015, meta: { lead_id: 'L' } };
    const res = await Promise.all([router.invoke(paidMeta(0.01), call, opts), router.invoke(paidMeta(0.01), call, opts)]);
    expect(running).toBe(1);
    expect(res.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('ProviderRouter.invoke — failed-call cost accounting', () => {
  it('records the real spend carried by the error instead of the worst-case reservation', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    const out = await router.invoke(
      paidMeta(2.1),
      async () => {
        throw Object.assign(new Error('run failed'), { cost_eur: 0.35 });
      },
      { paidEnabled: true, runCostCeilingEur: 10 },
    );
    expect(out).toBeNull();
    expect(ledger.getTotal()).toBeCloseTo(0.35);
  });

  it('records €0 for a start that never ran', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    await router.invoke(paidMeta(2.1), async () => { throw Object.assign(new Error('rejected'), { cost_eur: 0 }); }, { paidEnabled: true });
    expect(ledger.getTotal()).toBe(0);
  });

  it('falls back to the worst case when the spend is unknown', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    await router.invoke(paidMeta(2.1), async () => { throw new Error('socket hang up'); }, { paidEnabled: true });
    expect(ledger.getTotal()).toBeCloseTo(2.1);
  });
});
