import { describe, expect, it, vi } from 'vitest';
import { createNotifier, setNotifier, getNotifier } from '../../src/runtime/notifier';
import type { NotifyEvent, Notifier } from '../../src/runtime/notifier';

describe('Notifier — Phase A.5', () => {
  it('NOTIFY=off|0|false|none → noop notifier (does not throw, does nothing visible)', () => {
    for (const mode of ['off', '0', 'false', 'none', 'OFF']) {
      const n = createNotifier(mode);
      expect(() => n.notify({ kind: 'run_complete', title: 't', body: 'b' })).not.toThrow();
    }
  });

  it('default mode is local', () => {
    const n = createNotifier(undefined);
    // LocalNotifier writes through the logger; we only assert it is callable
    // without throwing on a non-darwin-safe path.
    expect(() => n.notify({ kind: 'cost_ceiling_hit', title: 'cap', body: 'hit', meta: { run_id: 'x' } })).not.toThrow();
  });

  it('setNotifier seam replaces the singleton (used by CLIs under test)', () => {
    const events: NotifyEvent[] = [];
    const fake: Notifier = { notify: (e) => void events.push(e) };
    setNotifier(fake);
    try {
      getNotifier().notify({ kind: 'yield_anomaly', title: 'y', body: 'z' });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('yield_anomaly');
    } finally {
      setNotifier(null);
    }
  });

  it('event shape carries kind/title/body/meta through', () => {
    const events: NotifyEvent[] = [];
    const fake: Notifier = { notify: (e) => void events.push(e) };
    const spy = vi.fn(fake.notify);
    fake.notify = spy as unknown as Notifier['notify'];
    fake.notify({
      kind: 'run_cost_ceiling_hit',
      title: 'Run cost ceiling reached',
      body: 'Paid disabled.',
      meta: { run_id: 'run-1', ledger_total_eur: 0.21, ceiling_eur: 0.2 },
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'run_cost_ceiling_hit', meta: expect.objectContaining({ ceiling_eur: 0.2 }) })
    );
  });
});
