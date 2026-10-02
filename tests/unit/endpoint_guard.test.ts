import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';
import { RateLimiter } from '../../src/runtime/rate_limiter';
import { EndpointGuard } from '../../src/runtime/endpoint_guard';

/** Records every token request instead of waiting for it. */
class SpyLimiter extends RateLimiter {
  readonly acquired: string[] = [];
  readonly configured: Array<[string, number, number | undefined]> = [];
  override configure(key: string, ratePerSec: number, capacity?: number): void {
    this.configured.push([key, ratePerSec, capacity]);
  }
  override async acquire(key: string): Promise<void> {
    this.acquired.push(key);
  }
}

describe('EndpointGuard — rate limit and breaker for free public endpoints', () => {
  it('configures the limiter per key and takes a token on every admitted call', async () => {
    const rate = new SpyLimiter();
    const guard = new EndpointGuard(new CircuitBreaker(), rate);
    guard.configure('rdap.nic.it', { ratePerSec: 1, burst: 2 });
    expect(rate.configured).toEqual([['rdap.nic.it', 1, 2]]);

    expect(await guard.admit('rdap.nic.it')).toBe(true);
    expect(await guard.admit('rdap.nic.it')).toBe(true);
    expect(rate.acquired).toEqual(['rdap.nic.it', 'rdap.nic.it']);
  });

  it('opens after N failures, refuses without taking a token, half-opens after the cool-down', async () => {
    let now = 1_000;
    const rate = new SpyLimiter();
    const guard = new EndpointGuard(new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 120_000 }, { now: () => now }), rate);

    for (let i = 0; i < 3; i++) guard.failed('vies', 'transport');
    expect(await guard.admit('vies')).toBe(false);
    expect(rate.acquired).toEqual([]);

    now += 120_000;
    expect(await guard.admit('vies')).toBe(true); // half-open trial
    guard.failed('vies', 'transport'); // the trial fails → open again at once
    expect(await guard.admit('vies')).toBe(false);

    now += 120_000;
    expect(await guard.admit('vies')).toBe(true);
    guard.succeeded('vies'); // the trial succeeds → closed
    expect(await guard.admit('vies')).toBe(true);
  });

  it('keeps keys apart: one registry down does not block another', async () => {
    const guard = new EndpointGuard(new CircuitBreaker({ failureThreshold: 2 }), new SpyLimiter());
    guard.failed('rdap.org', 'transport');
    guard.failed('rdap.org', 'transport');
    expect(await guard.admit('rdap.org')).toBe(false);
    expect(await guard.admit('rdap.nic.it')).toBe(true);
    expect(await guard.admit('vies')).toBe(true);
  });
});
