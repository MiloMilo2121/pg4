import { describe, it, expect } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider, SerpResult } from '../../src/types/providers';

/**
 * Phase G — paid-gate router tests. Default-deny is the load-bearing
 * safety: a run without `paidEnabled: true` MUST NOT reach any
 * provider with cost > 0, regardless of tier or budget hints.
 */

class FakeFreeSerp implements SerpProvider {
  id = 'fake_free';
  family = 'serp' as const;
  tier = 1;
  costPerCallEur = 0;
  callCount = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount++;
    return [{ title: 'free', url: 'https://free.example', snippet: '', rank: 1, source_provider: this.id }];
  }
}

class FakePaidSerp implements SerpProvider {
  id = 'fake_paid';
  family = 'serp' as const;
  tier = 2;
  costPerCallEur = 0.001;
  callCount = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount++;
    return [{ title: 'paid', url: 'https://paid.example', snippet: '', rank: 1, source_provider: this.id }];
  }
}

describe('ProviderRouter — Phase G paid gate', () => {
  it('paidEnabled default-false: paid providers are NEVER called', async () => {
    const ledger = new CostLedger();
    const free = new FakeFreeSerp();
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([free, paid], [], [], ledger);
    // No paidEnabled, no maxTier — a naive default would let tier 2 through.
    await router.search('q');
    expect(free.callCount).toBe(1);
    expect(paid.callCount).toBe(0);
  });

  it('paidEnabled=false explicit: paid providers are filtered out', async () => {
    const ledger = new CostLedger();
    const free = new FakeFreeSerp();
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([free, paid], [], [], ledger);
    await router.search('q', { paidEnabled: false });
    expect(paid.callCount).toBe(0);
  });

  it('paidEnabled=true with budget allows paid', async () => {
    // Free returns nothing, so router falls through to paid.
    const ledger = new CostLedger();
    const empty = new FakeFreeSerp();
    empty.search = async () => [];
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([empty, paid], [], [], ledger);
    const r = await router.search('q', { paidEnabled: true, remainingLeadBudgetEur: 0.01 });
    expect(paid.callCount).toBe(1);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('paidEnabled=true but remainingLeadBudgetEur < cost blocks the paid call', async () => {
    const ledger = new CostLedger();
    const empty = new FakeFreeSerp();
    empty.search = async () => [];
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([empty, paid], [], [], ledger);
    await router.search('q', { paidEnabled: true, remainingLeadBudgetEur: 0.0005 }); // < 0.001
    expect(paid.callCount).toBe(0);
  });

  it('paidEnabled=true with includeProviderIds limits to listed paid ids only', async () => {
    const ledger = new CostLedger();
    const free = new FakeFreeSerp();
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([free, paid], [], [], ledger);
    // Target the paid provider explicitly; the free provider gets
    // filtered by includeProviderIds even though it's free.
    await router.search('q', { paidEnabled: true, remainingLeadBudgetEur: 1, includeProviderIds: ['fake_paid'] });
    expect(free.callCount).toBe(0);
    expect(paid.callCount).toBe(1);
  });

  it('paidOnly=true filters out free providers so paid is actually reached', async () => {
    // Repro of the p90 first-attempt bug: paid pass without paidOnly
    // returned bing_html-class results before reaching Serper.
    // free.search returns NON-empty (mimicking bing_html), which would
    // satisfy router.search() and prevent the paid call.
    const ledger = new CostLedger();
    const free = new FakeFreeSerp();   // tier 1, returns 1 result
    const paid = new FakePaidSerp();    // tier 2, returns 1 result
    const router = new ProviderRouter([free, paid], [], [], ledger);
    // Without paidOnly: router returns on free.search (tier 1) first.
    free.callCount = 0; paid.callCount = 0;
    await router.search('q', { paidEnabled: true, remainingLeadBudgetEur: 0.01 });
    expect(free.callCount).toBe(1);
    expect(paid.callCount).toBe(0); // free satisfied → paid never reached
    // With paidOnly: free is filtered, paid IS called.
    free.callCount = 0; paid.callCount = 0;
    await router.search('q', { paidEnabled: true, paidOnly: true, remainingLeadBudgetEur: 0.01 });
    expect(free.callCount).toBe(0);
    expect(paid.callCount).toBe(1);
  });

  it('runCostCeilingEur enforces aggregate cap across calls (the p90-blowup hotfix)', async () => {
    // Phase G hotfix regression: without this gate the router would
    // keep calling paid providers indefinitely after the cap.
    const ledger = new CostLedger();
    const empty = new FakeFreeSerp();
    empty.search = async () => [];
    const paid = new FakePaidSerp(); // tier 2, cost 0.001
    const router = new ProviderRouter([empty, paid], [], [], ledger);
    // Simulate prior spend by recording two paid calls (= €0.002 in ledger).
    ledger.record('seed', 'serp', 0.001, true, { kind: 'success' });
    ledger.record('seed', 'serp', 0.001, true, { kind: 'success' });
    expect(ledger.getTotal()).toBeCloseTo(0.002, 6);
    // Now ask for paid with a run-cap of 0.0025: only one more paid call would
    // fit (0.002 + 0.001 = 0.003 > 0.0025), so the gate must filter paid out.
    paid.callCount = 0;
    await router.search('q', {
      paidEnabled: true,
      remainingLeadBudgetEur: 0.01,
      runCostCeilingEur: 0.0025,
    });
    expect(paid.callCount).toBe(0);
    // Bumping cap to 0.005 lets one more call fit.
    paid.callCount = 0;
    await router.search('q', {
      paidEnabled: true,
      remainingLeadBudgetEur: 0.01,
      runCostCeilingEur: 0.005,
    });
    expect(paid.callCount).toBe(1);
  });

  it('Phase G.1 — concurrent paid calls cannot both pass when only one fits the cap', async () => {
    // Two pipelines fire router.search at the same time. The cap is
    // €0.001 (one call's worth). Without atomic reservation both
    // would pass the filter (ledger.getTotal()=0 at filter time)
    // and both would spend → total = €0.002 > cap. With reservation,
    // only one wins; the other sees `ledger.getTotal() + reserved`
    // already at €0.001 and is filtered out.
    const ledger = new CostLedger();
    const empty = new FakeFreeSerp();
    empty.search = async () => [];
    // Slow paid provider — 50 ms per call. Long enough for both
    // pipelines to enter the await before either completes.
    const slowPaid = new FakePaidSerp();
    const origSearch = slowPaid.search.bind(slowPaid);
    slowPaid.search = async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
      return origSearch();
    };
    const router = new ProviderRouter([empty, slowPaid], [], [], ledger);
    slowPaid.callCount = 0;
    const [r1, r2] = await Promise.all([
      router.search('q1', { paidEnabled: true, remainingLeadBudgetEur: 1, runCostCeilingEur: 0.001 }),
      router.search('q2', { paidEnabled: true, remainingLeadBudgetEur: 1, runCostCeilingEur: 0.001 }),
    ]);
    void r1; void r2;
    // Exactly one paid call should have fired, not two.
    expect(slowPaid.callCount).toBe(1);
    expect(ledger.getTotal()).toBeCloseTo(0.001, 6);
  });

  it('cost ceiling 0 + paidEnabled=false: ledger total cost is 0', async () => {
    const ledger = new CostLedger();
    const free = new FakeFreeSerp();
    const paid = new FakePaidSerp();
    const router = new ProviderRouter([free, paid], [], [], ledger);
    await router.search('q'); // paidEnabled default-false
    expect(ledger.getTotal()).toBe(0);
    expect(paid.callCount).toBe(0);
  });
});
