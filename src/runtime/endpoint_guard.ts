import { CircuitBreaker, type CircuitConfig } from './circuit_breaker';
import { RateLimiter } from './rate_limiter';
import type { FailureKind } from '../types/providers';

/**
 * Rate limit and circuit breaker for free public endpoints that sit outside
 * the ProviderRouter (RDAP, VIES). They cost nothing, so the router's paid
 * gate and ledger add nothing; what they need is its pacing and its storm
 * protection. Without them a 5-lead pool bursts the registries, and an
 * `ENOTFOUND rdap.nic.it` outage costs every lead a full timeout.
 */
export class EndpointGuard {
  constructor(
    private readonly breaker: CircuitBreaker = new CircuitBreaker(),
    private readonly rate: RateLimiter = new RateLimiter(),
  ) {}

  configure(key: string, limits: { ratePerSec: number; burst: number; breaker?: Partial<CircuitConfig> }): void {
    this.rate.configure(key, limits.ratePerSec, limits.burst);
    if (limits.breaker) this.breaker.configure(key, limits.breaker);
  }

  /** Waits for a rate-limit token; answers false at once while the breaker is open. */
  async admit(key: string): Promise<boolean> {
    if (!this.breaker.allow(key)) return false;
    await this.rate.acquire(key);
    return true;
  }

  succeeded(key: string): void {
    this.breaker.recordSuccess(key);
  }

  failed(key: string, kind: FailureKind): void {
    this.breaker.recordFailure(key, kind);
  }
}

export const RDAP_NIC_IT = 'rdap.nic.it';
export const RDAP_ORG = 'rdap.org';
export const VIES = 'vies';

/**
 * One guard per process, not per router: the registries throttle by egress
 * IP, and the judgment layer builds a router of its own.
 *
 * Rates: each lead makes at most one RDAP call per candidate site and one VIES
 * call, so 1 req/s with a burst of 2 never slows a run (a lead takes seconds)
 * but stops the enrich pool from firing 5 at once. VIES answers bursts with
 * `MS_MAX_CONCURRENT_REQ`, and registry RDAP servers rate-limit per IP.
 * The breaker keeps the router default: 5 failures in 60 s, 120 s cool-down.
 */
export const publicRegistryGuard = new EndpointGuard();
publicRegistryGuard.configure(RDAP_NIC_IT, { ratePerSec: 1, burst: 2 });
publicRegistryGuard.configure(RDAP_ORG, { ratePerSec: 1, burst: 2 });
publicRegistryGuard.configure(VIES, { ratePerSec: 1, burst: 2 });
