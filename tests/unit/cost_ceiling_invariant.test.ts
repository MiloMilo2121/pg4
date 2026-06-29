import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider } from '../../src/types/providers';

/**
 * Gate-0 — the money-guard invariant, proven deterministically at €0.
 *
 * The discovery pass flagged that the run-cost ceiling was "verified by READ,
 * not by spend" — the reservation logic was unit-tested for the event but the
 * end-to-end accumulation invariant ("the ledger total never crosses the
 * ceiling, no matter how many paid calls are attempted") was asserted only by
 * inspection. This test exercises that invariant directly with a mock paid
 * provider. The complementary LIVE €0.02 Serper run (the only real spend in
 * this pass) is documented in docs/saas_foundation_report.md + the operator
 * playbook and runs once a SERPER_API_KEY is provided.
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

describe('Gate-0 — run-cost-ceiling invariant', () => {
  it('ledger total NEVER exceeds the ceiling across many paid calls', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('paid', 0.01)], [], [], ledger);
    const CEILING = 0.02;

    for (let i = 0; i < 50; i++) {
      await router.search(`q${i}`, { paidEnabled: true, runCostCeilingEur: CEILING });
      // The cap holds at every step — this is the property that protects money.
      expect(ledger.getTotal()).toBeLessThanOrEqual(CEILING + 1e-9);
    }
    // Exactly two €0.01 calls fit under €0.02; every later call is filtered
    // out before it can spend.
    expect(ledger.getTotal()).toBeCloseTo(0.02, 6);
  });

  it('a single call costlier than the whole ceiling never executes (spends €0)', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('expensive', 0.5)], [], [], ledger);
    await router.search('q', { paidEnabled: true, runCostCeilingEur: 0.02 });
    expect(ledger.getTotal()).toBe(0);
  });

  it('paidEnabled=false → no paid spend regardless of ceiling headroom', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([paidSerp('paid', 0.01)], [], [], ledger);
    await router.search('q', { paidEnabled: false, runCostCeilingEur: 1.0 });
    expect(ledger.getTotal()).toBe(0);
  });
});
