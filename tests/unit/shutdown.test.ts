import { afterEach, describe, expect, it, vi } from 'vitest';
import { onShutdownSignal } from '../../src/runtime/shutdown';

const SIG = 'SIGUSR2' as const; // never sent by the test runner itself
let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

describe('onShutdownSignal', () => {
  it('drains, then exits 0', async () => {
    const exit = vi.fn();
    const cleanup = vi.fn(async () => {});
    unregister = onShutdownSignal('t', cleanup, { exit, signals: [SIG] });
    process.emit(SIG, SIG);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the drain exceeds the timeout', async () => {
    const exit = vi.fn();
    unregister = onShutdownSignal('t', () => new Promise(() => {}), { exit, timeoutMs: 10, signals: [SIG] });
    process.emit(SIG, SIG);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('exits 1 when cleanup fails', async () => {
    const exit = vi.fn();
    unregister = onShutdownSignal('t', async () => { throw new Error('boom'); }, { exit, signals: [SIG] });
    process.emit(SIG, SIG);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('a second signal while draining forces an immediate exit', () => {
    const exit = vi.fn();
    unregister = onShutdownSignal('t', () => new Promise(() => {}), { exit, timeoutMs: 60_000, signals: [SIG] });
    process.emit(SIG, SIG);
    process.emit(SIG, SIG);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
