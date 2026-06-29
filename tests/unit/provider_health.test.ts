import { describe, expect, it, afterEach } from 'vitest';
import { detectDeadProviders, reportProviderHealth, DEAD_PROVIDER_MIN_CALLS } from '../../src/runtime/provider_health';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { setNotifier } from '../../src/runtime/notifier';
import type { NotifyEvent } from '../../src/runtime/notifier';

describe('detectDeadProviders (pure)', () => {
  it('flags a provider with ≥minCalls and 0% success, with dominant kind', () => {
    const byProvider = {
      dns_mx: { calls: 50, cost_eur: 0, success_rate: 0, by_kind: { empty: 48, transport: 2 } },
      bing_html: { calls: 50, cost_eur: 0, success_rate: 0.9, by_kind: { success: 45, empty: 5 } },
    };
    const dead = detectDeadProviders(byProvider);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ provider: 'dns_mx', calls: 50, dominant_kind: 'empty' });
  });

  it('does NOT flag a low-volume provider (below minCalls)', () => {
    const byProvider = {
      crtsh: { calls: 3, cost_eur: 0, success_rate: 0, by_kind: { transport: 3 } },
    };
    expect(detectDeadProviders(byProvider)).toEqual([]);
  });

  it('does NOT flag a provider that succeeded at least once', () => {
    const byProvider = {
      serper: { calls: 100, cost_eur: 1, success_rate: 0.01, by_kind: { success: 1, empty: 99 } },
    };
    expect(detectDeadProviders(byProvider)).toEqual([]);
  });

  it('sorts dead providers by call volume desc', () => {
    const byProvider = {
      a: { calls: 12, cost_eur: 0, success_rate: 0, by_kind: { empty: 12 } },
      b: { calls: 99, cost_eur: 0, success_rate: 0, by_kind: { blocked: 99 } },
    };
    expect(detectDeadProviders(byProvider).map((d) => d.provider)).toEqual(['b', 'a']);
  });
});

describe('reportProviderHealth (ledger + notifier)', () => {
  afterEach(() => setNotifier(null));

  it('returns ids, logs, and notifies when a provider is dead', () => {
    const events: NotifyEvent[] = [];
    setNotifier({ notify: (e) => events.push(e) });

    const ledger = new CostLedger();
    for (let i = 0; i < DEAD_PROVIDER_MIN_CALLS + 2; i++) {
      ledger.record('dns_mx', 'serp', 0, false, { kind: 'empty' });
    }
    ledger.record('bing_html', 'serp', 0, true, { kind: 'success' });

    const ids = reportProviderHealth(ledger, { runId: 'run-x' });
    expect(ids).toEqual(['dns_mx']);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('provider_dead');
    expect(events[0].meta?.providers).toBe('dns_mx');
  });

  it('is silent (no event, empty list) when all providers are healthy', () => {
    const events: NotifyEvent[] = [];
    setNotifier({ notify: (e) => events.push(e) });

    const ledger = new CostLedger();
    for (let i = 0; i < 20; i++) ledger.record('bing_html', 'serp', 0, true, { kind: 'success' });

    expect(reportProviderHealth(ledger)).toEqual([]);
    expect(events).toHaveLength(0);
  });
});
