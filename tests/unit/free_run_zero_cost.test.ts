import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { CostedMeta } from '../../src/types/providers';

// Addendum R1 / AC1 — the load-bearing cost-safety guard: router.invoke (the single
// execution path for non-router families) must NEVER spend on a free run, and must
// honour the run-cost-ceiling. This is the class of bug that once blew €0.10 → €0.229.

const paidMeta: CostedMeta = {
  id: 'hunter',
  family: 'email',
  tier: 2,
  costPerCallEur: 0.04,
  available: () => true,
  roles: ['EMAIL_FIND'],
};

function newRouter() {
  const ledger = new CostLedger();
  const router = new ProviderRouter([], [], [], ledger);
  return { router, ledger };
}

describe('router.invoke — cost-safety', () => {
  it('AC1: a paid provider does NOT run and does NOT spend when paidEnabled is absent', async () => {
    const { router, ledger } = newRouter();
    let called = false;
    const out = await router.invoke(paidMeta, async () => {
      called = true;
      return { ok: true, value: 'x', cost_eur: 0.04 };
    });
    expect(out).toBeNull();
    expect(called).toBe(false); // gated BEFORE the call — no spend possible
    expect(ledger.getTotal()).toBe(0);
  });

  it('paid provider is gated out when the run-cost-ceiling would be exceeded', async () => {
    const { router, ledger } = newRouter();
    let called = false;
    const out = await router.invoke(
      paidMeta,
      async () => {
        called = true;
        return { ok: true, value: 'x', cost_eur: 0.04 };
      },
      { paidEnabled: true, runCostCeilingEur: 0.0 }
    );
    expect(out).toBeNull();
    expect(called).toBe(false);
    expect(ledger.getTotal()).toBe(0);
  });

  it('per-lead budget gates a call costing more than the remaining budget', async () => {
    const { router, ledger } = newRouter();
    const out = await router.invoke(paidMeta, async () => ({ ok: true, value: 'x', cost_eur: 0.04 }), {
      paidEnabled: true,
      remainingLeadBudgetEur: 0.01,
    });
    expect(out).toBeNull();
    expect(ledger.getTotal()).toBe(0);
  });

  it('runs and records the cost when paid is enabled and within budget', async () => {
    const { router, ledger } = newRouter();
    const out = await router.invoke(paidMeta, async () => ({ ok: true, value: 'found@x.it', cost_eur: 0.04 }), {
      paidEnabled: true,
      remainingLeadBudgetEur: 0.2,
      runCostCeilingEur: 0.2,
    });
    expect(out).toBe('found@x.it');
    expect(ledger.getTotal()).toBeCloseTo(0.04, 5);
  });

  it('a free (cost 0) provider always runs, no paid gate needed', async () => {
    const { router, ledger } = newRouter();
    const freeMeta: CostedMeta = { id: 'website_body', family: 'official', tier: 0, costPerCallEur: 0, available: () => true };
    const out = await router.invoke(freeMeta, async () => ({ ok: true, value: 'ok' }));
    expect(out).toBe('ok');
    expect(ledger.getTotal()).toBe(0);
  });

  it('returns null (no throw) when the underlying call fails — caller moves to next step', async () => {
    const { router } = newRouter();
    const out = await router.invoke(paidMeta, async () => {
      throw new Error('network');
    }, { paidEnabled: true, remainingLeadBudgetEur: 0.2 });
    expect(out).toBeNull();
  });
});
