import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { RateLimiter } from '../../src/runtime/rate_limiter';
import type { SerpProvider } from '../../src/types/providers';

/**
 * Phase F finding — the RateLimiter existed on the Run since Phase 1 but
 * acquire() had no call sites; the smoke run's SERP burst (~3.7 req/s)
 * got soft-blocked by Bing with 185/185 empty. These tests pin the fix:
 * the router now paces per-provider via the injected RateLimiter.
 */

function freeSerp(id: string, calls: number[]): SerpProvider {
  return {
    id,
    family: 'serp',
    tier: 1,
    costPerCallEur: 0,
    available: () => true,
    search: async () => {
      calls.push(Date.now());
      return [{ title: 't', url: 'https://example.com', snippet: 's' }];
    },
  } as unknown as SerpProvider;
}

describe('ProviderRouter rate limiting — Phase F', () => {
  it('spaces consecutive calls to a configured provider', async () => {
    const calls: number[] = [];
    const rate = new RateLimiter();
    // 5/s with bucket capacity 1 → ≥ ~200ms between calls after the first.
    rate.configure('paced', 5, 1);
    const router = new ProviderRouter([freeSerp('paced', calls)], [], [], new CostLedger(), undefined, rate);

    const started = Date.now();
    await router.search('q1');
    await router.search('q2');
    await router.search('q3');
    const elapsed = Date.now() - started;

    expect(calls).toHaveLength(3);
    // 2 refill waits of ~200ms each; allow generous slack for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it('unconfigured providers are NOT throttled (behavior unchanged)', async () => {
    const calls: number[] = [];
    const rate = new RateLimiter();
    const router = new ProviderRouter([freeSerp('unlimited', calls)], [], [], new CostLedger(), undefined, rate);

    const started = Date.now();
    for (let i = 0; i < 5; i++) await router.search('q');
    expect(calls).toHaveLength(5);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('router without a limiter behaves as before', async () => {
    const calls: number[] = [];
    const router = new ProviderRouter([freeSerp('legacy', calls)], [], [], new CostLedger());
    await router.search('q');
    expect(calls).toHaveLength(1);
  });
});
