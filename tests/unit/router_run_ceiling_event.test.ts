import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider } from '../../src/types/providers';

/**
 * Phase A.5 — the router fires the run-ceiling listener exactly once,
 * the first time a paid provider is dropped because the run cap would
 * be exceeded. Previously this was a silent `continue`.
 */

function paidSerp(id: string, costPerCallEur: number): SerpProvider {
  return {
    id,
    family: 'serp',
    tier: 2,
    costPerCallEur,
    available: () => true,
    search: async () => [{ title: 't', url: 'https://example.com', snippet: 's' }],
  } as unknown as SerpProvider;
}

describe('ProviderRouter run-ceiling event — Phase A.5', () => {
  it('fires once when the cap filters a paid provider, not on subsequent drops', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('paid1', 0.5)], [], [], ledger);
    const events: Array<{ ledgerTotalEur: number; ceilingEur: number }> = [];
    router.setRunCeilingListener((info) => events.push(info));

    // Cap 0.3 < call cost 0.5 → provider filtered, event fires.
    await router.search('q1', { paidEnabled: true, runCostCeilingEur: 0.3 });
    expect(events).toHaveLength(1);
    expect(events[0].ceilingEur).toBe(0.3);

    // Second call: still filtered, but the latch holds — no second event.
    await router.search('q2', { paidEnabled: true, runCostCeilingEur: 0.3 });
    expect(events).toHaveLength(1);
  });

  it('does not fire when the budget fits or when no ceiling is set', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('paid1', 0.1)], [], [], ledger);
    const events: unknown[] = [];
    router.setRunCeilingListener((info) => events.push(info));

    await router.search('q', { paidEnabled: true, runCostCeilingEur: 1.0 });
    await router.search('q', { paidEnabled: true }); // no ceiling
    expect(events).toHaveLength(0);
  });

  it('does not fire for free providers regardless of ceiling', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('free1', 0)], [], [], ledger);
    const events: unknown[] = [];
    router.setRunCeilingListener((info) => events.push(info));
    await router.search('q', { runCostCeilingEur: 0 });
    expect(events).toHaveLength(0);
  });
});
