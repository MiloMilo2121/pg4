import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const cb = new CircuitBreaker();
    expect(cb.allow('bing_html')).toBe(true);
  });

  it('trips OPEN after N consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000 });
    for (let i = 0; i < 3; i++) cb.recordFailure('bing');
    expect(cb.allow('bing')).toBe(false);
  });

  it('does NOT trip when failures are spaced beyond the window', () => {
    let now = 1000;
    const cb = new CircuitBreaker(
      { failureThreshold: 3, windowMs: 1_000, cooldownMs: 5_000 },
      { now: () => now }
    );
    cb.recordFailure('x'); now += 2000;
    cb.recordFailure('x'); now += 2000;
    cb.recordFailure('x');
    // Each recordFailure starts a fresh window because the previous one expired.
    // The threshold of 3 is never reached *within* a single window.
    expect(cb.allow('x')).toBe(true);
  });

  it('a success resets the failure counter', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000 });
    cb.recordFailure('x');
    cb.recordFailure('x');
    cb.recordSuccess('x');
    cb.recordFailure('x');
    expect(cb.allow('x')).toBe(true); // 1 failure since reset, threshold not hit
  });

  it('moves to HALF_OPEN after cooldown and re-opens on next failure', () => {
    let now = 1000;
    const cb = new CircuitBreaker(
      { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
      { now: () => now }
    );
    cb.recordFailure('y'); cb.recordFailure('y');
    expect(cb.allow('y')).toBe(false);
    now += 5_500; // past cooldown
    expect(cb.allow('y')).toBe(true); // half_open
    cb.recordFailure('y'); // half_open trial fails → re-open
    expect(cb.allow('y')).toBe(false);
  });

  it('moves HALF_OPEN → CLOSED on a successful trial', () => {
    let now = 1000;
    const cb = new CircuitBreaker(
      { failureThreshold: 2, windowMs: 10_000, cooldownMs: 5_000 },
      { now: () => now }
    );
    cb.recordFailure('z'); cb.recordFailure('z');
    expect(cb.allow('z')).toBe(false);
    now += 5_500;
    expect(cb.allow('z')).toBe(true);
    cb.recordSuccess('z');
    expect(cb.allow('z')).toBe(true);
    cb.recordFailure('z'); // 1 failure in fresh closed state — does not trip
    expect(cb.allow('z')).toBe(true);
  });

  it('per-key configuration overrides the global default', () => {
    const cb = new CircuitBreaker({ failureThreshold: 100, windowMs: 60_000, cooldownMs: 5_000 });
    cb.configure('bing_html', { failureThreshold: 2, windowMs: 60_000, cooldownMs: 5_000 });
    cb.recordFailure('bing_html');
    cb.recordFailure('bing_html');
    expect(cb.allow('bing_html')).toBe(false);
    // global default still applies to other keys
    cb.recordFailure('serper');
    expect(cb.allow('serper')).toBe(true);
  });

  it('Phase D: timeout failures count as half-weight', () => {
    // 5 timeouts × 0.5 = 2.5 (< threshold 3) → still closed.
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 5_000 });
    for (let i = 0; i < 5; i++) cb.recordFailure('serper', 'timeout');
    expect(cb.allow('serper')).toBe(true);
    // Two more full-weight failures (block) push past threshold.
    cb.recordFailure('serper', 'block'); // 2.5 + 1 = 3.5
    expect(cb.allow('serper')).toBe(false);
  });

  it('Phase F.2: direct_fetch loose config tolerates 14 transport failures before tripping', () => {
    // Mirror of the catalog config used in src/providers/provider_catalog.ts:
    //   failureThreshold: 15, windowMs: 60_000, cooldownMs: 30_000.
    // Default config trips at 5; the loose config should tolerate
    // significantly more because direct_fetch failures are per-target.
    const cb = new CircuitBreaker();
    cb.configure('direct_fetch', { failureThreshold: 15, windowMs: 60_000, cooldownMs: 30_000 });
    for (let i = 0; i < 14; i++) cb.recordFailure('direct_fetch', 'transport');
    expect(cb.allow('direct_fetch')).toBe(true); // still under threshold
    cb.recordFailure('direct_fetch', 'transport');
    expect(cb.allow('direct_fetch')).toBe(false); // now tripped at 15
  });

  it('Phase F.2: direct_fetch loose config recovers fast (30 s cooldown)', () => {
    let now = 1000;
    const cb = new CircuitBreaker({}, { now: () => now });
    cb.configure('direct_fetch', { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
    for (let i = 0; i < 5; i++) cb.recordFailure('direct_fetch', 'transport');
    expect(cb.allow('direct_fetch')).toBe(false);
    now += 30_500;
    expect(cb.allow('direct_fetch')).toBe(true); // half_open after 30 s
  });

  it('Phase D: full-weight (block / rate_limit) trips at threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 5_000 });
    cb.recordFailure('bing', 'block');
    cb.recordFailure('bing', 'rate_limit');
    cb.recordFailure('bing', 'transport');
    expect(cb.allow('bing')).toBe(false);
  });

  it('snapshot returns a diagnostic view of all keys', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000 });
    cb.recordFailure('a');
    cb.recordFailure('b');
    cb.recordFailure('b');
    const snap = cb.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.find((s) => s.key === 'b')!.consecutiveFailures).toBe(2);
  });
});
