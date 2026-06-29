import { describe, it, expect } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { HttpProvider, SerpProvider } from '../../src/types/providers';

class FakeSerp implements SerpProvider {
  family = 'serp' as const;
  constructor(public id: string, public tier: number, public costPerCallEur: number, private enabled: boolean, private results: Array<{ title: string; url: string; snippet: string; rank: number; source_provider: string }>) {}
  available() { return this.enabled; }
  async search() { return this.results; }
}

class FailingHttp implements HttpProvider {
  id = 'failing_http';
  family = 'http' as const;
  tier = 1;
  costPerCallEur = 0;
  available() { return true; }
  async fetch() { return { status: 500, html: undefined, finalUrl: undefined, duration_ms: 1, cost_eur: 0, provider: this.id, error: 'boom' }; }
}

class OkHttp implements HttpProvider {
  id = 'ok_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  async fetch() { return { status: 200, html: '<html>ok</html>', finalUrl: 'https://x', duration_ms: 1, cost_eur: 0, provider: this.id }; }
}

describe('ProviderRouter', () => {
  it('skips unavailable providers', async () => {
    const ledger = new CostLedger();
    const cheap = new FakeSerp('cheap', 1, 0.001, false, [{ title: 't', url: 'u', snippet: 's', rank: 1, source_provider: 'cheap' }]);
    const free = new FakeSerp('free', 0, 0, true, [{ title: 't2', url: 'u2', snippet: 's2', rank: 1, source_provider: 'free' }]);
    const router = new ProviderRouter([cheap, free], [], [], ledger);
    const out = await router.search('foo');
    expect(out.provider).toBe('free');
    expect(out.results[0].url).toBe('u2');
  });

  it('selects ascending by tier', async () => {
    const ledger = new CostLedger();
    const high = new FakeSerp('high', 4, 0.01, true, [{ title: 'h', url: 'h', snippet: '', rank: 1, source_provider: 'high' }]);
    const low = new FakeSerp('low', 0, 0, true, [{ title: 'l', url: 'l', snippet: '', rank: 1, source_provider: 'low' }]);
    const router = new ProviderRouter([high, low], [], [], ledger);
    const out = await router.search('q');
    expect(out.provider).toBe('low');
  });

  it('respects maxTier ceiling', async () => {
    const ledger = new CostLedger();
    const t0 = new FakeSerp('free', 0, 0, true, []);
    const t4 = new FakeSerp('paid', 4, 0.01, true, [{ title: 'p', url: 'p', snippet: '', rank: 1, source_provider: 'paid' }]);
    const router = new ProviderRouter([t0, t4], [], [], ledger);
    const out = await router.search('q', { maxTier: 1 });
    expect(out.results).toHaveLength(0);
  });

  it('falls through HTTP providers until one succeeds', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [new OkHttp(), new FailingHttp()], [], ledger);
    const r = await router.fetch('https://x');
    expect(r.provider).toBe('ok_http');
    expect(r.html).toContain('ok');
  });

  it('trips a SERP provider via circuit breaker after repeated throws', async () => {
    class ThrowingSerp implements SerpProvider {
      id = 'flaky_serp';
      family = 'serp' as const;
      tier = 0;
      costPerCallEur = 0;
      callCount = 0;
      available() { return true; }
      async search() {
        this.callCount += 1;
        throw new Error('upstream 5xx');
      }
    }
    const flaky = new ThrowingSerp();
    const ledger = new CostLedger();
    const router = new ProviderRouter([flaky], [], [], ledger);
    router.configureBreaker('flaky_serp', { failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000 });

    // 3 calls trip the breaker.
    for (let i = 0; i < 3; i++) await router.search('q');
    const before = flaky.callCount;
    // After the breaker is open, the provider is filtered out — no more calls.
    await router.search('q');
    await router.search('q');
    expect(flaky.callCount).toBe(before);
  });
});
