/**
 * Hardening audit — run-cost ceiling exact-boundary behaviour
 *
 * The filter() method in ProviderRouter uses `<= runCostCeilingEur` (ALLOW
 * at exactly the cap). The hot-path re-check inside search/fetch/complete
 * uses `> runCostCeilingEur` (ALLOW at exactly the cap, REJECT when over).
 * Both operators agree: a call that would bring the total to EXACTLY the cap
 * is ALLOWED; a call that would exceed it is REJECTED.
 *
 * Boundary cases:
 *   N = 3, cost = 0.001 each, ceiling = 0.003
 *   - call 1: total=0 → 0 + 0.001 = 0.001 ≤ 0.003 → ALLOW → total=0.001
 *   - call 2: total=0.001 → 0.001 + 0.001 = 0.002 ≤ 0.003 → ALLOW → total=0.002
 *   - call 3: total=0.002 → 0.002 + 0.001 = 0.003 ≤ 0.003 → ALLOW → total=0.003
 *   - call 4: total=0.003 → 0.003 + 0.001 = 0.004 > 0.003 → REJECT
 *
 * paidEnabled must also be true for paid calls to be considered at all.
 */

import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider, SerpResult } from '../../src/types/providers';

class FreeSerp implements SerpProvider {
  id = 'free';
  family = 'serp' as const;
  tier = 1;
  costPerCallEur = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    return []; // returns nothing so router falls through to paid
  }
}

class PaidSerp implements SerpProvider {
  id = 'paid';
  family = 'serp' as const;
  tier = 2;
  costPerCallEur: number;
  callCount = 0;
  available() { return true; }
  constructor(cost: number) {
    this.costPerCallEur = cost;
  }
  async search(): Promise<SerpResult[]> {
    this.callCount++;
    return [{ title: 'paid result', url: 'https://paid.example', snippet: '', rank: 1, source_provider: this.id }];
  }
}

describe('ProviderRouter — run-cost ceiling exact boundary', () => {
  it('allows exactly N calls when N * cost = ceiling (no rounding loss)', async () => {
    const cost = 0.001;
    const ceiling = 0.003;
    const N = 3;

    const ledger = new CostLedger();
    const paid = new PaidSerp(cost);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    for (let i = 0; i < N; i++) {
      const r = await router.search(`q${i}`, {
        paidEnabled: true,
        paidOnly: true,
        runCostCeilingEur: ceiling,
      });
      expect(r.provider).toBe('paid');
    }
    expect(paid.callCount).toBe(N);
    expect(ledger.getTotal()).toBeCloseTo(ceiling, 6);
  });

  it('rejects call N+1 when total already equals ceiling', async () => {
    const cost = 0.001;
    const ceiling = 0.003;

    const ledger = new CostLedger();
    const paid = new PaidSerp(cost);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    // Pre-fill ledger with exactly `ceiling` already spent.
    for (let i = 0; i < 3; i++) {
      ledger.record('seed', 'serp', cost, true, { kind: 'success' });
    }
    expect(ledger.getTotal()).toBeCloseTo(ceiling, 6);

    paid.callCount = 0;
    const r = await router.search('q-extra', {
      paidEnabled: true,
      paidOnly: true,
      runCostCeilingEur: ceiling,
    });
    // The N+1 call must not go to the paid provider.
    expect(paid.callCount).toBe(0);
    expect(r.provider).toBe('none');
  });

  it('allows call that brings total to EXACTLY the ceiling (boundary inclusive)', async () => {
    const cost = 0.001;
    const ceiling = 0.003;

    const ledger = new CostLedger();
    const paid = new PaidSerp(cost);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    // Pre-fill 2 * cost = 0.002 already spent.
    ledger.record('seed', 'serp', cost, true, { kind: 'success' });
    ledger.record('seed', 'serp', cost, true, { kind: 'success' });
    expect(ledger.getTotal()).toBeCloseTo(0.002, 6);

    paid.callCount = 0;
    const r = await router.search('q-boundary', {
      paidEnabled: true,
      paidOnly: true,
      runCostCeilingEur: ceiling,
    });
    // 0.002 + 0.001 = 0.003 = ceiling → ALLOW
    expect(paid.callCount).toBe(1);
    expect(r.provider).toBe('paid');
    expect(ledger.getTotal()).toBeCloseTo(ceiling, 6);
  });

  it('paidEnabled=false blocks paid even when ceiling would permit it', async () => {
    const cost = 0.001;
    const ceiling = 1.0; // generous ceiling

    const ledger = new CostLedger();
    const paid = new PaidSerp(cost);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    paid.callCount = 0;
    await router.search('q', {
      paidEnabled: false,
      runCostCeilingEur: ceiling,
    });
    expect(paid.callCount).toBe(0);
    expect(ledger.getTotal()).toBe(0);
  });

  it('ceiling=0 blocks every paid call regardless of paidEnabled', async () => {
    const ledger = new CostLedger();
    const paid = new PaidSerp(0.001);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    paid.callCount = 0;
    await router.search('q', {
      paidEnabled: true,
      runCostCeilingEur: 0,
    });
    expect(paid.callCount).toBe(0);
  });

  it('per-lead budget filter is independent of run ceiling', async () => {
    // Per-lead budget < cost blocks the paid call even when run ceiling is large.
    const ledger = new CostLedger();
    const paid = new PaidSerp(0.01);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    paid.callCount = 0;
    await router.search('q', {
      paidEnabled: true,
      remainingLeadBudgetEur: 0.005, // less than 0.01
      runCostCeilingEur: 100,
    });
    expect(paid.callCount).toBe(0);
  });

  it('ledger total cost never exceeds ceiling after N allowed calls', async () => {
    const cost = 0.001;
    const ceiling = 0.005;
    const maxAllowed = Math.floor(ceiling / cost); // = 5

    const ledger = new CostLedger();
    const paid = new PaidSerp(cost);
    const router = new ProviderRouter([new FreeSerp(), paid], [], [], ledger);

    for (let i = 0; i < maxAllowed + 5; i++) {
      await router.search(`q${i}`, {
        paidEnabled: true,
        paidOnly: true,
        runCostCeilingEur: ceiling,
      });
    }

    // Total must not exceed ceiling.
    expect(ledger.getTotal()).toBeLessThanOrEqual(ceiling + Number.EPSILON);
    // Exactly N calls should have been made.
    expect(paid.callCount).toBe(maxAllowed);
  });
});
